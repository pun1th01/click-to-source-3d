import fs from "node:fs/promises";
import path from "node:path";
import {
  editParameter,
  readSourceFile,
  type DevServerOptions,
} from "./devServer.js";
import {
  isSourceFile,
  scanFile,
  type ProvenanceSite,
} from "./scanProvenance.js";

export type ToolContext = DevServerOptions & {
  /** Project root the scanning tools walk. */
  root: string;
};

const SCAN_IGNORED = new Set([
  "node_modules",
  "dist",
  "build",
  ".git",
  ".vite",
  "coverage",
]);

/**
 * How many source files a single scan will open.
 *
 * Shared by every tool that walks the tree, so "what the scanner can see" is
 * one number rather than one per caller. A scan that hits it stops early and
 * says so, rather than silently reporting a partial project as a whole one.
 */
const SCAN_BUDGET = 2000;

/** Lines either side of `around` when a caller gives a line instead of a range. */
const DEFAULT_CONTEXT_LINES = 20;

/**
 * Every source file under `root`, one visit each.
 *
 * The single definition of what these tools consider part of the project:
 * recognised source extensions only, no dotfiles, none of SCAN_IGNORED, and
 * symlinks are not followed in either direction. Both the provenance scan and
 * the file listing go through here so the two can never disagree about what
 * is in scope — a listing that showed a file the scanner would not read would
 * be worse than no listing at all.
 *
 * `visit` receives one file at a time and its result is discarded, so a caller
 * that reads contents holds one file's text rather than the whole project's.
 */
async function walkSourceFiles(
  root: string,
  dir: string,
  budget: { remaining: number },
  visit: (relativePath: string, absolutePath: string) => Promise<void>
): Promise<void> {
  if (budget.remaining <= 0) {
    return;
  }

  let entries;

  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    if (budget.remaining <= 0) {
      return;
    }
    if (entry.name.startsWith(".") || SCAN_IGNORED.has(entry.name)) {
      continue;
    }

    const full = path.join(dir, entry.name);

    // Symlinks are not followed, in either direction.
    //
    // Directories were already excluded by accident rather than by intent:
    // readdir's Dirent reflects lstat, so isDirectory() is false for a link
    // to a directory and the recursion below never saw one. Files had no
    // such accident — a link named `foo.ts` passes isSourceFile and
    // fs.readFile follows it, so a target outside the project root would be
    // scanned and reported under an in-root relative path.
    //
    // Nothing here reads a file's contents back to the caller; a site
    // carries a path, a line, a function name and argument names. But this
    // is the one place in the package that touches the filesystem directly
    // instead of going through the dev server, which resolves symlinks and
    // re-checks containment before it answers. Skipping links is what keeps
    // the two paths saying the same thing about what is in scope.
    if (entry.isSymbolicLink()) {
      continue;
    }

    if (entry.isDirectory()) {
      await walkSourceFiles(root, full, budget, visit);
      continue;
    }
    if (!isSourceFile(entry.name)) {
      continue;
    }

    budget.remaining--;

    try {
      const relative = path.relative(root, full).split(path.sep).join("/");

      await visit(relative, full);
    } catch {
      // unreadable file, skip
    }
  }
}

/**
 * Walks the project and accumulates provenance sites.
 *
 * Each file is scanned and released rather than collected first and scanned
 * afterwards, so peak memory tracks what was found rather than what was
 * searched.
 */
async function collectSites(
  root: string,
  out: ProvenanceSite[],
  budget: { remaining: number }
): Promise<void> {
  await walkSourceFiles(root, root, budget, async (relative, full) => {
    for (const site of scanFile(relative, await fs.readFile(full, "utf8"))) {
      out.push(site);
    }
  });
}

/**
 * Reads a source file, optionally a line range.
 *
 * Goes through the dev server rather than the filesystem so the same
 * allowlist and traversal guard apply as for the panel. An agent must not
 * have a wider reach than the UI it is standing in for.
 */
export async function getSource(
  context: ToolContext,
  input: {
    file: string;
    startLine?: number;
    endLine?: number;
    around?: number;
    contextLines?: number;
  }
): Promise<{ file: string; content: string; startLine: number; endLine: number }> {
  const content = await readSourceFile(context, input.file);
  const lines = content.split("\n");

  // A caller arriving from list_provenance or a bridge resolve holds a line,
  // not a range, and turning one into the other is arithmetic it should not
  // have to do. `around` takes the line; explicit bounds still win when both
  // are given, so a caller that did compute a range gets exactly that range.
  const centred =
    input.around === undefined
      ? null
      : {
          start: input.around - (input.contextLines ?? DEFAULT_CONTEXT_LINES),
          end: input.around + (input.contextLines ?? DEFAULT_CONTEXT_LINES),
        };

  const start = Math.max(1, input.startLine ?? centred?.start ?? 1);
  const end = Math.min(lines.length, input.endLine ?? centred?.end ?? lines.length);

  if (start > lines.length) {
    return { file: input.file, content: "", startLine: start, endLine: start };
  }

  return {
    file: input.file,
    content: lines.slice(start - 1, end).join("\n"),
    startLine: start,
    endLine: end,
  };
}

/**
 * Rewrites one argument at a source location.
 *
 * Deliberately accepts any file and line rather than requiring a prior
 * resolve. The guard is real without one: the server parses the file and
 * refuses anything it cannot pin down — ARGUMENT_NOT_FOUND when the name is
 * not at that line, LOCATION_NOT_FOUND when the line holds no candidate,
 * AMBIGUOUS_LOCATION when it holds more than one — and the extension
 * allowlist bounds what can be touched at all. A wrong coordinate fails
 * loudly rather than editing the wrong literal.
 *
 * Requiring a prior resolve would also break the agent's actual discovery
 * path, which is list_provenance: a static scan produces coordinates that
 * were never resolved through a click.
 */
export async function editParameterTool(
  context: ToolContext,
  input: { file: string; line: number; argName: string; newValue: unknown }
): Promise<{ file: string; line: number; argName: string; newValue: unknown }> {
  await editParameter(context, input);

  return input;
}

async function loadSites(context: ToolContext): Promise<ProvenanceSite[]> {
  const sites: ProvenanceSite[] = [];
  await collectSites(context.root, sites, { remaining: SCAN_BUDGET });

  return sites;
}

/**
 * The source files the scanning tools can see, by name.
 *
 * Deliberately not a file browser. It answers one question — what is there to
 * ask about — for a caller that has no way to guess a filename, and it answers
 * it with exactly the set walkSourceFiles would scan: recognised source
 * extensions under the project root, no dotfiles, nothing under node_modules,
 * dist, build, .git, .vite or coverage, and no symlink targets. Anything
 * outside that is invisible here whether or not it exists, which is why the
 * result names the root it walked and says when it stopped early.
 *
 * Reads no file contents. Names come from directory entries, so this is
 * strictly narrower than list_provenance, which already opens each of these
 * files to scan it.
 */
export async function listFiles(
  context: ToolContext
): Promise<{ files: string[]; scannedFrom: string; truncated: boolean }> {
  const files: string[] = [];
  const budget = { remaining: SCAN_BUDGET };

  await walkSourceFiles(context.root, context.root, budget, async (relative) => {
    files.push(relative);
  });

  return {
    files: files.sort(),
    scannedFrom: context.root,
    // The budget is spent, so the walk may have stopped with files unvisited.
    // Reported rather than hidden: a caller that treats a truncated listing as
    // the whole project will conclude a file does not exist when it does.
    truncated: budget.remaining <= 0,
  };
}

/**
 * Lists every declared provenance site in the project.
 *
 * Reports what the source says, not what is currently on screen. The
 * distinction matters: an object only exists after a mount, and nothing here
 * can see the running scene.
 */
export async function listProvenance(
  context: ToolContext,
  input: { file?: string } = {}
): Promise<{ sites: ProvenanceSite[]; scannedFrom: string }> {
  const sites = await loadSites(context);

  return {
    sites: input.file
      ? sites.filter((site) => site.file === input.file)
      : sites,
    scannedFrom: context.root,
  };
}

/**
 * Finds provenance sites by the function that generates them.
 *
 * The source-side half of the originally-scoped search_by_generator. It
 * cannot answer "which live objects did this generator produce" — that needs
 * the running scene — only "where does this generator declare provenance".
 */
export async function searchByGenerator(
  context: ToolContext,
  input: { function?: string; argName?: string }
): Promise<{ sites: ProvenanceSite[]; matched: number }> {
  let sites = await loadSites(context);

  if (input.function) {
    const needle = input.function.toLowerCase();
    sites = sites.filter((site) =>
      (site.function ?? "").toLowerCase().includes(needle)
    );
  }

  if (input.argName) {
    sites = sites.filter((site) => site.args.includes(input.argName!));
  }

  return { sites, matched: sites.length };
}

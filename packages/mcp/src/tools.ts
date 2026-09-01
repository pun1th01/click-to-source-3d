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
 * Walks the project and accumulates provenance sites.
 *
 * Each file is scanned and released rather than collected first and scanned
 * afterwards. The budget bounds how many files are read either way; what
 * changed is that only one file's text is held at a time, instead of up to
 * two thousand of them at once. Sites are far smaller than the sources they
 * come from, so peak memory now tracks what was found rather than what was
 * searched.
 */
async function collectSites(
  root: string,
  dir: string,
  out: ProvenanceSite[],
  budget: { remaining: number }
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
      await collectSites(root, full, out, budget);
      continue;
    }
    if (!isSourceFile(entry.name)) {
      continue;
    }

    budget.remaining--;

    try {
      const relative = path.relative(root, full).split(path.sep).join("/");

      for (const site of scanFile(relative, await fs.readFile(full, "utf8"))) {
        out.push(site);
      }
    } catch {
      // unreadable file, skip
    }
  }
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
  input: { file: string; startLine?: number; endLine?: number }
): Promise<{ file: string; content: string; startLine: number; endLine: number }> {
  const content = await readSourceFile(context, input.file);
  const lines = content.split("\n");

  const start = Math.max(1, input.startLine ?? 1);
  const end = Math.min(lines.length, input.endLine ?? lines.length);

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
  await collectSites(context.root, context.root, sites, { remaining: 2000 });

  return sites;
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

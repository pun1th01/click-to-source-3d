import fs from "node:fs/promises";
import path from "node:path";
import {
  editParameter,
  readSourceFile,
  type DevServerOptions,
} from "./devServer.js";
import {
  isSourceFile,
  scanProvenance,
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

async function collectSourceFiles(
  root: string,
  dir: string,
  out: Array<{ path: string; text: string }>,
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

    if (entry.isDirectory()) {
      await collectSourceFiles(root, full, out, budget);
      continue;
    }
    if (!isSourceFile(entry.name)) {
      continue;
    }

    budget.remaining--;

    try {
      out.push({
        path: path.relative(root, full).split(path.sep).join("/"),
        text: await fs.readFile(full, "utf8"),
      });
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
  const files: Array<{ path: string; text: string }> = [];
  await collectSourceFiles(context.root, context.root, files, {
    remaining: 2000,
  });

  return scanProvenance(files);
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

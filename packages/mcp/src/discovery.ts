import { readdirSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DEV_SERVER_REGISTRY, type DevServerEntry } from "@click-to-source-3d/shared";

function isAlive(pid: number): boolean {
  try {
    // Signal 0 checks for the process without touching it.
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: it exists, it is just not ours to signal.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function isWithin(child: string, parent: string): boolean {
  const relative = path.relative(parent, child);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

/**
 * The running dev server for the project at `cwd`, from the announcements
 * the Vite plugin writes when it starts.
 *
 * An AI assistant starts this server from the project it is working in, so
 * `cwd` is that project. Preference, in order: a dev server rooted exactly
 * there; one rooted inside it — an app within a monorepo — the nearest
 * first; one rooted above it; then the most recently started of any. Ties go
 * to the most recent, which is usually the one the developer is looking at.
 *
 * An announcement whose process has died — a dev server killed rather than
 * stopped — is removed rather than returned.
 */
export function findDevServer(
  cwd: string,
  directory = path.join(os.tmpdir(), DEV_SERVER_REGISTRY)
): DevServerEntry | null {
  let files: string[];
  try {
    files = readdirSync(directory).filter((name) => name.endsWith(".json"));
  } catch {
    return null;
  }

  const live: DevServerEntry[] = [];
  for (const name of files) {
    const file = path.join(directory, name);
    try {
      const entry = JSON.parse(readFileSync(file, "utf8")) as DevServerEntry;
      if (typeof entry.origin !== "string" || typeof entry.root !== "string") {
        continue;
      }
      if (!isAlive(entry.pid)) {
        rmSync(file, { force: true });
        continue;
      }
      live.push(entry);
    } catch {
      // Unreadable or half-written; skip it.
    }
  }

  const here = path.resolve(cwd);
  const rank = (entry: DevServerEntry): number => {
    const root = path.resolve(entry.root);
    if (root === here) {
      return 0;
    }
    if (isWithin(root, here)) {
      return 1 + path.relative(here, root).split(path.sep).length;
    }
    if (isWithin(here, root)) {
      return 100 + path.relative(root, here).split(path.sep).length;
    }
    return 1000;
  };

  live.sort((a, b) => rank(a) - rank(b) || b.startedAt - a.startedAt);
  return live[0] ?? null;
}

/**
 * A warning when this server and the plugin are not the same version.
 *
 * The two share a protocol and are released together, but they are installed
 * separately, so updating one is easy. The symptoms otherwise are strange: an
 * older plugin answers a new tool with an error about undefined, and an older
 * server is simply not shown as connected.
 */
export function versionMismatch(plugin: string | undefined, server: string): string | null {
  if (!plugin || plugin === server) {
    return null;
  }
  return (
    `The Vite plugin is version ${plugin} and this MCP server is version ${server}. ` +
    "They need to match, or some tools will not work. Ask the developer to update " +
    "@click-to-source-3d/vite-plugin and @click-to-source-3d/mcp together."
  );
}

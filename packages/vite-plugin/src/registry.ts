import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DEV_SERVER_REGISTRY, type DevServerEntry } from "@click-to-source-3d/shared";

/**
 * Announces a listening dev server where the MCP server looks for one.
 *
 * Returns the function that withdraws it. Withdrawal also runs on process
 * exit, since a dev server is usually stopped with Ctrl+C rather than closed;
 * a file left behind by a crash is recognised as stale by its dead pid and
 * cleared by whoever reads it.
 */
export function announceDevServer(
  entry: Omit<DevServerEntry, "pid" | "startedAt">,
  directory = path.join(os.tmpdir(), DEV_SERVER_REGISTRY)
): () => void {
  const port = new URL(entry.origin).port || "80";
  const file = path.join(directory, `${process.pid}-${port}.json`);
  const full: DevServerEntry = { ...entry, pid: process.pid, startedAt: Date.now() };

  try {
    mkdirSync(directory, { recursive: true });
    writeFileSync(file, JSON.stringify(full, null, 2));
  } catch {
    // Not fatal: the MCP server can still be pointed at the dev server with
    // CTS_DEV_SERVER.
    return () => undefined;
  }

  let withdrawn = false;
  const withdraw = () => {
    if (withdrawn) {
      return;
    }
    withdrawn = true;
    process.off("exit", withdraw);
    try {
      rmSync(file, { force: true });
    } catch {
      // already gone
    }
  };

  process.on("exit", withdraw);
  return withdraw;
}

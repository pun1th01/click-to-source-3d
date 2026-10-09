import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { afterEach, describe, expect, it } from "vitest";
import { DEV_SERVER_REGISTRY } from "@click-to-source-3d/shared";
import { announceDevServer } from "../src/registry.js";
import { clickToSource } from "../src/plugin.js";

const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

describe("announceDevServer", () => {
  let directory: string;

  afterEach(() => {
    rmSync(directory, { recursive: true, force: true });
  });

  it("writes an entry the MCP server can read, and withdraws it", () => {
    directory = mkdtempSync(path.join(os.tmpdir(), "cts-announce-"));
    const withdraw = announceDevServer(
      { origin: "http://localhost:5173", root: "/project", version: "0.1.5" },
      directory
    );
    const file = path.join(directory, `${process.pid}-5173.json`);

    expect(JSON.parse(readFileSync(file, "utf8"))).toMatchObject({
      origin: "http://localhost:5173",
      root: "/project",
      pid: process.pid,
      version: "0.1.5",
    });

    withdraw();
    expect(existsSync(file)).toBe(false);
  });
});

describe("a listening dev server", () => {
  it("announces itself while it listens, and not after it closes", async () => {
    const registry = path.join(os.tmpdir(), DEV_SERVER_REGISTRY);
    const server = await createServer({
      appType: "custom",
      configFile: false,
      logLevel: "silent",
      root: pluginRoot,
      plugins: [clickToSource()],
      server: { host: "127.0.0.1", port: 0, strictPort: true },
    });
    await server.listen();
    const port = (server.httpServer!.address() as { port: number }).port;
    const file = path.join(registry, `${process.pid}-${port}.json`);

    expect(readdirSync(registry)).toContain(path.basename(file));
    const entry = JSON.parse(readFileSync(file, "utf8")) as { origin: string; root: string };
    expect(entry.origin).toBe(`http://127.0.0.1:${port}`);
    // Vite's root uses forward slashes on every platform.
    expect(path.resolve(entry.root)).toBe(pluginRoot);

    await server.close();
    expect(existsSync(file)).toBe(false);
  });
});

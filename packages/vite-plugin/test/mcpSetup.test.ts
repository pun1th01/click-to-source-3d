import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createServer, type ViteDevServer } from "vite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MCP_SETUP_PATH } from "@click-to-source-3d/shared";
import { mcpSetupStatus, turnOnMcp, workspaceRootOf } from "../src/mcpSetup.js";
import { clickToSource } from "../src/plugin.js";

/**
 * The Agent tab's "Turn on MCP server" button, which registers the server where an
 * assistant reads its config: what `npx click-to-source-3d init --mcp` does to it.
 */

let repo: string;
let app: string;

beforeEach(() => {
  repo = mkdtempSync(path.join(os.tmpdir(), "cts-mcp-"));
  mkdirSync(path.join(repo, ".git"));
  app = path.join(repo, "apps", "scene");
  mkdirSync(app, { recursive: true });
});

afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
});

const json = (file: string) => JSON.parse(readFileSync(path.join(repo, file), "utf8"));

describe("turning on the MCP server", () => {
  it("writes .mcp.json at the repository's root, where the assistant starts", () => {
    const status = turnOnMcp(app, "linux");

    expect(json(".mcp.json")).toEqual({
      mcpServers: { "click-to-source": { command: "npx", args: ["-y", "@click-to-source-3d/mcp"] } },
    });
    expect(status).toMatchObject({ folder: path.basename(repo), registered: [".mcp.json"], written: [".mcp.json"], problems: [] });
    expect(existsSync(path.join(app, ".mcp.json"))).toBe(false);
  });

  it("starts it through cmd on Windows, where MCP clients use no shell", () => {
    turnOnMcp(app, "win32");

    expect(json(".mcp.json").mcpServers["click-to-source"]).toEqual({
      command: "cmd",
      args: ["/c", "npx", "-y", "@click-to-source-3d/mcp"],
    });
  });

  it("writes Cursor's and VS Code's files where those are in use", () => {
    mkdirSync(path.join(repo, ".cursor"));
    mkdirSync(path.join(repo, ".vscode"));

    const status = turnOnMcp(app, "linux");

    expect(json(".cursor/mcp.json").mcpServers["click-to-source"]).toBeDefined();
    expect(json(".vscode/mcp.json").servers["click-to-source"]).toEqual({
      type: "stdio",
      command: "npx",
      args: ["-y", "@click-to-source-3d/mcp"],
    });
    expect(status.registered).toEqual([".mcp.json", ".cursor/mcp.json", ".vscode/mcp.json"]);
  });

  it("keeps what is already in a file", () => {
    writeFileSync(path.join(repo, ".mcp.json"), JSON.stringify({ mcpServers: { other: { command: "x" } }, extra: 1 }));

    turnOnMcp(app, "linux");

    expect(Object.keys(json(".mcp.json").mcpServers)).toEqual(["other", "click-to-source"]);
    expect(json(".mcp.json").extra).toBe(1);
  });

  it("leaves an entry someone changed as it is, and writes nothing a second time", () => {
    const changed = JSON.stringify({ mcpServers: { "click-to-source": { command: "node", args: ["mine.js"] } } });
    writeFileSync(path.join(repo, ".mcp.json"), changed);

    const status = turnOnMcp(app, "linux");

    expect(readFileSync(path.join(repo, ".mcp.json"), "utf8")).toBe(changed);
    expect(status).toMatchObject({ registered: [".mcp.json"], written: [] });
  });

  // VS Code's own file often has comments, which a rewrite would lose.
  it("never rewrites a file it can't read, and says which and why", () => {
    mkdirSync(path.join(repo, ".vscode"));
    const commented = '{\n  // my servers\n  "servers": {}\n}\n';
    writeFileSync(path.join(repo, ".vscode/mcp.json"), commented);

    const status = turnOnMcp(app, "linux");

    expect(readFileSync(path.join(repo, ".vscode/mcp.json"), "utf8")).toBe(commented);
    expect(status.written).toEqual([".mcp.json"]);
    expect(status.problems).toEqual([{ file: ".vscode/mcp.json", reason: expect.any(String) }]);
  });

  it("refuses a file whose list of servers isn't one", () => {
    writeFileSync(path.join(repo, ".mcp.json"), JSON.stringify({ mcpServers: [] }));

    const status = turnOnMcp(app, "linux");

    expect(status.problems[0]).toMatchObject({ file: ".mcp.json" });
    expect(json(".mcp.json")).toEqual({ mcpServers: [] });
  });

  it("uses the app's own folder when it isn't in a repository", () => {
    const loose = mkdtempSync(path.join(os.tmpdir(), "cts-mcp-loose-"));
    try {
      expect(workspaceRootOf(loose)).toBe(path.resolve(loose));
    } finally {
      rmSync(loose, { recursive: true, force: true });
    }
  });
});

describe("whether it is on", () => {
  it("says it isn't, before anything is written", () => {
    expect(mcpSetupStatus(app)).toEqual({
      folder: path.basename(repo),
      registered: [],
      written: [],
      problems: [],
      assistant: null,
    });
  });

  it("says where it is, once it is", () => {
    turnOnMcp(app, "linux");

    expect(mcpSetupStatus(app).registered).toEqual([".mcp.json"]);
  });

  it("names the assistant the project is set up for", () => {
    mkdirSync(path.join(repo, ".claude"));

    expect(mcpSetupStatus(app).assistant).toBe("Claude Code");
  });

  // A path would put the developer's home directory in every screenshot of the panel.
  it("names the folder, not its path", () => {
    expect(mcpSetupStatus(app).folder).not.toContain(path.sep);
  });
});

describe("the endpoint", () => {
  let server: ViteDevServer | undefined;

  const serve = async (options = {}) => {
    server = await createServer({
      appType: "custom",
      configFile: false,
      logLevel: "silent",
      root: app,
      plugins: [clickToSource(options)],
      server: { host: "127.0.0.1", port: 0, strictPort: true },
    });
    await server.listen();
    const { port } = server.httpServer!.address() as { port: number };
    return (init: RequestInit = {}) => fetch(`http://127.0.0.1:${port}${MCP_SETUP_PATH}`, init);
  };

  afterEach(async () => {
    await server?.close();
    server = undefined;
  });

  it("says whether it is on, and turns it on", async () => {
    const call = await serve();

    expect((await (await call()).json()).registered).toEqual([]);
    const turned = await call({ method: "POST" });
    expect(turned.status).toBe(200);
    expect((await turned.json()).written).toEqual([".mcp.json"]);
    expect(existsSync(path.join(repo, ".mcp.json"))).toBe(true);
  });

  // It writes files, so a page on another site must not be able to make it.
  it("refuses another site, writing nothing", async () => {
    const call = await serve();

    const refused = await call({ method: "POST", headers: { Origin: "http://evil.example" } });

    expect(refused.status).toBe(403);
    expect(existsSync(path.join(repo, ".mcp.json"))).toBe(false);
  });

  it("refuses anything but asking and turning on", async () => {
    const call = await serve();

    const response = await call({ method: "DELETE" });
    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("GET, POST");
  });

  it("does nothing with the bridge off, as no assistant could see the page", async () => {
    const call = await serve({ bridge: false });

    expect((await call({ method: "POST" })).status).toBe(404);
    expect(existsSync(path.join(repo, ".mcp.json"))).toBe(false);
  });
});

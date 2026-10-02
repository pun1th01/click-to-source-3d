import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createServer, type ViteDevServer } from "vite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { READ_FILE_PATH, WRITE_FILE_PATH } from "@click-to-source-3d/shared";
import { clickToSource } from "../src/plugin.js";

const pluginRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  ".."
);

let server: ViteDevServer;
let baseUrl: string;
let fixtureDirectory: string;

async function postJson(endpoint: string, body: unknown) {
  const response = await fetch(`${baseUrl}${endpoint}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  return {
    status: response.status,
    body: (await response.json()) as Record<string, unknown>,
  };
}

describe("Step 6 Vite file I/O plugin", () => {
  beforeAll(async () => {
    fixtureDirectory = await fs.mkdtemp(
      path.join(pluginRoot, ".cts-plugin-fixture-")
    );

    server = await createServer({
      appType: "custom",
      configFile: false,
      logLevel: "silent",
      root: pluginRoot,
      plugins: [clickToSource()],
      server: {
        host: "127.0.0.1",
        port: 0,
        strictPort: true,
        // The root alone; the workspace boundary is covered below.
        fs: { allow: [pluginRoot] },
      },
    });

    await server.listen();

    const address = server.httpServer?.address();

    if (!address || typeof address === "string") {
      throw new Error("Vite test server did not expose a TCP address");
    }

    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterAll(async () => {
    await server?.close();
    await fs.rm(fixtureDirectory, { force: true, recursive: true });
  });

  it("reads an existing project file", async () => {
    const expectedContent = await fs.readFile(
      path.join(pluginRoot, "src", "index.ts"),
      "utf8"
    );
    const result = await postJson(READ_FILE_PATH, {
      file: "src/index.ts",
    });

    expect(result.status).toBe(200);
    expect(result.body).toEqual({ content: expectedContent });
  });

  // The endpoint used to write `content` verbatim: a whole-file overwrite of
  // any allowed source file under the root, which no client ever sent.
  it("refuses a whole-file write and leaves the file untouched", async () => {
    const original = "const value = 1;\n";
    const fixtureFile = path.relative(
      pluginRoot,
      path.join(fixtureDirectory, "fixture.tsx")
    );
    await fs.writeFile(path.join(pluginRoot, fixtureFile), original, "utf8");

    const writeResult = await postJson(WRITE_FILE_PATH, {
      file: fixtureFile,
      content: "clobbered\n",
    });

    expect(writeResult.status).toBe(400);
    expect(writeResult.body).toEqual({ error: "Invalid request body" });
    expect(await fs.readFile(path.join(pluginRoot, fixtureFile), "utf8")).toBe(
      original
    );
  });

  it("edits only the selected literal through the Step 7 pipeline", async () => {
    const content = `const pink = <mesh color="hotpink" />;
const cyan = <mesh color="cyan" />;
`;
    const fixtureFile = path.relative(
      pluginRoot,
      path.join(fixtureDirectory, "step8-fixture.tsx")
    );

    await fs.writeFile(path.join(pluginRoot, fixtureFile), content, "utf8");

    const writeResult = await postJson(WRITE_FILE_PATH, {
      file: fixtureFile,
      line: 1,
      argName: "color",
      newValue: "rebeccapurple",
    });

    expect(writeResult.status).toBe(200);
    expect(writeResult.body).toEqual({ success: true });
    expect(await fs.readFile(path.join(pluginRoot, fixtureFile), "utf8")).toBe(
      `const pink = <mesh color="rebeccapurple" />;
const cyan = <mesh color="cyan" />;
`
    );
  });

  // A 0.1.3 overlay still sends the contents it read. The edit must apply to
  // the file as it is now, or a save made in between is silently undone.
  it("applies an edit to the file on disk, ignoring any content sent with it", async () => {
    const fixtureFile = path.relative(
      pluginRoot,
      path.join(fixtureDirectory, "stale-fixture.tsx")
    );
    await fs.writeFile(
      path.join(pluginRoot, fixtureFile),
      `const pink = <mesh color="hotpink" />;\n// saved in the editor after the panel read the file\n`,
      "utf8"
    );

    const writeResult = await postJson(WRITE_FILE_PATH, {
      file: fixtureFile,
      content: `const pink = <mesh color="hotpink" />;\n`,
      line: 1,
      argName: "color",
      newValue: "cyan",
    });

    expect(writeResult.status).toBe(200);
    expect(await fs.readFile(path.join(pluginRoot, fixtureFile), "utf8")).toBe(
      `const pink = <mesh color="cyan" />;\n// saved in the editor after the panel read the file\n`
    );
  });

  it("rejects invalid bodies, missing files, and paths outside the Vite root", async () => {
    const invalidBody = await postJson(READ_FILE_PATH, {});
    const missingFile = await postJson(READ_FILE_PATH, {
      file: "src/does-not-exist.ts",
    });
    const traversal = await postJson(READ_FILE_PATH, {
      file: "..\\..\\package.json",
    });
    const absolutePath = await postJson(READ_FILE_PATH, {
      file: path.join(pluginRoot, "src", "index.ts"),
    });

    expect(invalidBody.status).toBe(400);
    expect(invalidBody.body).toEqual({ error: "Invalid request body" });
    expect(missingFile.status).toBe(404);
    expect(missingFile.body).toEqual({ error: "File not found" });
    expect(traversal.status).toBe(400);
    expect(traversal.body).toEqual({ error: "Invalid file path" });
    expect(absolutePath.status).toBe(400);
    expect(absolutePath.body).toEqual({ error: "Invalid file path" });
  });
});

/**
 * A component in a sibling workspace package is stamped relative to the app's
 * root — `../../packages/ui/src/Rock.tsx` — and with the root as the only
 * boundary, every such file was refused: the panel named it and could not
 * edit it. The boundary is now Vite's own `server.fs.allow`, which by default
 * is the workspace root: exactly what Vite already serves source from.
 */
describe("a monorepo workspace", () => {
  let workspace: string;
  let workspaceServer: ViteDevServer;
  let workspaceUrl: string;

  const rockFile = "../../packages/ui/src/Rock.tsx";

  async function post(endpoint: string, body: unknown) {
    const response = await fetch(`${workspaceUrl}${endpoint}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    return {
      status: response.status,
      body: (await response.json()) as Record<string, unknown>,
    };
  }

  beforeAll(async () => {
    // realpath: on Windows, os.tmpdir() can be an 8.3 short path.
    workspace = await fs.mkdtemp(
      path.join(await fs.realpath(os.tmpdir()), "cts-workspace-")
    );
    await fs.writeFile(
      path.join(workspace, "package.json"),
      JSON.stringify({ private: true, workspaces: ["apps/*", "packages/*"] })
    );
    await fs.mkdir(path.join(workspace, "apps", "web"), { recursive: true });
    await fs.mkdir(path.join(workspace, "packages", "ui", "src"), {
      recursive: true,
    });
    await fs.writeFile(
      path.join(workspace, "packages", "ui", "src", "Rock.tsx"),
      "export const Rock = () => <mesh scale={1} />;\n"
    );

    workspaceServer = await createServer({
      appType: "custom",
      configFile: false,
      logLevel: "silent",
      root: path.join(workspace, "apps", "web"),
      plugins: [clickToSource()],
      server: { host: "127.0.0.1", port: 0, strictPort: true },
    });
    await workspaceServer.listen();

    const address = workspaceServer.httpServer?.address();

    if (!address || typeof address === "string") {
      throw new Error("Vite test server did not expose a TCP address");
    }

    workspaceUrl = `http://127.0.0.1:${address.port}`;
  });

  afterAll(async () => {
    await workspaceServer?.close();
    await fs.rm(workspace, { force: true, recursive: true });
  });

  it("reads and edits a file in a sibling workspace package", async () => {
    const read = await post(READ_FILE_PATH, { file: rockFile });

    expect(read.status).toBe(200);
    expect(read.body.content).toContain("scale={1}");

    const write = await post(WRITE_FILE_PATH, {
      file: rockFile,
      line: 1,
      argName: "scale",
      newValue: 3,
    });

    expect(write.status).toBe(200);
    expect(
      await fs.readFile(
        path.join(workspace, "packages", "ui", "src", "Rock.tsx"),
        "utf8"
      )
    ).toBe("export const Rock = () => <mesh scale={3} />;\n");
  });

  it("still refuses a path that leaves the workspace", async () => {
    const outside = await post(READ_FILE_PATH, { file: "../../../outside.ts" });

    expect(outside.status).toBe(400);
    expect(outside.body).toEqual({ error: "Invalid file path" });
  });
});

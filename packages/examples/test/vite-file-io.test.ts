import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createServer, type ViteDevServer } from "vite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fileIoPlugin } from "../vite-file-io";

const examplesRoot = path.resolve(
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
      path.join(examplesRoot, ".cts-step6-fixture-")
    );

    server = await createServer({
      appType: "custom",
      configFile: false,
      logLevel: "silent",
      root: examplesRoot,
      plugins: [fileIoPlugin()],
      server: {
        host: "127.0.0.1",
        port: 0,
        strictPort: true,
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
      path.join(examplesRoot, "src", "main.tsx"),
      "utf8"
    );
    const result = await postJson("/__cts/read-file", {
      file: "src/main.tsx",
    });

    expect(result.status).toBe(200);
    expect(result.body).toEqual({ content: expectedContent });
  });

  it("writes and reads back a fixture without changing its content", async () => {
    const content = "const value = 1;\r\n// preserve this line exactly\n✓\n";
    const fixtureFile = path.relative(
      examplesRoot,
      path.join(fixtureDirectory, "fixture.tsx")
    );

    const writeResult = await postJson("/__cts/write-file", {
      file: fixtureFile,
      content,
    });
    const readResult = await postJson("/__cts/read-file", {
      file: fixtureFile,
    });

    expect(writeResult.status).toBe(200);
    expect(writeResult.body).toEqual({ success: true });
    expect(readResult.status).toBe(200);
    expect(readResult.body).toEqual({ content });
    expect(await fs.readFile(path.join(examplesRoot, fixtureFile), "utf8")).toBe(
      content
    );
  });

  it("edits only the selected literal through the Step 7 pipeline", async () => {
    const content = `const pink = <mesh color="hotpink" />;
const cyan = <mesh color="cyan" />;
`;
    const fixtureFile = path.relative(
      examplesRoot,
      path.join(fixtureDirectory, "step8-fixture.tsx")
    );

    await fs.writeFile(path.join(examplesRoot, fixtureFile), content, "utf8");

    const readResult = await postJson("/__cts/read-file", {
      file: fixtureFile,
    });
    const writeResult = await postJson("/__cts/write-file", {
      file: fixtureFile,
      content: readResult.body.content,
      line: 1,
      argName: "color",
      newValue: "rebeccapurple",
    });

    expect(readResult.status).toBe(200);
    expect(writeResult.status).toBe(200);
    expect(writeResult.body).toEqual({ success: true });
    expect(await fs.readFile(path.join(examplesRoot, fixtureFile), "utf8")).toBe(
      `const pink = <mesh color="rebeccapurple" />;
const cyan = <mesh color="cyan" />;
`
    );
  });

  it("rejects invalid bodies, missing files, and paths outside the Vite root", async () => {
    const invalidBody = await postJson("/__cts/read-file", {});
    const missingFile = await postJson("/__cts/read-file", {
      file: "src/does-not-exist.tsx",
    });
    const traversal = await postJson("/__cts/read-file", {
      file: "..\\..\\package.json",
    });
    const absolutePath = await postJson("/__cts/read-file", {
      file: path.join(examplesRoot, "src", "main.tsx"),
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

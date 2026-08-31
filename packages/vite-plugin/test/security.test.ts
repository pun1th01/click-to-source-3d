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
let host: string;

async function post(
  endpoint: string,
  body: unknown,
  headers: Record<string, string> = {}
) {
  const response = await fetch(`${baseUrl}${endpoint}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });

  return {
    status: response.status,
    body: (await response.json()) as Record<string, unknown>,
  };
}

beforeAll(async () => {
  server = await createServer({
    appType: "custom",
    configFile: false,
    logLevel: "silent",
    root: pluginRoot,
    plugins: [clickToSource()],
    server: { host: "127.0.0.1", port: 0, strictPort: true },
  });

  await server.listen();

  const address = server.httpServer?.address();

  if (!address || typeof address === "string") {
    throw new Error("Vite test server did not expose a TCP address");
  }

  host = `127.0.0.1:${address.port}`;
  baseUrl = `http://${host}`;
});

afterAll(async () => {
  await server?.close();
});

describe("extension allowlist", () => {
  it("allows a source file with a recognised extension", async () => {
    const result = await post(READ_FILE_PATH, { file: "src/index.ts" });

    expect(result.status).toBe(200);
    expect(typeof result.body.content).toBe("string");
  });

  // path.extname(".env") returns "" rather than ".env", so the dotfile fails
  // the extension test by accident of that return value. Pinning it here so
  // the behaviour cannot regress unnoticed if the check is ever rewritten.
  it("rejects .env, which path.extname reports as having no extension", async () => {
    expect(path.extname(".env")).toBe("");

    const result = await post(READ_FILE_PATH, { file: ".env" });

    expect(result.status).toBe(400);
    expect(result.body).toEqual({ error: "File type not editable" });
  });

  it("rejects .env.local, whose extension parses as .local", async () => {
    expect(path.extname(".env.local")).toBe(".local");

    const result = await post(READ_FILE_PATH, { file: ".env.local" });

    expect(result.status).toBe(400);
    expect(result.body).toEqual({ error: "File type not editable" });
  });

  it("rejects package.json", async () => {
    const result = await post(READ_FILE_PATH, { file: "package.json" });

    expect(result.status).toBe(400);
    expect(result.body).toEqual({ error: "File type not editable" });
  });

  // The gap the extname accident does not cover: dot-prefixed files that do
  // carry a recognised extension would otherwise pass the allowlist.
  it("rejects .babelrc.js even though path.extname reports .js", async () => {
    expect(path.extname(".babelrc.js")).toBe(".js");

    const result = await post(READ_FILE_PATH, { file: ".babelrc.js" });

    expect(result.status).toBe(400);
    expect(result.body).toEqual({ error: "File type not editable" });
  });

  it("rejects .hidden.ts even though path.extname reports .ts", async () => {
    expect(path.extname(".hidden.ts")).toBe(".ts");

    const result = await post(READ_FILE_PATH, { file: ".hidden.ts" });

    expect(result.status).toBe(400);
    expect(result.body).toEqual({ error: "File type not editable" });
  });

  it("rejects a dot-prefixed file in a subdirectory", async () => {
    const result = await post(READ_FILE_PATH, { file: "src/.secret.ts" });

    expect(result.status).toBe(400);
    expect(result.body).toEqual({ error: "File type not editable" });
  });

  it("rejects writes to a disallowed extension, not just reads", async () => {
    const result = await post(WRITE_FILE_PATH, {
      file: ".env",
      content: "STOLEN=1\n",
    });

    expect(result.status).toBe(400);
    expect(result.body).toEqual({ error: "File type not editable" });
  });

  it("reports a traversal attempt as a path failure, not a type failure", async () => {
    const result = await post(READ_FILE_PATH, { file: "../../package.json" });

    expect(result.status).toBe(400);
    expect(result.body).toEqual({ error: "Invalid file path" });
  });
});

describe("origin check", () => {
  it("allows a request with no Origin header, such as curl or this suite", async () => {
    const result = await post(READ_FILE_PATH, { file: "src/index.ts" });

    expect(result.status).toBe(200);
  });

  it("allows a same-origin request", async () => {
    const result = await post(
      READ_FILE_PATH,
      { file: "src/index.ts" },
      { Origin: `http://${host}` }
    );

    expect(result.status).toBe(200);
  });

  it("rejects a cross-origin request", async () => {
    const result = await post(
      READ_FILE_PATH,
      { file: "src/index.ts" },
      { Origin: "http://evil.example" }
    );

    expect(result.status).toBe(403);
    expect(result.body).toEqual({ error: "Cross-origin request rejected" });
  });

  it("rejects a cross-origin write before it can touch the filesystem", async () => {
    const result = await post(
      WRITE_FILE_PATH,
      { file: "src/index.ts", content: "clobbered" },
      { Origin: "http://evil.example" }
    );

    expect(result.status).toBe(403);
    expect(result.body).toEqual({ error: "Cross-origin request rejected" });
  });

  it("rejects on Sec-Fetch-Site: cross-site even without an Origin header", async () => {
    const result = await post(
      READ_FILE_PATH,
      { file: "src/index.ts" },
      { "Sec-Fetch-Site": "cross-site" }
    );

    expect(result.status).toBe(403);
    expect(result.body).toEqual({ error: "Cross-origin request rejected" });
  });
});

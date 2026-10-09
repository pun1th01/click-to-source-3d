import path from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import { createServer, type ViteDevServer } from "vite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { OPEN_IN_EDITOR_PATH } from "@click-to-source-3d/shared";
import { handleOpenRequest } from "../src/middleware.js";
import { clickToSource } from "../src/plugin.js";

/**
 * Driven through the handler with a stand-in launcher. A test that reached
 * the real one would open files in whatever editor the developer has running.
 */

const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function open(
  body: unknown,
  options: { method?: string; headers?: Record<string, string> } = {}
) {
  const opened: Array<[string, number, number]> = [];
  const request = Object.assign(new Readable({ read() {} }), {
    method: options.method ?? "POST",
    url: OPEN_IN_EDITOR_PATH,
    headers: { "content-type": "application/json", ...(options.headers ?? {}) },
    socket: { remoteAddress: "127.0.0.1" },
  }) as unknown as IncomingMessage;

  let raw = "";
  const response = {
    statusCode: 0,
    setHeader: () => undefined,
    end: (chunk?: string) => {
      raw = chunk ?? "";
    },
  } as unknown as ServerResponse;

  const pending = handleOpenRequest(
    request,
    response,
    pluginRoot,
    { allowedExtensions: [".ts"], allowedOrigins: ["http://localhost:5173"] },
    (file, line, column) => opened.push([file, line, column])
  );
  (request as unknown as Readable).push(JSON.stringify(body));
  (request as unknown as Readable).push(null);
  await pending;

  return {
    status: (response as unknown as { statusCode: number }).statusCode,
    body: raw ? (JSON.parse(raw) as Record<string, unknown>) : {},
    opened,
  };
}

describe("handleOpenRequest", () => {
  it("opens a file at the line and column asked for", async () => {
    const result = await open({ file: "src/plugin.ts", line: 12, column: 5 });

    expect(result.status).toBe(200);
    expect(result.opened).toEqual([[path.join(pluginRoot, "src", "plugin.ts"), 12, 5]]);
  });

  it("opens at the top when no position is given", async () => {
    const result = await open({ file: "src/plugin.ts" });

    expect(result.opened[0].slice(1)).toEqual([1, 1]);
  });

  it("refuses, without opening anything, what the read endpoint refuses", async () => {
    const cases: Array<[unknown, number, string]> = [
      [{ file: "../../package.json" }, 400, "Invalid file path"],
      [{ file: "package.json" }, 400, "File type not editable"],
      [{ file: "src/.hidden.ts" }, 400, "File type not editable"],
      [{ file: "src/missing.ts" }, 404, "File not found"],
      [{ file: "src/plugin.ts", line: 0 }, 400, "Invalid request body"],
      [{ file: "src/plugin.ts", column: "5" }, 400, "Invalid request body"],
    ];

    for (const [body, status, error] of cases) {
      const result = await open(body);
      expect(result.status, JSON.stringify(body)).toBe(status);
      expect(result.body.error).toBe(error);
      expect(result.opened).toEqual([]);
    }
  });

  it("applies the caller policy before anything else", async () => {
    const result = await open(
      { file: "src/plugin.ts" },
      { headers: { origin: "http://evil.example" } }
    );

    expect(result.status).toBe(403);
    expect(result.opened).toEqual([]);
  });

  it("accepts only POST", async () => {
    expect((await open({ file: "src/plugin.ts" }, { method: "GET" })).status).toBe(405);
  });
});

describe("the open endpoint on the dev server", () => {
  let server: ViteDevServer;
  let origin: string;

  beforeAll(async () => {
    server = await createServer({
      appType: "custom",
      configFile: false,
      logLevel: "silent",
      root: pluginRoot,
      plugins: [clickToSource()],
      server: { host: "127.0.0.1", port: 0, strictPort: true, fs: { allow: [pluginRoot] } },
    });
    await server.listen();
    origin = `http://127.0.0.1:${(server.httpServer!.address() as { port: number }).port}`;
  });

  afterAll(async () => {
    await server?.close();
  });

  // Routed and guarded. Only a refusal is exercised here, for the reason at
  // the top of the file.
  it("is served, and guarded like the other endpoints", async () => {
    const response = await fetch(`${origin}${OPEN_IN_EDITOR_PATH}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ file: "../../../outside.ts" }),
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "Invalid file path" });
  });
});

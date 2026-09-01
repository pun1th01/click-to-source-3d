import path from "node:path";
import { request as httpRequest } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import { createServer, type ViteDevServer } from "vite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  BRIDGE_QUERY_PATH,
  READ_FILE_PATH,
  WRITE_FILE_PATH,
} from "@click-to-source-3d/shared";
import { clickToSource } from "../src/plugin.js";
import { handleFileRequest } from "../src/middleware.js";

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

/**
 * Drives the shipped handler directly, with a chosen caller address and
 * headers.
 *
 * Not through a Vite server on purpose. Vite has its own allowedHosts check
 * that answers a forged Host before any plugin middleware runs, so a
 * through-Vite test would pass without exercising this package at all. The
 * middleware is also documented as reusable by other dev servers, which is
 * exactly the setting where it has to defend itself.
 */
async function callHandler(options: {
  remoteAddress?: string;
  headers?: Record<string, string>;
  allowedOrigins?: readonly string[];
}) {
  const payload = JSON.stringify({ file: "package.json" });
  const request = Object.assign(new Readable({ read() {} }), {
    method: "POST",
    url: READ_FILE_PATH,
    headers: { "content-type": "application/json", ...(options.headers ?? {}) },
    socket: { remoteAddress: options.remoteAddress ?? "127.0.0.1" },
  }) as unknown as IncomingMessage;

  let raw = "";
  const response = {
    statusCode: 0,
    setHeader: () => undefined,
    end: (body?: string) => {
      raw = body ?? "";
    },
  } as unknown as ServerResponse;

  const pending = handleFileRequest(request, response, pluginRoot, "read", {
    allowedExtensions: [".ts"],
    allowedOrigins: options.allowedOrigins ?? [],
  });
  (request as unknown as Readable).push(payload);
  (request as unknown as Readable).push(null);
  await pending;

  return {
    status: (response as unknown as { statusCode: number }).statusCode,
    body: raw ? (JSON.parse(raw) as Record<string, unknown>) : {},
  };
}

const callFrom = (remoteAddress: string | undefined) =>
  callHandler({ remoteAddress });

const SERVER_ORIGIN = "http://localhost:5173";

describe("origin check does not trust the request's own Host", () => {
  // Measured against the shipped 0.1.0 handler: 200, and the write completed.
  // The check compared Origin to request.headers.host, and a non-browser
  // client sets both, so it could always satisfy the comparison.
  it("rejects an Origin that a forged Host header would have vouched for", async () => {
    const result = await callHandler({
      headers: { origin: "http://evil.test", host: "evil.test" },
      allowedOrigins: [SERVER_ORIGIN],
    });

    expect(result.status).toBe(403);
    expect(result.body).toEqual({ error: "Cross-origin request rejected" });
  });

  // Same host and port, different scheme. Comparing only URL.host accepted it.
  it("rejects an origin differing from the server's only by scheme", async () => {
    const result = await callHandler({
      headers: { origin: "https://localhost:5173", host: "localhost:5173" },
      allowedOrigins: [SERVER_ORIGIN],
    });

    expect(result.status).toBe(403);
  });

  it("allows the server's own origin", async () => {
    const result = await callHandler({
      headers: { origin: SERVER_ORIGIN, host: "localhost:5173" },
      allowedOrigins: [SERVER_ORIGIN],
    });

    expect(result.status).not.toBe(403);
  });

  // Characterisation, not a fix: this already held in 0.1.0, pinned so it
  // cannot regress. "null" is a non-empty string, so it reaches the origin
  // comparison rather than the missing-Origin allowance.
  it("rejects a null Origin sent without Sec-Fetch-Site", async () => {
    const result = await callHandler({
      headers: { origin: "null", host: "localhost:5173" },
      allowedOrigins: [SERVER_ORIGIN],
    });

    expect(result.status).toBe(403);
  });
});

describe("callers beyond this machine", () => {
  // The endpoints allow requests with no Origin because a local non-browser
  // client could edit the files directly anyway. Under `vite --host` that
  // same request arrives from the network, where the reasoning does not hold.
  it("rejects a remote caller", async () => {
    const result = await callFrom("192.168.1.50");

    expect(result.status).toBe(403);
    expect(result.body).toEqual({ error: "Remote request rejected" });
  });

  it("allows an IPv4 loopback caller", async () => {
    expect((await callFrom("127.0.0.1")).status).not.toBe(403);
  });

  it("allows an IPv6 loopback caller", async () => {
    expect((await callFrom("::1")).status).not.toBe(403);
  });

  it("allows an IPv4-mapped IPv6 loopback caller", async () => {
    expect((await callFrom("::ffff:127.0.0.1")).status).not.toBe(403);
  });
});

/**
 * Drives the plugin's own middleware stack with a chosen caller.
 *
 * The bridge endpoints live in the plugin rather than in handleFileRequest,
 * so this goes through server.middlewares to exercise the wiring itself. That
 * wiring is what was missing: the guard existed and the bridge simply never
 * called it.
 */
function callBridge(options: {
  path: string;
  remoteAddress?: string;
  headers?: Record<string, string>;
}): Promise<{ status: number; body: string }> {
  return new Promise((resolve) => {
    const payload = JSON.stringify({
      query: { kind: "list_scene_provenance" },
    });

    const request = Object.assign(new Readable({ read() {} }), {
      method: "POST",
      url: options.path,
      headers: {
        "content-type": "application/json",
        host,
        ...(options.headers ?? {}),
      },
      socket: { remoteAddress: options.remoteAddress ?? "127.0.0.1" },
    }) as unknown as IncomingMessage;

    let raw = "";
    const response = {
      statusCode: 200,
      setHeader: () => undefined,
      getHeader: () => undefined,
      writeHead: () => response,
      write: () => true,
      end: (body?: string) => {
        raw += body ?? "";
        resolve({
          status: (response as unknown as { statusCode: number }).statusCode,
          body: raw,
        });
      },
    } as unknown as ServerResponse;

    server.middlewares(request as never, response as never, () =>
      resolve({ status: 0, body: "fell through to next()" })
    );

    (request as unknown as Readable).push(payload);
    (request as unknown as Readable).push(null);
  });
}

describe("bridge endpoints answer to the same caller policy", () => {
  // Measured against 0.1.1: this returned 200. The bridge paths were wired
  // straight to their handlers, so they inherited neither the origin check nor
  // the loopback guard that the file endpoints get.
  it("rejects a cross-origin bridge query", async () => {
    const result = await callBridge({
      path: BRIDGE_QUERY_PATH,
      headers: { origin: "http://evil.test" },
    });

    expect(result.status).toBe(403);
    expect(JSON.parse(result.body)).toEqual({
      error: "Cross-origin request rejected",
    });
  });

  it("rejects a bridge query from beyond this machine", async () => {
    const result = await callBridge({
      path: BRIDGE_QUERY_PATH,
      remoteAddress: "192.168.1.50",
    });

    expect(result.status).toBe(403);
    expect(JSON.parse(result.body)).toEqual({ error: "Remote request rejected" });
  });

  // The refusal comes before `bridging` is consulted, so a disallowed caller
  // cannot distinguish "bridge is off" from "you are not allowed to ask".
  it("does not reveal whether the bridge is enabled", async () => {
    const result = await callBridge({
      path: BRIDGE_QUERY_PATH,
      headers: { origin: "http://evil.test" },
    });

    expect(result.body).not.toContain("disabled");
    expect(result.body).not.toContain("bridge: true");
  });

  it("still serves a same-origin loopback caller", async () => {
    const result = await callBridge({
      path: BRIDGE_QUERY_PATH,
      headers: { origin: `http://${host}` },
    });

    expect(result.status).not.toBe(403);
  });
});

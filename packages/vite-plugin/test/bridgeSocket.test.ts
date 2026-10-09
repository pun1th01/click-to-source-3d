import path from "node:path";
import { fileURLToPath } from "node:url";
import { createServer, type ViteDevServer } from "vite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  BRIDGE_HELLO_EVENT,
  BRIDGE_QUERY_EVENT,
  BRIDGE_QUERY_PATH,
  BRIDGE_REPLY_EVENT,
} from "@click-to-source-3d/shared";
import { clickToSource } from "../src/plugin.js";

/**
 * The injected inspector's bridge, end to end: a real Vite dev server, a real
 * websocket speaking Vite's HMR protocol the way the page does, and a query
 * arriving over the HTTP endpoint the MCP server uses.
 */

const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

let server: ViteDevServer;
let origin: string;

beforeAll(async () => {
  server = await createServer({
    appType: "custom",
    configFile: false,
    logLevel: "silent",
    root: pluginRoot,
    plugins: [clickToSource({ bridge: true })],
    server: { host: "127.0.0.1", port: 0, strictPort: true },
  });
  await server.listen();
  const address = server.httpServer!.address() as { port: number };
  origin = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  await server?.close();
});

type Message = { type: string; event?: string; data?: unknown };

/** A page's end of the HMR socket. */
async function openPage(session: string) {
  const token = server.config.webSocketToken;
  const socket = new WebSocket(`${origin.replace("http", "ws")}/?token=${token}`, "vite-hmr");
  const queries: Array<{ requestId: string; query: unknown }> = [];

  socket.addEventListener("message", (event) => {
    const message = JSON.parse(String(event.data)) as Message;
    if (message.type === "custom" && message.event === BRIDGE_QUERY_EVENT) {
      queries.push(message.data as { requestId: string; query: unknown });
    }
  });

  await new Promise<void>((resolve, reject) => {
    socket.addEventListener("open", () => resolve(), { once: true });
    socket.addEventListener("error", () => reject(new Error("socket failed")), { once: true });
  });

  const send = (event: string, data: unknown) =>
    socket.send(JSON.stringify({ type: "custom", event, data }));

  const hello = () => send(BRIDGE_HELLO_EVENT, { session, url: "http://page/" });
  hello();

  return {
    queries,
    hello,
    reply: (requestId: string, result: unknown) => send(BRIDGE_REPLY_EVENT, { requestId, result }),
    close: () =>
      new Promise<void>((resolve) => {
        socket.addEventListener("close", () => resolve(), { once: true });
        socket.close();
      }),
  };
}

async function ask(body: unknown = { query: { kind: "list_scene_provenance" } }) {
  const response = await fetch(`${origin}${BRIDGE_QUERY_PATH}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return (await response.json()) as Record<string, unknown>;
}

const until = async (check: () => boolean, ms = 2000) => {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > ms) {
      throw new Error("timed out waiting");
    }
    await new Promise((r) => setTimeout(r, 10));
  }
};

describe("the bridge over Vite's websocket", () => {
  it("relays a query to the page and its answer back", async () => {
    const page = await openPage("session-a");
    await new Promise((r) => setTimeout(r, 50)); // let the hello land

    const pending = ask();
    await until(() => page.queries.length > 0);
    const [envelope] = page.queries;
    expect(envelope.query).toEqual({ kind: "list_scene_provenance" });

    page.reply(envelope.requestId, { status: "ready", objects: [] });

    expect(await pending).toMatchObject({
      status: "answered",
      result: { status: "ready", objects: [] },
    });

    await page.close();
  });

  it("forgets a page when its socket closes", async () => {
    const page = await openPage("session-b");
    await new Promise((r) => setTimeout(r, 50));
    await page.close();
    await new Promise((r) => setTimeout(r, 50));

    expect(await ask()).toEqual({ status: "disconnected" });
  });

  // A reconnect sends hello again on the same socket; it is still one page.
  it("counts a repeated hello from one socket as one page", async () => {
    const page = await openPage("session-c");
    await new Promise((r) => setTimeout(r, 50));
    page.hello();
    page.hello();
    await new Promise((r) => setTimeout(r, 50));

    const pending = ask();
    await until(() => page.queries.length > 0);
    page.reply(page.queries[0].requestId, { status: "ready" });

    expect((await pending).status).toBe("answered");
    await page.close();
  });

  it("reports two open pages as ambiguous", async () => {
    const one = await openPage("session-d");
    const two = await openPage("session-e");
    await new Promise((r) => setTimeout(r, 50));

    expect(await ask()).toMatchObject({ status: "ambiguous" });

    await one.close();
    await two.close();
  });
});

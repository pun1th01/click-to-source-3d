import path from "node:path";
import { fileURLToPath } from "node:url";
import { createServer, type ViteDevServer } from "vite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  AGENT_ACTIVITY_EVENT,
  AGENT_REPORT_PATH,
  AGENT_SELECTION_EVENT,
  AGENT_STATE_EVENT,
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
  const events: Array<{ event: string; data: unknown }> = [];

  socket.addEventListener("message", (event) => {
    const message = JSON.parse(String(event.data)) as Message;
    if (message.type === "custom" && message.event === BRIDGE_QUERY_EVENT) {
      queries.push(message.data as { requestId: string; query: unknown });
    } else if (message.type === "custom" && message.event) {
      events.push({ event: message.event, data: message.data });
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
    events,
    send,
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

describe("an assistant at work, seen from the page", () => {
  const report = (body: unknown, headers: Record<string, string> = {}) =>
    fetch(`${origin}${AGENT_REPORT_PATH}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify(body),
    });
  const agent = { id: "e2e-agent", name: "Claude Code" };

  it("tells a page who is connected as soon as it says hello", async () => {
    await report({ agent });
    const page = await openPage("agent-hello");

    await until(() => page.events.some((entry) => entry.event === AGENT_STATE_EVENT));
    const state = page.events.find((entry) => entry.event === AGENT_STATE_EVENT)!.data as {
      agents: Array<{ name: string }>;
    };
    expect(state.agents.map((entry) => entry.name)).toContain("Claude Code");

    await report({ agent, leaving: true });
    await page.close();
  });

  it("passes each tool call on to the page", async () => {
    const page = await openPage("agent-activity");
    await until(() => page.events.some((entry) => entry.event === AGENT_STATE_EVENT));

    const response = await report({
      agent,
      activity: { tool: "get_source", detail: "src/a.tsx", result: "lines 1-9", status: "ok", effect: "read", durationMs: 3, targets: [] },
    });
    expect(response.status).toBe(200);

    await until(() => page.events.some((entry) => entry.event === AGENT_ACTIVITY_EVENT));
    expect(page.events.find((entry) => entry.event === AGENT_ACTIVITY_EVENT)!.data).toMatchObject({
      tool: "get_source",
      agent: "Claude Code",
      result: "lines 1-9",
    });

    await report({ agent, leaving: true });
    await page.close();
  });

  it("gives a page that opens later the log so far", async () => {
    await report({
      agent,
      activity: { tool: "list_files", detail: "", result: "3 files", status: "ok", effect: "read", durationMs: 1, targets: [] },
    });

    const page = await openPage("agent-late");

    await until(() => page.events.some((entry) => entry.event === AGENT_STATE_EVENT));
    const state = page.events.find((entry) => entry.event === AGENT_STATE_EVENT)!.data as {
      log: Array<{ tool: string }>;
    };
    expect(state.log.map((entry) => entry.tool)).toContain("list_files");

    await report({ agent, leaving: true });
    await page.close();
  });

  it("answers get_selection from what the page published, without asking it", async () => {
    const page = await openPage("agent-pointing");
    const box = { kind: "Mesh", source: { file: "src/a.tsx", function: "A", line: 3 }, props: [] };

    page.send(AGENT_SELECTION_EVENT, { pointing: [box], selected: null });

    await expect
      .poll(async () => {
        const answer = (await ask({ query: { kind: "get_selection" } })) as {
          result?: { pointing?: unknown[] };
        };
        return answer.result?.pointing?.length;
      })
      .toBe(1);
    expect(page.queries).toEqual([]);

    const final = (await ask({ query: { kind: "get_selection" } })) as {
      status: string;
      result: { pointing: unknown[]; url: string };
    };
    expect(final.status).toBe("answered");
    expect(final.result.pointing).toEqual([box]);
    expect(final.result.url).toBe("http://page/");

    page.send(AGENT_SELECTION_EVENT, { pointing: [], selected: null });
    await page.close();
  });

  it("takes nothing from a socket that has not said hello", async () => {
    const token = server.config.webSocketToken;
    const socket = new WebSocket(`${origin.replace("http", "ws")}/?token=${token}`, "vite-hmr");
    await new Promise<void>((resolve) => socket.addEventListener("open", () => resolve(), { once: true }));

    socket.send(
      JSON.stringify({
        type: "custom",
        event: AGENT_SELECTION_EVENT,
        data: { pointing: [{ kind: "Mesh" , source: { file: "evil.tsx", function: "x", line: 1 } }], selected: null },
      })
    );
    await new Promise((resolve) => setTimeout(resolve, 100));

    const answer = JSON.stringify(await ask({ query: { kind: "get_selection" } }));
    expect(answer).not.toContain("evil.tsx");
    socket.close();
  });

  // The same policy as every other endpoint that reaches the page.
  it("refuses a report from another origin", async () => {
    const response = await report({ agent }, { Origin: "http://evil.example" });

    expect(response.status).toBe(403);
  });

  it("keeps the report endpoint's reply simple whatever it is sent", async () => {
    const response = await report({ nonsense: true });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
  });
});

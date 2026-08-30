import { describe, expect, it } from "vitest";
import { EventEmitter } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";
import { BridgeHub } from "../src/bridgeHub.js";

/** A ServerResponse stand-in that records what was written to the stream. */
function fakePage(url = "http://localhost:5173/") {
  const emitter = new EventEmitter();
  const written: string[] = [];

  const response = Object.assign(emitter, {
    writeHead: () => response,
    write: (chunk: string) => {
      written.push(chunk);
      return true;
    },
    end: () => undefined,
  }) as unknown as ServerResponse;

  const request = { headers: { referer: url } } as unknown as IncomingMessage;

  return {
    request,
    response,
    written,
    /** The query envelope most recently pushed to this page. */
    lastQuery: () => {
      const data = written.filter((w) => w.startsWith("data: ")).pop();
      return data ? JSON.parse(data.slice(6)) : null;
    },
    close: () => emitter.emit("close"),
  };
}

describe("BridgeHub lifecycle", () => {
  it("reports disconnected when no page is attached", async () => {
    const hub = new BridgeHub();

    expect(await hub.query({ kind: "list_scene_provenance" })).toEqual({
      status: "disconnected",
    });
  });

  it("answers when one page is attached", async () => {
    const hub = new BridgeHub();
    const page = fakePage();
    hub.handleEvents(page.request, page.response);

    const pending = hub.query({ kind: "list_scene_provenance" });
    const envelope = page.lastQuery();
    hub.handleReply({ requestId: envelope.requestId, result: { status: "ready" } });

    expect(await pending).toEqual({
      status: "answered",
      pageId: 1,
      result: { status: "ready" },
    });
  });

  // A reload closes the old stream before the replacement connects — measured
  // at 23ms against a real browser. The hub therefore knows it has no page,
  // and says so at once rather than waiting to find out.
  it("reports disconnected immediately during a reload", async () => {
    const hub = new BridgeHub();
    const first = fakePage();
    hub.handleEvents(first.request, first.response);
    expect(hub.pageCount()).toBe(1);

    first.close();

    expect(hub.pageCount()).toBe(0);
    expect(await hub.query({ kind: "list_scene_provenance" })).toEqual({
      status: "disconnected",
    });
  });

  it("answers again once the replacement page connects", async () => {
    const hub = new BridgeHub();
    const first = fakePage();
    hub.handleEvents(first.request, first.response);
    first.close();

    const second = fakePage();
    hub.handleEvents(second.request, second.response);

    const pending = hub.query({ kind: "list_scene_provenance" });
    hub.handleReply({
      requestId: second.lastQuery().requestId,
      result: { status: "ready" },
    });

    const outcome = await pending;

    expect(outcome.status).toBe("answered");
    // a new page is a new id, so a caller pinning pageId learns it changed
    expect(outcome.status === "answered" && outcome.pageId).toBe(2);
  });

  // Picking the first page would make an answer depend on tab order, which is
  // invisible to the caller and changes without warning.
  it("refuses to choose between two pages", async () => {
    const hub = new BridgeHub();
    const a = fakePage("http://localhost:5173/");
    const b = fakePage("http://localhost:5173/other");
    hub.handleEvents(a.request, a.response);
    hub.handleEvents(b.request, b.response);

    const outcome = await hub.query({ kind: "list_scene_provenance" });

    expect(outcome.status).toBe("ambiguous");
    expect(outcome.status === "ambiguous" && outcome.pages).toEqual([
      { pageId: 1, url: "http://localhost:5173/" },
      { pageId: 2, url: "http://localhost:5173/other" },
    ]);
  });

  it("addresses a named page when several are open", async () => {
    const hub = new BridgeHub();
    const a = fakePage();
    const b = fakePage();
    hub.handleEvents(a.request, a.response);
    hub.handleEvents(b.request, b.response);

    const pending = hub.query({ kind: "list_scene_provenance" }, { pageId: 2 });
    hub.handleReply({ requestId: b.lastQuery().requestId, result: "from b" });

    expect(await pending).toEqual({
      status: "answered",
      pageId: 2,
      result: "from b",
    });
  });

  it("reports a named page that has gone as disconnected", async () => {
    const hub = new BridgeHub();
    const page = fakePage();
    hub.handleEvents(page.request, page.response);

    expect(await hub.query({ kind: "list_scene_provenance" }, { pageId: 99 })).toEqual(
      { status: "disconnected" }
    );
  });

  // A page that is attached but silent is a different problem from no page:
  // something is wrong inside the page rather than nobody looking at it.
  it("distinguishes a silent page from an absent one", async () => {
    const hub = new BridgeHub();
    const page = fakePage();
    hub.handleEvents(page.request, page.response);

    const outcome = await hub.query(
      { kind: "list_scene_provenance" },
      { timeoutMs: 20 }
    );

    expect(outcome).toEqual({ status: "timeout", pageId: 1 });
  });

  it("drops a reply that arrives after its question timed out", async () => {
    const hub = new BridgeHub();
    const page = fakePage();
    hub.handleEvents(page.request, page.response);

    const envelope = (async () => {
      await hub.query({ kind: "list_scene_provenance" }, { timeoutMs: 20 });
      return page.lastQuery();
    })();

    const late = await envelope;

    // The page did nothing wrong, so this is accepted and ignored rather than
    // treated as an error.
    expect(hub.handleReply({ requestId: late.requestId, result: {} })).toBe(true);
  });

  it("ignores a reply with no request id", () => {
    expect(new BridgeHub().handleReply({})).toBe(false);
  });

  it("releases every waiting query on dispose", async () => {
    const hub = new BridgeHub();
    const page = fakePage();
    hub.handleEvents(page.request, page.response);

    const pending = hub.query({ kind: "list_scene_provenance" });
    hub.dispose();

    expect((await pending).status).toBe("timeout");
    expect(hub.pageCount()).toBe(0);
  });
});

describe("BridgeHub page identity", () => {
  /** A page whose events request carries a session id, as the client sends. */
  function sessionPage(session: string, url = "http://localhost:5173/") {
    const page = fakePage(url);
    (page.request as { url?: string }).url = `/__cts/bridge/events?session=${session}`;
    return page;
  }

  // StrictMode mounts the effect twice, and the first socket's close is not
  // always visible to the server before the second opens. Observed live as one
  // tab reported as two pages, which made every query ambiguous.
  it("counts one document as one page when it opens two streams", async () => {
    const hub = new BridgeHub();
    const first = sessionPage("s1");
    const second = sessionPage("s1");

    hub.handleEvents(first.request, first.response);
    hub.handleEvents(second.request, second.response);

    expect(hub.pageCount()).toBe(1);

    const pending = hub.query({ kind: "list_scene_provenance" });

    // the surviving stream is the newer one
    expect(second.lastQuery()).not.toBeNull();
    expect(first.lastQuery()).toBeNull();

    hub.handleReply({ requestId: second.lastQuery().requestId, result: "ok" });
    expect((await pending).status).toBe("answered");
  });

  // Ending the superseded stream reads to EventSource as a dropped connection,
  // so the browser reconnects and the reconnect supersedes its own
  // replacement. Live, page ids climbed without pause and every query landed
  // in the gap as `disconnected`.
  it("does not close the superseded stream, which would make the page reconnect", () => {
    const hub = new BridgeHub();
    const first = sessionPage("s1");
    let ended = false;
    (first.response as unknown as { end: () => void }).end = () => {
      ended = true;
    };
    hub.handleEvents(first.request, first.response);

    const second = sessionPage("s1");
    hub.handleEvents(second.request, second.response);

    expect(ended).toBe(false);
  });

  it("keeps two real tabs distinct", async () => {
    const hub = new BridgeHub();
    const a = sessionPage("s1");
    const b = sessionPage("s2");

    hub.handleEvents(a.request, a.response);
    hub.handleEvents(b.request, b.response);

    expect(hub.pageCount()).toBe(2);
    expect((await hub.query({ kind: "list_scene_provenance" })).status).toBe(
      "ambiguous"
    );
  });

  // Private mode, or storage disabled: the client falls back to no session.
  // De-duplication is lost, but nothing may be merged by accident.
  it("never merges pages that sent no session", () => {
    const hub = new BridgeHub();
    const a = fakePage();
    const b = fakePage();

    hub.handleEvents(a.request, a.response);
    hub.handleEvents(b.request, b.response);

    expect(hub.pageCount()).toBe(2);
  });
});

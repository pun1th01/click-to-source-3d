import { describe, expect, it } from "vitest";
import { BridgeHub, type BridgeEnvelope } from "../src/bridgeHub.js";

/** A page on its own connection, recording the questions it is asked. */
function fakePage(url = "http://localhost:5173/", session: string | null = null) {
  const sent: BridgeEnvelope[] = [];
  const key = {};
  let attachedTo: BridgeHub | null = null;

  return {
    attach(hub: BridgeHub) {
      attachedTo = hub;
      return hub.attach({ send: (envelope) => sent.push(envelope) }, { key, session, url });
    },
    /** The question most recently put to this page. */
    lastQuery: () => sent[sent.length - 1] ?? null,
    close: () => attachedTo?.detach(key),
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
    page.attach(hub);

    const pending = hub.query({ kind: "list_scene_provenance" });
    const envelope = page.lastQuery()!;
    hub.handleReply({ requestId: envelope.requestId, result: { status: "ready" } });

    expect(await pending).toEqual({
      status: "answered",
      pageId: 1,
      result: { status: "ready" },
    });
  });

  // A reload closes the old socket before the replacement connects — measured
  // at 23ms against a real browser. The hub therefore knows it has no page,
  // and says so at once rather than waiting to find out.
  it("reports disconnected immediately during a reload", async () => {
    const hub = new BridgeHub();
    const first = fakePage();
    first.attach(hub);
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
    first.attach(hub);
    first.close();

    const second = fakePage();
    second.attach(hub);

    const pending = hub.query({ kind: "list_scene_provenance" });
    hub.handleReply({
      requestId: second.lastQuery()!.requestId,
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
    a.attach(hub);
    b.attach(hub);

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
    a.attach(hub);
    b.attach(hub);

    const pending = hub.query({ kind: "list_scene_provenance" }, { pageId: 2 });
    hub.handleReply({ requestId: b.lastQuery()!.requestId, result: "from b" });

    expect(await pending).toEqual({
      status: "answered",
      pageId: 2,
      result: "from b",
    });
  });

  it("reports a named page that has gone as disconnected", async () => {
    const hub = new BridgeHub();
    const page = fakePage();
    page.attach(hub);

    expect(await hub.query({ kind: "list_scene_provenance" }, { pageId: 99 })).toEqual(
      { status: "disconnected" }
    );
  });

  // A page that is attached but silent is a different problem from no page:
  // something is wrong inside the page rather than nobody looking at it.
  it("distinguishes a silent page from an absent one", async () => {
    const hub = new BridgeHub();
    const page = fakePage();
    page.attach(hub);

    const outcome = await hub.query(
      { kind: "list_scene_provenance" },
      { timeoutMs: 20 }
    );

    expect(outcome).toEqual({ status: "timeout", pageId: 1 });
  });

  it("drops a reply that arrives after its question timed out", async () => {
    const hub = new BridgeHub();
    const page = fakePage();
    page.attach(hub);

    const envelope = (async () => {
      await hub.query({ kind: "list_scene_provenance" }, { timeoutMs: 20 });
      return page.lastQuery();
    })();

    const late = await envelope;

    // The page did nothing wrong, so this is accepted and ignored rather than
    // treated as an error.
    expect(hub.handleReply({ requestId: late!.requestId, result: {} })).toBe(true);
  });

  it("ignores a reply with no request id", () => {
    expect(new BridgeHub().handleReply({})).toBe(false);
  });

  it("releases every waiting query on dispose", async () => {
    const hub = new BridgeHub();
    const page = fakePage();
    page.attach(hub);

    const pending = hub.query({ kind: "list_scene_provenance" });
    hub.dispose();

    expect((await pending).status).toBe("timeout");
    expect(hub.pageCount()).toBe(0);
  });
});

describe("BridgeHub page identity", () => {
  const sessionPage = (session: string) => fakePage("http://localhost:5173/", session);

  // The old socket's close is not always visible to the server before the new
  // hello arrives. Observed live as one tab reported as two pages, which made
  // every query ambiguous.
  it("counts one document as one page when it connects twice", async () => {
    const hub = new BridgeHub();
    const first = sessionPage("s1");
    const second = sessionPage("s1");

    first.attach(hub);
    second.attach(hub);

    expect(hub.pageCount()).toBe(1);

    const pending = hub.query({ kind: "list_scene_provenance" });

    // the surviving connection is the newer one
    expect(second.lastQuery()).not.toBeNull();
    expect(first.lastQuery()).toBeNull();

    hub.handleReply({ requestId: second.lastQuery()!.requestId, result: "ok" });
    expect((await pending).status).toBe("answered");
  });

  it("keeps two real tabs distinct", async () => {
    const hub = new BridgeHub();
    const a = sessionPage("s1");
    const b = sessionPage("s2");

    a.attach(hub);
    b.attach(hub);

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

    a.attach(hub);
    b.attach(hub);

    expect(hub.pageCount()).toBe(2);
  });
});

describe("BridgeHub connections", () => {
  function channelPage() {
    const sent: Array<{ requestId: string }> = [];
    return { channel: { send: (envelope: { requestId: string }) => sent.push(envelope) }, sent };
  }

  it("answers a page attached over a channel", async () => {
    const hub = new BridgeHub();
    const page = channelPage();
    hub.attach(page.channel, { key: "socket-1", session: "s1" });

    const pending = hub.query({ kind: "list_scene_provenance" });
    hub.handleReply({ requestId: page.sent[0].requestId, result: { status: "ready" } });

    expect(await pending).toMatchObject({ status: "answered", result: { status: "ready" } });
  });

  it("detaches a page by its connection", async () => {
    const hub = new BridgeHub();
    hub.attach(channelPage().channel, { key: "socket-1", session: "s1" });
    hub.detach("socket-1");

    expect(await hub.query({ kind: "list_scene_provenance" })).toEqual({ status: "disconnected" });
  });

  it("replaces a page that says hello again on the same connection", () => {
    const hub = new BridgeHub();
    hub.attach(channelPage().channel, { key: "socket-1" });
    hub.attach(channelPage().channel, { key: "socket-1" });

    expect(hub.pageCount()).toBe(1);
  });

});

describe("BridgeHub.broadcast", () => {
  it("tells every attached page that can be told", () => {
    const hub = new BridgeHub();
    const told: string[] = [];

    hub.attach(
      { send: () => undefined, emit: (event) => told.push(`a:${event}`) },
      { key: {}, session: "a" }
    );
    hub.attach(
      { send: () => undefined, emit: (event) => told.push(`b:${event}`) },
      { key: {}, session: "b" }
    );
    // Only answers questions.
    hub.attach({ send: () => undefined }, { key: {}, session: "c" });

    hub.broadcast("news", {});

    expect(told).toEqual(["a:news", "b:news"]);
  });

  it("is not stopped by a page going away as it is told", () => {
    const hub = new BridgeHub();
    const told: string[] = [];

    hub.attach(
      {
        send: () => undefined,
        emit: () => {
          throw new Error("socket closed");
        },
      },
      { key: {}, session: "a" }
    );
    hub.attach(
      { send: () => undefined, emit: (event) => told.push(event) },
      { key: {}, session: "b" }
    );

    expect(() => hub.broadcast("news", {})).not.toThrow();
    expect(told).toEqual(["news"]);
  });
});

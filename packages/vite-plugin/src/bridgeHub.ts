import type { IncomingMessage, ServerResponse } from "node:http";
import type { BridgeQuery } from "@click-to-source-3d/shared";

/**
 * Server half of the bridge. Holds the open pages and correlates a question
 * from a Node client with the answer one page sends back.
 *
 * The lifecycle it has to get right is a full page reload. Measured against a
 * real browser: the old connection's close is observed 23ms before the new one
 * opens, so the hub genuinely knows it has no page during that window and
 * never has to infer it from silence. That is why a reload reports
 * `disconnected` immediately rather than waiting — a fast truthful answer
 * beats a slow one that is sometimes still wrong, and an agent can act on
 * "nobody is looking at the page" but not on a timeout.
 */

/** A question as a page receives it. */
export type BridgeEnvelope = { requestId: string; query: BridgeQuery };

/**
 * How a question reaches one page: an EventSource stream for
 * `<ClickToSourceBridge />`, or Vite's HMR websocket for the injected
 * inspector. The hub only needs to be able to send.
 */
export type BridgeChannel = {
  send: (envelope: BridgeEnvelope) => void;
  /** Ends the connection when the dev server shuts down, if the hub owns it. */
  close?: () => void;
};

type Page = {
  id: number;
  channel: BridgeChannel;
  url: string;
  session: string | null;
  /** Identity of the connection, for transports that report it. */
  key: unknown;
  connectedAt: number;
};

type Pending = {
  resolve: (value: unknown) => void;
  timer: ReturnType<typeof setTimeout>;
};

export type QueryOutcome =
  | { status: "disconnected" }
  | { status: "ambiguous"; pages: Array<{ pageId: number; url: string }> }
  | { status: "timeout"; pageId: number }
  | { status: "answered"; pageId: number; result: unknown };

export class BridgeHub {
  private pages = new Map<number, Page>();
  private pending = new Map<string, Pending>();
  private nextPageId = 1;
  private nextRequestId = 1;

  /**
   * Registers a page, replacing any earlier registration of the same
   * document or the same connection.
   *
   * One document is one page even when it connects twice. React StrictMode
   * mounts effects twice in development, and the first stream's close is not
   * always visible to the server before the second opens — observed live as a
   * single tab reported as two pages, which made every query ambiguous. The
   * session id is per document, so a page with the legacy component and the
   * injected inspector, one on each transport, also counts once.
   *
   * The superseded entry is dropped from the map but its connection is left
   * alone. Ending an EventSource stream would be tidier and is wrong: to the
   * browser a stream that ends looks like a dropped connection, so it
   * reconnects, and the reconnect supersedes its own replacement. Measured
   * with that end() in place, page ids climbed without pause and every query
   * landed in the gap as `disconnected`.
   */
  private register(page: Omit<Page, "id" | "connectedAt">): number {
    for (const [existingId, existing] of this.pages) {
      if (
        (page.session && existing.session === page.session) ||
        (page.key !== undefined && existing.key === page.key)
      ) {
        this.pages.delete(existingId);
      }
    }

    const id = this.nextPageId++;
    this.pages.set(id, { ...page, id, connectedAt: Date.now() });
    return id;
  }

  /** Attaches a page's event stream. Returns when the page disconnects. */
  handleEvents(request: IncomingMessage, response: ServerResponse): void {
    const session = new URL(
      request.url ?? "/",
      "http://localhost"
    ).searchParams.get("session");

    response.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      // Vite sits behind no proxy in dev, but a stray buffering layer would
      // hold events indefinitely and look exactly like a hung page.
      "X-Accel-Buffering": "no",
    });

    const id = this.register({
      channel: {
        send: (envelope) => {
          response.write(`data: ${JSON.stringify(envelope)}\n\n`);
        },
        close: () => response.end(),
      },
      url: request.headers.referer ?? "unknown",
      session,
      key: response,
    });
    response.write(`: connected ${id}\n\n`);

    response.on("close", () => {
      this.pages.delete(id);
    });
  }

  /**
   * Attaches a page that speaks over another channel — the injected
   * inspector, over Vite's HMR websocket.
   *
   * `key` identifies the connection, so a page that says hello again after a
   * reconnect replaces itself instead of becoming a second page; the same key
   * detaches it.
   */
  attach(
    channel: BridgeChannel,
    info: { session?: string | null; url?: string; key: unknown }
  ): number {
    return this.register({
      channel,
      url: info.url ?? "unknown",
      session: info.session ?? null,
      key: info.key,
    });
  }

  /** Drops the page registered under a connection's key, if any. */
  detach(key: unknown): void {
    for (const [id, page] of this.pages) {
      if (page.key === key) {
        this.pages.delete(id);
      }
    }
  }

  /** Accepts a page's answer to an earlier question. */
  handleReply(body: { requestId?: string; result?: unknown }): boolean {
    if (typeof body.requestId !== "string") {
      return false;
    }

    const waiting = this.pending.get(body.requestId);

    if (!waiting) {
      // A reply for a question that already timed out. Dropped rather than
      // treated as an error: the page did nothing wrong.
      return true;
    }

    clearTimeout(waiting.timer);
    this.pending.delete(body.requestId);
    waiting.resolve(body.result);

    return true;
  }

  pageCount(): number {
    return this.pages.size;
  }

  /**
   * Puts a question to the connected page.
   *
   * More than one page is an error rather than a choice. Picking the first
   * would make an answer depend on tab order, which is invisible to the
   * caller and changes without warning.
   */
  async query(
    query: BridgeQuery,
    options: { pageId?: number; timeoutMs?: number } = {}
  ): Promise<QueryOutcome> {
    const pages = [...this.pages.values()];

    if (pages.length === 0) {
      return { status: "disconnected" };
    }

    let page: Page | undefined;

    if (options.pageId !== undefined) {
      page = this.pages.get(options.pageId);

      if (!page) {
        return { status: "disconnected" };
      }
    } else if (pages.length > 1) {
      return {
        status: "ambiguous",
        pages: pages.map((p) => ({ pageId: p.id, url: p.url })),
      };
    } else {
      page = pages[0];
    }

    const requestId = `q${this.nextRequestId++}`;
    const timeoutMs = options.timeoutMs ?? 5000;

    const result = await new Promise<unknown>((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        resolve(undefined);
      }, timeoutMs);

      this.pending.set(requestId, { resolve, timer });

      try {
        page.channel.send({ requestId, query });
      } catch {
        clearTimeout(timer);
        this.pending.delete(requestId);
        resolve(undefined);
      }
    });

    if (result === undefined) {
      return { status: "timeout", pageId: page.id };
    }

    return { status: "answered", pageId: page.id, result };
  }

  /** Drops every page, used when the dev server shuts down. */
  dispose(): void {
    for (const page of this.pages.values()) {
      try {
        page.channel.close?.();
      } catch {
        // already gone
      }
    }

    this.pages.clear();

    for (const waiting of this.pending.values()) {
      clearTimeout(waiting.timer);
      waiting.resolve(undefined);
    }

    this.pending.clear();
  }
}

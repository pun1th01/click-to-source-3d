import type { IncomingMessage, ServerResponse } from "node:http";
import type { BridgeQuery } from "@click-to-source/shared";

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

type Page = {
  id: number;
  response: ServerResponse;
  url: string;
  session: string | null;
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

  /** Attaches a page's event stream. Returns when the page disconnects. */
  handleEvents(request: IncomingMessage, response: ServerResponse): void {
    const id = this.nextPageId++;
    const session = new URL(
      request.url ?? "/",
      "http://localhost"
    ).searchParams.get("session");

    // One document is one page even when it opens two streams. React
    // StrictMode mounts effects twice in development, and the first socket's
    // close is not always visible to the server before the second opens —
    // observed live as a single tab reported as two pages, which made every
    // query ambiguous.
    //
    // The superseded entry is dropped from the map but its socket is left
    // alone. Ending it would be tidier and is wrong: to EventSource a stream
    // that ends looks like a dropped connection, so the browser reconnects,
    // and the reconnect supersedes its own replacement. Measured with that
    // end() in place, page ids climbed without pause and every query landed
    // in the gap as `disconnected`. The abandoned socket costs nothing and
    // clears itself when the page navigates.
    if (session) {
      for (const [existingId, page] of this.pages) {
        if (page.session === session) {
          this.pages.delete(existingId);
        }
      }
    }

    response.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      // Vite sits behind no proxy in dev, but a stray buffering layer would
      // hold events indefinitely and look exactly like a hung page.
      "X-Accel-Buffering": "no",
    });
    response.write(`: connected ${id}\n\n`);

    this.pages.set(id, {
      id,
      response,
      url: request.headers.referer ?? "unknown",
      session,
      connectedAt: Date.now(),
    });

    response.on("close", () => {
      this.pages.delete(id);
    });
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
        page.response.write(
          `data: ${JSON.stringify({ requestId, query })}\n\n`
        );
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
        page.response.end();
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

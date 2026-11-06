import {
  AGENT_ACTIVITY_EVENT,
  AGENT_STATE_EVENT,
  type ActivityTarget,
  type AgentActivity,
  type AgentInfo,
  type AgentState,
  type PageSelection,
  type PointedObject,
} from "@click-to-source-3d/shared";
import type { QueryOutcome } from "./bridgeHub.js";

/** Lines kept for a page that opens later, or reloads. */
const LOG_LIMIT = 200;
/** How long an assistant counts as connected without a word from it. */
const AGENT_TTL_MS = 15_000;
/** How long what a page pointed at outlives its connection. */
const PAGE_GRACE_MS = 15_000;
/** More objects than anyone means to point at, and a bound on what is held. */
const MAX_POINTED = 64;
/** Long enough for any honest detail. */
const MAX_TEXT = 300;

type PageRef = { pageId: number; session: string | null; url: string };

type Published = {
  page: PageRef;
  selection: PageSelection;
  at: number;
  /** When the page's connection went away, if it has. */
  leftAt: number | null;
};

const text = (value: unknown): string =>
  typeof value === "string" ? value.slice(0, MAX_TEXT) : "";

function targetsOf(value: unknown): ActivityTarget[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const targets: ActivityTarget[] = [];
  for (const item of value.slice(0, MAX_POINTED) as Array<Partial<ActivityTarget> | null>) {
    if (typeof item?.file === "string" && typeof item.line === "number") {
      targets.push({
        file: item.file,
        line: item.line,
        ...(typeof item.column === "number" ? { column: item.column } : {}),
        ...(typeof item.ordinal === "number" ? { ordinal: item.ordinal } : {}),
        ...(typeof item.instanceId === "number" ? { instanceId: item.instanceId } : {}),
      });
    }
  }
  return targets;
}

function isPointed(value: unknown): value is PointedObject {
  return typeof value === "object" && value !== null && typeof (value as PointedObject).kind === "string";
}

/**
 * What the dev server knows about the assistant at work: who is connected, what
 * they have done, and what the developer is pointing them at.
 *
 * An assistant has no window of its own and reaches the page only through
 * here. Every MCP tool call passes through as a report, which is passed on to
 * the open pages, so the developer can watch. A heartbeat of empty reports
 * tells connected from gone.
 *
 * What the developer points at is pushed by the page when it changes rather
 * than fetched when asked, because of when an assistant asks: right after the
 * developer has switched from the browser to their terminal, when the page may
 * be in a background tab, or partway through the reload an edit caused.
 */
export class AgentHub {
  private readonly agents = new Map<string, AgentInfo & { seenAt: number }>();
  /** Assistants that said goodbye, and when. */
  private readonly left = new Map<string, number>();
  private log: AgentActivity[] = [];
  private nextId = 1;
  private readonly published = new Map<string, Published>();
  private readonly sweeper: ReturnType<typeof setInterval>;

  constructor(
    private readonly broadcast: (event: string, data: unknown) => void,
    private readonly now: () => number = Date.now
  ) {
    this.sweeper = setInterval(() => this.sweep(), 5000);
    // Never the reason a dev server stays up.
    this.sweeper.unref?.();
  }

  /** The whole picture, for a page that has just said hello. */
  state(): AgentState {
    return {
      agents: [...this.agents.values()].map(({ id, name, lastCallAt }) => ({ id, name, lastCallAt })),
      log: this.log,
    };
  }

  /** Takes a report from an MCP server. Anything malformed in it is ignored. */
  report(body: unknown): void {
    const report = (body ?? {}) as {
      agent?: { id?: unknown; name?: unknown };
      activity?: Record<string, unknown>;
      leaving?: unknown;
    };
    const id = text(report.agent?.id);
    if (!id) {
      return;
    }

    const now = this.now();

    if (report.leaving === true) {
      this.left.set(id, now);
      if (this.agents.delete(id)) {
        this.broadcast(AGENT_STATE_EVENT, this.state());
      }
      return;
    }

    const known = this.agents.get(id);
    const name = text(report.agent?.name) || "Assistant";
    const called = report.activity !== undefined;

    // Each report is its own request, so the last call's can arrive after the
    // goodbye sent just behind it. It still goes in the log, but must not bring
    // the assistant back, or the page says it is connected for 15 seconds more.
    if (!this.left.has(id)) {
      this.agents.set(id, {
        id,
        name,
        seenAt: now,
        lastCallAt: called ? now : (known?.lastCallAt ?? null),
      });

      if (!known || known.name !== name) {
        this.broadcast(AGENT_STATE_EVENT, this.state());
      }
    }

    if (report.activity) {
      const activity = report.activity;
      const entry: AgentActivity = {
        id: this.nextId++,
        at: now,
        agent: name,
        tool: text(activity.tool),
        detail: text(activity.detail),
        result: text(activity.result),
        status: activity.status === "error" ? "error" : "ok",
        effect: activity.effect === "edit" || activity.effect === "point" ? activity.effect : "read",
        durationMs: typeof activity.durationMs === "number" ? activity.durationMs : 0,
        targets: targetsOf(activity.targets),
      };

      this.log.push(entry);
      if (this.log.length > LOG_LIMIT) {
        this.log = this.log.slice(-LOG_LIMIT);
      }
      this.broadcast(AGENT_ACTIVITY_EVENT, entry);
    }
  }

  /** Records what a page now has selected and pointed at. */
  setSelection(page: PageRef, body: unknown): void {
    const selection = (body ?? {}) as { pointing?: unknown; selected?: unknown };
    const pointing = Array.isArray(selection.pointing) ? selection.pointing.filter(isPointed) : [];

    this.published.set(page.session ?? `page:${page.pageId}`, {
      page,
      selection: {
        pointing: pointing.slice(0, MAX_POINTED),
        selected: isPointed(selection.selected) ? selection.selected : null,
      },
      at: this.now(),
      leftAt: null,
    });
  }

  /**
   * A page's connection closed. What it pointed at is kept for a moment: the
   * usual reason is a reload, and an assistant asking during it should not be
   * told the developer has stopped pointing at anything.
   */
  pageLeft(page: Pick<PageRef, "pageId" | "session">): void {
    const entry = this.published.get(page.session ?? `page:${page.pageId}`);
    // A reload's new connection can arrive before the old one is seen to close.
    if (entry && entry.page.pageId === page.pageId) {
      entry.leftAt = this.now();
    }
  }

  /**
   * Answers `get_selection`, given the sessions of the pages now open.
   *
   * More than one open page is not ambiguous here, as it is for questions
   * about a scene: the developer's latest gesture says which page they mean.
   *
   * What a page published outlives its connection only for a reload: while that
   * same session is back, or while no page is open at all. A tab that was closed
   * has no say over a different one that is open.
   */
  selectionOutcome(sessions: Array<string | null>): QueryOutcome {
    this.sweep();
    const entries = [...this.published.entries()]
      .filter(([key, entry]) => entry.leftAt === null || sessions.length === 0 || sessions.includes(key))
      .map(([, entry]) => entry);

    if (sessions.length === 0 && entries.length === 0) {
      return { status: "disconnected" };
    }

    const holding = (entry: Published) => entry.selection.pointing.length > 0 || entry.selection.selected !== null;
    const latest = entries
      .filter(holding)
      .sort((a, b) => b.at - a.at)[0];

    return {
      status: "answered",
      pageId: latest?.page.pageId ?? 0,
      result: {
        status: "ready",
        pointing: latest?.selection.pointing ?? [],
        selected: latest?.selection.selected ?? null,
        url: latest?.page.url ?? null,
        ...(latest
          ? {}
          : {
              hint:
                "The developer has not selected or pointed at anything. They can press the " +
                "inspector's shortcut in the browser and click an object, or Shift+click several.",
            }),
      },
    };
  }

  private sweep(): void {
    const now = this.now();

    for (const [key, entry] of this.published) {
      if (entry.leftAt !== null && now - entry.leftAt > PAGE_GRACE_MS) {
        this.published.delete(key);
      }
    }

    for (const [id, at] of this.left) {
      if (now - at > AGENT_TTL_MS) {
        this.left.delete(id);
      }
    }

    let changed = false;
    for (const [id, agent] of this.agents) {
      if (now - agent.seenAt > AGENT_TTL_MS) {
        this.agents.delete(id);
        changed = true;
      }
    }
    if (changed) {
      this.broadcast(AGENT_STATE_EVENT, this.state());
    }
  }

  dispose(): void {
    clearInterval(this.sweeper);
  }
}

import {
  AGENT_ACTIVITY_EVENT,
  AGENT_SELECTION_EVENT,
  AGENT_STATE_EVENT,
  type ActivityTarget,
  type AgentActivity,
  type AgentInfo,
  type AgentState,
  type BridgeQuery,
  type ObjectRef,
  type PageSelection,
} from "@click-to-source-3d/shared";
import type { HotChannel } from "@click-to-source-3d/core/devtools";
import { captureView } from "./capture.js";
import type { Discovery } from "./discovery.js";
import { findRefs, kindOf, type Target } from "./targets.js";

/** How long an object the assistant merely asked about stays outlined. */
const GLANCE_SECONDS = 4;
/** How long an object it deliberately pointed out stays outlined, unless it says. */
const POINT_SECONDS = 15;
const MAX_POINT_SECONDS = 120;
const DEFAULT_CAPTURE_SIZE = 1024;
const MAX_CAPTURE_SIZE = 2048;

/** Objects outlined for the assistant, until a timer runs out. */
type Look = { targets: Target[]; timer: ReturnType<typeof setTimeout> | null };

/**
 * The page's end of the conversation with the assistant: who is connected, what
 * they have done, and what the page has told them is being pointed at.
 *
 * Also what the assistant can do to the page. It can outline objects, in a colour
 * of their own, and take a picture of the canvas.
 */
export class AgentLink {
  agents: AgentInfo[] = [];
  log: AgentActivity[] = [];

  private readonly listeners = new Set<() => void>();
  private readonly pointedOut: Look = { targets: [], timer: null };
  private readonly glanced: Look = { targets: [], timer: null };
  private lastPublished: PageSelection | null = null;

  constructor(
    private readonly discovery: Discovery,
    private readonly hot: HotChannel
  ) {
    hot.on(AGENT_STATE_EVENT, ((state: AgentState) => {
      this.agents = state.agents;
      this.log = state.log;
      this.notify();
    }) as (data: never) => void);

    hot.on(AGENT_ACTIVITY_EVENT, ((entry: AgentActivity) => {
      this.log = [...this.log, entry].slice(-200);
      this.agents = this.agents.map((agent) =>
        agent.name === entry.agent ? { ...agent, lastCallAt: entry.at } : agent
      );
      // What it deliberately pointed out is already outlined, for as long as it asked.
      if (entry.effect !== "point") {
        this.glanceAt(entry.targets);
      }
      this.notify();
    }) as (data: never) => void);

    // After a dev-server restart the server has forgotten what is pointed at.
    // Registered after the bridge's hello, so it arrives after it.
    hot.on("vite:ws:connect", (() => {
      if (this.lastPublished) {
        this.hot.send(AGENT_SELECTION_EVENT, this.lastPublished);
      }
    }) as (data: never) => void);
  }

  onChange(listener: () => void): void {
    this.listeners.add(listener);
  }

  private notify(): void {
    for (const listener of this.listeners) {
      listener();
    }
  }

  get connected(): boolean {
    return this.agents.length > 0;
  }

  /** Tells the dev server what the developer now has selected and pointed at. */
  publish(selection: PageSelection): void {
    this.lastPublished = selection;
    this.hot.send(AGENT_SELECTION_EVENT, selection);
  }

  // ── Outlining what the assistant is looking at ────────────────────────────

  private showLooks(): void {
    const targets = [...this.pointedOut.targets, ...this.glanced.targets];
    for (const view of this.discovery.all()) {
      const mine = targets.filter((target) => target.view === view);
      if (mine.length > 0 || view.layer.get("agent")) {
        view.layer.setAll(
          "agent",
          mine.map(({ pick }) => ({ object: pick.object, instanceId: pick.instanceId }))
        );
        view.redraw();
      }
    }
  }

  /**
   * Replaces one kind of look. There are two so that a passing question cannot
   * cut short something the assistant asked to keep on screen.
   */
  private look(look: Look, targets: Target[], seconds: number): void {
    if (look.timer) {
      clearTimeout(look.timer);
      look.timer = null;
    }
    look.targets = targets;
    if (targets.length > 0) {
      look.timer = setTimeout(() => this.look(look, [], 0), seconds * 1000);
    }
    this.showLooks();
  }

  private glanceAt(refs: ActivityTarget[]): void {
    const targets = refs.flatMap((ref) => findRefs(this.discovery, ref));
    if (targets.length > 0) {
      this.look(this.glanced, targets, GLANCE_SECONDS);
    }
  }

  private highlight(refs: ObjectRef[], seconds: number | undefined) {
    if (this.discovery.all().length === 0) {
      return { status: "no_scene" };
    }

    const found: Target[] = [];
    const missing: ObjectRef[] = [];
    for (const ref of refs) {
      const targets = findRefs(this.discovery, ref);
      if (targets.length > 0) {
        found.push(...targets);
      } else {
        missing.push(ref);
      }
    }

    const hold = Math.min(MAX_POINT_SECONDS, Math.max(1, seconds ?? POINT_SECONDS));
    this.look(this.pointedOut, found, hold);

    return {
      status: "ready",
      highlighted: found.map(({ pick }) => ({
        kind: kindOf(pick.object),
        file: pick.resolution?.sourceRef.file ?? null,
        line: pick.resolution?.sourceRef.line ?? null,
        instanceId: pick.instanceId,
      })),
      missing,
      ...(found.length > 0 ? { seconds: hold } : {}),
    };
  }

  // ── Answering the bridge ──────────────────────────────────────────────────

  /** Queries that need the screen rather than only the scene. */
  answer = (query: BridgeQuery): unknown => {
    if (query.kind === "highlight_objects") {
      return this.highlight(query.targets ?? [], query.seconds);
    }

    if (query.kind === "capture_canvas") {
      const view = this.discovery.primary();
      if (!view) {
        return { status: "no_scene" };
      }
      const maxSize = Math.min(MAX_CAPTURE_SIZE, Math.max(64, query.maxSize ?? DEFAULT_CAPTURE_SIZE));
      return captureView(view, { maxSize }).then((capture) => ({ status: "ready", ...capture }));
    }

    return undefined;
  };

  /** For tests and debugging: what is outlined in the assistant's colour. */
  looking(): Array<{ kind: string; instanceId: number | null | undefined }> {
    return this.discovery.all().flatMap((view) =>
      view.layer.all("agent").map((target) => ({
        kind: kindOf(target.object),
        instanceId: target.instanceId,
      }))
    );
  }
}

import * as THREE from "three";
import {
  OPEN_IN_EDITOR_PATH,
  type AgentActivity,
  type ObjectCost,
  type SourceFunction,
  type SourceNumbers,
  type StampedValue,
  type TraceFrame,
  type UsedFunction,
} from "@click-to-source-3d/shared";
import { resolveSourceRef } from "@click-to-source-3d/core";
import {
  describeMesh,
  editSourceFile,
  measureObject,
  ndcFromClient,
  pickAt,
  recordOf,
  type HotChannel,
  type Pick,
} from "@click-to-source-3d/core/devtools";
import { agentStatusText, agentTab } from "./agentTab.js";
import type { AgentLink } from "./agentLink.js";
import { blobOf, captureView } from "./capture.js";
import { compareTab } from "./compareTab.js";
import type { Discovery, View } from "./discovery.js";
import { h, icon, ICONS } from "./dom.js";
import { ValueEditors } from "./editors.js";
import { elementLabel, formatBytes, formatCount, plural } from "./format.js";
import { copyImage, copyReport, reportMarkdown } from "./report.js";
import { STYLES } from "./styles.js";
import {
  addressOf,
  describeTarget,
  findAddress,
  findRefs,
  generatorsOfTarget,
  isInside,
  kindOf,
  labelOf,
  modelPathOf,
  partsOfTarget,
  sameTarget,
  stampOf,
  type Address,
  type Target,
  type TargetPart,
} from "./targets.js";
import { draftOf, parseDraft } from "./values.js";

export type InspectorOptions = {
  /** e.g. "alt+shift+c". */
  hotkey: string;
  /** Show the toggle button on the canvas. */
  button: boolean;
};

type Tab = "inspect" | "compare" | "agent";

/** A target kept across updates, with what it takes to find it again. */
type Held = Target & { address: Address | null };

type Saved = {
  inspecting: boolean;
  pointerMode: boolean;
  panelOpen: boolean;
  tab: Tab;
  selection: Address | null;
  pointing: Address[];
  pins: Address[];
};

const STORAGE_KEY = "__cts_inspector";

/** Two are side by side; a third pin replaces the oldest. */
const MAX_PINS = 2;

type Hotkey = {
  alt: boolean;
  shift: boolean;
  ctrl: boolean;
  meta: boolean;
  /** Physical key, when the key is a letter or digit. */
  code: string | null;
  key: string;
};

export function parseHotkey(spec: string): Hotkey {
  const parts = spec
    .toLowerCase()
    .split("+")
    .map((part) => part.trim())
    .filter(Boolean);
  const key = parts[parts.length - 1] ?? "";

  return {
    alt: parts.includes("alt") || parts.includes("option"),
    shift: parts.includes("shift"),
    ctrl: parts.includes("ctrl") || parts.includes("control"),
    meta: parts.includes("meta") || parts.includes("cmd"),
    // Matched by physical key where there is one: on macOS, Alt+Shift+C types
    // "Ç", so comparing event.key would never match.
    code: /^[a-z]$/.test(key)
      ? `Key${key.toUpperCase()}`
      : /^[0-9]$/.test(key)
        ? `Digit${key}`
        : null,
    key,
  };
}

export function matchesHotkey(event: KeyboardEvent, hotkey: Hotkey): boolean {
  if (
    event.altKey !== hotkey.alt ||
    event.shiftKey !== hotkey.shift ||
    event.ctrlKey !== hotkey.ctrl ||
    event.metaKey !== hotkey.meta
  ) {
    return false;
  }
  return hotkey.code ? event.code === hotkey.code : event.key.toLowerCase() === hotkey.key;
}

/** "alt+shift+c" as a person would write it: "Alt+Shift+C". */
function hotkeyLabel(spec: string): string {
  return spec
    .split("+")
    .map((part) => part.trim())
    .map((part) => (part.length === 1 ? part.toUpperCase() : part[0].toUpperCase() + part.slice(1)))
    .join("+");
}

/** Typing in a field — the app's or the panel's — never triggers a shortcut. */
function isTyping(event: Event): boolean {
  const target = event.composedPath()[0];
  if (!(target instanceof HTMLElement)) {
    return false;
  }
  return target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName);
}

/**
 * What the panel draws an object's values from. A module update replaces them
 * with new objects, so comparing identity says whether this object's source
 * could have changed.
 */
function marksOf(target: Target): unknown[] {
  const resolved = target.pick.resolution?.object;
  return [resolved, stampOf(resolved), resolved?.userData?.sourceRef];
}

function sameMarks(a: unknown[], b: unknown[]): boolean {
  return a.length === b.length && a.every((mark, index) => mark === b[index]);
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : "Something went wrong";
}

/**
 * The inspector the plugin injects: a toggleable inspect mode, a highlight,
 * and a panel naming where the selected object came from and what can be
 * changed about it.
 *
 * Lives in a shadow root on <html>, outside the application's own tree, so
 * React never sees it and the application's CSS never reaches it.
 */
export class Inspector {
  private readonly hotkey: Hotkey;
  private readonly host: HTMLElement;
  private readonly root: HTMLDivElement;
  private readonly toggle: HTMLButtonElement;
  private readonly pointer: HTMLButtonElement;
  private readonly pointerCount: HTMLSpanElement;
  private readonly tip: HTMLDivElement;
  private panel: HTMLElement | null = null;
  private tabsRow: HTMLElement | null = null;
  private bodies: Record<Tab, HTMLElement> | null = null;
  private toolbar: HTMLElement | null = null;
  private unsaved: HTMLElement | null = null;
  private statusLine: HTMLElement | null = null;

  private inspecting = false;
  /** Inspect mode in which a click points the assistant at an object. */
  private pointerMode = false;
  private panelOpen = false;
  private tab: Tab = "inspect";
  private selection: Target | null = null;
  private pointing: Held[] = [];
  private pins: Held[] = [];
  private lastAddress: Address | null = null;
  /** What the Inspect tab was drawn from. */
  private shownMarks: unknown[] = [];
  private refreshGeneration = 0;
  private restoring = false;
  private differencesOnly = false;
  /** What a person looks at first stays open until they say otherwise. */
  private readonly openSections = new Set<string>(["called", "uses"]);
  private status: { kind: "ok" | "error"; text: string } | null = null;
  private downAt: { x: number; y: number } | null = null;
  private pendingHover: { view: View; x: number; y: number } | null = null;
  private hoverFrame = 0;
  private noteShown = false;
  private readonly cursors = new Map<HTMLCanvasElement, string>();
  private readonly raycaster = new THREE.Raycaster();
  private readonly editors: ValueEditors;

  constructor(
    private readonly discovery: Discovery,
    private readonly options: InspectorOptions,
    private readonly hot: HotChannel | null,
    private readonly agent: AgentLink | null = null
  ) {
    this.hotkey = parseHotkey(options.hotkey);

    this.editors = new ValueEditors({
      status: (kind, text) => this.setStatus(kind, text),
      redraw: () => this.selection?.view.redraw(),
      changed: () => this.showUnsaved(),
    });

    this.host = document.createElement("cts-devtools");
    this.host.setAttribute(
      "style",
      "position:fixed;top:0;left:0;width:0;height:0;z-index:2147483647;"
    );
    const shadow = this.host.attachShadow({ mode: "open" });
    const style = document.createElement("style");
    style.textContent = STYLES;
    this.root = h("div", { class: "root" });
    shadow.append(style, this.root);

    this.toggle = h(
      "button",
      {
        class: "toggle",
        title: `Inspect objects (${hotkeyLabel(options.hotkey)})`,
        attrs: { type: "button", "aria-label": "Inspect objects", "aria-pressed": "false" },
        on: { click: () => this.setInspecting(!this.inspecting) },
      },
      [icon(ICONS.crosshair)]
    );
    this.toggle.hidden = true;

    this.pointerCount = h("span", { class: "count" });
    this.pointerCount.hidden = true;
    this.pointer = h(
      "button",
      {
        class: "toggle pointer",
        title: "Point your assistant at objects",
        attrs: { type: "button", "aria-label": "Point your assistant at objects", "aria-pressed": "false" },
        on: { click: () => this.setPointerMode(!this.pointerMode) },
      },
      [icon(ICONS.point), this.pointerCount]
    );
    this.pointer.hidden = true;

    this.tip = h("div", { class: "tip" });
    this.tip.hidden = true;
    this.root.append(this.toggle, this.pointer, this.tip);

    // Keys typed into the panel are the panel's. An application listening on
    // window — OrbitControls' arrow keys, a game's WASD — must not also act
    // on them.
    this.host.addEventListener("keydown", (event) => event.stopPropagation());
  }

  mount(): void {
    document.documentElement.append(this.host);

    window.addEventListener("keydown", this.onKeyDown, true);
    window.addEventListener("pointermove", this.onPointerMove, true);
    window.addEventListener("pointerdown", this.onPointerDown, true);
    window.addEventListener("click", this.onClick, true);
    window.addEventListener("resize", this.place);
    window.addEventListener("scroll", this.place, true);
    // A canvas can move or resize without either event: a layout change, a
    // panel opening beside it. The status line counts seconds since a call.
    setInterval(() => {
      this.place();
      this.showAgentStatus();
    }, 1000);

    this.discovery.onView(() => this.place());
    this.place();

    // After Save, Vite updates the module and R3F re-applies the new stamp to
    // the same object. Re-read it then, so positions and values stay current.
    this.hot?.on("vite:afterUpdate", (() => this.refreshSoon()) as (data: never) => void);
    this.agent?.onChange(() => this.onAgentChange());

    this.restore();
  }

  // ── Mode ──────────────────────────────────────────────────────────────────

  setInspecting(on: boolean): void {
    if (on === this.inspecting) {
      return;
    }

    this.inspecting = on;
    this.toggle.setAttribute("aria-pressed", String(on));
    this.discovery.refresh();

    for (const view of this.discovery.all()) {
      if (on) {
        this.cursors.set(view.canvas, view.canvas.style.cursor);
        view.canvas.style.cursor = "crosshair";
      } else {
        view.canvas.style.cursor = this.cursors.get(view.canvas) ?? "";
      }
    }

    if (!on) {
      this.clearHover();
      this.pointerMode = false;
      this.showPointerState();
      this.renderAgent();
    }

    const global = globalThis as { __CTS_MANUAL_OVERLAY__?: boolean };
    if (on && global.__CTS_MANUAL_OVERLAY__ && !this.noteShown) {
      this.noteShown = true;
      console.info(
        "[click-to-source] The inspector is built in now. <GenerationTrace /> and " +
          "<SelectionHighlight /> can be removed from your app."
      );
    }

    this.save();
  }

  /**
   * Inspect mode in which a click points the assistant at an object instead of
   * selecting it, so several can be picked one after another. Opens the Agent
   * tab, where the list of them is.
   */
  private setPointerMode(on: boolean): void {
    if (!on) {
      this.setInspecting(false);
      return;
    }

    this.pointerMode = true;
    this.setInspecting(true);
    this.openTab("agent");
    this.showPointerState();
    this.renderAgent();
    this.save();
  }

  /**
   * Puts the toggle button at the bottom-right corner of the main canvas, with
   * the pointer button beside it while there is an assistant to point.
   */
  private place = (): void => {
    const view = this.discovery.primary();

    if (!view || !this.options.button) {
      this.toggle.hidden = true;
      this.pointer.hidden = true;
      return;
    }

    const rect = view.canvas.getBoundingClientRect();
    const size = 34;
    const inset = 12;
    const left = Math.min(rect.right, window.innerWidth) - size - inset;
    const top = Math.min(rect.bottom, window.innerHeight) - size - inset;
    const x = Math.max(rect.left + inset, left);
    const y = Math.max(rect.top + inset, top);
    this.toggle.style.left = `${x}px`;
    this.toggle.style.top = `${y}px`;
    this.toggle.hidden = false;

    this.pointer.style.left = `${Math.max(rect.left + inset, x - size - 8)}px`;
    this.pointer.style.top = `${y}px`;
    this.pointer.hidden = !this.agent || (!this.agent.connected && this.pointing.length === 0);
  };

  private showPointerState(): void {
    this.pointer.setAttribute("aria-pressed", String(this.pointerMode));
    this.pointerCount.textContent = String(this.pointing.length);
    this.pointerCount.hidden = this.pointing.length === 0;
    this.place();
  }

  // ── Input ─────────────────────────────────────────────────────────────────

  private onKeyDown = (event: KeyboardEvent): void => {
    if (isTyping(event)) {
      return;
    }

    if (matchesHotkey(event, this.hotkey)) {
      event.preventDefault();
      event.stopPropagation();
      this.setInspecting(!this.inspecting);
      return;
    }

    if (event.key === "Escape") {
      if (this.inspecting) {
        this.setInspecting(false);
      } else if (this.panelOpen) {
        this.closePanel();
      }
    }
  };

  private onPointerMove = (event: PointerEvent): void => {
    if (!this.inspecting) {
      return;
    }

    const view = this.discovery.viewAt(event.target, event.clientX, event.clientY);
    if (!view) {
      this.clearHover();
      return;
    }

    this.pendingHover = { view, x: event.clientX, y: event.clientY };
    if (!this.hoverFrame) {
      // One raycast per frame, however fast the pointer moves.
      this.hoverFrame = requestAnimationFrame(() => {
        this.hoverFrame = 0;
        const pending = this.pendingHover;
        if (pending && this.inspecting) {
          this.hoverAt(pending.view, pending.x, pending.y);
        }
      });
    }
  };

  private onPointerDown = (event: PointerEvent): void => {
    this.downAt = { x: event.clientX, y: event.clientY };
  };

  /**
   * In inspect mode a click on a canvas belongs to the inspector, so it is
   * stopped here, in the capture phase at window, before the application's
   * handlers — R3F's onClick included — can see it. Pointer down and move
   * still pass, so OrbitControls and the like keep working: a drag orbits,
   * and a click that turns out to have been a drag selects nothing.
   */
  private onClick = (event: MouseEvent): void => {
    if (!this.inspecting) {
      return;
    }

    const view = this.discovery.viewAt(event.target, event.clientX, event.clientY);
    if (!view) {
      return;
    }

    event.stopImmediatePropagation();
    event.preventDefault();

    const moved = this.downAt
      ? Math.hypot(event.clientX - this.downAt.x, event.clientY - this.downAt.y)
      : 0;
    if (moved > 5) {
      return;
    }

    if (this.agent && (this.pointerMode || event.shiftKey)) {
      const pick = this.pick(view, event.clientX, event.clientY);
      if (pick) {
        this.togglePointing({ view, pick });
      }
      return;
    }

    this.selectAtClient(view, event.clientX, event.clientY);
  };

  // ── Picking and highlight ─────────────────────────────────────────────────

  private pick(view: View, x: number, y: number): Pick | null {
    const scene = view.scene();
    const camera = view.camera();
    if (!scene || !camera) {
      return null;
    }
    return pickAt(
      scene,
      camera,
      ndcFromClient(view.canvas, x, y),
      this.raycaster,
      view.canvas.getBoundingClientRect().height
    );
  }

  private hoverAt(view: View, x: number, y: number): void {
    const pick = this.pick(view, x, y);

    for (const other of this.discovery.all()) {
      if (other !== view && other.layer.get("hover")) {
        other.layer.set("hover", null);
        other.redraw();
      }
    }

    const current = view.layer.get("hover");
    if (current?.object !== pick?.object || (current?.instanceId ?? null) !== (pick?.instanceId ?? null)) {
      view.layer.set("hover", pick ? { object: pick.object, instanceId: pick.instanceId } : null);
      view.redraw();
    }

    if (!pick) {
      this.tip.hidden = true;
      return;
    }

    const ref = pick.resolution?.sourceRef;
    const pointed = this.pointing.some((held) => sameTarget(held, { view, pick }));
    this.tip.replaceChildren(
      h("span", { text: kindOf(pick.object) }),
      " · ",
      ref
        ? h("span", { class: "where mono", text: `${ref.file}:${ref.line}` })
        : h("span", { class: "none", text: "no source" }),
      this.pointerMode
        ? h("span", { class: "none", text: pointed ? " · click to remove" : " · click to point" })
        : ""
    );
    this.tip.hidden = false;
    const width = this.tip.offsetWidth;
    this.tip.style.left = `${Math.min(x + 14, window.innerWidth - width - 8)}px`;
    this.tip.style.top = `${Math.min(y + 16, window.innerHeight - 30)}px`;
  }

  private clearHover(): void {
    this.tip.hidden = true;
    for (const view of this.discovery.all()) {
      if (view.layer.get("hover")) {
        view.layer.set("hover", null);
        view.redraw();
      }
    }
  }

  selectAtClient(view: View, x: number, y: number): void {
    const pick = this.pick(view, x, y);
    this.select(pick ? { view, pick } : null);
  }

  select(selection: Target | null): void {
    const previous = this.selection;
    if (previous) {
      previous.view.layer.set("selected", null);
      previous.view.redraw();
    }

    this.editors.begin(null);
    this.selection = selection;
    this.status = null;

    if (selection) {
      selection.view.layer.set("selected", {
        object: selection.pick.object,
        instanceId: selection.pick.instanceId,
      });
      selection.view.redraw();
      this.panelOpen = true;
      if (this.tab === "agent") {
        this.tab = "inspect";
      }
    } else if (this.tab === "inspect") {
      this.panelOpen = false;
    }

    this.render();
    this.save();
    this.publish();
  }

  private closePanel(): void {
    this.panelOpen = false;
    this.tab = "inspect";
    this.select(null);
  }

  // ── Pointing and pinning ──────────────────────────────────────────────────

  private hold(target: Target): Held {
    return { view: target.view, pick: target.pick, address: addressOf(target) };
  }

  /** The boxes for what is held, which outlast any one selection. */
  private showHeld(): void {
    for (const view of this.discovery.all()) {
      const boxes = (list: Held[]) =>
        list
          .filter((held) => held.view === view)
          .map(({ pick }) => ({ object: pick.object, instanceId: pick.instanceId }));
      view.layer.setAll("pointed", boxes(this.pointing));
      view.layer.setAll("pinned", boxes(this.pins));
      view.redraw();
    }
  }

  private togglePointing(target: Target): void {
    const index = this.pointing.findIndex((held) => sameTarget(held, target));
    if (index >= 0) {
      this.pointing.splice(index, 1);
    } else {
      this.pointing.push(this.hold(target));
    }
    this.pointingChanged();
  }

  private pointingChanged(): void {
    this.showHeld();
    this.showPointerState();
    this.renderTabs();
    this.renderToolbar();
    this.renderAgent();
    this.save();
    this.publish();
  }

  private togglePin(target: Target): void {
    const index = this.pins.findIndex((held) => sameTarget(held, target));
    if (index >= 0) {
      this.pins.splice(index, 1);
    } else {
      this.pins.push(this.hold(target));
      if (this.pins.length > MAX_PINS) {
        this.pins.shift();
      }
    }
    this.pinsChanged();
  }

  private pinsChanged(): void {
    this.showHeld();
    this.renderToolbar();
    this.renderCompare();
    this.save();
  }

  /** Tells the assistant what is selected and pointed at, when there is one to tell. */
  private publish(): void {
    if (!this.agent || this.restoring) {
      return;
    }
    this.agent.publish({
      pointing: this.pointing.map(describeTarget),
      selected: this.selection ? describeTarget(this.selection) : null,
    });
  }

  private onAgentChange(): void {
    this.renderTabs();
    this.renderAgent();
    this.place();
  }

  /** A line in the log leads to its object if the scene has it, or else its source. */
  private followEntry(entry: AgentActivity): void {
    const target = entry.targets[0];
    if (!target) {
      return;
    }
    const found = findRefs(this.discovery, target)[0];
    if (found) {
      this.select(found);
    } else {
      void this.open(target.file, target.line, target.column);
    }
  }

  // ── Panel ─────────────────────────────────────────────────────────────────

  private render(): void {
    if (!this.panelOpen) {
      this.panel?.remove();
      this.panel = null;
      this.tabsRow = null;
      this.bodies = null;
      this.toolbar = null;
      this.unsaved = null;
      this.statusLine = null;
      return;
    }

    if (!this.panel) {
      this.tabsRow = h("div", { class: "head", attrs: { role: "tablist" } });
      this.bodies = {
        inspect: h("div", { class: "body", attrs: { role: "tabpanel", "data-cts-tab": "inspect" } }),
        compare: h("div", { class: "body", attrs: { role: "tabpanel", "data-cts-tab": "compare" } }),
        agent: h("div", { class: "body", attrs: { role: "tabpanel", "data-cts-tab": "agent" } }),
      };
      this.unsaved = h("div", { class: "unsaved" });
      this.unsaved.hidden = true;
      this.statusLine = h("div", { class: "status" });
      this.statusLine.hidden = true;
      this.panel = h(
        "div",
        { class: "panel", attrs: { role: "dialog", "aria-label": "Click-to-Source inspector" } },
        [
          this.tabsRow,
          this.bodies.inspect,
          this.bodies.compare,
          this.bodies.agent,
          this.unsaved,
          this.statusLine,
        ]
      );
      this.root.append(this.panel);
    }

    this.renderTabs();
    this.renderInspect();
    this.renderCompare();
    this.renderAgent();
    this.showTab();
    this.showUnsaved();
    this.showStatus();
  }

  private openTab(tab: Tab): void {
    this.tab = tab;
    if (!this.panelOpen) {
      this.panelOpen = true;
      this.render();
    } else {
      this.renderTabs();
      this.showTab();
    }
    this.save();
  }

  private showTab(): void {
    if (!this.panel || !this.bodies) {
      return;
    }
    this.panel.setAttribute("data-tab", this.tab);
    for (const [tab, body] of Object.entries(this.bodies)) {
      body.hidden = tab !== this.tab;
    }
    if (this.tab === "compare") {
      this.renderCompare();
    }
    // Drawn now, so what it shows is current, and so it can ask whether the MCP server is on.
    if (this.tab === "agent") {
      this.renderAgent();
    }
  }

  private renderTabs(): void {
    if (!this.tabsRow) {
      return;
    }

    const tab = (name: Tab, label: string, extras: Array<Node | null> = []) =>
      h(
        "button",
        {
          class: "tab",
          attrs: {
            type: "button",
            role: "tab",
            "aria-selected": String(this.tab === name),
            "data-cts-open-tab": name,
          },
          on: { click: () => this.openTab(name) },
        },
        [label, ...extras]
      );

    const count = this.pointing.length;
    this.tabsRow.replaceChildren(
      tab("inspect", "Inspect"),
      tab("compare", "Compare"),
      ...(this.agent
        ? [
            tab("agent", "Agent", [
              count > 0 ? h("span", { class: "count", text: String(count) }) : null,
              h("span", { class: `dot ${this.agent.connected ? "on" : ""}` }),
            ]),
          ]
        : []),
      h("span", { class: "spacer" }),
      h(
        "button",
        {
          class: "icon-button",
          title: "Close (Esc)",
          attrs: { type: "button", "aria-label": "Close" },
          on: { click: () => this.closePanel() },
        },
        [icon(ICONS.close)]
      )
    );
  }

  private renderInspect(): void {
    const body = this.bodies?.inspect;
    if (!body) {
      return;
    }

    const selection = this.selection;
    this.toolbar = null;
    this.editors.begin(selection?.pick.resolution?.object ?? null);
    this.shownMarks = selection ? marksOf(selection) : [];

    if (!selection) {
      body.replaceChildren(
        h("div", {
          class: "note",
          text: `Nothing selected. Press ${hotkeyLabel(this.options.hotkey)} and click an object.`,
        })
      );
      return;
    }

    const { pick } = selection;
    const object = pick.object;
    const resolution = pick.resolution;

    body.replaceChildren(
      h("div", { class: "title" }, [
        h("span", { class: "kind", text: kindOf(object) }),
        object.name ? h("span", { class: "name mono", text: object.name }) : null,
      ])
    );

    if (resolution) {
      const ref = resolution.sourceRef;
      const stamp = stampOf(resolution.object);
      const column = stamp && stamp.line === ref.line ? stamp.column : undefined;

      body.append(
        h("div", { class: "where-row" }, [
          h("div", {}, [
            h("div", { class: "fn", text: ref.function }),
            h("div", { class: "file mono", text: `${ref.file}:${ref.line}` }),
          ]),
          h(
            "button",
            {
              class: "open",
              title: "Open in editor",
              attrs: { type: "button" },
              on: { click: () => void this.open(ref.file, ref.line, column) },
            },
            [icon(ICONS.open), "Open"]
          ),
        ])
      );
    }

    this.toolbar = h("div", { class: "actions" });
    body.append(this.toolbar);
    this.renderToolbar();

    if (resolution) {
      const ref = resolution.sourceRef;
      const stamp = stampOf(resolution.object);

      if (resolution.object !== object) {
        body.append(
          h("div", {
            class: "note",
            text:
              stamp?.how === "load"
                ? `Part of a model loaded here: ${modelPathOf(selection)}.`
                : `Part of the ${kindOf(resolution.object)} made here: ${modelPathOf(selection)}.`,
          })
        );
      } else if (stamp?.how === "clone") {
        body.append(h("div", { class: "note", text: "A clone of another object, made here." }));
      } else if (stamp?.how === "load") {
        body.append(h("div", { class: "note", text: "A model loaded here." }));
      }

      // Placed by JSX, `<primitive object={rock} />`, and made by plain code elsewhere.
      const made = recordOf(resolution.object)?.stamp;
      if (made && made !== stamp) {
        const how = made.how === "load" ? " by a loader" : made.how === "clone" ? " as a clone" : "";
        const where = made.function === "(top level)" ? " at the top level of the module, " : ` in ${made.function}, `;
        body.append(
          h("div", { class: "note made", attrs: { "data-cts-made": "" } }, [
            `Made${how}${where}`,
            this.sourceLink(made.file, made.line, made.column),
          ])
        );
      }

      const trace = recordOf(resolution.object)?.trace ?? [];
      if (trace.length > 0) {
        body.append(this.calledFromSection(trace));
      }

      if (pick.instanceId !== null && resolution.readonly) {
        body.append(this.instanceSection(pick, ref.args));
      } else if (Object.keys(ref.args ?? {}).length > 0) {
        body.append(this.argsSection(ref));
      }

      const parts = partsOfTarget(selection);
      if (parts.some((part) => part.stamp.props?.length)) {
        body.append(this.propsSection(parts));
      }

      const functions = generatorsOfTarget(selection);
      const uses = this.usesSection(functions);
      if (uses) {
        body.append(uses);
      }
      const numbers = this.numbersSection(functions);
      if (numbers) {
        body.append(numbers);
      }
    } else {
      const parents: string[] = [];
      for (let current = object.parent; current && parents.length < 6; current = current.parent) {
        parents.push(current.name ? `${kindOf(current)} "${current.name}"` : kindOf(current));
      }
      body.append(
        h("div", { class: "note", text: "No source found for this object." }),
        h("div", {
          class: "note",
          text:
            "Neither it nor any parent was made by code in your project. It may " +
            "come from a library or from a loaded model.",
        })
      );
      if (parents.length > 0) {
        body.append(h("div", { class: "parents mono", text: `in ${parents.join(" › ")}` }));
      }
    }

    const performance = this.performanceSection(selection);
    if (performance) {
      body.append(performance);
    }
    body.append(this.detailsSection(pick));
    body.append(
      h("div", {
        class: "hint",
        text: `Drag or type to preview a value, and press Enter to save it to source. ${hotkeyLabel(
          this.options.hotkey
        )} toggles inspect mode.${this.agent ? " Shift+click points your assistant at an object." : ""}`,
      })
    );
  }

  /** What can be done with the selected object. Redrawn alone, to keep any draft. */
  private renderToolbar(): void {
    const toolbar = this.toolbar;
    const selection = this.selection;
    if (!toolbar || !selection) {
      return;
    }

    const action = (
      name: string,
      paths: string[],
      label: string,
      title: string,
      onClick: () => void,
      pressed?: boolean
    ) =>
      h(
        "button",
        {
          class: "action",
          title,
          attrs: {
            type: "button",
            "data-cts-action": name,
            ...(pressed === undefined ? {} : { "aria-pressed": String(pressed) }),
          },
          on: { click: onClick },
        },
        [icon(paths), label]
      );

    const pointed = this.pointing.some((held) => sameTarget(held, selection));
    const pinned = this.pins.some((held) => sameTarget(held, selection));

    toolbar.replaceChildren(
      ...(this.agent
        ? [
            action(
              "point",
              ICONS.point,
              pointed ? "Pointing" : "Point",
              "Show this object to your assistant, then tell it what to do",
              () => this.togglePointing(selection),
              pointed
            ),
          ]
        : []),
      action(
        "pin",
        ICONS.pin,
        pinned ? "Pinned" : "Pin",
        "Pin this object to compare it with another",
        () => this.togglePin(selection),
        pinned
      ),
      action(
        "report",
        ICONS.report,
        "Report",
        "Copy where this came from, its values and a screenshot, for a bug report",
        () => void this.copyBugReport(selection)
      ),
      action(
        "screenshot",
        ICONS.camera,
        "Image",
        "Copy a screenshot of the canvas",
        () => void this.copyScreenshot(selection)
      )
    );
  }

  private renderCompare(): void {
    const body = this.bodies?.compare;
    if (!body || this.tab !== "compare") {
      return;
    }

    const columns: Target[] = [...this.pins];
    if (this.selection && columns.length < 2 && !columns.some((held) => sameTarget(held, this.selection!))) {
      columns.push(this.selection);
    }

    body.replaceChildren(
      ...compareTab({
        columns,
        isPinned: (target) => this.pins.some((held) => sameTarget(held, target)),
        differencesOnly: this.differencesOnly,
        onDifferencesOnly: (on) => {
          this.differencesOnly = on;
          this.renderCompare();
        },
        onUnpin: (target) => this.togglePin(target),
        onSelect: (target) => this.select(target),
      })
    );
  }

  private renderAgent(): void {
    const body = this.bodies?.agent;
    const agent = this.agent;
    if (!body || !agent) {
      return;
    }

    const scroll = body.scrollTop;
    const selection = this.selection;
    body.replaceChildren(
      ...agentTab({
        agents: agent.agents,
        log: agent.log,
        pointing: this.pointing,
        pointerMode: this.pointerMode,
        canPointAtSelection:
          selection !== null && !this.pointing.some((held) => sameTarget(held, selection)),
        onTogglePointerMode: () => this.setPointerMode(!this.pointerMode),
        onPointAtSelection: () => {
          if (selection) {
            this.togglePointing(selection);
          }
        },
        onRemove: (target) => this.togglePointing(target),
        onClear: () => {
          this.pointing = [];
          this.pointingChanged();
        },
        onSelect: (target) => this.select(target),
        onEntry: (entry) => this.followEntry(entry),
        setup: agent.setup,
        setupState: agent.setupState,
        onTurnOnMcp: () => void agent.turnOnMcp(),
      })
    );
    body.scrollTop = scroll;

    // Asked for once, when there's an assistant to connect and the tab is in view.
    if (!agent.connected && agent.setup === null && this.panelOpen && this.tab === "agent" && !this.setupAsked) {
      this.setupAsked = true;
      void agent.checkSetup();
    }
  }

  /** Whether the dev server has been asked if the MCP server is registered. */
  private setupAsked = false;

  private showAgentStatus(): void {
    const line = this.bodies?.agent.querySelector("[data-cts-agent-status]");
    if (line && this.agent && this.tab === "agent") {
      line.textContent = agentStatusText(this.agent.agents, Date.now());
    }
  }

  private showUnsaved(): void {
    const bar = this.unsaved;
    if (!bar) {
      return;
    }

    const count = this.editors.count;
    bar.hidden = count === 0;
    if (count === 0) {
      return;
    }
    bar.replaceChildren(
      h("span", { text: `${plural(count, "unsaved value")} shown in the scene` }),
      h("span", { class: "spacer" }),
      h(
        "button",
        {
          class: "action",
          attrs: { type: "button", "data-cts-action": "revert" },
          on: { click: () => this.editors.revert() },
        },
        ["Revert"]
      ),
      h(
        "button",
        {
          class: "action primary",
          attrs: { type: "button", "data-cts-action": "save" },
          on: { click: () => void this.editors.saveAll() },
        },
        ["Save"]
      )
    );
  }

  private setStatus(kind: "ok" | "error", text: string): void {
    this.status = { kind, text };
    this.showStatus();
  }

  private showStatus(): void {
    if (!this.statusLine) {
      return;
    }
    this.statusLine.hidden = !this.status;
    this.statusLine.className = `status ${this.status?.kind ?? ""}`;
    this.statusLine.textContent = this.status?.text ?? "";
    this.statusLine.setAttribute("role", this.status?.kind === "error" ? "alert" : "status");
  }

  /** A file and line that opens in the editor. */
  private sourceLink(file: string, line: number, column?: number): HTMLElement {
    return h("button", {
      class: "link mono",
      text: `${file}:${line}`,
      title: "Open in editor",
      attrs: { type: "button" },
      on: { click: () => void this.open(file, line, column) },
    });
  }

  private readonlyValue(text: string): HTMLElement {
    return h("div", { class: "values" }, [
      h("div", { class: "value ro" }, [h("div", { class: "readonly mono", text })]),
    ]);
  }

  /** The calls that led to an object, nearest first, with what each was given. */
  private calledFromSection(trace: TraceFrame[]): HTMLElement {
    const content = h("div", {});

    for (const frame of [...trace].reverse()) {
      const where = frame.calledAt ?? frame;
      content.append(
        h("div", { class: "frame", attrs: { "data-cts-frame": frame.name } }, [
          h("div", { class: "frame-head" }, [
            h("span", { class: "fn mono", text: frame.name }),
            this.sourceLink(where.file, where.line, where.column),
          ]),
          ...frame.args.map((arg) => {
            const site = frame.calledAt;
            return h("div", { class: "prop" }, [
              h("div", { class: "label mono", text: arg.name, title: arg.name }),
              arg.literal && site
                ? h("div", { class: "values" }, [
                    this.editors.editor(
                      site.file,
                      { element: frame.name, name: arg.name, array: false, values: [arg.literal] },
                      arg.literal,
                      0,
                      { live: false }
                    ),
                  ])
                : this.readonlyValue(arg.value),
            ]);
          }),
        ])
      );
    }

    return this.foldable("called", ["Called from"], content);
  }

  private propsSection(parts: TargetPart[]): HTMLElement {
    const section = h("div", { class: "section" }, [
      h("div", { class: "section-title", text: "Properties" }),
    ]);

    parts.forEach((part, partIndex) => {
      const { stamp } = part;
      let element: string | null = null;

      for (const prop of stamp.props ?? []) {
        if (prop.element !== element) {
          element = prop.element;
          section.append(
            h("div", { class: "element mono" }, [
              elementLabel(prop.element),
              // The first is what the panel's heading already names.
              partIndex > 0 ? this.sourceLink(stamp.file, stamp.line, stamp.column) : null,
            ])
          );
        }
        section.append(
          h("div", { class: "prop" }, [
            h("div", { class: "label mono", text: prop.name, title: prop.name }),
            h(
              "div",
              { class: "values" },
              prop.values.map((value, index) =>
                this.editors.editor(stamp.file, prop, value, index, { live: part.live })
              )
            ),
          ])
        );
      }
    });

    return section;
  }

  /** The numbers on the lines of a function, each with the line it is on. */
  private numbersBlock(file: string, owner: string, groups: SourceNumbers[]): HTMLElement {
    return h(
      "div",
      { class: "numbers" },
      groups.map((group) =>
        h("div", { class: "number-line" }, [
          h("div", { class: "line-text mono", title: group.text }, [
            h("span", { class: "line-no", text: String(group.line) }),
            group.text,
          ]),
          h(
            "div",
            { class: "values" },
            group.values.map((value, index) =>
              this.editors.editor(
                file,
                { element: owner, name: `line ${group.line}`, array: true, values: group.values },
                value,
                index,
                { live: false }
              )
            )
          ),
        ])
      )
    );
  }

  /** The helpers behind an object: its noise function, and what that calls in turn. */
  private usesSection(functions: SourceFunction[]): HTMLElement | null {
    const seen = new Set<string>();
    const uses: UsedFunction[] = [];
    for (const fn of functions) {
      for (const use of fn.uses) {
        const key = use.file ? `${use.file}:${use.line}` : `${use.package}#${use.name}`;
        if (!seen.has(key)) {
          seen.add(key);
          uses.push(use);
        }
      }
    }
    if (uses.length === 0) {
      return null;
    }

    const content = h("div", {});
    for (const use of uses) {
      const signature = use.params ? `${use.name}(${use.params.join(", ")})` : use.name;
      const head = h("div", { class: "use-head" }, [
        h("span", { class: "fn mono", text: signature }),
        use.file && use.line !== undefined
          ? this.sourceLink(use.file, use.line, use.column)
          : h("span", { class: "package mono", text: use.package ?? "" }),
      ]);
      const row = h("div", { class: "use", attrs: { "data-cts-use": use.name } }, [
        use.file && use.numbers?.length
          ? this.foldable(
              `use:${use.file}:${use.name}`,
              [head],
              this.numbersBlock(use.file, use.name, use.numbers)
            )
          : head,
      ]);
      row.style.marginLeft = `${use.depth * 12}px`;
      content.append(row);
    }

    return this.foldable("uses", ["Uses"], content);
  }

  /** Every other number in the functions that made an object. */
  private numbersSection(functions: SourceFunction[]): HTMLElement | null {
    const withNumbers = functions.filter((fn) => fn.numbers.length > 0);
    if (withNumbers.length === 0) {
      return null;
    }

    const count = withNumbers.reduce(
      (total, fn) => total + fn.numbers.reduce((sum, group) => sum + group.values.length, 0),
      0
    );
    const content = h("div", {});
    for (const fn of withNumbers) {
      if (withNumbers.length > 1) {
        content.append(
          h("div", { class: "element mono" }, [fn.name, this.sourceLink(fn.file, fn.line, fn.column)])
        );
      }
      content.append(this.numbersBlock(fn.file, fn.name, fn.numbers));
    }

    return this.foldable(
      "numbers",
      ["Numbers", h("span", { class: "headline mono", text: String(count) })],
      content
    );
  }

  /** Values from a hand-written sourceRef, edited by name as before. */
  private argsSection(ref: NonNullable<Pick["resolution"]>["sourceRef"]): HTMLElement {
    const section = h("div", { class: "section" }, [
      h("div", { class: "section-title", text: "Arguments" }),
    ]);

    for (const [name, current] of Object.entries(ref.args)) {
      const asStamped: StampedValue = {
        raw: typeof current === "string" ? JSON.stringify(current) : String(current),
        value: current as StampedValue["value"],
        editable: true,
      };
      const input = h("input", { attrs: { type: "text", spellcheck: "false", "aria-label": name } });
      const initial = draftOf(asStamped);
      input.value = initial;
      input.addEventListener("input", () => input.classList.toggle("dirty", input.value !== initial));
      input.addEventListener("keydown", (event) => {
        if (event.key !== "Enter" || input.value === initial) {
          return;
        }
        event.preventDefault();
        const parsed = parseDraft(asStamped, input.value);
        if (!parsed.ok) {
          this.setStatus("error", parsed.error);
          return;
        }
        input.disabled = true;
        editSourceFile(ref, name, parsed.value)
          .then(() => this.setStatus("ok", `Saved ${name}. Vite is updating the scene.`))
          .catch((error) => this.setStatus("error", errorText(error)))
          .finally(() => {
            input.disabled = false;
          });
      });
      section.append(
        h("div", { class: "prop" }, [
          h("div", { class: "label mono", text: name }),
          h("div", { class: "values" }, [h("div", { class: "value" }, [input])]),
        ])
      );
    }

    return section;
  }

  private instanceSection(pick: Pick, args: Record<string, unknown>): HTMLElement {
    const mesh = pick.object as THREE.InstancedMesh;
    const grid = h("div", { class: "detail-grid" });
    for (const [name, value] of Object.entries(args)) {
      grid.append(h("div", { class: "k mono", text: name }), h("div", { class: "mono", text: String(value) }));
    }

    return h("div", { class: "section" }, [
      h("div", {
        class: "section-title",
        text: `Instance ${pick.instanceId} of ${mesh.count}`,
      }),
      h("div", {
        class: "note",
        text: "Read-only: an instance's placement comes from the code that wrote its matrix.",
      }),
      grid,
    ]);
  }

  /** A <details> that stays open or closed across redraws of the panel. */
  private foldable(name: string, summary: Array<Node | string>, content: HTMLElement): HTMLDetailsElement {
    const details = h("details", {}, [h("summary", {}, summary), content]);
    details.open = this.openSections.has(name);
    details.addEventListener("toggle", () => {
      if (details.open) {
        this.openSections.add(name);
      } else {
        this.openSections.delete(name);
      }
    });
    return details;
  }

  /** What drawing the object costs: the answer to "why is this slow?" */
  private performanceSection(selection: Target): HTMLElement | null {
    const cost: ObjectCost | null = measureObject(selection.pick.object);
    if (!cost) {
      return null;
    }

    const grid = h("div", { class: "detail-grid" });
    const row = (key: string, value: string) =>
      grid.append(h("div", { class: "k", text: key }), h("div", { class: "mono", text: value }));

    row("triangles", formatCount(cost.triangles));
    row("draw calls", formatCount(cost.drawCalls));
    row("vertices", formatCount(cost.vertices));
    if (cost.instances !== null) {
      row("instances", formatCount(cost.instances));
    }
    if (cost.meshes > 1) {
      row("meshes", formatCount(cost.meshes));
    }
    row("geometry", formatBytes(cost.geometryBytes));
    row("materials", formatCount(cost.materials));
    for (const texture of cost.textures) {
      const size = texture.width !== null ? `${texture.width}×${texture.height}` : "not loaded";
      row(texture.slot, texture.bytes !== null ? `${size} · ${formatBytes(texture.bytes)}` : size);
    }
    if (cost.castsShadow) {
      row("casts shadow", "drawn again per light");
    }

    // The last frame, as three counted it. A composer's final pass draws one
    // triangle, so a total smaller than this one object says nothing about it.
    const frame = selection.view.renderer.info?.render;
    if (frame && frame.triangles >= cost.triangles && cost.triangles > 0) {
      const share = Math.round((cost.triangles / frame.triangles) * 100);
      row("of the frame", `${share < 1 ? "under 1" : share}% of ${formatCount(frame.triangles)} triangles`);
    }

    if (selection.pick.instanceId !== null) {
      grid.append(h("div", { class: "span", text: "For the whole InstancedMesh, which draws its instances together." }));
    }

    return this.foldable(
      "performance",
      [
        "Performance",
        h("span", {
          class: "headline mono",
          text: `${plural(cost.triangles, "triangle")} · ${plural(cost.drawCalls, "draw call")}`,
        }),
      ],
      grid
    );
  }

  private detailsSection(pick: Pick): HTMLElement {
    const details = describeMesh(pick.object, pick.instanceId);
    const grid = h("div", { class: "detail-grid" });
    const row = (key: string, value: string) =>
      grid.append(h("div", { class: "k", text: key }), h("div", { class: "mono", text: value }));

    const world = new THREE.Vector3();
    pick.object.getWorldPosition(world);
    row("world position", world.toArray().map((n) => Number(n.toFixed(3))).join(", "));

    if (details?.geometry) {
      if (details.geometry.vertexCount !== null) {
        row("vertices", details.geometry.vertexCount.toLocaleString());
      }
      if (details.geometry.triangleCount !== null) {
        row("triangles", details.geometry.triangleCount.toLocaleString());
      }
    }
    for (const material of details?.materials ?? []) {
      row("material", material.color ? `${material.type} ${material.color}` : material.type);
    }

    return this.foldable("details", ["Details"], grid);
  }

  private async open(file: string, line: number, column?: number): Promise<void> {
    try {
      const response = await fetch(OPEN_IN_EDITOR_PATH, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ file, line, column }),
      });
      if (!response.ok) {
        const payload = (await response.json().catch(() => ({}))) as { error?: string };
        this.setStatus("error", payload.error ?? "Could not open the editor");
      }
    } catch (error) {
      this.setStatus("error", errorText(error));
    }
  }

  // ── Copying ───────────────────────────────────────────────────────────────

  private async copyBugReport(target: Target): Promise<void> {
    const markdown = reportMarkdown(describeTarget(target), {
      url: location.href,
      threeRevision: THREE.REVISION,
      userAgent: navigator.userAgent,
    });
    const image = captureView(target.view, { mimeType: "image/png", maxSize: 1600 }).then(blobOf);
    // The text is worth having without the picture, and a copy may finish
    // without ever looking at it.
    image.catch(() => undefined);

    try {
      const { picture } = await copyReport(markdown, image);
      this.setStatus(
        "ok",
        picture
          ? "Copied the report. Pasted as plain text it is Markdown; pasted into a doc or chat, the screenshot comes too."
          : "Copied the report as Markdown."
      );
    } catch (error) {
      this.setStatus("error", `Could not copy: ${errorText(error)}`);
    }
  }

  private async copyScreenshot(target: Target): Promise<void> {
    const image = captureView(target.view, { mimeType: "image/png" }).then(blobOf);
    image.catch(() => undefined);

    try {
      await copyImage(image);
      this.setStatus("ok", "Copied a screenshot of the canvas.");
    } catch (error) {
      this.setStatus("error", `Could not copy: ${errorText(error)}`);
    }
  }

  // ── Surviving an update or a reload ───────────────────────────────────────

  private refreshSoon(): void {
    // R3F applies the new stamp when React re-renders, which follows the
    // module update by a moment. More than once, so a slow re-render is still
    // caught, and an object only counts as gone after the last.
    const delays = [80, 400, 1500];
    this.refreshGeneration++;
    const generation = this.refreshGeneration;
    delays.forEach((delay, index) => {
      setTimeout(() => {
        // A later update starts the count again.
        this.refresh(index === delays.length - 1 && generation === this.refreshGeneration);
      }, delay);
    });
  }

  /**
   * Keeps what is still in its scene, and finds a remounted object by address.
   *
   * An object missing from its scene is not gone yet. An update that remounts a
   * component unmounts everything first, so a look in that gap finds nothing,
   * and dropping what is held then would lose it for good: Vite may follow with
   * a reload, which restores from what was last saved. Found by an edit to an
   * entry module, where an assistant's list of two objects came back as one.
   */
  private reheld(list: Held[], final: boolean): Held[] {
    const kept: Held[] = [];
    for (const held of list) {
      const scene = held.view.scene();
      if (scene && isInside(held.pick.object, scene)) {
        held.pick.resolution = resolveSourceRef(held.pick.object, held.pick.instanceId ?? undefined);
        held.address = addressOf(held) ?? held.address;
        kept.push(held);
        continue;
      }
      const found = held.address ? findAddress(this.discovery, held.address) : null;
      if (found) {
        kept.push(this.hold(found));
      } else if (!final) {
        kept.push(held);
      }
    }
    return kept;
  }

  private refresh(final: boolean): void {
    // Each write in a save brings its own update. The save refreshes when done.
    if (this.editors.busy) {
      return;
    }

    if (this.selection === null && this.pointing.length === 0 && this.pins.length === 0) {
      return;
    }

    this.pointing = this.reheld(this.pointing, final);
    this.pins = this.reheld(this.pins, final);
    this.showHeld();
    this.showPointerState();

    const selection = this.selection;

    if (selection) {
      const scene = selection.view.scene();
      if (scene && isInside(selection.pick.object, scene)) {
        selection.pick.resolution = resolveSourceRef(
          selection.pick.object,
          selection.pick.instanceId ?? undefined
        );
      } else {
        // The object was replaced — a remount. Find its successor by address.
        const found = this.lastAddress ? findAddress(this.discovery, this.lastAddress) : null;
        if (found) {
          this.dropDrafts();
          const status = this.status;
          this.select(found);
          this.status = status;
          this.showStatus();
          return;
        }
      }
    }

    // Any module's update lands here, a stylesheet's included. Only one that
    // changed this object's stamp is worth redrawing for, and taking a value
    // being dragged along with it.
    if (selection && !sameMarks(marksOf(selection), this.shownMarks)) {
      this.dropDrafts();
      this.renderInspect();
    }
    this.renderTabs();
    this.renderToolbar();
    this.renderCompare();
    this.renderAgent();
    this.save();
    this.publish();
  }

  /**
   * The positions behind a draft may have moved, and an edit to them would be
   * refused anyway. Unsaved work on a stale view is not worth keeping.
   */
  private dropDrafts(): void {
    if (this.editors.count > 0) {
      this.editors.revert();
      this.setStatus("error", "The source changed, so unsaved values were put back.");
    }
  }

  private save(): void {
    if (this.restoring) {
      return;
    }

    this.lastAddress = this.selection ? addressOf(this.selection) : null;
    const addresses = (list: Held[]) =>
      list.map((held) => held.address).filter((address): address is Address => address !== null);

    try {
      const saved: Saved = {
        inspecting: this.inspecting,
        pointerMode: this.pointerMode,
        panelOpen: this.panelOpen,
        tab: this.tab,
        selection: this.lastAddress,
        pointing: addresses(this.pointing),
        pins: addresses(this.pins),
      };
      sessionStorage.setItem(STORAGE_KEY, JSON.stringify(saved));
    } catch {
      // Storage unavailable: the mode simply does not survive a reload.
    }
  }

  /**
   * Puts back the mode, the selection, and what is pointed at and pinned after a
   * full reload. Saving a value in a module React cannot hot-swap — often the
   * app's entry — reloads the page, and losing all of it after every such save
   * would make editing tedious. It would also make an assistant that edited a
   * value lose sight of what the developer pointed it at.
   *
   * Until this finishes the server keeps what the page last told it, so an
   * assistant asking during a reload still gets an answer.
   */
  private restore(): void {
    let saved: Partial<Saved> | null = null;
    try {
      saved = JSON.parse(sessionStorage.getItem(STORAGE_KEY) ?? "null") as Partial<Saved> | null;
    } catch {
      return;
    }
    if (!saved) {
      return;
    }

    const memory = saved;
    this.restoring = true;
    this.tab = memory.tab ?? "inspect";

    let selection = memory.selection ?? null;
    type Slot = { address: Address; held: Held | null };
    const slots = (addresses: Address[] | undefined): Slot[] =>
      (addresses ?? []).map((address) => ({ address, held: null }));
    const pointing = slots(memory.pointing);
    const pins = slots(memory.pins);
    let started: number | null = null;

    const attempt = () => {
      this.discovery.refresh();
      const ready = this.discovery.all().length > 0;

      // No canvas yet says nothing about what will be in it: a slow load, or a
      // route of a single-page app with no scene on it. Giving up here would
      // lose what was saved, so the clock only starts once there is a canvas.
      if (!ready) {
        setTimeout(attempt, 500);
        return;
      }
      started ??= performance.now();

      if (memory.inspecting && !this.inspecting) {
        this.pointerMode = memory.pointerMode === true;
        this.setInspecting(true);
        this.showPointerState();
      }

      const found = selection ? findAddress(this.discovery, selection) : null;
      if (found) {
        selection = null;
        const tab = this.tab;
        this.select(found);
        this.tab = tab;
        this.showTab();
        this.renderTabs();
      }

      // In the order they were saved, however they turn up: "the second one"
      // has to go on meaning the same object.
      let changed = false;
      const take = (wanted: Slot[], current: Held[]): Held[] => {
        for (const slot of wanted) {
          const target = slot.held ? null : findAddress(this.discovery, slot.address);
          if (target) {
            slot.held = this.hold(target);
            changed = true;
          }
        }
        const restored = wanted.flatMap((slot) => (slot.held ? [slot.held] : []));
        return [...restored, ...current.filter((held) => !restored.includes(held))];
      };
      this.pointing = take(pointing, this.pointing);
      this.pins = take(pins, this.pins);
      if (changed) {
        this.showHeld();
        this.showPointerState();
        this.renderTabs();
        this.renderToolbar();
        this.renderCompare();
        this.renderAgent();
      }

      // The Inspect tab opens with its selection; the others have nothing to wait for.
      if (memory.panelOpen && memory.tab !== "inspect" && !this.panelOpen) {
        this.panelOpen = true;
        this.render();
      }

      const waiting =
        selection !== null || [...pointing, ...pins].some((slot) => slot.held === null);
      if (waiting && performance.now() - started < 8000) {
        setTimeout(attempt, 200);
        return;
      }

      this.restoring = false;
      this.save();
      this.publish();
    };
    setTimeout(attempt, 100);
  }

  // ── For tests and debugging ───────────────────────────────────────────────

  describe() {
    const selection = this.selection;
    if (!selection) {
      return null;
    }
    const ref = selection.pick.resolution?.sourceRef ?? null;
    return {
      kind: kindOf(selection.pick.object),
      instanceId: selection.pick.instanceId,
      file: ref?.file ?? null,
      line: ref?.line ?? null,
      function: ref?.function ?? null,
      ...(({ props, trace, generators, how, modelPath, materials }) => ({
        props,
        trace,
        generators,
        how,
        modelPath,
        materials,
      }))(describeTarget(selection)),
    };
  }

  /** Where on the page an object stamped at a line is drawn, for a test to click. */
  screenPointOf(file: string, line: number): { x: number; y: number } | null {
    for (const view of this.discovery.all()) {
      const scene = view.scene();
      const camera = view.camera();
      if (!scene || !camera) {
        continue;
      }
      let target: THREE.Object3D | null = null;
      scene.traverse((object) => {
        const stamp = stampOf(object);
        if (!target && stamp && stamp.file === file && stamp.line === line) {
          target = object;
        }
      });
      if (!target) {
        continue;
      }
      const center = new THREE.Box3()
        .setFromObject(target as THREE.Object3D)
        .getCenter(new THREE.Vector3())
        .project(camera);
      const rect = view.canvas.getBoundingClientRect();
      return {
        x: rect.left + ((center.x + 1) / 2) * rect.width,
        y: rect.top + ((1 - center.y) / 2) * rect.height,
      };
    }
    return null;
  }

  /** What is under a point on the page, without selecting it. */
  describeAt(x: number, y: number) {
    const view = this.discovery.all().find((candidate) => {
      const rect = candidate.canvas.getBoundingClientRect();
      return x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;
    });
    const pick = view ? this.pick(view, x, y) : null;
    if (!pick) {
      return null;
    }
    const ref = pick.resolution?.sourceRef ?? null;
    return {
      kind: kindOf(pick.object),
      instanceId: pick.instanceId,
      file: ref?.file ?? null,
      line: ref?.line ?? null,
    };
  }

  api() {
    return {
      setInspecting: (on: boolean) => this.setInspecting(on),
      isInspecting: () => this.inspecting,
      selection: () => this.describe(),
      describeAt: (x: number, y: number) => this.describeAt(x, y),
      screenPointOf: (file: string, line: number) => this.screenPointOf(file, line),
      clear: () => this.closePanel(),
      pointing: () => this.pointing.map(labelOf),
      pins: () => this.pins.map(labelOf),
      looking: () => this.agent?.looking() ?? [],
    };
  }
}

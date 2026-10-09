import * as THREE from "three";
import {
  OPEN_IN_EDITOR_PATH,
  type SourceStamp,
  type StampedProp,
  type StampedValue,
} from "@click-to-source-3d/shared";
import { resolveSourceRef } from "@click-to-source-3d/core";
import {
  describeMesh,
  editSourceAt,
  editSourceFile,
  ndcFromClient,
  pickAt,
  type HotChannel,
  type Pick,
} from "@click-to-source-3d/core/devtools";
import type { Discovery, View } from "./discovery.js";
import { h, icon, ICONS } from "./dom.js";
import { STYLES } from "./styles.js";
import { draftOf, parseDraft } from "./values.js";

export type InspectorOptions = {
  /** e.g. "alt+shift+c". */
  hotkey: string;
  /** Show the toggle button on the canvas. */
  button: boolean;
};

type Selection = { view: View; pick: Pick };

/** Enough to find a selection again after a full reload. */
type Address = {
  file: string;
  line: number;
  column?: number;
  ordinal: number;
  instanceId: number | null;
};

type Saved = { inspecting: boolean; selection: Address | null };

const STORAGE_KEY = "__cts_inspector";

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

function kindOf(object: THREE.Object3D): string {
  // three gives InstancedMesh no type string of its own.
  return (object as THREE.InstancedMesh).isInstancedMesh ? "InstancedMesh" : object.type;
}

function stampOf(object: THREE.Object3D | undefined): SourceStamp | undefined {
  return object?.userData?.__ctsSource as SourceStamp | undefined;
}

function sameSite(a: SourceStamp, b: { file: string; line: number; column?: number }): boolean {
  return a.file === b.file && a.line === b.line && (b.column === undefined || a.column === b.column);
}

function isInside(object: THREE.Object3D, root: THREE.Object3D): boolean {
  for (let current: THREE.Object3D | null = object; current; current = current.parent) {
    if (current === root) {
      return true;
    }
  }
  return false;
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
  private readonly tip: HTMLDivElement;
  private panel: HTMLElement | null = null;
  private statusLine: HTMLElement | null = null;

  private inspecting = false;
  private selection: Selection | null = null;
  private status: { kind: "ok" | "error"; text: string } | null = null;
  private downAt: { x: number; y: number } | null = null;
  private pendingHover: { view: View; x: number; y: number } | null = null;
  private hoverFrame = 0;
  private noteShown = false;
  private readonly cursors = new Map<HTMLCanvasElement, string>();
  private readonly raycaster = new THREE.Raycaster();

  constructor(
    private readonly discovery: Discovery,
    private readonly options: InspectorOptions,
    private readonly hot: HotChannel | null
  ) {
    this.hotkey = parseHotkey(options.hotkey);

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
    this.tip = h("div", { class: "tip" });
    this.tip.hidden = true;
    this.root.append(this.toggle, this.tip);

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
    // panel opening beside it.
    setInterval(this.place, 1000);

    this.discovery.onView(() => this.place());
    this.place();

    // After Save, Vite updates the module and R3F re-applies the new stamp to
    // the same object. Re-read it then, so positions and values stay current.
    this.hot?.on("vite:afterUpdate", (() => this.refreshSoon()) as (data: never) => void);

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
    }

    const global = globalThis as { __CTS_MANUAL_OVERLAY__?: boolean };
    if (on && global.__CTS_MANUAL_OVERLAY__ && !this.noteShown) {
      this.noteShown = true;
      console.info(
        "[click-to-source] The inspector is built in now. <GenerationTrace />, " +
          "<SelectionHighlight /> and <ClickToSourceBridge /> can be removed from your app."
      );
    }

    this.save();
  }

  /** Puts the toggle button at the bottom-right corner of the main canvas. */
  private place = (): void => {
    const view = this.discovery.primary();

    if (!view || !this.options.button) {
      this.toggle.hidden = true;
      return;
    }

    const rect = view.canvas.getBoundingClientRect();
    const size = 34;
    const inset = 12;
    const left = Math.min(rect.right, window.innerWidth) - size - inset;
    const top = Math.min(rect.bottom, window.innerHeight) - size - inset;
    this.toggle.style.left = `${Math.max(rect.left + inset, left)}px`;
    this.toggle.style.top = `${Math.max(rect.top + inset, top)}px`;
    this.toggle.hidden = false;
  };

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
      } else if (this.selection) {
        this.select(null);
      }
    }
  };

  private onPointerMove = (event: PointerEvent): void => {
    if (!this.inspecting) {
      return;
    }

    const view = this.discovery.forCanvas(event.target);
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

    const view = this.discovery.forCanvas(event.target);
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

    this.selectAtClient(view, event.clientX, event.clientY);
  };

  // ── Picking and highlight ─────────────────────────────────────────────────

  private pick(view: View, x: number, y: number): Pick | null {
    const scene = view.scene();
    const camera = view.camera();
    if (!scene || !camera) {
      return null;
    }
    return pickAt(scene, camera, ndcFromClient(view.canvas, x, y), this.raycaster);
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
    this.tip.replaceChildren(
      h("span", { text: kindOf(pick.object) }),
      " · ",
      ref
        ? h("span", { class: "where mono", text: `${ref.file}:${ref.line}` })
        : h("span", { class: "none", text: "no source" })
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

  select(selection: Selection | null): void {
    const previous = this.selection;
    if (previous) {
      previous.view.layer.set("selected", null);
      previous.view.redraw();
    }

    this.selection = selection;
    this.status = null;

    if (selection) {
      selection.view.layer.set("selected", {
        object: selection.pick.object,
        instanceId: selection.pick.instanceId,
      });
      selection.view.redraw();
    }

    this.render();
    this.save();
  }

  // ── Panel ─────────────────────────────────────────────────────────────────

  private render(): void {
    this.panel?.remove();
    this.panel = null;
    this.statusLine = null;

    const selection = this.selection;
    if (!selection) {
      return;
    }

    const { pick } = selection;
    const object = pick.object;
    const resolution = pick.resolution;

    const head = h("div", { class: "head" }, [
      h("span", { class: "kind", text: kindOf(object) }),
      object.name ? h("span", { class: "name mono", text: object.name }) : null,
      h("span", { class: "spacer" }),
      h(
        "button",
        {
          class: "icon-button",
          title: "Close (Esc)",
          attrs: { type: "button", "aria-label": "Close" },
          on: { click: () => this.select(null) },
        },
        [icon(ICONS.close)]
      ),
    ]);

    const body = h("div", { class: "body" });

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

      if (resolution.object !== object) {
        body.append(
          h("div", {
            class: "note",
            text: `Defined on its parent ${kindOf(resolution.object)}.`,
          })
        );
      }

      if (pick.instanceId !== null && resolution.readonly) {
        body.append(this.instanceSection(pick, ref.args));
      } else if (Object.keys(ref.args ?? {}).length > 0) {
        body.append(this.argsSection(ref));
      }

      if (stamp?.props?.length) {
        body.append(this.propsSection(stamp));
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
            "Neither it nor any parent was created by JSX in your project. It may " +
            "come from a library component, a loaded model, or code outside JSX.",
        })
      );
      if (parents.length > 0) {
        body.append(h("div", { class: "parents mono", text: `in ${parents.join(" › ")}` }));
      }
    }

    body.append(this.detailsSection(pick));
    body.append(
      h("div", {
        class: "hint",
        text: `Edit a value and press Enter to save it to source. ${hotkeyLabel(
          this.options.hotkey
        )} toggles inspect mode.`,
      })
    );

    this.statusLine = h("div", { class: "status" });
    this.statusLine.hidden = true;
    this.panel = h(
      "div",
      { class: "panel", attrs: { role: "dialog", "aria-label": "Click-to-Source inspector" } },
      [head, body, this.statusLine]
    );
    this.root.append(this.panel);
    this.showStatus();
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

  private propsSection(stamp: SourceStamp): HTMLElement {
    const section = h("div", { class: "section" }, [
      h("div", { class: "section-title", text: "Properties" }),
    ]);
    let element: string | null = null;

    for (const prop of stamp.props ?? []) {
      if (prop.element !== element) {
        element = prop.element;
        section.append(h("div", { class: "element mono", text: `<${prop.element}>` }));
      }
      section.append(
        h("div", { class: "prop" }, [
          h("div", { class: "label mono", text: prop.name, title: prop.name }),
          h(
            "div",
            { class: "values" },
            prop.values.map((value, index) => this.valueEditor(stamp.file, prop, value, index))
          ),
        ])
      );
    }

    return section;
  }

  private valueEditor(file: string, prop: StampedProp, value: StampedValue, index: number): HTMLElement {
    if (!value.editable) {
      return h("div", { class: "value ro" }, [h("div", { class: "readonly mono", text: value.raw })]);
    }

    const name = `${prop.element}.${prop.name}${prop.array ? `[${index}]` : ""}`;
    const input = h("input", {
      attrs: { type: "text", spellcheck: "false", "aria-label": name, "data-cts-edit": name },
    });
    const initial = draftOf(value);
    input.value = initial;

    input.addEventListener("input", () => input.classList.toggle("dirty", input.value !== initial));
    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        void this.saveValue(file, prop, value, input, initial);
      } else if (event.key === "Escape") {
        input.value = initial;
        input.classList.remove("dirty");
        input.blur();
      }
    });

    return h("div", { class: "value" }, [
      input,
      value.via
        ? h("div", { class: "via mono", text: `${value.via} · line ${value.line}` })
        : null,
    ]);
  }

  private async saveValue(
    file: string,
    prop: StampedProp,
    value: StampedValue,
    input: HTMLInputElement,
    initial: string
  ): Promise<void> {
    if (input.value === initial) {
      return;
    }

    const parsed = parseDraft(value, input.value);
    if (!parsed.ok) {
      this.setStatus("error", parsed.error);
      return;
    }

    input.disabled = true;
    try {
      await editSourceAt(file, value, parsed.value, prop.name);
      input.classList.remove("dirty");
      this.setStatus("ok", `Saved ${value.via ?? prop.name}. Vite is updating the scene.`);
    } catch (error) {
      this.setStatus("error", errorText(error));
    } finally {
      input.disabled = false;
    }
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

    return h("details", {}, [h("summary", { text: "Details" }), grid]);
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

  // ── Surviving an update or a reload ───────────────────────────────────────

  private refreshSoon(): void {
    // R3F applies the new stamp when React re-renders, which follows the
    // module update by a moment. Twice, so a slow re-render is still caught.
    for (const delay of [80, 400]) {
      setTimeout(() => this.refresh(), delay);
    }
  }

  private refresh(): void {
    const selection = this.selection;
    if (!selection) {
      return;
    }

    const scene = selection.view.scene();
    if (scene && isInside(selection.pick.object, scene)) {
      selection.pick.resolution = resolveSourceRef(
        selection.pick.object,
        selection.pick.instanceId ?? undefined
      );
      this.render();
      return;
    }

    // The object was replaced — a remount. Find its successor by address.
    const address = this.lastAddress;
    const found = address ? this.find(address) : null;
    if (found) {
      const status = this.status;
      this.select(found);
      this.status = status;
      this.showStatus();
    }
  }

  private lastAddress: Address | null = null;

  private addressOf(selection: Selection): Address | null {
    const resolved = selection.pick.resolution?.object;
    const stamp = stampOf(resolved);
    const scene = selection.view.scene();
    if (!resolved || !stamp || !scene) {
      return null;
    }

    let ordinal = 0;
    let found = -1;
    scene.traverse((object) => {
      const other = stampOf(object);
      if (other && sameSite(other, stamp)) {
        if (object === resolved) {
          found = ordinal;
        }
        ordinal++;
      }
    });

    return found < 0
      ? null
      : {
          file: stamp.file,
          line: stamp.line,
          column: stamp.column,
          ordinal: found,
          instanceId: selection.pick.instanceId,
        };
  }

  private find(address: Address): Selection | null {
    for (const view of this.discovery.all()) {
      const scene = view.scene();
      if (!scene) {
        continue;
      }
      let ordinal = 0;
      let match: THREE.Object3D | null = null;
      scene.traverse((object) => {
        const stamp = stampOf(object);
        if (!match && stamp && sameSite(stamp, address)) {
          if (ordinal === address.ordinal) {
            match = object;
          }
          ordinal++;
        }
      });
      if (match) {
        const object = match as THREE.Object3D;
        return {
          view,
          pick: {
            object,
            instanceId: address.instanceId,
            point: object.getWorldPosition(new THREE.Vector3()),
            distance: 0,
            resolution: resolveSourceRef(object, address.instanceId ?? undefined),
          },
        };
      }
    }
    return null;
  }

  private save(): void {
    this.lastAddress = this.selection ? this.addressOf(this.selection) : null;
    try {
      const saved: Saved = { inspecting: this.inspecting, selection: this.lastAddress };
      sessionStorage.setItem(STORAGE_KEY, JSON.stringify(saved));
    } catch {
      // Storage unavailable: the mode simply does not survive a reload.
    }
  }

  /**
   * Puts back the mode and selection after a full reload. Saving a value in
   * a module React cannot hot-swap — often the app's entry — reloads the
   * page, and losing the panel after every such save would make editing
   * tedious.
   */
  private restore(): void {
    let saved: Saved | null = null;
    try {
      saved = JSON.parse(sessionStorage.getItem(STORAGE_KEY) ?? "null") as Saved | null;
    } catch {
      return;
    }
    if (!saved) {
      return;
    }

    const started = performance.now();
    const attempt = () => {
      this.discovery.refresh();
      if (saved!.inspecting && this.discovery.all().length > 0) {
        this.setInspecting(true);
      }
      const found = saved!.selection ? this.find(saved!.selection) : null;
      if (found) {
        this.select(found);
        return;
      }
      if (saved!.selection && performance.now() - started < 8000) {
        setTimeout(attempt, 200);
      }
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
      props: stampOf(selection.pick.resolution?.object)?.props ?? [],
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
      clear: () => this.select(null),
    };
  }
}

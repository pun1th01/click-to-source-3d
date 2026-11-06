import type { AgentActivity, AgentInfo } from "@click-to-source-3d/shared";
import { h, icon, ICONS } from "./dom.js";
import { plural } from "./format.js";
import { labelOf, type Target } from "./targets.js";

/** The longest log the panel draws. */
const SHOWN = 100;

export type AgentTabProps = {
  agents: AgentInfo[];
  log: AgentActivity[];
  pointing: readonly Target[];
  pointerMode: boolean;
  /** The object open in the panel, when it is not already pointed at. */
  canPointAtSelection: boolean;
  onTogglePointerMode(): void;
  onPointAtSelection(): void;
  onRemove(target: Target): void;
  onClear(): void;
  onSelect(target: Target): void;
  onEntry(entry: AgentActivity): void;
};

function ago(milliseconds: number): string {
  const seconds = Math.max(0, Math.round(milliseconds / 1000));
  if (seconds < 60) {
    return `${seconds}s ago`;
  }
  const minutes = Math.round(seconds / 60);
  return minutes < 60 ? `${minutes}m ago` : `${Math.round(minutes / 60)}h ago`;
}

/** `Claude Code connected · last call 2s ago`. Redrawn each second while shown. */
export function agentStatusText(agents: AgentInfo[], now: number): string {
  if (agents.length === 0) {
    return "No assistant connected";
  }
  const names = [...new Set(agents.map((agent) => agent.name))].join(", ");
  const last = Math.max(...agents.map((agent) => agent.lastCallAt ?? 0));
  return `${names} connected · ${last > 0 ? `last call ${ago(now - last)}` : "no calls yet"}`;
}

function clock(at: number): string {
  return new Date(at).toLocaleTimeString([], { hour12: false });
}

function entryRow(entry: AgentActivity, onEntry: (entry: AgentActivity) => void): HTMLElement {
  const target = entry.targets[0];
  const lines = [
    h("span", { class: "log-time mono", text: clock(entry.at) }),
    h("span", { class: "log-call" }, [
      h("span", { class: "log-tool mono", text: entry.tool }),
      entry.detail ? h("span", { class: "log-detail mono", text: entry.detail }) : null,
      entry.effect === "edit" ? h("span", { class: "pill edit", text: "edit" }) : null,
      entry.effect === "point" ? h("span", { class: "pill point", text: "pointed" }) : null,
    ]),
    h("span", { class: `log-result ${entry.status === "error" ? "bad" : ""}`, text: entry.result }),
  ];

  return target
    ? h(
        "button",
        {
          class: "log-row link",
          title: "Select this object, or open this line",
          attrs: { type: "button", "data-cts-entry": String(entry.id) },
          on: { click: () => onEntry(entry) },
        },
        lines
      )
    : h("div", { class: "log-row", attrs: { "data-cts-entry": String(entry.id) } }, lines);
}

/** The Agent tab: who is connected, what they are pointed at, what they have done. */
export function agentTab(props: AgentTabProps): Node[] {
  const connected = props.agents.length > 0;

  const status = h("div", { class: `agent-status ${connected ? "on" : ""}` }, [
    h("span", { class: "dot" }),
    h("span", {
      attrs: { "data-cts-agent-status": "" },
      text: agentStatusText(props.agents, Date.now()),
    }),
  ]);

  const help = connected
    ? null
    : h("div", { class: "note connect" }, [
        "To connect one, run ",
        h("code", { class: "mono", text: "npx click-to-source-3d init --mcp" }),
        " and start your assistant in this project.",
      ]);

  const list = h(
    "ol",
    { class: "pointing" },
    props.pointing.map((target) => {
      const label = labelOf(target);
      return h("li", {}, [
        h(
          "button",
          {
            class: "pointed-name",
            title: "Select this object",
            attrs: { type: "button" },
            on: { click: () => props.onSelect(target) },
          },
          [
            h("span", { text: label.what }),
            label.where ? h("span", { class: "where mono", text: label.where }) : null,
          ]
        ),
        h(
          "button",
          {
            class: "icon-button",
            title: "Stop pointing at this",
            attrs: { type: "button", "aria-label": `Stop pointing at ${label.what}` },
            on: { click: () => props.onRemove(target) },
          },
          [icon(ICONS.close)]
        ),
      ]);
    })
  );

  const count = props.pointing.length;
  const pointer = h("div", { class: "section" }, [
    h("div", { class: "section-title", text: count > 0 ? `Pointing at ${count}` : "Point at objects" }),
    count > 0 ? list : null,
    h("div", { class: "actions" }, [
      h(
        "button",
        {
          class: "action",
          attrs: {
            type: "button",
            "aria-pressed": String(props.pointerMode),
            "data-cts-action": "pointer-mode",
          },
          on: { click: () => props.onTogglePointerMode() },
        },
        [icon(ICONS.point), props.pointerMode ? "Click objects…" : "Point"]
      ),
      props.canPointAtSelection
        ? h(
            "button",
            {
              class: "action",
              attrs: { type: "button", "data-cts-action": "point-selected" },
              on: { click: () => props.onPointAtSelection() },
            },
            ["Add selected"]
          )
        : null,
      count > 0
        ? h(
            "button",
            {
              class: "action",
              attrs: { type: "button", "data-cts-action": "clear-pointing" },
              on: { click: () => props.onClear() },
            },
            ["Clear"]
          )
        : null,
    ]),
    h("div", {
      class: "hint",
      text:
        count > 0
          ? `Now tell your assistant what to do, such as "make ${count === 1 ? "this" : "these"} bigger". It can see what you are pointing at.`
          : "Press Point and click one or more objects, or Shift+click them in inspect mode. Then tell your assistant what to do with them.",
    }),
  ]);

  const entries = props.log.slice(-SHOWN).reverse();
  const activity = h("div", { class: "section" }, [
    h("div", {
      class: "section-title",
      text: props.log.length > 0 ? plural(props.log.length, "tool call") : "Activity",
    }),
    entries.length > 0
      ? h(
          "div",
          { class: "log" },
          entries.map((entry) => entryRow(entry, props.onEntry))
        )
      : h("div", { class: "note", text: "Nothing yet. Each thing your assistant does appears here." }),
  ]);

  return help ? [status, help, pointer, activity] : [status, pointer, activity];
}

import { compareRows } from "./compare.js";
import { h, icon, ICONS } from "./dom.js";
import { describeTarget, labelOf, type Target } from "./targets.js";

export type CompareTabProps = {
  /** At most two: what is pinned, and the selection if there is room. */
  columns: Target[];
  isPinned(target: Target): boolean;
  differencesOnly: boolean;
  onDifferencesOnly(on: boolean): void;
  onUnpin(target: Target): void;
  onSelect(target: Target): void;
};

function columnHead(target: Target, props: CompareTabProps): HTMLElement {
  const label = labelOf(target);
  return h("div", { class: "compare-head" }, [
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
    props.isPinned(target)
      ? h(
          "button",
          {
            class: "icon-button",
            title: "Unpin",
            attrs: { type: "button", "aria-label": `Unpin ${label.what}` },
            on: { click: () => props.onUnpin(target) },
          },
          [icon(ICONS.close)]
        )
      : null,
  ]);
}

/** The Compare tab: two objects side by side, with what differs marked. */
export function compareTab(props: CompareTabProps): Node[] {
  const { columns } = props;

  if (columns.length === 0) {
    return [
      h("div", {
        class: "note",
        text: "Pin an object from the Inspect tab, then select another to compare the two.",
      }),
    ];
  }
  if (columns.length === 1) {
    return [
      columnHead(columns[0], props),
      h("div", {
        class: "note",
        text: props.isPinned(columns[0])
          ? "Select another object to compare it with this one."
          : "Pin this object from the Inspect tab, then select another to compare the two.",
      }),
    ];
  }

  const [a, b] = columns;
  const rows = compareRows(describeTarget(a), describeTarget(b));
  const shown = props.differencesOnly ? rows.filter((row) => row.differs) : rows;
  const grid = h("div", { class: "compare-grid" });
  let group: string | null = null;

  for (const row of shown) {
    if (row.group !== group) {
      group = row.group;
      grid.append(h("div", { class: "section-title span", text: group }));
    }
    const cell = (text: string) =>
      h("div", { class: `cell mono ${row.differs ? "differs" : ""}`, text });
    grid.append(h("div", { class: "k", text: row.label, title: row.label }), cell(row.a), cell(row.b));
  }

  const toggle = h("input", {
    attrs: { type: "checkbox", "data-cts-action": "differences-only" },
    on: { change: (event) => props.onDifferencesOnly((event.target as HTMLInputElement).checked) },
  });
  toggle.checked = props.differencesOnly;

  return [
    h("div", { class: "compare-heads" }, [columnHead(a, props), columnHead(b, props)]),
    h("label", { class: "check" }, [toggle, "Only what differs"]),
    shown.length > 0
      ? grid
      : h("div", { class: "note", text: "These two are the same in everything shown here." }),
  ];
}

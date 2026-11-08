import type { ObjectCost, PointedObject, StampedProp } from "@click-to-source-3d/shared";
import { formatBytes, formatCount, usesOf, valueText, vectorText } from "./format.js";

export type CompareRow = { group: string; label: string; a: string; b: string; differs: boolean };

const NOTHING = "—";

function propText(prop: StampedProp | undefined): string {
  if (!prop) {
    return NOTHING;
  }
  return prop.values.map(valueText).join(", ");
}

function costRows(cost: ObjectCost | null): Array<[string, string]> {
  return [
    ["triangles", cost ? formatCount(cost.triangles) : NOTHING],
    ["draw calls", cost ? formatCount(cost.drawCalls) : NOTHING],
    ["vertices", cost ? formatCount(cost.vertices) : NOTHING],
    ["geometry memory", cost ? formatBytes(cost.geometryBytes) : NOTHING],
    ["textures", cost ? String(cost.textures.length) : NOTHING],
    ["texture memory", cost ? formatBytes(cost.textureBytes) : NOTHING],
    ["casts shadow", cost ? String(cost.castsShadow) : NOTHING],
  ];
}

/**
 * Two objects, side by side, row by row.
 *
 * Values are compared as written in source, so `1.0` and `1` differ, as they do
 * to whoever is reading the code. A prop only one of them sets shows a dash
 * rather than the default three would fall back to, which this cannot know.
 */
export function compareRows(a: PointedObject, b: PointedObject): CompareRow[] {
  const rows: CompareRow[] = [];
  const add = (group: string, label: string, left: string, right: string) =>
    rows.push({ group, label, a: left, b: right, differs: left !== right });

  const where = (object: PointedObject) =>
    object.source ? `${object.source.file}:${object.source.line}` : "no source";

  add("Source", "type", a.kind, b.kind);
  add("Source", "component", a.source?.function ?? NOTHING, b.source?.function ?? NOTHING);
  add("Source", "where", where(a), where(b));

  const called = (object: PointedObject) =>
    [...object.trace]
      .reverse()
      .map((frame) => `${frame.name}(${frame.args.map((arg) => arg.value).join(", ")})`)
      .join(" ← ") || NOTHING;
  const uses = (object: PointedObject) =>
    usesOf(object)
      .map((use) => use.name)
      .join(", ") || NOTHING;
  add("Source", "called from", called(a), called(b));
  add("Source", "uses", uses(a), uses(b));

  add("Transform", "position", vectorText(a.transform.position), vectorText(b.transform.position));
  add("Transform", "rotation", vectorText(a.transform.rotation), vectorText(b.transform.rotation));
  add("Transform", "scale", vectorText(a.transform.scale), vectorText(b.transform.scale));

  const key = (prop: StampedProp) => `${prop.element} ${prop.name}`;
  const keys = [...new Set([...a.props, ...b.props].map(key))];
  for (const name of keys) {
    add(
      "Values",
      name,
      propText(a.props.find((prop) => key(prop) === name)),
      propText(b.props.find((prop) => key(prop) === name))
    );
  }

  add("Materials", "materials", a.materials.join(", ") || NOTHING, b.materials.join(", ") || NOTHING);

  const costA = costRows(a.cost);
  const costB = costRows(b.cost);
  costA.forEach(([label, value], index) => add("Performance", label, value, costB[index][1]));

  return rows;
}

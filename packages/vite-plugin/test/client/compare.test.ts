import { describe, expect, it } from "vitest";
import type { PointedObject } from "@click-to-source-3d/shared";
import { compareRows } from "../../src/client/compare.js";

function object(overrides: Partial<PointedObject> = {}): PointedObject {
  return {
    kind: "Mesh",
    name: null,
    instanceId: null,
    source: { file: "src/World.tsx", function: "World", line: 10 },
    address: null,
    parents: [],
    props: [],
    transform: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1], worldPosition: [0, 0, 0] },
    materials: ["MeshStandardMaterial #ffffff"],
    cost: {
      meshes: 1,
      drawCalls: 1,
      triangles: 12,
      vertices: 24,
      instances: null,
      geometryBytes: 2048,
      materials: 1,
      textures: [],
      textureBytes: 0,
      castsShadow: false,
    },
    trace: [],
    generators: [],
    how: null,
    modelPath: null,
    ...overrides,
  };
}

const row = (rows: ReturnType<typeof compareRows>, label: string) =>
  rows.find((entry) => entry.label === label)!;

describe("compareRows", () => {
  it("compares how each came to be", () => {
    const called = object({
      trace: [
        { name: "buildWorld", file: "src/world.js", line: 8, args: [{ name: "seed", value: "7" }] },
        { name: "createTerrain", file: "src/world.js", line: 30, args: [{ name: "size", value: "40" }] },
      ],
      generators: [
        {
          id: "src/world.js#createTerrain",
          name: "createTerrain",
          file: "src/world.js",
          line: 30,
          params: [],
          numbers: [],
          uses: [{ name: "fbm", depth: 0 }],
        },
      ],
    });
    const rows = compareRows(called, object());

    expect(row(rows, "called from")).toMatchObject({
      a: "createTerrain(40) ← buildWorld(7)",
      b: "—",
      differs: true,
    });
    expect(row(rows, "uses")).toMatchObject({ a: "fbm", b: "—", differs: true });
  });

  it("finds nothing different between two identical objects", () => {
    expect(compareRows(object(), object()).filter((entry) => entry.differs)).toEqual([]);
  });

  it("marks what differs, and only that", () => {
    const rows = compareRows(
      object(),
      object({
        kind: "InstancedMesh",
        transform: { position: [1, 2, 3], rotation: [0, 0, 0], scale: [1, 1, 1], worldPosition: [1, 2, 3] },
      })
    );

    expect(row(rows, "type")).toMatchObject({ a: "Mesh", b: "InstancedMesh", differs: true });
    expect(row(rows, "position")).toMatchObject({ a: "0, 0, 0", b: "1, 2, 3", differs: true });
    expect(row(rows, "scale").differs).toBe(false);
  });

  it("compares props across the two by element and name", () => {
    const value = (raw: string) => ({ raw, value: Number(raw), editable: true, line: 1, column: 1 });
    const rows = compareRows(
      object({
        props: [{ element: "mesh", name: "scale", array: false, values: [value("2")] }],
      }),
      object({
        props: [
          { element: "mesh", name: "scale", array: false, values: [value("2")] },
          { element: "boxGeometry", name: "args", array: true, values: [value("1"), value("2")] },
        ],
      })
    );

    expect(row(rows, "mesh scale")).toMatchObject({ a: "2", b: "2", differs: false });
    // Only one of them sets it. What three would default it to is not known here.
    expect(row(rows, "boxGeometry args")).toMatchObject({ a: "—", b: "1, 2", differs: true });
  });

  it("shows a constant by name and value", () => {
    const rows = compareRows(
      object({
        props: [
          {
            element: "boxGeometry",
            name: "args",
            array: true,
            values: [{ raw: "1.4", value: 1.4, editable: true, line: 1, column: 1, via: "BOX_HEIGHT" }],
          },
        ],
      }),
      object()
    );

    expect(row(rows, "boxGeometry args").a).toBe("BOX_HEIGHT = 1.4");
  });

  it("compares what each costs", () => {
    const heavy = object();
    heavy.cost = { ...heavy.cost!, triangles: 1680, geometryBytes: 5 * 1024 * 1024 };

    const rows = compareRows(object(), heavy);

    expect(row(rows, "triangles")).toMatchObject({ a: "12", b: "1,680", differs: true });
    expect(row(rows, "geometry memory")).toMatchObject({ a: "2.0 KB", b: "5.0 MB", differs: true });
    expect(row(rows, "draw calls").differs).toBe(false);
  });

  it("copes with an object that has no source and draws nothing", () => {
    const rows = compareRows(object({ source: null, cost: null, materials: [] }), object());

    expect(row(rows, "where").a).toBe("no source");
    expect(row(rows, "component").a).toBe("—");
    expect(row(rows, "triangles").a).toBe("—");
    expect(row(rows, "materials").a).toBe("—");
  });

  it("groups its rows in a fixed order", () => {
    const groups = [...new Set(compareRows(object(), object()).map((entry) => entry.group))];

    expect(groups).toEqual(["Source", "Transform", "Materials", "Performance"]);
  });
});

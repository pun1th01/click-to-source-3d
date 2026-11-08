// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PointedObject } from "@click-to-source-3d/shared";
import { copyImage, copyReport, reportMarkdown } from "../../src/client/report.js";

const context = {
  url: "http://localhost:5173/",
  threeRevision: "170",
  userAgent: "TestBrowser/1.0",
};

const box: PointedObject = {
  kind: "Mesh",
  name: "crate",
  instanceId: null,
  source: { file: "src/main.tsx", function: "Scene", line: 88, column: 7 },
  address: null,
  parents: [],
  props: [
    {
      element: "mesh",
      name: "position",
      array: true,
      values: [
        { raw: "-2.2", value: -2.2, editable: true, line: 88, column: 24 },
        { raw: "BOX_HEIGHT / 2", editable: false },
      ],
    },
    {
      element: "boxGeometry",
      name: "args",
      array: true,
      values: [{ raw: "1.4", value: 1.4, editable: true, line: 16, column: 20, via: "BOX_HEIGHT" }],
    },
  ],
  transform: { position: [-2.2, 0.7, 6], rotation: [0, 0, 0], scale: [1, 1, 1], worldPosition: [-2.2, 0.7, 6] },
  materials: ["MeshStandardMaterial #c2643c"],
  cost: {
    meshes: 1,
    drawCalls: 1,
    triangles: 12,
    vertices: 24,
    instances: null,
    geometryBytes: 840,
    materials: 1,
    textures: [],
    textureBytes: 0,
    castsShadow: false,
  },
  trace: [],
  generators: [],
  how: null,
  modelPath: null,
};

describe("reportMarkdown for plain three.js", () => {
  const terrain: PointedObject = {
    ...box,
    props: [
      {
        element: "PlaneGeometry",
        name: "args",
        array: true,
        values: [{ raw: "96", value: 96, editable: true, line: 31, column: 40 }],
      },
    ],
    trace: [
      {
        name: "buildWorld",
        file: "src/world.js",
        line: 8,
        args: [{ name: "seed", value: "7" }],
        calledAt: { file: "src/main.js", line: 23 },
      },
      {
        name: "createTerrain",
        file: "src/world.js",
        line: 30,
        args: [{ name: "size", value: "40" }],
        calledAt: { file: "src/world.js", line: 9 },
      },
    ],
    generators: [
      {
        id: "src/world.js#createTerrain",
        name: "createTerrain",
        file: "src/world.js",
        line: 30,
        params: [],
        numbers: [],
        uses: [
          { name: "fbm", depth: 0, file: "src/noise.js", line: 21 },
          { name: "hash", depth: 1, file: "src/noise.js", line: 1 },
          { name: "createNoise2D", depth: 0, package: "simplex-noise" },
        ],
      },
    ],
    modelPath: "beacon › left blade",
  };
  const report = () => reportMarkdown(terrain, context);

  it("lists the calls that led to the object, nearest first", () => {
    const text = report();
    expect(text).toContain("`createTerrain(size = 40)` at `src/world.js:9`");
    expect(text).toContain("`buildWorld(seed = 7)` at `src/main.js:23`");
    expect(text.indexOf("createTerrain(size")).toBeLessThan(text.indexOf("buildWorld(seed"));
  });

  it("lists the helpers, nested as they call each other", () => {
    const text = report();
    expect(text).toContain("- `fbm` (src/noise.js:21)");
    expect(text).toContain("  - `hash` (src/noise.js:1)");
    expect(text).toContain("- `createNoise2D` (simplex-noise)");
  });

  // Its own function and its geometry's can both use it.
  it("lists a helper once, however many functions behind the object use it", () => {
    const twice = {
      ...terrain,
      generators: [terrain.generators[0], { ...terrain.generators[0], id: "src/world.js#other", name: "other" }],
    };
    const text = reportMarkdown(twice, context);

    expect(text.match(/\`fbm\`/g)).toHaveLength(1);
  });

  it("names plain classes without JSX's brackets", () => {
    expect(report()).toContain("`PlaneGeometry` args:");
  });

  it("says which part of a model it is", () => {
    expect(report()).toContain("`beacon › left blade`");
  });
});

describe("reportMarkdown", () => {
  const report = reportMarkdown(box, context);

  it("says what it is and where it came from", () => {
    expect(report).toContain('### Mesh "crate" at `src/main.tsx:88`');
    expect(report).toContain("Created in `Scene`, `src/main.tsx:88:7`.");
  });

  it("gives its transform as a table", () => {
    expect(report).toContain("| position | -2.2, 0.7, 6 |");
    expect(report).toContain("| world position | -2.2, 0.7, 6 |");
  });

  it("lists its values as written, with constants named", () => {
    expect(report).toContain("- `<mesh>` position: `-2.2`, `BOX_HEIGHT / 2`");
    expect(report).toContain("- `<boxGeometry>` args: `BOX_HEIGHT = 1.4`");
  });

  it("gives its cost and the environment", () => {
    expect(report).toContain("Cost: 12 triangles, 1 draw call, 840 B of geometry, no textures.");
    expect(report).toContain("three.js r170, http://localhost:5173/, TestBrowser/1.0");
  });

  it("names one instance of an InstancedMesh", () => {
    const tree = reportMarkdown({ ...box, kind: "InstancedMesh", name: null, instanceId: 12 }, context);

    expect(tree).toContain("### InstancedMesh instance 12 at `src/main.tsx:88`");
  });

  it("says plainly when there is no source, and where it sits instead", () => {
    const stray = reportMarkdown({ ...box, name: null, source: null, parents: ["Group", "Scene"], props: [] }, context);

    expect(stray).toContain("### Mesh, with no source found");
    expect(stray).toContain("In Group › Scene.");
    expect(stray).not.toContain("Values in source");
  });

  it("does not break Markdown on a value with a backtick in it", () => {
    const strange = reportMarkdown(
      {
        ...box,
        props: [{ element: "mesh", name: "name", array: false, values: [{ raw: "`a`", editable: false }] }],
      },
      context
    );

    expect(strange).toContain("name: ```a```");
  });
});

describe("copying", () => {
  const image = () => Promise.resolve(new Blob(["png"], { type: "image/png" }));
  const original = navigator.clipboard;

  function useClipboard(clipboard: unknown) {
    Object.defineProperty(navigator, "clipboard", { value: clipboard, configurable: true });
  }

  class FakeClipboardItem {
    constructor(readonly items: Record<string, Blob | Promise<Blob>>) {}
  }

  afterEach(() => {
    useClipboard(original);
    vi.unstubAllGlobals();
  });

  it("offers Markdown to plain-text targets and the picture to rich ones", async () => {
    vi.stubGlobal("ClipboardItem", FakeClipboardItem);
    const write = vi.fn(async () => undefined);
    useClipboard({ write });

    const { picture } = await copyReport("### a <b> report", image());

    expect(picture).toBe(true);
    const item = (write.mock.calls[0] as unknown as [FakeClipboardItem[]])[0][0];
    expect(await (item.items["text/plain"] as Blob).text()).toBe("### a <b> report");

    const html = await (await item.items["text/html"]).text();
    // Source text is shown, never parsed as markup.
    expect(html).toContain("<pre>### a &lt;b&gt; report</pre>");
    expect(html).toContain('<img src="data:image/png;base64,');
  });

  it("falls back to text when rich copies are refused", async () => {
    vi.stubGlobal("ClipboardItem", FakeClipboardItem);
    const writeText = vi.fn(async () => undefined);
    let rich: Blob | Promise<Blob> | undefined;
    const write = vi.fn(async ([item]: FakeClipboardItem[]) => {
      rich = item.items["text/html"];
      throw new Error("refused");
    });
    useClipboard({ write, writeText });

    const { picture } = await copyReport("the report", image());

    expect(picture).toBe(false);
    expect(writeText).toHaveBeenCalledWith("the report");

    // The picture is still being read when the write is refused. Left running,
    // that read can finish after jsdom has shut down and swapped the global
    // Uint8Array back, which throws and fails the whole run after every test
    // has passed. Seen once on CI; forced by keeping reads going past shutdown.
    await rich;
  });

  // navigator.clipboard is only there in a secure context, and `vite --host`
  // over plain http is not one.
  it("copies by selection where there is no clipboard API", async () => {
    useClipboard(undefined);
    const execCommand = vi.fn(() => true);
    (document as unknown as { execCommand: unknown }).execCommand = execCommand;

    const { picture } = await copyReport("the report", image());

    expect(picture).toBe(false);
    expect(execCommand).toHaveBeenCalledWith("copy");
    expect(document.querySelector("textarea")).toBeNull();
  });

  it("says so when the browser refuses altogether", async () => {
    useClipboard(undefined);
    (document as unknown as { execCommand: unknown }).execCommand = () => false;

    await expect(copyReport("the report", image())).rejects.toThrow("refused to copy");
  });

  it("copies a picture on its own", async () => {
    vi.stubGlobal("ClipboardItem", FakeClipboardItem);
    const write = vi.fn(async () => undefined);
    useClipboard({ write });

    await copyImage(image());

    const item = (write.mock.calls[0] as unknown as [FakeClipboardItem[]])[0][0];
    expect(Object.keys(item.items)).toEqual(["image/png"]);
  });

  it("says when a picture cannot be copied", async () => {
    useClipboard(undefined);

    await expect(copyImage(image())).rejects.toThrow("cannot copy pictures");
  });
});

import { describe, expect, it } from "vitest";
import type { SourceStamp } from "@click-to-source-3d/shared";
import { editSource, SourceEditError } from "../src/sourceEditor.js";
import { stampSource } from "../src/stampSource.js";

/**
 * Edits by exact position, the mode the inspector uses for values the build
 * step found. The positions come from the stamp itself, so these tests hold
 * the two halves to one contract: whatever the stamp says is editable, the
 * editor can edit, at exactly that place.
 */
describe("editSource, by the file's language", () => {
  const edit = (file: string, source: string, expected: string, newValue: unknown) =>
    editSource(source, {
      file,
      line: 1,
      column: source.indexOf(expected) + 1,
      expected,
      newValue,
    });

  // As JSX these read as the start of an element, and the file can't be parsed at all.
  it("reads a .ts file's casts and generics", () => {
    expect(edit("a.ts", "const a = <number>b; const f = <T>(x: T) => x; const n = 1;", "1", 2)).toBe(
      "const a = <number>b; const f = <T>(x: T) => x; const n = 2;"
    );
  });

  it("reads plain JavaScript", () => {
    expect(edit("a.js", "export const n = 1;", "1", 2)).toBe("export const n = 2;");
  });

  it("reads a .jsx file's elements", () => {
    expect(edit("a.jsx", "const a = <mesh scale={1} />;", "1", 2)).toBe("const a = <mesh scale={2} />;");
  });

  it("reads a decorator", () => {
    expect(edit("a.ts", "@dec class A { n = 1; }", "1", 2)).toBe("@dec class A { n = 2; }");
  });
});

describe("editSource for a script in a page", () => {
  const PAGE = [
    "<!doctype html>",
    "<html><body>",
    '  <script type="module">',
    "    const a = 1.5; const color = 0x88aa55;",
    '    const name = "hello";',
    "  </script>",
    "</body></html>",
    "",
  ].join("\n");
  const edit = (line: number, expected: string, newValue: unknown) =>
    editSource(PAGE, {
      file: "index.html",
      line,
      column: PAGE.split("\n")[line - 1].indexOf(expected) + 1,
      expected,
      newValue,
    });

  it("rewrites just the literal, leaving the page as it was", () => {
    expect(edit(4, "1.5", 2)).toBe(PAGE.replace("const a = 1.5;", "const a = 2;"));
  });

  it("keeps hex as hex", () => {
    expect(edit(4, "0x88aa55", 0xff0000)).toBe(PAGE.replace("0x88aa55", "0xff0000"));
  });

  it("writes a string as a string", () => {
    expect(edit(5, '"hello"', "bye")).toBe(PAGE.replace('"hello"', '"bye"'));
  });

  it("handles line endings as Windows writes them", () => {
    const windows = PAGE.split("\n").join("\r\n");
    const result = editSource(windows, { file: "index.html", line: 4, column: 15, expected: "1.5", newValue: 2 });

    expect(result).toBe(windows.replace("const a = 1.5;", "const a = 2;"));
  });

  it("refuses when the text there has changed", () => {
    expect(() =>
      editSource(PAGE, { file: "index.html", line: 4, column: 15, expected: "9.9", newValue: 2 })
    ).toThrowError(expect.objectContaining({ code: "STALE_LOCATION" }));
  });

  it("refuses a position past the end of the file", () => {
    expect(() =>
      editSource(PAGE, { file: "index.html", line: 400, column: 1, expected: "1.5", newValue: 2 })
    ).toThrowError(expect.objectContaining({ code: "STALE_LOCATION" }));
  });

  it("only edits by position, since names mean nothing in HTML", () => {
    expect(() => editSource(PAGE, { file: "index.html", line: 4, argName: "a", newValue: 2 })).toThrowError(
      expect.objectContaining({ code: "INVALID_REQUEST" })
    );
  });

  it("refuses a value it can't write", () => {
    expect(() =>
      editSource(PAGE, { file: "index.html", line: 4, column: 15, expected: "1.5", newValue: { a: 1 } })
    ).toThrowError(expect.objectContaining({ code: "UNSUPPORTED_VALUE" }));
  });
});

describe("editSource keeps a colour as it was written", () => {
  const edit = (expected: string, newValue: unknown) =>
    editSource(`const color = ${expected};`, {
      file: "a.js",
      line: 1,
      column: 15,
      expected,
      newValue,
    });

  it("stays in hex", () => {
    expect(edit("0x88aa55", 0xff0000)).toBe("const color = 0xff0000;");
  });

  it("keeps its length", () => {
    expect(edit("0x88aa55", 0xff)).toBe("const color = 0x0000ff;");
  });

  it("keeps its case", () => {
    expect(edit("0X88AA55", 0xabcdef)).toBe("const color = 0XABCDEF;");
  });

  it("gives up on a value hex can't write", () => {
    expect(edit("0x10", 1.5)).toBe("const color = 1.5;");
    expect(edit("0x10", -1)).toBe("const color = -1;");
  });

  it("leaves other numbers as they are", () => {
    expect(edit("16", 255)).toBe("const color = 255;");
  });
});

describe("editSource by position", () => {
  const SCENE = [
    "const HEIGHT = 1.4;",
    "export function Scene() {",
    "  return (",
    '    <mesh position={[-2.2, 0, 6]} name="box">',
    "      <boxGeometry args={[1.2, HEIGHT, 1.2]} />",
    '      <meshStandardMaterial color="#c2643c" />',
    "    </mesh>",
    "  );",
    "}",
  ].join("\n");

  const stamp = (): SourceStamp => {
    const out = stampSource(SCENE, "/r/src/Scene.tsx", { root: "/r" })!.code;
    return (JSON.parse(out.match(/^const __ctsStamps = (\[.*?\]); /)![1]) as SourceStamp[])[0];
  };

  it("edits every value the stamp marks editable, and only that value", () => {
    const editable = stamp()
      .props!.flatMap((p) => p.values)
      .filter((v) => v.editable);

    expect(editable.length).toBe(8);

    for (const value of editable) {
      const replacement = typeof value.value === "number" ? 9.5 : "teal";
      const result = editSource(SCENE, {
        file: "src/Scene.tsx",
        line: value.line!,
        column: value.column!,
        expected: value.raw,
        newValue: replacement,
      });

      const changed = result.split("\n").filter((line, i) => line !== SCENE.split("\n")[i]);
      expect(changed, value.raw).toHaveLength(1);
      expect(changed[0], value.raw).toContain(
        typeof replacement === "number" ? "9.5" : '"teal"'
      );
    }
  });

  it("edits a constant at its declaration", () => {
    const height = stamp().props!.find((p) => p.element === "boxGeometry")!.values[1];

    const result = editSource(SCENE, {
      file: "src/Scene.tsx",
      line: height.line!,
      column: height.column!,
      expected: height.raw,
      newValue: 2,
    });

    expect(result.split("\n")[0]).toBe("const HEIGHT = 2;");
  });

  it("writes a JSX attribute string as an attribute, not an expression", () => {
    const result = editSource(SCENE, {
      file: "src/Scene.tsx",
      line: 6,
      column: SCENE.split("\n")[5].indexOf('"#c2643c"') + 1,
      expected: '"#c2643c"',
      newValue: 'say "hi"',
    });

    expect(result.split("\n")[5]).toBe('      <meshStandardMaterial color="say &quot;hi&quot;" />');
  });

  // The file changed between the stamp and Save. The position may now hold
  // nothing, or a different literal; either way nothing is written.
  it("refuses a position that no longer holds the expected text", () => {
    const edited = SCENE.replace("-2.2", "-3.5");

    for (const request of [
      { line: 4, column: 22, expected: "-2.2" }, // same place, different text
      { line: 4, column: 23, expected: "2.2" }, // not where a literal starts
      { line: 99, column: 1, expected: "1" }, // past the end of the file
    ]) {
      expect(() =>
        editSource(edited, { file: "src/Scene.tsx", newValue: 0, ...request })
      ).toThrowError(
        expect.objectContaining<Partial<SourceEditError>>({ code: "STALE_LOCATION" })
      );
    }
  });

  it("never edits inside hand-written provenance, even by position", () => {
    const source = 'const m = <mesh userData={{ sourceRef: { args: { r: 0.6 } } }} />;';
    const column = source.indexOf("0.6") + 1;

    expect(() =>
      editSource(source, { file: "a.tsx", line: 1, column, expected: "0.6", newValue: 1 })
    ).toThrowError(
      expect.objectContaining<Partial<SourceEditError>>({ code: "STALE_LOCATION" })
    );
  });

  it("requires the expected text with a column", () => {
    expect(() =>
      editSource(SCENE, { file: "src/Scene.tsx", line: 4, column: 22, newValue: 0 })
    ).toThrowError(
      expect.objectContaining<Partial<SourceEditError>>({ code: "INVALID_REQUEST" })
    );
  });
});

function lineContaining(source: string, text: string, occurrence = 1): number {
  let seen = 0;
  const line = source.split("\n").findIndex((value) => {
    if (!value.includes(text)) {
      return false;
    }

    seen += 1;
    return seen === occurrence;
  });

  if (line === -1) {
    throw new Error(`Fixture text not found: ${text}`);
  }

  return line + 1;
}

describe("editSource", () => {
  it("replaces a string literal in a JSX attribute", () => {
    const source = `const scene = () => (
  <mesh
    userData={{ sourceRef }}
    color="hotpink"
  />
);`;

    const result = editSource(source, {
      file: "Scene.tsx",
      line: lineContaining(source, 'color="hotpink"'),
      argName: "color",
      newValue: "cyan",
    });

    expect(result).toBe(`const scene = () => (
  <mesh
    userData={{ sourceRef }}
    color="cyan"
  />
);`);
  });

  it("replaces a numeric literal inside a JSX expression", () => {
    const source = `function Scene() {
  return <mesh
    scale={0.35}
  />;
}`;

    const result = editSource(source, {
      file: "Scene.tsx",
      line: lineContaining(source, "scale={0.35}"),
      argName: "scale",
      newValue: 0.5,
    });

    expect(result).toBe(`function Scene() {
  return <mesh
    scale={0.5}
  />;
}`);
  });

  it("supports boolean and null literal replacements", () => {
    const source = `const item = (
  <mesh
    visible={true}
    fallback={"ready"}
  />
);`;

    const booleanResult = editSource(source, {
      file: "Item.tsx",
      line: lineContaining(source, "visible={true}"),
      argName: "visible",
      newValue: false,
    });
    const nullResult = editSource(source, {
      file: "Item.tsx",
      line: lineContaining(source, 'fallback={"ready"}'),
      argName: "fallback",
      newValue: null,
    });

    expect(booleanResult).toContain("visible={false}");
    expect(nullResult).toContain("fallback={null}");
    expect(booleanResult).toContain('fallback={"ready"}');
    expect(nullResult).toContain("visible={true}");
  });

  it("uses the supplied line to edit only the matching duplicate value", () => {
    const source = `const first = {
  color: "hotpink",
};

const second = {
  color: "hotpink",
};`;

    const result = editSource(source, {
      file: "colors.ts",
      line: lineContaining(source, '  color: "hotpink",', 2),
      argName: "color",
      newValue: "cyan",
    });

    expect(result).toBe(`const first = {
  color: "hotpink",
};

const second = {
  color: "cyan",
};`);
  });

  it("preserves tabs, spaces, trailing commas, and surrounding JSX formatting", () => {
    const source = `function makeMesh() {
\treturn (
\t\t<mesh
\t\t\tcolor="hotpink"
\t\t\tscale={0.35}
\t\t\tuserData={{
\t\t\t\tsourceRef,
\t\t\t}} 
\t\t/>
\t);
}`;

    const result = editSource(source, {
      file: "makeMesh.tsx",
      line: lineContaining(source, "scale={0.35}"),
      argName: "scale",
      newValue: 0.5,
    });

    expect(result).toBe(`function makeMesh() {
\treturn (
\t\t<mesh
\t\t\tcolor="hotpink"
\t\t\tscale={0.5}
\t\t\tuserData={{
\t\t\t\tsourceRef,
\t\t\t}} 
\t\t/>
\t);
}`);
  });

  it("fails with a typed error when the argument is missing", () => {
    const source = `const mesh = <mesh color="hotpink" />;`;

    expect(() =>
      editSource(source, {
        file: "mesh.tsx",
        line: 1,
        argName: "material",
        newValue: "basic",
      })
    ).toThrowError(
      expect.objectContaining<Partial<SourceEditError>>({
        name: "SourceEditError",
        code: "ARGUMENT_NOT_FOUND",
      })
    );
  });

  it("fails safely when the line does not identify the intended location", () => {
    const source = `const first = <mesh color="hotpink" />;
const second = <mesh color="hotpink" />;`;

    expect(() =>
      editSource(source, {
        file: "mesh.tsx",
        line: 99,
        argName: "color",
        newValue: "cyan",
      })
    ).toThrowError(
      expect.objectContaining<Partial<SourceEditError>>({
        name: "SourceEditError",
        code: "LOCATION_NOT_FOUND",
      })
    );
  });

  it("names the lines an argument does live on when the requested one is wrong", () => {
    // The shape argSources exists for: a hoisted constant whose only location
    // is its own declaration, addressed by a sourceRef pointing at the
    // generator. The edit still fails — this pins the reason being legible.
    const source = [
      "const WATER_LEVEL = 3;",
      "",
      "function Terrain() {",
      "  return <mesh />;",
      "}",
    ].join("\n");

    expect(() =>
      editSource(source, {
        file: "Terrain.jsx",
        line: 4,
        argName: "WATER_LEVEL",
        newValue: 9,
      })
    ).toThrowError(
      expect.objectContaining<Partial<SourceEditError>>({
        code: "LOCATION_NOT_FOUND",
        message: expect.stringContaining("declared at line 1"),
      })
    );
  });

  describe("hand-written provenance metadata", () => {
    // The reported failure: Save rewrote the copy of the value inside the
    // metadata, said it had saved, and the sphere did not change.
    it("never edits a literal inside sourceRef, even when it is the only match", () => {
      const source = [
        "function Scene() {",
        "  return (",
        "    <mesh",
        "      userData={{ sourceRef: { line: 3, args: { radius: 0.6 } } }}",
        "    >",
        "      <sphereGeometry args={[0.6, 32, 32]} />",
        "    </mesh>",
        "  );",
        "}",
      ].join("\n");

      expect(() =>
        editSource(source, {
          file: "Scene.tsx",
          line: 3,
          argName: "radius",
          newValue: 2,
        })
      ).toThrowError(
        expect.objectContaining<Partial<SourceEditError>>({
          code: "ARGUMENT_NOT_FOUND",
        })
      );
    });

    it("ignores the metadata copy and edits the real declaration beside it", () => {
      const source = [
        "const RADIUS = 0.6;",
        "const sourceRef = { line: 1, args: { RADIUS: 0.6 } };",
        "const refs = { instanceSourceRefs: [{ sourceRef: { args: { RADIUS: 0.6 } } }] };",
      ].join("\n");

      const result = editSource(source, {
        file: "Scene.tsx",
        line: 1,
        argName: "RADIUS",
        newValue: 2,
      });

      expect(result.split("\n")).toEqual([
        "const RADIUS = 2;",
        "const sourceRef = { line: 1, args: { RADIUS: 0.6 } };",
        "const refs = { instanceSourceRefs: [{ sourceRef: { args: { RADIUS: 0.6 } } }] };",
      ]);
    });

    // `line` and `file` are fields of the metadata, not arguments.
    it("does not offer the metadata's own fields as arguments", () => {
      const source = `const mesh = <mesh userData={{ sourceRef: { file: "a.tsx", line: 1 } }} />;`;

      expect(() =>
        editSource(source, { file: "a.tsx", line: 1, argName: "line", newValue: 9 })
      ).toThrowError(
        expect.objectContaining<Partial<SourceEditError>>({
          code: "ARGUMENT_NOT_FOUND",
        })
      );
    });
  });

  it("does not alter the original source when transformation fails", () => {
    const source = `const mesh = <mesh scale={0.35} />;`;

    expect(() =>
      editSource(source, {
        file: "mesh.tsx",
        line: 1,
        argName: "scale",
        newValue: { amount: 0.5 },
      })
    ).toThrowError(
      expect.objectContaining<Partial<SourceEditError>>({
        code: "UNSUPPORTED_VALUE",
      })
    );
    expect(source).toBe(`const mesh = <mesh scale={0.35} />;`);
  });

  describe("VariableDeclarator support", () => {
    it("replaces a literal inside a simple VariableDeclarator (including negative numbers)", () => {
      const source = `const noiseFloor = -26;
const lakeBedLevel = -20;`;

      const result = editSource(source, {
        file: "config.ts",
        line: 1,
        argName: "noiseFloor",
        newValue: -30,
      });

      expect(result).toBe(`const noiseFloor = -30;
const lakeBedLevel = -20;`);
    });

    it("resolves duplicate variable names using the supplied line number", () => {
      const source = `function setup() {
  const target = 1;
}

function process() {
  const target = 2;
}`;

      const result = editSource(source, {
        file: "script.ts",
        line: 6,
        argName: "target",
        newValue: 5,
      });

      expect(result).toBe(`function setup() {
  const target = 1;
}

function process() {
  const target = 5;
}`);
    });

    it("throws AMBIGUOUS_LOCATION if the same variable is defined twice on the exact same line (e.g. JSX and const)", () => {
      const source = `const size = 10; <mesh size={10} />`;

      expect(() =>
        editSource(source, {
          file: "mesh.tsx",
          line: 1,
          argName: "size",
          newValue: 20,
        })
      ).toThrowError(
        expect.objectContaining<Partial<SourceEditError>>({
          code: "AMBIGUOUS_LOCATION",
        })
      );
    });
  });
});

import path from "node:path";
import { describe, expect, it } from "vitest";
import type { SourceStamp, StampedProp } from "@click-to-source-3d/shared";
import { stampSource } from "../src/stampSource.js";

const ROOT = "/project";
const FILE = "/project/src/components/Water.jsx";

function stamp(code: string, filename = FILE): string {
  const result = stampSource(code, filename, { root: ROOT });

  if (!result) {
    throw new Error("expected the file to be stamped");
  }

  return result.code;
}

/** The module's stamp table, as the page will see it. */
function tableOf(out: string): SourceStamp[] {
  const match = out.match(/^const (__ctsStamps_*) = (\[.*?\]); /);

  if (!match) {
    throw new Error(`no stamp table at the start of:\n${out}`);
  }

  return JSON.parse(match[2]) as SourceStamp[];
}

function propsOf(code: string, filename = FILE): StampedProp[] {
  return tableOf(stamp(code, filename))[0].props ?? [];
}

function prop(props: StampedProp[], name: string, element?: string): StampedProp {
  const found = props.find((p) => p.name === name && (!element || p.element === element));

  if (!found) {
    throw new Error(`no prop ${name} in ${JSON.stringify(props)}`);
  }

  return found;
}

describe("stampSource", () => {
  it("stamps a bare host element", () => {
    const out = stamp("const A = () => <mesh />;");

    expect(tableOf(out)[0]).toMatchObject({
      file: "src/components/Water.jsx",
      function: "A",
      line: 1,
      column: 17,
    });
    expect(out).toContain("<mesh userData-__ctsSource={__ctsStamps[0]} />");
  });

  it("emits a project-relative path, never an absolute one", () => {
    const out = stamp("const A = () => <mesh />;");

    expect(tableOf(out)[0].file).toBe("src/components/Water.jsx");
    expect(out).not.toContain("/project/src");
  });

  // Built with the ambient `path` rather than hardcoded Windows literals.
  // relativeFile uses path.relative and path.sep, both of which follow the
  // platform, so a test that pins win32 strings only agrees with the code on
  // win32 — on Linux posix reads "C:\project\src\Scene.jsx" as one filename
  // containing backslashes and returns "../C:\project\src\Scene.jsx". Native
  // paths assert the invariant that actually matters on both: the emitted
  // path is root-relative and separated by forward slashes, whatever the
  // platform separates by.
  it("emits forward slashes whatever the platform separates by", () => {
    const root = path.resolve("project");
    const result = stampSource(
      "const A = () => <mesh />;",
      path.join(root, "src", "Scene.jsx"),
      { root }
    );

    expect(tableOf(result!.code)[0].file).toBe("src/Scene.jsx");
    expect(result?.code).not.toContain("\\");
  });

  it("merges into existing userData without clobbering it", () => {
    const out = stamp(
      "const A = () => <mesh userData={{ sourceRef: { line: 20 } }} />;"
    );

    expect(out).toContain("userData={{ ...{ sourceRef: { line: 20 } }, __ctsSource: __ctsStamps[0] }}");
  });

  it("skips React components, which are stamped where they are declared", () => {
    const out = stamp("const A = () => <group><Water /></group>;");

    expect(out).toContain("<group userData-__ctsSource=");
    expect(out).not.toMatch(/<Water[^>]*userData/);
  });

  it("skips geometries and materials", () => {
    const out = stamp(
      "const A = () => <mesh><planeGeometry /><meshStandardMaterial /></mesh>;"
    );

    expect(out).not.toMatch(/<planeGeometry[^>]*userData/);
    expect(out).not.toMatch(/<meshStandardMaterial[^>]*userData/);
    expect(out).toContain("<mesh userData-__ctsSource=");
    expect(tableOf(out)).toHaveLength(1);
  });

  it("recovers the function name from every declaration shape", () => {
    const cases: Array<[string, string]> = [
      ["function Water() { return <mesh />; }", "Water"],
      ["const Trees = () => <mesh />;", "Trees"],
      ["export default function App() { return <mesh />; }", "App"],
      ["const o = { render() { return <mesh />; } };", "render"],
    ];

    for (const [code, expected] of cases) {
      expect(tableOf(stamp(code))[0].function, code).toBe(expected);
    }
  });

  // Each of these used to stamp `function: "unknown"`.
  it("names components wrapped in memo or forwardRef", () => {
    const cases: Array<[string, string]> = [
      ["const Tree = memo(() => <mesh />);", "Tree"],
      ["const Tree = React.memo(() => <mesh />);", "Tree"],
      ["const Rock = forwardRef((props, ref) => <mesh ref={ref} />);", "Rock"],
      ["const Rock = React.forwardRef(function (p, r) { return <mesh />; });", "Rock"],
      ["const Bush = memo(forwardRef((p, r) => <mesh />));", "Bush"],
    ];

    for (const [code, expected] of cases) {
      expect(tableOf(stamp(code))[0].function, code).toBe(expected);
    }
  });

  it("names an anonymous default export after its file", () => {
    for (const code of [
      "export default () => <mesh />;",
      "export default function () { return <mesh />; }",
      "export default memo(() => <mesh />);",
    ]) {
      expect(tableOf(stamp(code))[0].function, code).toBe("Water (default export)");
    }
    // Trees/index.tsx is imported as Trees.
    expect(
      tableOf(stamp("export default () => <mesh />;", "/project/src/Trees/index.tsx"))[0]
        .function
    ).toBe("Trees (default export)");
  });

  // A wrapper is recognised by name, so an ordinary call taking a callback
  // does not lend its result's variable name to the callback.
  it("names a .map callback after the component around it", () => {
    const out = stamp(
      "function Forest({ trees }) { const nodes = trees.map((t) => <mesh key={t} />); return nodes; }"
    );

    expect(tableOf(out)[0].function).toBe("Forest");
  });

  // react-spring and framer-motion wrap an intrinsic and render it.
  describe("member-expression elements", () => {
    it("stamps animated.mesh and motion.group", () => {
      const out = stamp(
        "const A = () => <animated.mesh><motion.group /></animated.mesh>;"
      );

      expect(out).toContain("<animated.mesh userData-__ctsSource=");
      expect(out).toContain("<motion.group userData-__ctsSource=");
    });

    it("still skips DOM and components behind a member expression", () => {
      expect(
        stampSource("const A = () => <motion.div><Foo.Bar /></motion.div>;", FILE, {
          root: ROOT,
        })
      ).toBeNull();
    });
  });

  // The object a <primitive> wraps already has userData — a glTF scene's is
  // the extras exported from Blender. `userData={...}` replaced it outright.
  it("adds to a primitive's userData instead of replacing it", () => {
    const out = stamp("const M = ({ gltf }) => <primitive object={gltf.scene} />;");

    expect(out).toContain("<primitive object={gltf.scene} userData-__ctsSource=");
    expect(out).not.toMatch(/userData=\{/);
  });

  // Skipped without a parse: most modules contain no lowercase JSX.
  it("skips a module with no lowercase JSX without parsing it", () => {
    expect(
      stampSource("const A = () => <Water><Rock /></Water>;", FILE, { root: ROOT })
    ).toBeNull();
    expect(
      stampSource("export const id = <T,>(x: T): T => x;", "/project/src/id.tsx", {
        root: ROOT,
      })
    ).toBeNull();
  });

  it("records the element's own line and column, not the component's", () => {
    const out = stamp(
      ["function Water() {", "  return (", "    <mesh />", "  );", "}"].join("\n")
    );

    expect(tableOf(out)[0]).toMatchObject({ line: 3, column: 5 });
  });

  // The table sits on the first line, so nothing below it moves: a stamped
  // line, a stack trace and the source all agree without a sourcemap.
  it("moves no line of the module", () => {
    const source = [
      "import x from 'y';",
      "function Water() {",
      "  return <mesh position={[0, 1, 2]} />;",
      "}",
    ].join("\n");
    const outLines = stamp(source).split("\n");
    const inLines = source.split("\n");

    expect(outLines).toHaveLength(inLines.length);
    expect(outLines[0].endsWith(inLines[0])).toBe(true);
    expect(outLines[1]).toBe(inLines[1]);
    expect(outLines[3]).toBe(inLines[3]);
  });

  it("keeps a directive prologue first", () => {
    const out = stamp('"use client";\nconst A = () => <mesh />;');

    expect(out.startsWith('"use client"; const __ctsStamps = [')).toBe(true);
  });

  it("names the table so it collides with nothing in the module", () => {
    const out = stamp("const __ctsStamps = 1; const A = () => <mesh />;");

    expect(out.startsWith("const __ctsStamps_ = [")).toBe(true);
    expect(out).toContain("userData-__ctsSource={__ctsStamps_[0]}");
  });

  /**
   * A spread can carry userData, and appending the stamp after it made the
   * stamp win — destroying a hand-written sourceRef, which is the documented
   * override for anything the transform gets wrong. Whether a given spread
   * carries userData is a runtime value, so the fix is positional.
   */
  describe("spread attributes", () => {
    it("emits the stamp before a spread, so an author's userData wins", () => {
      const out = stamp("const A = (props) => <mesh {...props} />;");

      expect(out).toContain("<mesh userData-__ctsSource={__ctsStamps[0]} {...props} />");
    });

    it("goes ahead of the first of several spreads", () => {
      const out = stamp("const A = (a, b) => <mesh {...a} {...b} />;");

      expect(out.indexOf("userData-__ctsSource")).toBeLessThan(out.indexOf("{...a}"));
    });

    it("goes ahead of a spread that is not the first attribute", () => {
      const out = stamp(
        "const A = (props) => <mesh position={[0,0,0]} {...props} scale={2} />;"
      );

      expect(out.indexOf("userData-__ctsSource")).toBeGreaterThan(
        out.indexOf("position=")
      );
      expect(out.indexOf("userData-__ctsSource")).toBeLessThan(
        out.indexOf("{...props}")
      );
    });

    // An explicit userData already outranks any spread before it, so the
    // existing merge is correct and must keep applying rather than being
    // replaced by the positional path.
    it("still merges into an explicit userData that follows a spread", () => {
      const out = stamp(
        "const A = (props) => <mesh {...props} userData={{ x: 1 }} />;"
      );

      expect(out).toContain("userData={{ ...{ x: 1 }, __ctsSource: __ctsStamps[0] }}");
      expect(out.indexOf("{...props}")).toBeLessThan(out.indexOf("userData="));
    });

    it("appends the stamp after every attribute when there is no spread", () => {
      const out = stamp("const A = () => <mesh scale={2} />;");

      expect(out.endsWith(
        "const A = () => <mesh scale={2} userData-__ctsSource={__ctsStamps[0]} />;"
      )).toBe(true);
    });
  });

  it("returns null when there is nothing to stamp", () => {
    expect(stampSource("export const x = 1;", FILE, { root: ROOT })).toBeNull();
    expect(
      stampSource("const A = () => <planeGeometry />;", FILE, { root: ROOT })
    ).toBeNull();
  });

  it("leaves a non-object userData alone rather than guessing", () => {
    const result = stampSource(
      'const A = () => <mesh userData="opaque" />;',
      FILE,
      { root: ROOT }
    );

    expect(result).toBeNull();
  });

  it("produces a sourcemap alongside the stamped code", () => {
    const result = stampSource("const A = () => <mesh />;", FILE, { root: ROOT });

    expect(result?.map).toBeTruthy();
    expect(result?.map.mappings.length).toBeGreaterThan(0);
  });

  it("handles TypeScript JSX", () => {
    const out = stamp(
      "const A = (): JSX.Element => <mesh scale={1 as number} />;",
      "/project/src/Scene.tsx"
    );

    expect(tableOf(out)[0].file).toBe("src/Scene.tsx");
    expect(out).toContain("userData-__ctsSource=");
  });
});

/**
 * What makes a value editable without hand-written metadata: the stamp lists
 * every prop with where its literal is, so the inspector can rewrite exactly
 * that literal.
 */
describe("stampSource — props", () => {
  it("records each literal with its exact position", () => {
    const props = propsOf(
      'const A = () => <mesh position={[-2.2, 0, 6]} scale={1.5} name="rock" visible={false} />;'
    );

    expect(prop(props, "position")).toEqual({
      element: "mesh",
      name: "position",
      array: true,
      values: [
        { raw: "-2.2", value: -2.2, editable: true, line: 1, column: 34 },
        { raw: "0", value: 0, editable: true, line: 1, column: 40 },
        { raw: "6", value: 6, editable: true, line: 1, column: 43 },
      ],
    });
    expect(prop(props, "scale").values[0]).toMatchObject({ raw: "1.5", value: 1.5, editable: true });
    expect(prop(props, "name").values[0]).toMatchObject({ raw: '"rock"', value: "rock", editable: true });
    expect(prop(props, "visible").values[0]).toMatchObject({ raw: "false", value: false });
  });

  it("includes the props of a geometry and material written inside the element", () => {
    const out = stamp(
      [
        "const A = () => (",
        "  <mesh>",
        "    <boxGeometry args={[1, 2, 3]} />",
        '    <meshStandardMaterial color="#c2643c" roughness={0.4} />',
        "  </mesh>",
        ");",
      ].join("\n")
    );
    const props = tableOf(out)[0].props!;

    expect(prop(props, "args", "boxGeometry").values.map((v) => v.value)).toEqual([1, 2, 3]);
    expect(prop(props, "color", "meshStandardMaterial").values[0]).toMatchObject({
      raw: '"#c2643c"',
      line: 4,
      column: 33,
    });
    // Geometry and material are still not stamps of their own.
    expect(tableOf(out)).toHaveLength(1);
  });

  it("does not reach into a child mesh's geometry", () => {
    const out = stamp(
      "const A = () => <group><mesh><boxGeometry args={[1, 1, 1]} /></mesh></group>;"
    );
    const [group, mesh] = tableOf(out);

    expect(group.props).toBeUndefined();
    expect(prop(mesh.props!, "args", "boxGeometry").values).toHaveLength(3);
  });

  // `args={[1.2, BOX_HEIGHT]}` is edited at `const BOX_HEIGHT = 1.4`.
  it("follows a constant to its declaration", () => {
    const props = propsOf(
      ["const HEIGHT = 1.4;", "const A = () => <mesh scale={HEIGHT} />;"].join("\n")
    );

    expect(prop(props, "scale").values[0]).toEqual({
      raw: "1.4",
      value: 1.4,
      editable: true,
      line: 1,
      column: 16,
      via: "HEIGHT",
    });
  });

  // Scope is not modelled, so any second binding of the name makes the
  // constant ambiguous, and an ambiguous value is shown, never edited.
  it("will not follow a name that is bound more than once", () => {
    const shapes = [
      "const H = 1; function A({ H }) { return <mesh scale={H} />; }",
      "const H = 1; function A(H) { return <mesh scale={H} />; }",
      "const H = 1; function B() { const H = 2; } const A = () => <mesh scale={H} />;",
      "let H = 1; const A = () => <mesh scale={H} />;",
      "import { H } from './h'; const A = () => <mesh scale={H} />;",
      "const H = compute(); const A = () => <mesh scale={H} />;",
    ];

    for (const code of shapes) {
      expect(prop(propsOf(code), "scale").values[0], code).toEqual({ raw: "H", editable: false });
    }
  });

  it("shows an expression as text it cannot edit", () => {
    const props = propsOf(
      "const A = ({ x }) => <mesh position={[x, noise(x) * 8, -Math.PI / 2]} />;"
    );

    expect(prop(props, "position").values).toEqual([
      { raw: "x", editable: false },
      { raw: "noise(x) * 8", editable: false },
      { raw: "-Math.PI / 2", editable: false },
    ]);
  });

  it("shortens a long expression", () => {
    const long = `veryLongFunctionName(${"argument, ".repeat(10)}last)`;
    const value = prop(propsOf(`const A = () => <mesh scale={${long}} />;`), "scale").values[0];

    expect(value.raw.length).toBeLessThanOrEqual(80);
    expect(value.raw.endsWith("…")).toBe(true);
  });

  it("shows a bare boolean prop as true, but read-only", () => {
    expect(prop(propsOf("const A = () => <mesh castShadow />;"), "castShadow").values[0]).toEqual({
      raw: "true",
      value: true,
      editable: false,
    });
  });

  it("leaves out wiring that is never a tuned value", () => {
    const props = propsOf(
      "const A = (r) => <mesh key=\"k\" ref={r} attach=\"x\" onClick={f} onPointerOver={f} userData={{}} geometry={g} />;"
    );

    expect(props.map((p) => p.name)).toEqual([]);
  });
});

describe("stampSource — DOM elements", () => {
  // Lowercase JSX covers DOM tags as well as R3F intrinsics. Stamping a <div>
  // puts a userData attribute on a DOM node, which React warns about at
  // runtime and which carries no meaning.
  it("does not stamp HTML elements", () => {
    const result = stampSource(
      "const P = () => <div><button /><span /><label /></div>;",
      FILE,
      { root: ROOT }
    );

    expect(result).toBeNull();
  });

  it("does not stamp SVG elements", () => {
    expect(
      stampSource("const I = () => <svg><path /><circle /></svg>;", FILE, {
        root: ROOT,
      })
    ).toBeNull();
  });

  it("still stamps three elements sharing no name with the DOM", () => {
    const out = stampSource(
      "const S = () => <div><mesh /><instancedMesh /></div>;",
      FILE,
      { root: ROOT }
    );

    expect(out!.code).toContain("<mesh userData-__ctsSource=");
    expect(out!.code).toContain("<instancedMesh userData-__ctsSource=");
    expect(out!.code).not.toMatch(/<div[^>]*userData/);
  });

  // R3F applications register their own lowercase elements via extend(), so
  // an allowlist of known three classes would silently miss them.
  it("stamps an application's own extended element", () => {
    const out = stampSource("const W = () => <waterSurface />;", FILE, {
      root: ROOT,
    });

    expect(out!.code).toContain("<waterSurface userData-__ctsSource=");
  });
});

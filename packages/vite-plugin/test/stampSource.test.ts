import path from "node:path";
import { describe, expect, it } from "vitest";
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

describe("stampSource", () => {
  it("stamps a bare host element", () => {
    const out = stamp("const A = () => <mesh />;");

    expect(out).toContain('__ctsSource: { file: "src/components/Water.jsx"');
    expect(out).toContain('function: "A"');
    expect(out).toContain("line: 1");
  });

  it("emits a project-relative path, never an absolute one", () => {
    const out = stamp("const A = () => <mesh />;");

    expect(out).toContain('"src/components/Water.jsx"');
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

    expect(result?.code).toContain('"src/Scene.jsx"');
    expect(result?.code).not.toContain("\\");
  });

  it("merges into existing userData without clobbering it", () => {
    const out = stamp(
      "const A = () => <mesh userData={{ sourceRef: { line: 20 } }} />;"
    );

    expect(out).toContain("{ ...{ sourceRef: { line: 20 } }");
    expect(out).toContain("__ctsSource:");
  });

  it("skips React components, which are stamped where they are declared", () => {
    const out = stamp("const A = () => <group><Water /></group>;");

    expect(out).toContain("<group userData=");
    expect(out).not.toMatch(/<Water userData=/);
  });

  it("skips geometries and materials", () => {
    const out = stamp(
      "const A = () => <mesh><planeGeometry /><meshStandardMaterial /></mesh>;"
    );

    expect(out).not.toContain("<planeGeometry userData=");
    expect(out).not.toContain("<meshStandardMaterial userData=");
    expect(out).toContain("<mesh userData=");
  });

  it("recovers the function name from every declaration shape", () => {
    const cases: Array<[string, string]> = [
      ["function Water() { return <mesh />; }", '"Water"'],
      ["const Trees = () => <mesh />;", '"Trees"'],
      ["export default function App() { return <mesh />; }", '"App"'],
      ["const o = { render() { return <mesh />; } };", '"render"'],
    ];

    for (const [code, expected] of cases) {
      expect(stamp(code)).toContain(`function: ${expected}`);
    }
  });

  it("records the element's own line, not the component's", () => {
    const out = stamp(
      ["function Water() {", "  return (", "    <mesh />", "  );", "}"].join("\n")
    );

    expect(out).toContain("line: 3");
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

      expect(out).toContain("<mesh userData={{ __ctsSource:");
      expect(out.indexOf("userData=")).toBeLessThan(out.indexOf("{...props}"));
    });

    it("goes ahead of the first of several spreads", () => {
      const out = stamp("const A = (a, b) => <mesh {...a} {...b} />;");

      expect(out.indexOf("userData=")).toBeLessThan(out.indexOf("{...a}"));
    });

    it("goes ahead of a spread that is not the first attribute", () => {
      const out = stamp(
        "const A = (props) => <mesh position={[0,0,0]} {...props} scale={2} />;"
      );

      expect(out.indexOf("userData=")).toBeGreaterThan(out.indexOf("position="));
      expect(out.indexOf("userData=")).toBeLessThan(out.indexOf("{...props}"));
    });

    // An explicit userData already outranks any spread before it, so the
    // existing merge is correct and must keep applying rather than being
    // replaced by the positional path.
    it("still merges into an explicit userData that follows a spread", () => {
      const out = stamp(
        "const A = (props) => <mesh {...props} userData={{ x: 1 }} />;"
      );

      expect(out).toContain("userData={{ ...{ x: 1 }, __ctsSource:");
      expect(out.indexOf("{...props}")).toBeLessThan(out.indexOf("userData="));
    });

    // The regression boundary: nothing without a spread changes.
    it("leaves elements with no spread exactly where they were", () => {
      const out = stamp("const A = () => <mesh scale={2} />;");

      expect(out).toBe(
        'const A = () => <mesh scale={2} userData={{ __ctsSource: { file: "src/components/Water.jsx", function: "A", line: 1 } }} />;'
      );
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

    expect(out).toContain('file: "src/Scene.tsx"');
    expect(out).toContain("__ctsSource:");
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

    expect(out!.code).toContain("<mesh userData=");
    expect(out!.code).toContain("<instancedMesh userData=");
    expect(out!.code).not.toContain("<div userData=");
  });

  // R3F applications register their own lowercase elements via extend(), so
  // an allowlist of known three classes would silently miss them.
  it("stamps an application's own extended element", () => {
    const out = stampSource("const W = () => <waterSurface />;", FILE, {
      root: ROOT,
    });

    expect(out!.code).toContain("<waterSurface userData=");
  });
});

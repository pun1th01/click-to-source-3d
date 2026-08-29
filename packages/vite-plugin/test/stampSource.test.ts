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

  it("normalises separators so Windows paths do not leak backslashes", () => {
    const result = stampSource(
      "const A = () => <mesh />;",
      "C:\\project\\src\\Scene.jsx",
      { root: "C:\\project" }
    );

    expect(result?.code).toContain('"src/Scene.jsx"');
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

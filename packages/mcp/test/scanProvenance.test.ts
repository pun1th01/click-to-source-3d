import { describe, expect, it } from "vitest";
import { scanFile, scanProvenance } from "../src/scanProvenance.js";

describe("scanFile", () => {
  it("finds a hand-written sourceRef and its declared line", () => {
    const text = [
      "function Terrain() {",
      "  const noiseFloor = -30, lakeBedLevel = -20;",
      "  return <mesh userData={{",
      "    sourceRef: {",
      "      file: 'src/components/Terrain.jsx',",
      "      function: 'Terrain',",
      "      line: 2,",
      "      args: { noiseFloor, lakeBedLevel },",
      "    }",
      "  }} />;",
      "}",
    ].join("\n");

    const [site] = scanFile("src/components/Terrain.jsx", text);

    expect(site.function).toBe("Terrain");
    expect(site.args).toEqual(["noiseFloor", "lakeBedLevel"]);
    // the ref sits on line 4 but points at line 2 — the distinction the
    // edit tool depends on
    expect(site.line).toBe(4);
    expect(site.declaredLine).toBe(2);
    expect(site.perInstance).toBe(false);
  });

  it("marks a per-instance ref, which carries no editable literal", () => {
    const text = [
      "const instanceRef = {",
      "  sourceRef: {",
      "    file: 'src/components/Trees.jsx',",
      "    function: 'Trees',",
      "    line: 178,",
      "    args: { x: 1, z: 2 },",
      "  }",
      "};",
      "trunkSourceRefs.push(instanceRef);",
    ].join("\n");

    expect(scanFile("src/components/Trees.jsx", text)[0].perInstance).toBe(true);
  });

  it("reads args through a nested object without stopping at its brace", () => {
    const text = [
      "sourceRef: {",
      "  file: 'a.jsx',",
      "  function: 'A',",
      "  line: 1,",
      "  args: { outer: 1, nested: { inner: 2 }, after: 3 },",
      "}",
    ].join("\n");

    // `nested` is an argument; `inner` is not
    expect(scanFile("a.jsx", text)[0].args).toEqual([
      "outer",
      "nested",
      "after",
    ]);
  });

  it("is not confused by a brace inside a string", () => {
    const text = [
      "sourceRef: {",
      "  file: 'a.jsx',",
      "  function: 'A{B',",
      "  line: 1,",
      "  args: { label: '}' , tail: 2 },",
      "}",
    ].join("\n");

    const [site] = scanFile("a.jsx", text);

    expect(site.function).toBe("A{B");
    expect(site.args).toEqual(["label", "tail"]);
  });

  it("finds several sites in one file", () => {
    const text = [
      "sourceRef: { file: 'a.jsx', function: 'Grass', line: 10, args: { x: 1 } },",
      "sourceRef: { file: 'a.jsx', function: 'Bush', line: 20, args: { z: 2 } },",
    ].join("\n");

    const sites = scanFile("a.jsx", text);

    expect(sites).toHaveLength(2);
    expect(sites.map((s) => s.function)).toEqual(["Grass", "Bush"]);
  });

  // A destructuring or a type annotation is not a declaration.
  it("ignores a sourceRef mention with no file field", () => {
    expect(
      scanFile("a.ts", "const { sourceRef } = result;\nsourceRef: SourceRef;")
    ).toEqual([]);
  });

  it("reports no args when the ref declares none", () => {
    const text = "sourceRef: { file: 'a.jsx', function: 'A', line: 3 }";

    expect(scanFile("a.jsx", text)[0].args).toEqual([]);
  });
});

describe("scanProvenance", () => {
  it("skips files that are not source", () => {
    const entries = [
      { path: "src/a.jsx", text: "sourceRef: { file: 'src/a.jsx', function: 'A', line: 1, args: {} }" },
      { path: "package.json", text: "sourceRef: { file: 'x', function: 'Y', line: 1, args: {} }" },
      { path: "src/.env", text: "sourceRef: { file: 'x', function: 'Y', line: 1, args: {} }" },
    ];

    const sites = scanProvenance(entries);

    expect(sites).toHaveLength(1);
    expect(sites[0].file).toBe("src/a.jsx");
  });
});

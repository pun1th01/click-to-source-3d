import { describe, expect, it } from "vitest";
import { editSource, SourceEditError } from "../src/sourceEditor";

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

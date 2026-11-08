import { describe, expect, it } from "vitest";
import { patchViteConfig } from "../src/viteConfig.js";

const IMPORT = 'import { clickToSource } from "@click-to-source-3d/vite-plugin";';
const WRAP_IMPORT = 'import { withClickToSource } from "@click-to-source-3d/vite-plugin";';

function patched(code: string): string {
  const result = patchViteConfig(code);
  if (result.status !== "patched") {
    throw new Error(`expected a patch, got ${JSON.stringify(result)}`);
  }
  return result.code;
}

describe("patchViteConfig", () => {
  // The template `npm create vite` writes for React.
  it("adds the plugin first, and its import after the others", () => {
    const code = [
      "import { defineConfig } from 'vite'",
      "import react from '@vitejs/plugin-react'",
      "",
      "// https://vite.dev/config/",
      "export default defineConfig({",
      "  plugins: [react()],",
      "})",
      "",
    ].join("\n");

    expect(patched(code)).toBe(
      [
        "import { defineConfig } from 'vite'",
        "import react from '@vitejs/plugin-react'",
        IMPORT,
        "",
        "// https://vite.dev/config/",
        "export default defineConfig({",
        "  plugins: [clickToSource(), react()],",
        "})",
        "",
      ].join("\n")
    );
  });

  // The shapes a library reported success on while adding only the import.
  it("reaches into a config written as a function", () => {
    expect(
      patched("import { defineConfig } from 'vite'\nexport default defineConfig(({ mode }) => ({ plugins: [react()] }))\n")
    ).toContain("plugins: [clickToSource(), react()]");
    expect(
      patched("import { defineConfig } from 'vite'\nexport default defineConfig(() => {\n  const x = 1\n  return { plugins: [react()] }\n})\n")
    ).toContain("plugins: [clickToSource(), react()]");
  });

  it("handles a plain object, a config held in a variable, and a typed one", () => {
    expect(patched("export default { plugins: [react()] }\n")).toContain("plugins: [clickToSource(), react()]");
    expect(
      patched("import { defineConfig } from 'vite'\nconst config = defineConfig({ plugins: [react()] })\nexport default config\n")
    ).toContain("plugins: [clickToSource(), react()]");
    expect(
      patched("import type { UserConfig } from 'vite'\nexport default { plugins: [react()] } satisfies UserConfig\n")
    ).toContain("plugins: [clickToSource(), react()]");
  });

  it("adds a plugins array where there is none", () => {
    const out = patched("import { defineConfig } from 'vite'\nexport default defineConfig({ server: { port: 3000 } })\n");

    expect(out).toContain("defineConfig({\n  plugins: [clickToSource()], server: { port: 3000 } })");
  });

  it("fills an empty plugins array", () => {
    expect(patched("export default { plugins: [] }\n")).toContain("plugins: [clickToSource()]");
  });

  it("puts the import first when there are no imports", () => {
    expect(patched("export default { plugins: [] }\n").startsWith(IMPORT)).toBe(true);
  });

  // Not the config's plugins: a worker's are nested a level down.
  it("edits the config's own plugins, not a worker's", () => {
    const out = patched("export default { worker: { plugins: () => [] }, plugins: [react()] }\n");

    expect(out).toContain("worker: { plugins: () => [] }, plugins: [clickToSource(), react()]");
  });

  it("recognises a config that is already set up", () => {
    expect(
      patchViteConfig(`${IMPORT}\nexport default { plugins: [clickToSource()] }\n`)
    ).toEqual({ status: "already" });
  });

  it("wraps plugins it can't see into, which Vite flattens", () => {
    expect(patched("export default { plugins: getPlugins() }\n")).toContain(
      "plugins: [clickToSource(), getPlugins()]"
    );
    expect(patched("const plugins = [];\nexport default { plugins };\n")).toContain(
      "{ plugins: [clickToSource(), plugins] }"
    );
  });

  describe("a config that isn't one object", () => {
    const wrapped = (code: string) => {
      const out = patched(code);
      expect(out).toContain(WRAP_IMPORT);
      return out;
    };

    it("wraps a function that can return different ones", () => {
      const out = wrapped(
        [
          "import { defineConfig } from 'vite'",
          "export default defineConfig(({ mode }) => {",
          "  if (mode === 'test') return { base: '/a/' }",
          "  return { plugins: [] }",
          "})",
          "",
        ].join("\n")
      );
      expect(out).toContain("export default withClickToSource(defineConfig(({ mode }) => {");
      expect(out).toContain("}))");
    });

    it("isn't misled by a return inside a helper function", () => {
      const out = patched(
        "import { defineConfig } from 'vite'\nexport default defineConfig(() => {\n  const f = () => { return 1 }\n  return { plugins: [] }\n})\n"
      );
      expect(out).toContain("plugins: [clickToSource()]");
    });

    it("wraps a call to anything else", () => {
      expect(wrapped("export default makeConfig()\n")).toContain("export default withClickToSource(makeConfig())");
      expect(wrapped("import { mergeConfig } from 'vite'\nexport default mergeConfig(base, { plugins: [] })\n")).toContain(
        "withClickToSource(mergeConfig(base, { plugins: [] }))"
      );
    });

    // A spread can bring plugins of its own, which would replace these.
    it("wraps an object with a spread in it", () => {
      expect(wrapped("export default { ...base, server: {} }\n")).toContain(
        "withClickToSource({ ...base, server: {} })"
      );
    });

    it("wraps an imported config", () => {
      expect(wrapped("import config from './base'\nexport default config\n")).toContain(
        "export default withClickToSource(config)"
      );
    });

    it("wraps a function declaration", () => {
      expect(wrapped("export default async function config(env) { return { plugins: [] }; if (env) return {}; }\n")).toContain(
        "withClickToSource(async function config(env)"
      );
    });

    it("produces something that parses, and that it recognises afterwards", () => {
      const out = wrapped("export default makeConfig() as UserConfig\n");
      expect(patchViteConfig(out)).toEqual({ status: "already" });
    });
  });

  it("handles a CommonJS config", () => {
    const out = patched("const { defineConfig } = require('vite')\nmodule.exports = defineConfig({ plugins: [] })\n");

    expect(out.startsWith('const { withClickToSource } = require("@click-to-source-3d/vite-plugin");')).toBe(true);
    expect(out).toContain("module.exports = withClickToSource(defineConfig({ plugins: [] }))");
  });

  it("only gives up on a file that exports nothing, or can't be read", () => {
    for (const code of ["console.log(1)\n", "export const a = 1\n", "export default {{{ not code\n"]) {
      expect(patchViteConfig(code).status, code).toBe("unsupported");
    }
  });
});

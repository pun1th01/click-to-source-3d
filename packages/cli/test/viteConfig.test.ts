import { describe, expect, it } from "vitest";
import { patchViteConfig } from "../src/viteConfig.js";

const IMPORT = 'import { clickToSource } from "@click-to-source-3d/vite-plugin";';

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

  it("reports what it cannot edit instead of guessing", () => {
    const cases = [
      "module.exports = { plugins: [] }\n",
      "export default { plugins: getPlugins() }\n",
      "export default makeConfig()\n",
      "export default {{{ not code\n",
    ];

    for (const code of cases) {
      expect(patchViteConfig(code).status, code).toBe("unsupported");
    }
  });
});

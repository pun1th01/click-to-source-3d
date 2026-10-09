import { defineConfig } from "vite";

/**
 * Builds the injected inspector into a single file, dist/client.js.
 *
 * Everything it imports is bundled in except three, which has to be the
 * application's own copy: the inspector raycasts the application's scene and
 * draws with its renderer. Bundling the rest means the page loads one module
 * from this package, and the application's dependency optimiser never meets
 * a package it did not already know about — which would otherwise trigger a
 * re-optimise and a full reload the first time the inspector loads.
 */
export default defineConfig({
  logLevel: "warn",
  build: {
    lib: {
      entry: "src/client/index.ts",
      formats: ["es"],
      fileName: () => "client.js",
    },
    outDir: "dist",
    emptyOutDir: false,
    minify: false,
    sourcemap: true,
    target: "es2022",
    rolldownOptions: {
      external: [/^three($|\/)/],
    },
  },
});

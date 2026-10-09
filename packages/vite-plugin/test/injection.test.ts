import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createServer, type ViteDevServer } from "vite";
import { afterEach, describe, expect, it } from "vitest";
import { clickToSource, type ClickToSourceOptions } from "../src/plugin.js";

/**
 * How the inspector reaches the page: a script tag the plugin adds to every
 * HTML page it serves, pointing at a virtual module that is the bundled
 * client itself. No application code involved.
 */

const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const HTML = "<!doctype html><html><head><title>t</title></head><body><script type=\"module\" src=\"/src/main.tsx\"></script></body></html>";

let server: ViteDevServer | undefined;

async function serve(options?: ClickToSourceOptions) {
  server = await createServer({
    configFile: false,
    logLevel: "silent",
    root: pluginRoot,
    plugins: [clickToSource(options)],
    server: { middlewareMode: true, hmr: false },
  });
  return server;
}

async function clientModule(vite: ViteDevServer): Promise<string> {
  const result = await vite.pluginContainer.load("\0virtual:click-to-source/client");
  return typeof result === "string" ? result : result?.code ?? "";
}

afterEach(async () => {
  await server?.close();
  server = undefined;
});

describe("inspector injection", () => {
  it("adds the inspector ahead of the application's own scripts", async () => {
    const html = await (await serve()).transformIndexHtml("/", HTML);
    const tag = '<script type="module" src="/@id/__x00__virtual:click-to-source/client"></script>';

    expect(html).toContain(tag);
    // Head-prepended: before anything the application loads.
    expect(html.indexOf(tag)).toBeLessThan(html.indexOf("<title>"));
    expect(html.indexOf(tag)).toBeLessThan(html.indexOf("/src/main.tsx"));
  });

  it("serves the bundled client and starts it with the configured options", async () => {
    const code = await clientModule(await serve({ inspector: { hotkey: "ctrl+shift+i", button: false } }));

    expect(code).toContain("function startDevtools(");
    expect(code).toContain('"hotkey":"ctrl+shift+i"');
    expect(code).toContain('"button":false');
    expect(code).toContain('"bridge":true');
    expect(code).toContain("import.meta.hot");
  });

  // Served as the virtual module itself, so its imports resolve as the
  // application's do. Imported from its file inside node_modules, it got a
  // second, raw copy of three — found in a freshly created app, where three
  // logged "Multiple instances of Three.js being imported".
  it("imports nothing but three, from the application", async () => {
    const code = await clientModule(await serve());
    const imports = [...code.matchAll(/^import .* from "([^"]+)";?\s*$/gm)].map((match) => match[1]);

    expect(imports.filter((source) => source !== "@react-three/fiber")).toEqual(["three"]);
    expect(code).not.toContain("sourceMappingURL");
  });

  // An app whose code imports only R3F never names three itself, so Vite's
  // start-up scan missed it, the inspector's import found it late, and the
  // first page load re-optimised and reloaded. Found in a freshly created app.
  it("names three and R3F for the first dependency optimisation", async () => {
    const vite = await serve();

    expect(vite.config.optimizeDeps.include).toEqual(
      expect.arrayContaining(["three", "@react-three/fiber"])
    );
  });

  it("names nothing it cannot find installed", async () => {
    // A project with no node_modules of its own, outside this repository.
    const empty = mkdtempSync(path.join(os.tmpdir(), "cts-empty-"));
    try {
      server = await createServer({
        configFile: false,
        logLevel: "silent",
        root: empty,
        plugins: [clickToSource()],
        server: { middlewareMode: true, hmr: false },
      });

      expect(server.config.optimizeDeps.include ?? []).not.toContain("three");
    } finally {
      await server?.close();
      server = undefined;
      rmSync(empty, { recursive: true, force: true });
    }
  });

  it("injects nothing when the inspector and the bridge are both off", async () => {
    const html = await (await serve({ inspector: false, bridge: false })).transformIndexHtml(
      "/",
      HTML
    );

    expect(html).not.toContain("click-to-source");
  });
});

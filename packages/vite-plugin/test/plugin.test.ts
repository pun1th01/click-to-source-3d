import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createServer, type ViteDevServer } from "vite";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { READ_FILE_PATH, WRITE_FILE_PATH } from "@click-to-source-3d/shared";
import { clickToSource, withClickToSource } from "../src/plugin.js";

const pluginRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  ".."
);

let server: ViteDevServer;
let baseUrl: string;
let fixtureDirectory: string;

async function postJson(endpoint: string, body: unknown) {
  const response = await fetch(`${baseUrl}${endpoint}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  return {
    status: response.status,
    body: (await response.json()) as Record<string, unknown>,
  };
}

describe("writing several values at once", () => {
  let server: ViteDevServer;
  let directory: string;
  let relative: string;

  const write = async (edits: unknown[]) => {
    const address = server.httpServer!.address() as { port: number };
    const response = await fetch(`http://127.0.0.1:${address.port}${WRITE_FILE_PATH}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ edits }),
    });
    return { status: response.status, body: (await response.json()) as Record<string, unknown> };
  };
  const read = (name: string) => fs.readFile(path.join(directory, name), "utf8");
  const edit = (name: string, line: number, column: number, expected: string, newValue: unknown) => ({
    file: `${relative}/${name}`,
    line,
    column,
    expected,
    newValue,
  });

  beforeAll(async () => {
    directory = await fs.mkdtemp(path.join(pluginRoot, ".cts-many-fixture-"));
    relative = path.basename(directory);
    server = await createServer({
      appType: "custom",
      configFile: false,
      logLevel: "silent",
      root: pluginRoot,
      plugins: [clickToSource()],
      server: { host: "127.0.0.1", port: 0, strictPort: true, fs: { allow: [pluginRoot] } },
    });
    await server.listen();
  });

  afterAll(async () => {
    await server?.close();
    await fs.rm(directory, { force: true, recursive: true });
  });

  it("changes every value, in any order, across files", async () => {
    await fs.writeFile(path.join(directory, "a.js"), "export const p = [1, 2, 3];\n");
    await fs.writeFile(path.join(directory, "b.js"), "export const q = 4;\n");

    const result = await write([
      edit("a.js", 1, 19, "1", 100),
      edit("b.js", 1, 18, "4", 5),
      edit("a.js", 1, 25, "3", 300),
    ]);

    expect(result.status).toBe(200);
    expect(await read("a.js")).toBe("export const p = [100, 2, 300];\n");
    expect(await read("b.js")).toBe("export const q = 5;\n");
  });

  // A refused value must not leave the others written, in this file or another.
  it("changes nothing if any one is refused", async () => {
    await fs.writeFile(path.join(directory, "a.js"), "export const n = 1;\n");
    await fs.writeFile(path.join(directory, "b.js"), "export const n = 2;\n");

    const result = await write([
      edit("a.js", 1, 18, "1", 100),
      edit("b.js", 1, 18, "9", 200),
    ]);

    expect(result.status).toBe(400);
    expect(result.body.code).toBe("STALE_LOCATION");
    expect(await read("a.js")).toBe("export const n = 1;\n");
    expect(await read("b.js")).toBe("export const n = 2;\n");
  });

  it("refuses a file outside the project, writing nothing else", async () => {
    await fs.writeFile(path.join(directory, "a.js"), "export const n = 1;\n");

    const result = await write([
      edit("a.js", 1, 18, "1", 100),
      { file: "../../outside.js", line: 1, column: 1, expected: "1", newValue: 2 },
    ]);

    expect(result.status).toBe(400);
    expect(await read("a.js")).toBe("export const n = 1;\n");
  });

  it("refuses a file type it doesn't edit", async () => {
    const result = await write([{ file: ".env", line: 1, column: 1, expected: "1", newValue: 2 }]);

    expect(result.status).toBe(400);
    expect(result.body.error).toBe("File type not editable");
  });

  it("refuses a malformed list", async () => {
    expect((await write([])).status).toBe(400);
    expect((await write([{ file: "a.js" }])).status).toBe(400);
    expect((await write([1])).status).toBe(400);
    expect((await write(Array.from({ length: 257 }, () => edit("a.js", 1, 18, "1", 2)))).status).toBe(400);
  });
});

describe("which modules are recorded", () => {
  type Plugin = ReturnType<typeof clickToSource>;
  const CODE = `import * as THREE from "three"; export function make() { return new THREE.Mesh(); }`;

  /** The plugin's transform, called as Vite calls it. */
  const transformer = (config: { command?: string; mode?: string }, options = {}) => {
    const plugin = clickToSource(options) as Plugin & {
      configResolved(config: unknown): void;
      transform(this: unknown, code: string, id: string, options?: { ssr?: boolean }): unknown;
    };
    plugin.configResolved({ command: "serve", mode: "development", root: "/app", ...config });
    const context = {
      warn: () => undefined,
      resolve: async (source: string) => ({ id: `/app/node_modules/${source}/index.js` }),
    };
    return async (code: string, id: string, transformOptions?: { ssr?: boolean }) =>
      (await plugin.transform.call(context, code, id, transformOptions)) as { code: string } | null;
  };

  it("records a module on its way to the browser", async () => {
    const result = await transformer({})(CODE, "/app/src/a.js");

    expect(result?.code).toContain('from "virtual:click-to-source/client"');
    expect(result?.code).toContain("__ctsNew(new THREE.Mesh()");
  });

  it.each([".js", ".mjs", ".cjs", ".ts", ".mts", ".cts", ".jsx", ".tsx"])("reads %s", async (extension) => {
    expect((await transformer({})(CODE, `/app/src/a${extension}`))?.code).toContain("__ctsNew(");
  });

  it.each([
    ["a type declaration", "/app/src/a.d.ts"],
    ["a dependency", "/app/node_modules/lib/a.js"],
    ["a virtual module", "\0virtual:thing.js"],
    ["a stylesheet", "/app/src/a.css"],
    ["a worker", "/app/src/a.js?worker"],
    ["a worker's own file", "/app/src/a.js?worker_file&type=module"],
    ["a shared worker", "/app/src/a.js?sharedworker"],
    ["text", "/app/src/a.js?raw"],
    ["a URL", "/app/src/a.js?url"],
    ["an inlined asset", "/app/src/a.js?inline"],
    ["a script from a page", "/app/index.html?html-proxy&index=0.js"],
  ])("leaves %s alone", async (_what, id) => {
    expect(await transformer({})(CODE, id)).toBeNull();
  });

  it("keeps the query out of the way otherwise", async () => {
    expect((await transformer({})(CODE, "/app/src/a.js?t=123"))?.code).toContain("__ctsNew(");
    expect((await transformer({})(CODE, "/app/src/a.js?v=1&workerish"))?.code).toContain("__ctsNew(");
  });

  it("does nothing for a server render, which has no inspector to read it", async () => {
    expect(await transformer({})(CODE, "/app/src/a.js", { ssr: true })).toBeNull();
  });

  it("knows a server render by its environment, as Vite 6 and later say it", async () => {
    const plugin = clickToSource() as ReturnType<typeof clickToSource> & {
      configResolved(config: unknown): void;
      transform(this: unknown, code: string, id: string): unknown;
    };
    plugin.configResolved({ command: "serve", mode: "development", root: "/app" });
    const context = (consumer: string) => ({
      warn: () => undefined,
      resolve: async () => null,
      environment: { config: { consumer } },
    });

    expect(await plugin.transform.call(context("server"), CODE, "/app/src/a.js")).toBeNull();
    expect(((await plugin.transform.call(context("client"), CODE, "/app/src/a.js")) as { code: string }).code).toContain("__ctsNew(");
  });

  // A test runner serves modules through Vite too, with nothing to import this from.
  it("does nothing under a test runner", async () => {
    expect(await transformer({ mode: "test" })(CODE, "/app/src/a.js")).toBeNull();
  });

  it("does nothing in a build, even one stamping JSX", async () => {
    const build = transformer({ command: "build", mode: "production" }, { stampSource: "always" });

    expect(await build(CODE, "/app/src/a.js")).toBeNull();
    const jsx = await build(`${CODE}; const A = () => <mesh />;`, "/app/src/a.jsx");
    expect(jsx?.code).toContain("__ctsStamps");
    expect(jsx?.code).not.toContain("virtual:click-to-source");
    expect(jsx?.code).not.toContain("__ctsNew");
  });

  it("does nothing when stamping is off, or there's no inspector to read it", async () => {
    expect(await transformer({}, { stampSource: false })(CODE, "/app/src/a.js")).toBeNull();
    expect(await transformer({}, { inspector: false, bridge: false })(CODE, "/app/src/a.js")).toBeNull();
  });

  it("still stamps JSX with no inspector, for a page of your own to read", async () => {
    const result = await transformer({}, { inspector: false, bridge: false })(
      "const A = () => <mesh />;",
      "/app/src/a.jsx"
    );

    expect(result?.code).toContain("const __ctsStamps = [");
    expect(result?.code).not.toContain("virtual:click-to-source");
  });

  it("leaves a copy of three kept in the project alone", async () => {
    const build = `export class Mesh {}\nnew Mesh();\n${"// padding\n".repeat(20000)}`;
    expect(await transformer({})(build, "/app/src/lib/three.module.js")).toBeNull();
  });

  it("leaves a file too big to be being worked on alone", async () => {
    expect(await transformer({})(`${CODE}\n${"// x\n".repeat(300000)}`, "/app/src/vendor.js")).toBeNull();
  });

  it("leaves something that can't be parsed for what compiles it next to report", async () => {
    expect(await transformer({})("import x from; new Foo(", "/app/src/a.js")).toBeNull();
  });

  describe("scripts in a page", () => {
    const SCRIPT = `
      import * as THREE from "three";
      export function make() { return new THREE.Mesh(new THREE.BoxGeometry(2, 3, 4)); }
    `;
    const PAGE = `<!doctype html>
<html>
  <body>
    <script type="module">${SCRIPT}</script>
  </body>
</html>
`;
    let directory: string;
    let id: string;

    beforeAll(async () => {
      directory = await fs.mkdtemp(path.join(pluginRoot, ".cts-page-fixture-"));
      await fs.writeFile(path.join(directory, "index.html"), PAGE);
      id = `${path.join(directory, "index.html").split(path.sep).join("/")}?html-proxy&index=0.js`;
    });

    afterAll(async () => {
      await fs.rm(directory, { force: true, recursive: true });
    });

    const inPage = () => transformer({ ...{}, ...({ root: directory } as object) });

    it("records one at its line in the page", async () => {
      const code = (await inPage()(SCRIPT, id))!.code;

      expect(code).toContain("__ctsNew(new THREE.Mesh(");
      // Line 4 is the tag; the script's own lines start counting there.
      expect(code).toContain('"file":"index.html"');
      expect(code).toContain('"line":6');
      expect(code).toContain('"function":"make"');
    });

    it("keeps its own lines where they were", async () => {
      expect((await inPage()(SCRIPT, id))!.code.split("\n").length).toBe(SCRIPT.split("\n").length);
    });

    // An HTML parser hands over the script with \n endings, whatever the file has.
    it("finds one in a page saved with Windows line endings", async () => {
      const windows = path.join(directory, "windows.html");
      await fs.writeFile(windows, PAGE.split("\n").join("\r\n"));
      const windowsId = `${windows.split(path.sep).join("/")}?html-proxy&index=0.js`;

      const code = (await inPage()(SCRIPT, windowsId))?.code ?? "";

      expect(code).toContain("__ctsNew(new THREE.Mesh(");
      expect(code).toContain('"line":6');
    });

    it("leaves one it can't find in the page", async () => {
      expect(await inPage()("export const elsewhere = new Thing();", id)).toBeNull();
    });

    it("leaves a page's styles alone", async () => {
      const styles = id.replace("index=0.js", "index=0.css");
      expect(await inPage()("a { color: red }", styles)).toBeNull();
    });

    it("does nothing in a build", async () => {
      const build = transformer({ command: "build", mode: "production", root: directory } as object, { stampSource: "always" });
      expect(await build(SCRIPT, id)).toBeNull();
    });
  });

  describe("classic scripts", () => {
    const PLUGIN_ROOT = "/app";
    const classic = (html: string) => {
      const plugin = clickToSource() as ReturnType<typeof clickToSource> & {
        configResolved(config: unknown): void;
        transform(this: unknown, code: string, id: string): unknown;
        transformIndexHtml: { handler(html: string, context: unknown): Array<{ tag: string; children?: string; attrs?: object }> };
      };
      plugin.configResolved({ command: "serve", mode: "development", root: PLUGIN_ROOT });
      const tags = plugin.transformIndexHtml.handler(html, { path: "/pages/index.html", server: {} });
      const context = { warn: () => undefined, resolve: async () => null };
      return {
        tags,
        transform: async (id: string) =>
          (await plugin.transform.call(context, `import { Mesh } from "three"; new Mesh();`, id)) as { code: string } | null,
      };
    };

    // It can't import anything, and an import in it is a syntax error that stops the page.
    it("leaves a file a page loads as a classic script alone", async () => {
      const { transform } = classic('<script src="/src/old.js"></script><script src="./near.js"></script>');
      const resolved = (file: string) => path.join(PLUGIN_ROOT, file).split(path.sep).join("/");

      expect(await transform(resolved("src/old.js"))).toBeNull();
      expect(await transform(resolved("pages/near.js"))).toBeNull();
      expect((await transform(resolved("src/other.js")))?.code).toContain("__ctsNew(");
    });

    it("still records one the page loads as a module", async () => {
      const { transform } = classic('<script type="module" src="/src/new.js"></script>');

      expect((await transform(path.join(PLUGIN_ROOT, "src/new.js").split(path.sep).join("/")))?.code).toContain("__ctsNew(");
    });

    // Classic scripts run first, so three would otherwise announce its renderer to nobody.
    it("gets a hook in place for a page that has one", () => {
      const { tags } = classic('<script src="https://unpkg.com/three@0.149.0/build/three.min.js"></script>');

      expect(tags[0].tag).toBe("script");
      expect(tags[0].children).toContain("__CTS_EARLY_RENDERERS__");
      expect(tags[0].attrs).toBeUndefined();
      expect(tags).toHaveLength(2);
    });

    it("adds nothing extra to a page without one", () => {
      expect(classic('<script type="module" src="/a.js"></script>').tags).toHaveLength(1);
    });
  });

  it("warns once when a .jsx file has lost its JSX, as before", async () => {
    const warnings: string[] = [];
    const plugin = clickToSource() as ReturnType<typeof clickToSource> & {
      configResolved(config: unknown): void;
      transform(this: unknown, code: string, id: string): unknown;
    };
    plugin.configResolved({ command: "serve", mode: "development", root: "/app" });
    const context = { warn: (text: string) => warnings.push(text), resolve: async () => null };

    await plugin.transform.call(context, "export const a = 1;", "/app/src/a.jsx");
    await plugin.transform.call(context, "export const b = 2;", "/app/src/b.tsx");

    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("no JSX found");
  });
});

describe("files coming and going while the dev server runs", () => {
  let server: ViteDevServer;
  let directory: string;

  beforeAll(async () => {
    directory = await fs.mkdtemp(path.join(pluginRoot, ".cts-watch-fixture-"));
    server = await createServer({
      appType: "custom",
      configFile: false,
      logLevel: "silent",
      root: directory,
      plugins: [clickToSource()],
      server: { middlewareMode: true, hmr: false },
    });
  });

  afterAll(async () => {
    await server?.close();
    await fs.rm(directory, { force: true, recursive: true });
  });

  const transformMain = async () => {
    const result = await server.transformRequest("/main.js");
    return result?.code ?? "";
  };

  // What saving a value does, around the save.
  it("keeps what it knows when a temporary file appears and goes", async () => {
    await fs.writeFile(path.join(directory, "world.js"), `import { Mesh } from "three"; export function build(seed) { return new Mesh(); }`);
    await fs.writeFile(path.join(directory, "main.js"), `import { build } from "./world.js"; build(7);`);
    expect(await transformMain()).toContain("__ctsVia(");

    const resolve = vi.spyOn(server.pluginContainer, "resolveId");
    server.watcher.emit("add", path.join(directory, ".main.js.cts-1-2.tmp"));
    server.watcher.emit("unlink", path.join(directory, ".main.js.cts-1-2.tmp"));
    await fs.writeFile(path.join(directory, "main.js"), `import { build } from "./world.js"; build(8);`);
    server.moduleGraph.invalidateAll();

    expect(await transformMain()).toContain("__ctsVia(");
    expect(resolve.mock.calls.filter(([source]) => source === "./world.js").length).toBeLessThanOrEqual(2);
    resolve.mockRestore();
  });

  it("looks again when a file of code appears", async () => {
    await fs.writeFile(path.join(directory, "main.js"), `import { later } from "./later.js"; later();`);
    server.moduleGraph.invalidateAll();
    expect(await transformMain().catch(() => "")).not.toContain("__ctsVia(");

    await fs.writeFile(path.join(directory, "later.js"), `import { Mesh } from "three"; export function later() { return new Mesh(); }`);
    server.watcher.emit("add", path.join(directory, "later.js"));
    server.moduleGraph.invalidateAll();

    expect(await transformMain()).toContain("__ctsVia(");
  });

  // Line numbers in what another file says about it would otherwise be out of date.
  it("marks what depends on a changed file to be transformed again", async () => {
    await fs.writeFile(path.join(directory, "world.js"), `import { Mesh } from "three"; export function build(seed) { return new Mesh(); }`);
    await fs.writeFile(path.join(directory, "main.js"), `import { build } from "./world.js"; build(7);`);
    server.moduleGraph.invalidateAll();
    // A result is only kept if it's newer than the invalidation, by the clock.
    await new Promise((resolve) => setTimeout(resolve, 20));
    await transformMain();
    await server.transformRequest("/world.js");
    const main = await server.moduleGraph.getModuleByUrl("/main.js");
    expect(main?.transformResult).toBeTruthy();

    server.watcher.emit("change", path.join(directory, "world.js"));

    expect(main?.transformResult).toBeNull();
  });
});

describe("withClickToSource", () => {
  const namesOf = (config: { plugins?: unknown[] }) =>
    (config.plugins ?? []).map((plugin) => (plugin as { name: string }).name);
  const other = { name: "other" };
  const env = { command: "serve", mode: "development" } as const;

  it("adds the plugin to an object", () => {
    const config = withClickToSource({ plugins: [other], base: "/x/" }) as { plugins: unknown[]; base: string };

    expect(namesOf(config)).toEqual(["click-to-source", "other"]);
    expect(config.base).toBe("/x/");
  });

  it("adds it to nothing at all", () => {
    expect(namesOf(withClickToSource() as { plugins: unknown[] })).toEqual(["click-to-source"]);
  });

  it("adds it to a function", () => {
    const config = withClickToSource(() => ({ plugins: [other] })) as (e: typeof env) => { plugins: unknown[] };

    expect(namesOf(config(env))).toEqual(["click-to-source", "other"]);
  });

  it("adds it to an async function", async () => {
    const config = withClickToSource(async () => ({ plugins: [other] })) as (e: typeof env) => Promise<{ plugins: unknown[] }>;

    expect(namesOf(await config(env))).toEqual(["click-to-source", "other"]);
  });

  it("adds it to a promise", async () => {
    const config = withClickToSource(Promise.resolve({ plugins: [other] })) as Promise<{ plugins: unknown[] }>;

    expect(namesOf(await config)).toEqual(["click-to-source", "other"]);
  });

  it("passes options along", () => {
    const config = withClickToSource({}, { stampSource: false }) as { plugins: unknown[] };

    expect(namesOf(config)).toEqual(["click-to-source"]);
  });
});

describe("Step 6 Vite file I/O plugin", () => {
  beforeAll(async () => {
    fixtureDirectory = await fs.mkdtemp(
      path.join(pluginRoot, ".cts-plugin-fixture-")
    );

    server = await createServer({
      appType: "custom",
      configFile: false,
      logLevel: "silent",
      root: pluginRoot,
      plugins: [clickToSource()],
      server: {
        host: "127.0.0.1",
        port: 0,
        strictPort: true,
        // The root alone; the workspace boundary is covered below.
        fs: { allow: [pluginRoot] },
      },
    });

    await server.listen();

    const address = server.httpServer?.address();

    if (!address || typeof address === "string") {
      throw new Error("Vite test server did not expose a TCP address");
    }

    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterAll(async () => {
    await server?.close();
    await fs.rm(fixtureDirectory, { force: true, recursive: true });
  });

  it("reads an existing project file", async () => {
    const expectedContent = await fs.readFile(
      path.join(pluginRoot, "src", "index.ts"),
      "utf8"
    );
    const result = await postJson(READ_FILE_PATH, {
      file: "src/index.ts",
    });

    expect(result.status).toBe(200);
    expect(result.body).toEqual({ content: expectedContent });
  });

  // The endpoint used to write `content` verbatim: a whole-file overwrite of
  // any allowed source file under the root, which no client ever sent.
  it("refuses a whole-file write and leaves the file untouched", async () => {
    const original = "const value = 1;\n";
    const fixtureFile = path.relative(
      pluginRoot,
      path.join(fixtureDirectory, "fixture.tsx")
    );
    await fs.writeFile(path.join(pluginRoot, fixtureFile), original, "utf8");

    const writeResult = await postJson(WRITE_FILE_PATH, {
      file: fixtureFile,
      content: "clobbered\n",
    });

    expect(writeResult.status).toBe(400);
    expect(writeResult.body).toEqual({ error: "Invalid request body" });
    expect(await fs.readFile(path.join(pluginRoot, fixtureFile), "utf8")).toBe(
      original
    );
  });

  it("edits only the selected literal through the Step 7 pipeline", async () => {
    const content = `const pink = <mesh color="hotpink" />;
const cyan = <mesh color="cyan" />;
`;
    const fixtureFile = path.relative(
      pluginRoot,
      path.join(fixtureDirectory, "step8-fixture.tsx")
    );

    await fs.writeFile(path.join(pluginRoot, fixtureFile), content, "utf8");

    const writeResult = await postJson(WRITE_FILE_PATH, {
      file: fixtureFile,
      line: 1,
      argName: "color",
      newValue: "rebeccapurple",
    });

    expect(writeResult.status).toBe(200);
    expect(writeResult.body).toEqual({ success: true });
    expect(await fs.readFile(path.join(pluginRoot, fixtureFile), "utf8")).toBe(
      `const pink = <mesh color="rebeccapurple" />;
const cyan = <mesh color="cyan" />;
`
    );
  });

  // A 0.1.3 overlay still sends the contents it read. The edit must apply to
  // the file as it is now, or a save made in between is silently undone.
  it("applies an edit to the file on disk, ignoring any content sent with it", async () => {
    const fixtureFile = path.relative(
      pluginRoot,
      path.join(fixtureDirectory, "stale-fixture.tsx")
    );
    await fs.writeFile(
      path.join(pluginRoot, fixtureFile),
      `const pink = <mesh color="hotpink" />;\n// saved in the editor after the panel read the file\n`,
      "utf8"
    );

    const writeResult = await postJson(WRITE_FILE_PATH, {
      file: fixtureFile,
      content: `const pink = <mesh color="hotpink" />;\n`,
      line: 1,
      argName: "color",
      newValue: "cyan",
    });

    expect(writeResult.status).toBe(200);
    expect(await fs.readFile(path.join(pluginRoot, fixtureFile), "utf8")).toBe(
      `const pink = <mesh color="cyan" />;\n// saved in the editor after the panel read the file\n`
    );
  });

  it("rejects invalid bodies, missing files, and paths outside the Vite root", async () => {
    const invalidBody = await postJson(READ_FILE_PATH, {});
    const missingFile = await postJson(READ_FILE_PATH, {
      file: "src/does-not-exist.ts",
    });
    const traversal = await postJson(READ_FILE_PATH, {
      file: "..\\..\\package.json",
    });
    const absolutePath = await postJson(READ_FILE_PATH, {
      file: path.join(pluginRoot, "src", "index.ts"),
    });

    expect(invalidBody.status).toBe(400);
    expect(invalidBody.body).toEqual({ error: "Invalid request body" });
    expect(missingFile.status).toBe(404);
    expect(missingFile.body).toEqual({ error: "File not found" });
    expect(traversal.status).toBe(400);
    expect(traversal.body).toEqual({ error: "Invalid file path" });
    expect(absolutePath.status).toBe(400);
    expect(absolutePath.body).toEqual({ error: "Invalid file path" });
  });
});

/**
 * A component in a sibling workspace package is stamped relative to the app's
 * root — `../../packages/ui/src/Rock.tsx` — and with the root as the only
 * boundary, every such file was refused: the panel named it and could not
 * edit it. The boundary is now Vite's own `server.fs.allow`, which by default
 * is the workspace root: exactly what Vite already serves source from.
 */
describe("a monorepo workspace", () => {
  let workspace: string;
  let workspaceServer: ViteDevServer;
  let workspaceUrl: string;

  const rockFile = "../../packages/ui/src/Rock.tsx";

  async function post(endpoint: string, body: unknown) {
    const response = await fetch(`${workspaceUrl}${endpoint}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    return {
      status: response.status,
      body: (await response.json()) as Record<string, unknown>,
    };
  }

  beforeAll(async () => {
    // realpath: on Windows, os.tmpdir() can be an 8.3 short path.
    workspace = await fs.mkdtemp(
      path.join(await fs.realpath(os.tmpdir()), "cts-workspace-")
    );
    await fs.writeFile(
      path.join(workspace, "package.json"),
      JSON.stringify({ private: true, workspaces: ["apps/*", "packages/*"] })
    );
    await fs.mkdir(path.join(workspace, "apps", "web"), { recursive: true });
    await fs.mkdir(path.join(workspace, "packages", "ui", "src"), {
      recursive: true,
    });
    await fs.writeFile(
      path.join(workspace, "packages", "ui", "src", "Rock.tsx"),
      "export const Rock = () => <mesh scale={1} />;\n"
    );

    workspaceServer = await createServer({
      appType: "custom",
      configFile: false,
      logLevel: "silent",
      root: path.join(workspace, "apps", "web"),
      plugins: [clickToSource()],
      server: { host: "127.0.0.1", port: 0, strictPort: true },
    });
    await workspaceServer.listen();

    const address = workspaceServer.httpServer?.address();

    if (!address || typeof address === "string") {
      throw new Error("Vite test server did not expose a TCP address");
    }

    workspaceUrl = `http://127.0.0.1:${address.port}`;
  });

  afterAll(async () => {
    await workspaceServer?.close();
    await fs.rm(workspace, { force: true, recursive: true });
  });

  it("reads and edits a file in a sibling workspace package", async () => {
    const read = await post(READ_FILE_PATH, { file: rockFile });

    expect(read.status).toBe(200);
    expect(read.body.content).toContain("scale={1}");

    const write = await post(WRITE_FILE_PATH, {
      file: rockFile,
      line: 1,
      argName: "scale",
      newValue: 3,
    });

    expect(write.status).toBe(200);
    expect(
      await fs.readFile(
        path.join(workspace, "packages", "ui", "src", "Rock.tsx"),
        "utf8"
      )
    ).toBe("export const Rock = () => <mesh scale={3} />;\n");
  });

  it("still refuses a path that leaves the workspace", async () => {
    const outside = await post(READ_FILE_PATH, { file: "../../../outside.ts" });

    expect(outside.status).toBe(400);
    expect(outside.body).toEqual({ error: "Invalid file path" });
  });
});

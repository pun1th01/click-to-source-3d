import path from "node:path";
import { parse } from "@babel/parser";
import * as THREE from "three";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SourceFunction, SourceStamp, TraceFrame } from "@click-to-source-3d/shared";
import * as runtime from "@click-to-source-3d/core/devtools";
import { stampSource } from "../src/stampSource.js";
import { parseSource, pluginsFor } from "../src/trace/facts.js";
import { isThreeBuild, ProjectIndex } from "../src/trace/project.js";

const ROOT = "/app";
const CLIENT = "virtual:click-to-source/client";

/** A project in memory, resolved the way Vite would: relative paths, and packages. */
function project(files: Record<string, string>) {
  const absolute = (name: string) => `${ROOT}/${name}`;
  const resolve = vi.fn(async (source: string, importer: string) => {
    if (source.startsWith(".")) {
      const base = path.posix.join(path.posix.dirname(importer), source);
      for (const candidate of [base, `${base}.js`, `${base}.ts`, `${base}/index.js`]) {
        if (files[candidate.slice(ROOT.length + 1)] !== undefined) {
          return candidate;
        }
      }
      return null;
    }
    return `${ROOT}/node_modules/${source}/index.js`;
  });

  const index = new ProjectIndex({
    resolve,
    read: async (file) => files[file.slice(ROOT.length + 1)] ?? null,
    relative: (file) => file.slice(ROOT.length + 1),
  });

  const transform = async (name: string) => {
    const file = absolute(name);
    const code = files[name];
    const program = parseSource(code, file)!;
    const plan = await index.plan(file, code, program);
    const result = stampSource(code, file, { root: ROOT, trace: { program, plan, client: CLIENT } });
    return { plan, code: result?.code ?? null };
  };

  return { files, index, transform, resolve, absolute };
}

const single = async (code: string, name = "src/main.js") => {
  const { transform } = project({ [name]: code });
  const { code: output } = await transform(name);
  return output as string;
};

/** Runs a transformed module against real three and the real recording functions. */
function run(output: string, returns: string, scope: Record<string, unknown> = {}) {
  const body = output
    .replace(
      /import \{ ([^}]*) \} from "virtual:click-to-source\/client";/,
      (_, names: string) => `const { ${names.replace(/ as /g, ": ")} } = __client;`
    )
    .replace(/import (\* as \w+|\{[^}]*\}|\w+) from "[^"]+";?/g, "")
    .replace(/export default /g, "")
    .replace(/export \{[^}]*\};?/g, "")
    .replace(/export /g, "");
  const names = Object.keys(scope);
  return new Function("__client", "THREE", ...names, `${body}\nreturn ${returns};`)(
    runtime,
    THREE,
    ...names.map((name) => scope[name])
  );
}

/** The table of stamps a transformed module would use. */
function stampsOf(output: string): SourceStamp[] {
  return run(output.split("\n")[0].replace(/\} from "virtual:click-to-source\/client"; /, '} from "virtual:click-to-source/client";\n'), "__ctsData().s") as SourceStamp[];
}

const stampAt = (output: string, line: number) => stampsOf(output).find((stamp) => stamp.line === line)!;
const propsAt = (output: string, line: number) =>
  Object.fromEntries((stampAt(output, line).props ?? []).map((prop) => [prop.name, prop.values.map((value) => value.raw)]));
const usesOf = (stamp: SourceStamp) =>
  (stamp.generator as SourceFunction).uses.map((use) => `${"  ".repeat(use.depth)}${use.name}`);
const names = (trace: TraceFrame[] | undefined) => (trace ?? []).map((frame) => frame.name);

/** What every transformed module must be: valid, and with its lines where they were. */
function expectSound(input: string, output: string, file = "src/main.js") {
  expect(() => parse(output, { sourceType: "module", plugins: pluginsFor(file) })).not.toThrow();
  expect(output.split("\n").length).toBe(input.split("\n").length);
}

beforeEach(() => {
  delete (globalThis as { __CTS_TRACE__?: unknown }).__CTS_TRACE__;
});

describe("which `new`s are recorded", () => {
  it("records three's objects, however three was imported", async () => {
    const out = await single(`
      import * as THREE from "three";
      import { Mesh, Group as G } from "three";
      const a = new THREE.Mesh();
      const b = new Mesh();
      const c = new G();
    `);
    expect(out.match(/__ctsNew\(new /g)).toHaveLength(3);
  });

  it("leaves math alone, which code allocates in tight loops", async () => {
    const out = await single(`
      import * as THREE from "three";
      import { Vector3, Color as Tint, Matrix4 } from "three";
      for (let i = 0; i < 1000; i++) {
        const a = new THREE.Vector3(i, 0, 0);
        const b = new Vector3();
        const c = new Tint("#fff");
        const d = new Matrix4();
        const e = new THREE.Float32BufferAttribute([], 3);
      }
    `);
    expect(out).toBeNull();
  });

  it("leaves the language and the browser alone", async () => {
    const out = await single(`
      const a = new Map();
      const b = new Float32Array(4);
      const c = new Date();
      const d = new Error("x");
      const e = new URL("x");
    `);
    expect(out).toBeNull();
  });

  it("keeps a class of yours with a name three uses for math", async () => {
    const out = await single(`
      import * as THREE from "three";
      class Plane extends THREE.Mesh {}
      const aircraft = new Plane();
    `);
    expect(out).toContain("__ctsNew(new Plane()");
  });

  it("records anything else, for the runtime to judge", async () => {
    const out = await single(`
      import { Thing } from "some-library";
      import Other from "./other";
      const a = new Thing();
      const b = new Other();
      const c = new lowercase();
    `);
    expect(out).toContain("__ctsNew(new Thing()");
    expect(out).toContain("__ctsNew(new Other()");
    expect(out).toContain("new lowercase()");
    expect(out).not.toContain("__ctsNew(new lowercase");
  });

  it("copes with the shapes a `new` is written in", async () => {
    const input = `
      import * as THREE from "three";
      const a = new THREE.Mesh;
      const b = new THREE.Group().add(new THREE.Mesh());
      const c = [new THREE.Mesh()];
      const d = { x: new THREE.Mesh() };
      const e = cond ? new THREE.Mesh() : new THREE.Group();
      function f(a = new THREE.Mesh()) { return a; }
      class G { h = new THREE.Mesh(); }
      export default new THREE.Group();
    `;
    expectSound(input, await single(input));
  });
});

describe("recording calls", () => {
  it("wraps a function that makes objects, inside a try", async () => {
    const out = await single(`
      import * as THREE from "three";
      export function make(a, b) {
        return new THREE.Mesh();
      }
    `);
    expect(out).toMatch(/function make\(a, b\) \{__ctsEnter\(__ctsData\(\)\.f\[\d+\],\[a,b\]\);try\{/);
    expect(out).toContain("}finally{__ctsLeave()}}");
  });

  it("leaves a function that makes nothing untouched", async () => {
    const input = `
      import * as THREE from "three";
      export function area(w, h) { return w * h; }
      export function length(v) { return new THREE.Vector3(v, 0, 0).length(); }
    `;
    const out = await single(input);
    expect(out).toBeNull();
  });

  it("handles a function with no block body", async () => {
    const input = `
      import * as THREE from "three";
      const a = (s) => new THREE.Mesh();
      const b = (s) => ({ mesh: new THREE.Mesh() });
    `;
    const out = await single(input);
    expectSound(input, out);
    expect(out).toContain("__ctsCall(__ctsData().f[0],[s],()=>__ctsNew(new THREE.Mesh()");
    expect(out).toContain("()=>({ mesh:");
  });

  it("can't follow an async function or a generator past its first pause", async () => {
    const out = await single(`
      import * as THREE from "three";
      async function a() { return new THREE.Mesh(); }
      function* b() { yield new THREE.Mesh(); }
      class C { get d() { return new THREE.Mesh(); } }
    `);
    expect(out).not.toContain("__ctsEnter(");
    expect(out.match(/__ctsNew\(new THREE\.Mesh\(\)/g)).toHaveLength(3);
  });

  it("stays after a directive, even one with no semicolon", async () => {
    const input = `
      import * as THREE from "three";
      function a() {
        "use strict"
        return new THREE.Mesh();
      }
    `;
    const out = await single(input);
    expectSound(input, out);
    expect(out).toContain('"use strict";__ctsEnter(');
  });

  it("waits for super() in a subclass, and leaves it out of the try", async () => {
    const input = `
      import * as THREE from "three";
      class Tree extends THREE.Group {
        constructor(height) {
          const half = height / 2
          super()
          this.add(new THREE.Mesh());
        }
      }
    `;
    const out = await single(input);
    expectSound(input, out);
    expect(out).toMatch(/super\(\);__ctsEnter\(__ctsData\(\)\.f\[\d+\],\[height\]\);try\{/);
  });

  it("leaves a constructor alone when super() isn't a statement of its own", async () => {
    const input = `
      import * as THREE from "three";
      class Tree extends THREE.Group {
        constructor(tall) {
          tall ? super() : super();
          this.add(new THREE.Mesh());
        }
      }
    `;
    const out = await single(input);
    expectSound(input, out);
    expect(out).not.toContain("__ctsEnter(");
  });

  it("records a parameter destructured from an options object", async () => {
    const out = await single(`
      import * as THREE from "three";
      export function make({ size, color: tint = "red" }, [first], ...rest) {
        return new THREE.Mesh();
      }
    `);
    expect(out).toContain("[size,tint,rest]");
  });

  it("keeps working in modules that already use the names", async () => {
    const input = `
      import * as THREE from "three";
      const __ctsNew = 1, __ctsData = 2;
      export function make() { return new THREE.Mesh(); }
    `;
    const out = await single(input);
    expectSound(input, out);
    expect(out).toContain("__ctsNew_(new THREE.Mesh()");
    expect(out).toContain("ctsNew as __ctsNew_,");
    expect(out).toContain("function __ctsData_()");
  });
});

describe("what happens when it runs", () => {
  const SOURCE = `
    import * as THREE from "three";
    const SIZE = 40;
    function buildWorld(scene, seed) {
      scene.add(createTerrain(SIZE, seed));
      return 12;
    }
    function createTerrain(size, seed) {
      const mesh = new THREE.Mesh(new THREE.BoxGeometry(size, 1, 1), new THREE.MeshBasicMaterial());
      return mesh;
    }
    const scene = new THREE.Scene();
    const answer = buildWorld(scene, 7);
  `;

  it("doesn't change what the code does", async () => {
    const { answer, scene } = run(await single(SOURCE), "{ answer, scene }");

    expect(answer).toBe(12);
    expect(scene.children).toHaveLength(1);
    expect(scene.children[0].geometry.parameters.width).toBe(40);
  });

  it("gives an object the calls it was made under, with their real values", async () => {
    const { scene } = run(await single(SOURCE), "{ scene }");
    const record = runtime.recordOf(scene.children[0])!;

    expect(names(record.trace)).toEqual(["buildWorld", "createTerrain"]);
    expect(record.trace[0].args.map((arg) => `${arg.name}=${arg.value}`)).toEqual(["scene=<Scene>", "seed=7"]);
    expect(record.trace[1].args.map((arg) => `${arg.name}=${arg.value}`)).toEqual(["size=40", "seed=7"]);
  });

  it("says where a literal argument can be edited, and where a constant is", async () => {
    const { scene } = run(await single(SOURCE), "{ scene }");
    const [outer, inner] = runtime.recordOf(scene.children[0])!.trace;

    expect(outer.calledAt).toMatchObject({ file: "src/main.js", line: 13 });
    expect(outer.args[1].literal).toMatchObject({ raw: "7", line: 13 });
    expect(inner.calledAt).toMatchObject({ file: "src/main.js", line: 5 });
    expect(inner.args[0].literal).toMatchObject({ raw: "40", line: 3, via: "SIZE" });
    // Passed along from a parameter: the frame above holds the literal.
    expect(inner.args[1].literal).toBeUndefined();
  });

  it("leaves objects clean", async () => {
    const { scene } = run(await single(SOURCE), "{ scene }");

    expect(scene.children[0].userData).toEqual({});
    expect(runtime.recordOf(scene)).toBeUndefined();
  });

  it("keeps `this`, return values and exceptions as they were", async () => {
    const out = await single(`
      import * as THREE from "three";
      class Maker {
        factor = 3;
        make(n) { return [new THREE.Group(), n * this.factor]; }
        arrow = (n) => [new THREE.Group(), n * this.factor];
      }
      function broken() { new THREE.Group(); throw new Error("nope"); }
      const object = new Maker();
    `);
    const { object, broken } = run(out, "{ object, broken }");

    expect(object.make(2)[1]).toBe(6);
    expect(object.arrow(2)[1]).toBe(6);
    expect(broken).toThrow("nope");
    // A throw takes the record of the call with it.
    expect(runtime.recordOf(runtime.ctsNew(new THREE.Group(), {} as SourceStamp))?.trace).toEqual([]);
  });

  // A circular import can call a function before the module's body has run.
  it("works when a function runs before the module's body", async () => {
    const out = await single(`
      import * as THREE from "three";
      const early = make();
      function make() { return new THREE.Mesh(); }
    `);
    const { early } = run(out, "{ early }");

    expect(runtime.recordOf(early)?.stamp.function).toBe("make");
  });

  it("follows a subclass's constructor", async () => {
    const out = await single(`
      import * as THREE from "three";
      class Tree extends THREE.Group {
        constructor(height) {
          super();
          this.trunk = new THREE.Mesh();
          this.add(this.trunk);
        }
      }
      function plant() { return new Tree(5); }
      const tree = plant();
    `);
    const { tree } = run(out, "{ tree }");
    const trunk = runtime.recordOf(tree.trunk)!;

    expect(tree).toBeInstanceOf(THREE.Group);
    expect(names(trunk.trace)).toEqual(["plant", "Tree"]);
    expect(trunk.trace[1].args[0]).toMatchObject({ name: "height", value: "5", literal: { raw: "5" } });
    expect(trunk.trace[1].calledAt?.line).toBe(10);
    expect(runtime.recordOf(tree)?.stamp).toMatchObject({ creates: "Tree", how: "new", line: 10 });
  });

  it("doesn't confuse two calls in one expression", async () => {
    const out = await single(`
      import * as THREE from "three";
      function outer(child) { const group = new THREE.Group(); group.add(child); return group; }
      function inner(n) { return new THREE.Mesh(); }
      const made = outer(inner(1));
    `);
    const { made } = run(out, "{ made }");

    expect(names(runtime.recordOf(made.children[0])?.trace)).toEqual(["inner"]);
    expect(runtime.recordOf(made.children[0])?.trace[0].args[0].literal?.raw).toBe("1");
    expect(names(runtime.recordOf(made)?.trace)).toEqual(["outer"]);
    expect(runtime.recordOf(made)?.trace[0].calledAt?.line).toBe(5);
  });

  it("clones are recorded where they are cloned", async () => {
    const out = await single(`
      import * as THREE from "three";
      const rock = new THREE.Mesh();
      const second = rock.clone();
      second.position.set(1, 2, 3);
    `);
    const { rock, second } = run(out, "{ rock, second }");

    expect(runtime.recordOf(rock)?.stamp).toMatchObject({ line: 3, how: "new", creates: "Mesh" });
    expect(runtime.recordOf(second)?.stamp).toMatchObject({ line: 4, how: "clone", creates: "rock.clone" });
    expect(runtime.recordOf(second)?.stamp.props?.[0]).toMatchObject({ name: "position" });
  });

  it("passes what a loader returns through to the callback", async () => {
    const seen: unknown[] = [];
    const gltf = { scene: new THREE.Group() };
    class GLTFLoader {
      load(_url: string, done: (result: unknown) => void) {
        done(gltf);
      }
    }
    const out = await single(`
      import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
      function load() {
        const loader = new GLTFLoader();
        loader.load("/a.glb", (model) => seen.push(model));
      }
      load();
    `);
    run(out, "0", { GLTFLoader, seen });

    expect(seen).toEqual([gltf]);
    expect(runtime.recordOf(gltf.scene)?.stamp).toMatchObject({ how: "load", creates: "GLTFLoader", line: 5 });
    expect(runtime.recordOf(gltf.scene)?.stamp.props?.[0]).toMatchObject({ name: "url", values: [{ raw: '"/a.glb"' }] });
    expect(names(runtime.recordOf(gltf.scene)?.trace)).toEqual(["load"]);
  });
});

describe("clones and loaders, as written", () => {
  it("skips what is always a vector, and optional chains", async () => {
    const out = await single(`
      import * as THREE from "three";
      const mesh = new THREE.Mesh();
      const a = mesh.position.clone();
      const b = this.velocity.clone();
      const c = target.clone();
      const d = mesh?.clone();
    `);
    expect(out).not.toContain("__ctsNew(mesh.position");
    expect(out).not.toContain("__ctsNew(this.velocity");
    expect(out).not.toContain("__ctsNew(target");
    expect(out).toContain("mesh?.clone()");
  });

  it("knows a loader by what made it, by its name, or by the chain it is in", async () => {
    const input = `
      import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
      const a = new GLTFLoader();
      a.load("a", (x) => x);
      myLoader.load("b", (x) => x);
      this.modelLoader.load("c", (x) => x);
      new GLTFLoader().setPath("/m/").load("d", (x) => x);
      const e = await a.loadAsync("e");
      const f = await a.parseAsync("f", "");
      a.parse("g", "", (x) => x);
    `;
    const out = await single(input);
    expectSound(input, out);
    expect(out.match(/__ctsOnLoad\(/g)).toHaveLength(5);
    expect(out.match(/__ctsLoadAsync\(/g)).toHaveLength(2);
  });

  it("doesn't take JSON.parse or a store's load for one", async () => {
    const out = await single(`
      import * as THREE from "three";
      new THREE.Mesh();
      const a = JSON.parse("{}");
      store.load("x", (y) => y);
      const b = Date.parse("x");
    `);
    expect(out).not.toContain("__ctsOnLoad(");
    expect(out).toContain('JSON.parse("{}")');
  });
});

describe("following a project across files", () => {
  const FILES = {
    "src/main.js": `
      import { buildWorld } from "./world";
      import { unrelated } from "./math";
      function init() {
        buildWorld(7);
        unrelated(1);
      }
      init();
    `,
    "src/world.js": `
      import { createTerrain } from "./terrain";
      export function buildWorld(seed) {
        return createTerrain(40, seed);
      }
    `,
    "src/terrain.js": `
      import * as THREE from "three";
      import { fbm } from "./noise";
      export function createTerrain(size, seed) {
        const height = fbm(seed, 0.08) * 6;
        return new THREE.Mesh();
      }
    `,
    "src/noise.js": `
      function hash(x) { return x * 127.1; }
      export function fbm(x, frequency) { return hash(x) * frequency; }
    `,
    "src/math.js": `
      export function unrelated(x) { return x + 1; }
    `,
  };

  it("records every function on the way to an object, however many files away", async () => {
    const { transform } = project(FILES);

    expect((await transform("src/main.js")).code).toContain("__ctsEnter(");
    expect((await transform("src/world.js")).code).toContain("__ctsEnter(");
    expect((await transform("src/terrain.js")).code).toContain("__ctsEnter(");
  });

  it("leaves everything else alone", async () => {
    const { transform } = project(FILES);

    expect((await transform("src/noise.js")).code).toBeNull();
    expect((await transform("src/math.js")).code).toBeNull();
    expect((await transform("src/main.js")).code).toContain("unrelated(1)");
    expect((await transform("src/main.js")).code).not.toContain("__ctsVia(__ctsSite(__ctsData().c[1]),unrelated");
  });

  it("notes a call to such a function wherever it is defined", async () => {
    const { transform } = project(FILES);
    const { code } = await transform("src/world.js");

    expect(code).toContain("__ctsVia(__ctsSite(__ctsData().c[0]),createTerrain(40, seed))");
    expect(run(code!.split("\n")[0].replace(/\} from "virtual:click-to-source\/client"; /, '} from "virtual:click-to-source/client";\n'), "__ctsData().c")).toEqual([
      expect.objectContaining({ target: "src/terrain.js#createTerrain", file: "src/world.js", line: 4 }),
    ]);
  });

  it("lists the helpers behind an object, nested", async () => {
    const { transform } = project(FILES);
    const stamp = stampAt((await transform("src/terrain.js")).code!, 6);

    expect(usesOf(stamp)).toEqual(["fbm", "  hash"]);
    const fbm = (stamp.generator as SourceFunction).uses[0];
    expect(fbm).toMatchObject({ file: "src/noise.js", line: 3, params: ["x", "frequency"] });
  });

  // A file is read once and kept, so what it says has to be forgotten when it changes.
  it("sees a helper start making objects", async () => {
    const files: Record<string, string> = {
      "src/main.js": `import { helper } from "./helper"; export function caller() { return helper(); }`,
      "src/helper.js": `export function helper() { return 1; }`,
    };
    const { transform, index, absolute } = project(files);
    expect((await transform("src/main.js")).code).toBeNull();

    files["src/helper.js"] = `import * as THREE from "three"; export function helper() { return new THREE.Mesh(); }`;
    index.invalidate(absolute("src/helper.js"));

    expect((await transform("src/main.js")).code).toContain("__ctsEnter(");
  });

  // Saving a value writes a temporary file, and the watcher sees it appear and go while a
  // reload is reading the project. Found by the save in a browser test failing one time in
  // four: the call in main.js was served with no record of it, and with no literal to edit.
  describe("when a file changes while the project is being read", () => {
    const SOURCES = {
      "src/main.js": `import { build } from "./world"; build(7);`,
      "src/world.js": `import { Mesh } from "three"; export function build(seed) { return new Mesh(); }`,
    };

    /** A project in which something happens the first few times an import is resolved. */
    function disturbedProject(disturb: (index: ProjectIndex) => void, times = 1) {
      let left = times;
      const index: ProjectIndex = new ProjectIndex({
        resolve: async (source, importer) => {
          await Promise.resolve();
          if (left > 0) {
            left--;
            disturb(index);
          }
          return source.startsWith(".")
            ? path.posix.join(path.posix.dirname(importer), `${source}.js`)
            : `${ROOT}/node_modules/${source}/index.js`;
        },
        read: async (file) => SOURCES[file.slice(ROOT.length + 1) as keyof typeof SOURCES] ?? null,
        relative: (file) => file.slice(ROOT.length + 1),
      });
      return index;
    }

    const planOf = async (index: ProjectIndex) => {
      const code = SOURCES["src/main.js"];
      return index.plan(`${ROOT}/src/main.js`, code, parseSource(code, "/app/src/main.js")!);
    };

    it("isn't misled by forgetting how imports resolve", async () => {
      const plan = await planOf(disturbedProject((index) => index.forgetResolutions()));

      expect([...plan.callTargets.values()]).toEqual(["src/world.js#build"]);
    });

    it("isn't misled by a file it had read changing", async () => {
      const plan = await planOf(disturbedProject((index) => index.invalidate(`${ROOT}/src/world.js`)));

      expect([...plan.callTargets.values()]).toEqual(["src/world.js#build"]);
    });

    it("gets there through several changes in a row", async () => {
      const plan = await planOf(disturbedProject((index) => index.forgetResolutions(), 5));

      expect([...plan.callTargets.values()]).toEqual(["src/world.js#build"]);
    });

    it("doesn't go on forever if files never stop changing", async () => {
      await expect(planOf(disturbedProject((index) => index.forgetResolutions(), Infinity))).resolves.toBeDefined();
    });
  });

  it("doesn't take a path it couldn't resolve for a package", async () => {
    const { transform } = project({
      "src/main.js": `
        import * as THREE from "three";
        import { gone } from "./gone";
        function make() { gone(1); return new THREE.Mesh(); }
      `,
    });
    const stamp = stampsOf((await transform("src/main.js")).code!)[0];

    expect(usesOf(stamp)).toEqual([]);
  });

  it("reads each file once, however many ask", async () => {
    const { transform, resolve } = project(FILES);
    await transform("src/main.js");
    await transform("src/world.js");
    await transform("src/main.js");

    // Each import resolved once: 2 + 1 + 2 project imports, one package.
    expect(resolve.mock.calls.filter(([source]) => source === "./noise")).toHaveLength(1);
  });

  it("isn't caught out by files importing each other", async () => {
    const { transform } = project({
      "src/a.js": `import { b } from "./b"; export function a() { return b(); }`,
      "src/b.js": `import * as THREE from "three"; import { a } from "./a"; export function b() { new THREE.Mesh(); return a(); }`,
    });

    expect((await transform("src/a.js")).code).toContain("__ctsEnter(");
    expect((await transform("src/b.js")).code).toContain("__ctsEnter(");
  });

  it("follows re-exports, aliases, defaults and namespaces", async () => {
    const { transform } = project({
      "src/main.js": `
        import makeDefault from "./default";
        import { renamed } from "./barrel";
        import { viaStar } from "./barrel";
        import * as all from "./barrel";
        export function a() { return makeDefault(); }
        export function b() { return renamed(); }
        export function c() { return viaStar(); }
        export function d() { return all.renamed(); }
        export function e() { return 1; }
      `,
      "src/barrel.js": `
        export { original as renamed } from "./original";
        export * from "./star";
      `,
      "src/original.js": `import { Mesh } from "three"; export const original = () => new Mesh();`,
      "src/star.js": `import { Mesh } from "three"; export function viaStar() { return new Mesh(); }`,
      "src/default.js": `import { Mesh } from "three"; export default function () { return new Mesh(); }`,
    });
    const { code } = await transform("src/main.js");

    expect(code!.match(/__ctsEnter\(/g)).toHaveLength(4);
  });

  it("follows a class that extends one from another file", async () => {
    const { transform } = project({
      "src/main.js": `
        import { Oak } from "./oak";
        export function plant() { return new Oak(); }
      `,
      "src/oak.js": `
        import { Tree } from "./tree";
        export class Oak extends Tree {}
      `,
      "src/tree.js": `
        import * as THREE from "three";
        export class Tree extends THREE.Group {}
      `,
    });

    expect((await transform("src/main.js")).code).toContain("__ctsEnter(");
  });

  it("follows a method through what a variable holds", async () => {
    const { transform } = project({
      "src/main.js": `
        import { World } from "./world";
        const world = new World();
        export function run() { return world.build(); }
      `,
      "src/world.js": `
        import { Mesh } from "three";
        export class World {
          build() { return this.part(); }
          part() { return new Mesh(); }
        }
      `,
    });
    const { code } = await transform("src/main.js");

    expect(code).toContain("__ctsVia(__ctsSite(");
    expect((await transform("src/world.js")).code!.match(/__ctsEnter\(/g)).toHaveLength(2);
  });

  it("copes with names a plain object already has", async () => {
    const input = `
      import * as THREE from "three";
      class C { make() { return new THREE.Mesh(); } }
      function make() { return toString() + valueOf() + constructor(); }
      const c = new C();
    `;
    expectSound(input, await single(input));
  });
});

describe("what a name means where it is written", () => {
  // Found in three's own GLTFLoader: a parameter called onLoad, and a function called
  // onLoad further down. The call was noted as one to the function, which it isn't.
  it("takes a parameter for a parameter, not for a function of the same name", async () => {
    const out = await single(`
      import * as THREE from "three";
      function onLoad() { return new THREE.Mesh(); }
      export function parse(onLoad) { return onLoad(1); }
    `);

    expect(out).not.toContain("__ctsVia(");
    expect(out).toContain("export function parse(onLoad) { return onLoad(1); }");
  });

  it("takes a local variable for a variable, whatever is assigned to it later", async () => {
    const out = await single(`
      import * as THREE from "three";
      function loadImage(resolve) {
        let onLoad = resolve;
        onLoad = function (image) { return new THREE.Mesh(); };
        return 1;
      }
      export function caller() { const onLoad = () => 2; onLoad(); }
    `);

    expect(out).not.toContain("__ctsVia(");
  });

  it("takes a call to a function declared inside the caller for that one", async () => {
    const out = await single(`
      import * as THREE from "three";
      function helper() { return 1; }
      export function build() {
        const made = helper();
        function helper() { return new THREE.Mesh(); }
        return made;
      }
    `);
    const stamp = stampsOf(out)[0];

    expect(out).toContain("__ctsVia(__ctsSite(");
    expect(usesOf(stamp)).toEqual([]);
  });

  it("takes a call to the module's function where nothing nearer has the name", async () => {
    const out = await single(`
      import * as THREE from "three";
      function height(x) { return x * 2; }
      export function build(size) {
        const shadowed = (height) => height + 1;
        return new THREE.Mesh(new THREE.BoxGeometry(size, height(size), size));
      }
    `);

    expect(usesOf(stampsOf(out)[0])).toEqual(["height"]);
  });

  it("finds a class declared inside a function", async () => {
    const out = await single(`
      import * as THREE from "three";
      export function makeLamp() {
        class Lamp extends THREE.Group {}
        return new Lamp();
      }
      export function caller() { return makeLamp(); }
    `);

    expect(out.match(/__ctsEnter\(/g)).toHaveLength(2);
  });

  it("lets a parameter hide an import with its name", async () => {
    const out = await single(`
      import * as THREE from "three";
      import { noise } from "simplex-noise";
      export function terrain(noise) {
        const height = noise.sample(1);
        return new THREE.Mesh();
      }
    `);

    expect(usesOf(stampsOf(out)[0])).toEqual([]);
  });

  it("lets a named function expression call itself", async () => {
    const out = await single(`
      import * as THREE from "three";
      export const grow = function branch(depth) {
        const group = new THREE.Group();
        if (depth > 0) group.add(branch(depth - 1));
        return group;
      };
    `);

    expect(out).toContain("__ctsVia(__ctsSite(");
  });
});

describe("the arguments of a call", () => {
  const sitesOf = (output: string) =>
    run(output.split("\n")[0].replace(/\} from "virtual:click-to-source\/client"; /, '} from "virtual:click-to-source/client";\n'), "__ctsData().c") as Array<{
      args: unknown[];
    }>;
  const MAKER = `import * as THREE from "three"; function make(a, b, c) { return new THREE.Mesh(); }`;

  // A position after a spread says nothing about which parameter an argument is.
  it("gives up on positions after a spread", async () => {
    const [site] = sitesOf(await single(`
${MAKER}
make(1, ...rest, 3);`));

    expect(site.args).toEqual([expect.objectContaining({ raw: "1" }), null, null]);
  });

  it("keeps an object's keys after a spread in it, and drops those before", async () => {
    const [site] = sitesOf(await single(`
${MAKER}
make({ a: 1, ...defaults, b: 2 });`));

    expect(site.args).toEqual([{ keys: { b: expect.objectContaining({ raw: "2" }) } }]);
  });

  it("drops a key a later one replaces with something that can't be edited", async () => {
    const [site] = sitesOf(await single(`
${MAKER}
make({ size: 1, size: compute() });`));

    expect(site.args).toEqual([{ keys: {} }]);
  });

  it("doesn't offer a rest parameter's first value as all of it", async () => {
    const out = await single(`
      import * as THREE from "three";
      function make(first, ...others) { return new THREE.Mesh(); }
      const mesh = make(1, 2, 3);
    `);
    const { mesh } = run(out, "{ mesh }");
    const args = runtime.recordOf(mesh)!.trace[0].args;

    expect(args[0].literal?.raw).toBe("1");
    expect(args[1]).toEqual({ name: "others", value: "Array(2)" });
  });
});

describe("helpers", () => {
  const usesIn = async (body: string, line: number) => usesOf(stampAt(await single(body), line));

  it("finds a noise function from a package", async () => {
    expect(
      await usesIn(
        `
        import * as THREE from "three";
        import { createNoise2D } from "simplex-noise";
        const noise = createNoise2D();
        function terrain() {
          const height = noise(1, 2);
          return new THREE.Mesh();
        }
        `,
        7
      )
    ).toEqual(["noise"]);
  });

  it("finds one made inside the function", async () => {
    expect(
      await usesIn(
        `
        import * as THREE from "three";
        import { createNoise2D } from "simplex-noise";
        function terrain() {
          const noise = createNoise2D();
          const height = noise(1, 2);
          return new THREE.Mesh();
        }
        `,
        7
      )
    ).toEqual(["createNoise2D", "noise"]);
  });

  it("finds a method of a noise class", async () => {
    expect(
      await usesIn(
        `
        import * as THREE from "three";
        import SimplexNoise from "simplex-noise";
        function terrain() {
          const simplex = new SimplexNoise();
          const height = simplex.noise2D(1, 2);
          return new THREE.Mesh();
        }
        `,
        7
      )
    ).toEqual(["default.noise2D"]);
  });

  it("finds three's own noise addons, though not its other functions", async () => {
    expect(
      await usesIn(
        `
        import * as THREE from "three";
        import { ImprovedNoise } from "three/addons/math/ImprovedNoise.js";
        function terrain() {
          const perlin = new ImprovedNoise();
          const height = perlin.noise(1, 2, 3);
          const clamped = THREE.MathUtils.clamp(height, 0, 1);
          return new THREE.Mesh();
        }
        `,
        8
      )
    ).toEqual(["ImprovedNoise.noise"]);
  });

  it("finds a method of an object of helpers", async () => {
    const { transform } = project({
      "src/main.js": `
        import { Mesh } from "three";
        import { noise } from "./noise";
        const local = { wobble(x) { return x; } };
        function terrain() {
          local.wobble(1);
          noise.fbm(1);
          return new Mesh();
        }
      `,
      "src/noise.js": `
        export const noise = { fbm(x) { return x * 0.5; } };
      `,
    });

    expect(usesOf(stampAt((await transform("src/main.js")).code!, 8))).toEqual(["wobble", "fbm"]);
  });

  it("leaves out react and three, which aren't helpers", async () => {
    expect(
      await usesIn(
        `
        import * as THREE from "three";
        import { useMemo } from "react";
        import { OrbitControls } from "three/addons/controls/OrbitControls.js";
        function Terrain() {
          const made = useMemo(() => 1, []);
          const c = THREE.MathUtils.clamp(1, 0, 1);
          return new THREE.Mesh();
        }
        `,
        8
      )
    ).toEqual([]);
  });

  // What another function makes has its own source, and isn't what this was made with.
  it("leaves out functions that make objects of their own", async () => {
    expect(
      await usesIn(
        `
        import * as THREE from "three";
        function rocks() { return new THREE.Group(); }
        function height() { return 2; }
        function world() {
          rocks();
          height();
          return new THREE.Mesh();
        }
        `,
        8
      )
    ).toEqual(["height"]);
  });

  it("doesn't go on forever", async () => {
    const depth = Array.from({ length: 12 }, (_, i) => `function h${i}() { return h${i + 1}(); }`).join("\n");
    const out = await single(`
      import * as THREE from "three";
      ${depth}
      function h12() { return h0(); }
      function make() { h0(); return new THREE.Mesh(); }
    `);

    expect(out).toContain("__ctsEnter(");
  });
});

describe("what an object's values are", () => {
  it("reads a constructor's arguments, following a constant to where it is written", async () => {
    const out = await single(`
      import * as THREE from "three";
      const SIZE = 4;
      const geometry = new THREE.BoxGeometry(SIZE, 2, -1.5);
    `);

    expect(propsAt(out, 4).args).toEqual(["4", "2", "-1.5"]);
    expect(stampAt(out, 4).props![0].values[0]).toMatchObject({ via: "SIZE", line: 3, editable: true });
    expect(stampAt(out, 4).props![0].values[1]).toMatchObject({ line: 4, editable: true });
  });

  it("shows a geometry's arguments even when they are all variables", async () => {
    const out = await single(`
      import * as THREE from "three";
      function make(w, h) { return new THREE.BoxGeometry(w, h); }
    `);
    expect(propsAt(out, 3).args).toEqual(["w", "h"]);
    expect(stampAt(out, 3).props![0].values[0].editable).toBe(false);
  });

  it("says nothing about `new Mesh(geometry, material)`, which the panel already shows", async () => {
    const out = await single(`
      import * as THREE from "three";
      const mesh = new THREE.Mesh(geometry, material);
    `);
    expect(stampAt(out, 3).props).toBeUndefined();
  });

  it("reads an options object key by key", async () => {
    const out = await single(`
      import * as THREE from "three";
      const material = new THREE.MeshStandardMaterial({ color: "#ff0000", roughness: 0.5, map, nested: { a: 1 }, [computed]: 1 });
    `);

    expect(propsAt(out, 3)).toEqual({ color: ['"#ff0000"'], roughness: ["0.5"], map: ["map"] });
  });

  it("reads what is set on the object afterwards", async () => {
    const out = await single(`
      import * as THREE from "three";
      const mesh = new THREE.Mesh();
      mesh.position.set(1, 2, 3);
      mesh.scale.setScalar(2);
      mesh.rotation.y = 0.5;
      mesh.position.setX(9);
      mesh.material.color.setHex(0xff0000);
      mesh.castShadow = true;
      mesh.rotateX(0.25);
      mesh.lookAt(0, 1, 0);
    `);
    const props = propsAt(out, 3);

    expect(props.position).toEqual(["1", "2", "3"]);
    expect(props.scale).toEqual(["2"]);
    expect(props["rotation-y"]).toEqual(["0.5"]);
    expect(props["position-x"]).toEqual(["9"]);
    expect(props["material-color"]).toEqual(["0xff0000"]);
    expect(props.castShadow).toEqual(["true"]);
    expect(props["rotateX()"]).toEqual(["0.25"]);
    expect(props["lookAt()"]).toEqual(["0", "1", "0"]);
  });

  it("leaves out bookkeeping and deep paths", async () => {
    const out = await single(`
      import * as THREE from "three";
      const mesh = new THREE.Mesh();
      mesh.userData.id = 1;
      mesh.matrixAutoUpdate = false;
      mesh.geometry.attributes.position.needsUpdate = true;
      mesh.a.b.c.d = 1;
      mesh.add(child);
      mesh.foo.bar();
    `);
    expect(stampAt(out, 3).props).toBeUndefined();
  });

  it("finds values set anywhere in the file on a top-level object", async () => {
    const out = await single(`
      import * as THREE from "three";
      function animate() { cube.rotation.x += 0.01; }
      const cube = new THREE.Mesh();
      function resize() { cube.scale.x = 2; }
    `);

    expect(propsAt(out, 4)["rotation-x +="]).toEqual(["0.01"]);
    expect(propsAt(out, 4)["scale-x"]).toEqual(["2"]);
  });

  it("follows a variable declared first and assigned later", async () => {
    const out = await single(`
      import * as THREE from "three";
      let cube;
      function init() { cube = new THREE.Mesh(); }
      function animate() { cube.rotation.x = 1; }
    `);
    expect(propsAt(out, 4)["rotation-x"]).toEqual(["1"]);
  });

  it("stays inside the function for a local variable", async () => {
    const out = await single(`
      import * as THREE from "three";
      function a() { const mesh = new THREE.Mesh(); mesh.scale.x = 1; }
      function b() { const mesh = new THREE.Mesh(); mesh.scale.x = 2; }
    `);
    const [first, second] = stampsOf(out);

    expect(first.props?.[0].values[0].raw).toBe("1");
    expect(second.props?.[0].values[0].raw).toBe("2");
  });

  it("tells apart one name used twice in a function", async () => {
    const out = await single(`
      import * as THREE from "three";
      function a() {
        { const mesh = new THREE.Mesh(); mesh.scale.x = 1; }
        { const mesh = new THREE.Mesh(); mesh.scale.x = 2; }
      }
    `);
    const [first, second] = stampsOf(out);

    expect(first.props?.map((prop) => prop.values[0].raw)).toEqual(["1"]);
    expect(second.props?.map((prop) => prop.values[0].raw)).toEqual(["2"]);
  });

  it("credits a field to its class", async () => {
    const out = await single(`
      import * as THREE from "three";
      class Rig { mesh = new THREE.Mesh(); }
    `);
    expect(stampAt(out, 3).function).toBe("Rig");
  });

  it("follows a field through its class, and no other", async () => {
    const out = await single(`
      import * as THREE from "three";
      class A {
        mesh = new THREE.Mesh();
        update() { this.mesh.position.x = 1; }
      }
      class B {
        constructor() { this.mesh = new THREE.Mesh(); }
        update() { this.mesh.position.x = 2; }
      }
    `);
    const [first, second] = stampsOf(out);

    expect(first.props?.[0].values[0].raw).toBe("1");
    expect(second.props?.[0].values[0].raw).toBe("2");
  });

  it("sees through a TypeScript cast", async () => {
    const out = await single(
      `
      import * as THREE from "three";
      const mesh = new THREE.Mesh() as THREE.Mesh<THREE.BoxGeometry>;
      mesh.position.x = 1;
      `,
      "src/main.ts"
    );
    expect(propsAt(out, 3)["position-x"]).toEqual(["1"]);
  });
});

describe("numbers", () => {
  it("lists a function's other numbers, by line, with the line's text", async () => {
    const out = await single(`
      import * as THREE from "three";
      function terrain(x) {
        const height = x * 0.08 + 6;
        const mesh = new THREE.Mesh();
        mesh.position.y = 2;
        return mesh;
      }
    `);
    const { numbers } = stampAt(out, 5).generator as SourceFunction;

    expect(numbers).toEqual([
      {
        line: 4,
        text: "const height = x * 0.08 + 6;",
        values: [expect.objectContaining({ raw: "0.08" }), expect.objectContaining({ raw: "6" })],
      },
    ]);
  });

  it("leaves out what isn't a value anyone tunes", async () => {
    const out = await single(`
      import * as THREE from "three";
      function make(list) {
        for (let i = 0; i < 4; i++) { list[0] = { 3: "a" }; }
        return new THREE.Mesh();
      }
    `);
    const { numbers } = stampAt(out, 5).generator as SourceFunction;

    expect(numbers.flatMap((group) => group.values.map((value) => value.raw))).toEqual(["4"]);
  });

  it("includes colours, and a negative number as one value", async () => {
    const out = await single(`
      import * as THREE from "three";
      function make() {
        const tint = "#ff0000", name = "hello", offset = -2.5;
        return new THREE.Mesh();
      }
    `);
    const { numbers } = stampAt(out, 5).generator as SourceFunction;

    expect(numbers[0].values.map((value) => value.raw)).toEqual(['"#ff0000"', "-2.5"]);
  });

  it("stops somewhere", async () => {
    const out = await single(`
      import * as THREE from "three";
      function make() {
        ${Array.from({ length: 300 }, (_, i) => `const n${i} = ${i + 2};`).join("\n")}
        return new THREE.Mesh();
      }
    `);
    const stamp = stampsOf(out)[0];
    const count = (stamp.generator as SourceFunction).numbers.flatMap((group) => group.values).length;

    expect(count).toBeLessThanOrEqual(48);
  });
});

describe("code at the top level of a module", () => {
  // Written one statement at a time, with no function to hold it together.
  const SCRIPT = `
    import * as THREE from "three";
    import { createNoise2D } from "simplex-noise";
    const noise = createNoise2D();
    const geometry = new THREE.PlaneGeometry(10, 10, 64, 64);
    const position = geometry.attributes.position;
    for (let i = 0; i < position.count; i++) {
      position.setZ(i, noise(i, 0.5) * 2);
    }
    const other = new THREE.BoxGeometry(1, 1, 1);
    const scale = 3 * 4;
  `;

  it("finds the noise in the loop that uses what it made", async () => {
    const out = await single(SCRIPT);
    expect(usesOf(stampAt(out, 5))).toEqual(["noise"]);
  });

  it("finds the numbers there too, and not those of unrelated statements", async () => {
    const out = await single(SCRIPT);
    const numbers = (stampAt(out, 5).generator as SourceFunction).numbers.flatMap((group) =>
      group.values.map((value) => value.raw)
    );

    expect(numbers).toEqual(["0.5", "2"]);
    expect(usesOf(stampAt(out, 10))).toEqual([]);
  });

  it("calls it the top level", async () => {
    const out = await single(SCRIPT);
    expect(stampAt(out, 5).function).toBe("(top level)");
    expect((stampAt(out, 5).generator as SourceFunction).name).toBe("(top level)");
  });
});

describe("TypeScript", () => {
  it("reads a file that JSX would misread", async () => {
    const input = `
      import * as THREE from "three";
      const cast = <THREE.Mesh>new THREE.Mesh();
      const identity = <T>(value: T): T => value;
      export function make<T>(a: T): THREE.Mesh { return new THREE.Mesh(); }
    `;
    const out = await single(input, "src/main.ts");
    expectSound(input, out, "src/main.ts");
    expect(out).toContain("__ctsNew(new THREE.Mesh()");
  });

  it("handles what TypeScript adds to a class", async () => {
    const input = `
      import * as THREE from "three";
      export abstract class Base extends THREE.Group {
        declare foo: string;
        private readonly mesh: THREE.Mesh = new THREE.Mesh();
        abstract shape(): void;
        constructor(public height: number, private tint: string = "red") {
          super();
          this.add(this.mesh, new THREE.Mesh());
        }
      }
      export enum Kind { A = 1, B = 2 }
      interface Shape { size: number }
      declare const external: number;
      type Alias = THREE.Mesh;
    `;
    const out = await single(input, "src/main.ts");
    expectSound(input, out, "src/main.ts");
    expect(out).toMatch(/super\(\);;?__ctsEnter\(__ctsData\(\)\.f\[\d+\],\[height,tint\]\);try\{/);
  });

  it("ignores an import of types", async () => {
    const { resolve, transform } = project({
      "src/main.ts": `
        import type { Foo } from "./types";
        import { Mesh } from "three";
        export function make(): Foo { return new Mesh(); }
      `,
      "src/types.ts": `export type Foo = number;`,
    });
    await transform("src/main.ts");

    expect(resolve.mock.calls.map(([source]) => source)).not.toContain("./types");
  });
});

describe("JSX, in the same module", () => {
  const COMPONENT = `
    import * as THREE from "three";
    import { useMemo } from "react";
    import { fbm } from "./noise";
    export function Terrain({ size }) {
      const geometry = useMemo(() => new THREE.PlaneGeometry(size, size), [size]);
      const height = fbm(1, 0.5);
      return <mesh geometry={geometry} position={[0, height, 0]} scale={1.5}><meshStandardMaterial color="red" /></mesh>;
    }
  `;

  const files = {
    "src/Terrain.jsx": COMPONENT,
    "src/noise.js": `export function fbm(x, y) { return x * y; }`,
  };

  it("stamps the elements and records the rest", async () => {
    const { code } = await project(files).transform("src/Terrain.jsx");

    expect(code).toContain("userData-__ctsSource={__ctsData().s[");
    expect(code).toContain("__ctsNew(new THREE.PlaneGeometry(size, size)");
    expectSound(COMPONENT, code!, "src/Terrain.jsx");
  });

  it("gives an element what its function uses, too", async () => {
    const { code } = await project(files).transform("src/Terrain.jsx");
    const mesh = stampsOf(code!).find((stamp) => stamp.function === "Terrain" && stamp.creates === undefined)!;

    expect(usesOf(mesh)).toEqual(["fbm"]);
    // 1.5 is a prop, so it is already shown as one.
    const numbers = (mesh.generator as SourceFunction).numbers.flatMap((group) => group.values.map((value) => value.raw));
    expect(numbers).toContain("0.5");
    expect(numbers).not.toContain("1.5");
  });
});

describe("what isn't a project file", () => {
  it("takes a copy of three kept in the project for three", async () => {
    const { transform, index } = project({
      "src/main.js": `
        import { Mesh, Vector3 } from "./lib/three.module.js";
        export function make() { new Vector3(); return new Mesh(); }
      `,
      "src/lib/three.module.js": `export class Mesh {} ${"// padding\n".repeat(10000)}`,
    });
    const { code } = await transform("src/main.js");

    expect(code).toContain("__ctsEnter(");
    expect(code).toContain("__ctsNew(new Mesh()");
    expect(code).not.toContain("__ctsNew(new Vector3()");
    expect(index).toBeDefined();
  });

  it("isn't fooled by your own small file called three.js", () => {
    expect(isThreeBuild("/app/src/three.js", "export const scene = 1;")).toBe(false);
    expect(isThreeBuild("/app/lib/three.module.min.js", "x".repeat(200000))).toBe(true);
    expect(isThreeBuild("/app/lib/three.core.js", "x".repeat(200000))).toBe(true);
    expect(isThreeBuild("/app/lib/other.js", "x".repeat(200000))).toBe(false);
  });

  it("names the package behind one of Vite's pre-bundled copies", async () => {
    const index = new ProjectIndex({
      resolve: async (source) =>
        source === "simplex-noise"
          ? "/app/node_modules/.vite/deps/simplex-noise.js?v=abc123"
          : "/app/node_modules/.vite/deps/three.js?v=abc123",
      read: async () => null,
      relative: (file) => file.slice(ROOT.length + 1),
    });
    const code = `
      import * as THREE from "three";
      import { createNoise2D } from "simplex-noise";
      const noise = createNoise2D();
      export function make() { noise(1); return new THREE.Mesh(); }
    `;
    const program = parseSource(code, "/app/src/main.js")!;
    const plan = await index.plan("/app/src/main.js", code, program);
    const output = stampSource(code, "/app/src/main.js", { root: ROOT, trace: { program, plan, client: CLIENT } })!.code;

    expect(output).toContain("__ctsEnter(");
    expect((stampsOf(output)[0].generator as SourceFunction).uses[0]).toMatchObject({
      name: "noise",
      package: "simplex-noise",
    });
  });

  it("recognises three from a CDN, and doesn't try to read it", async () => {
    const read = vi.fn(async () => null);
    const index = new ProjectIndex({
      resolve: async (source) => source,
      read,
      relative: (file) => file.slice(ROOT.length + 1),
    });
    const code = `
      import * as THREE from "https://cdn.jsdelivr.net/npm/three@0.160.0/build/three.module.js";
      export function make() { return new THREE.Mesh(); }
    `;
    const program = parseSource(code, "/app/src/main.js")!;
    const plan = await index.plan("/app/src/main.js", code, program);

    expect(plan.wrap.size).toBe(1);
    expect(read).not.toHaveBeenCalled();
  });

  it("recognises three from a script tag", async () => {
    const out = await single(`
      export function make() { new THREE.Vector3(); return new THREE.Mesh(); }
    `);
    expect(out).toContain("__ctsEnter(");
    expect(out).not.toContain("__ctsNew(new THREE.Vector3");
  });

  it("doesn't follow an import of something that isn't code", async () => {
    const { transform } = project({
      "src/main.js": `
        import shader from "./water.glsl";
        import * as THREE from "three";
        export const material = () => new THREE.ShaderMaterial({ fragmentShader: shader() });
      `,
      "src/water.glsl": "void main() {}",
    });

    expect((await transform("src/main.js")).code).toContain("__ctsNew(");
  });

  it("carries on when an import can't be resolved", async () => {
    const index = new ProjectIndex({
      resolve: async () => {
        throw new Error("no such file");
      },
      read: async () => null,
      relative: (file) => file,
    });
    const code = `import { gone } from "./gone"; export const a = gone();`;

    await expect(index.plan("/app/a.js", code, parseSource(code, "/app/a.js")!)).resolves.toBeDefined();
  });
});

describe("a module with nothing to do", () => {
  it("is left exactly as it was", async () => {
    expect(await single(`export const add = (a, b) => a + b;`)).toBeNull();
    expect(await single(`import { add } from "lodash"; export const twice = (a) => add(a, a);`)).toBeNull();
  });
});

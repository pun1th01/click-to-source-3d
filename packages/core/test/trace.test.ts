import { beforeEach, describe, expect, it, vi } from "vitest";
import * as THREE from "three";
import type { SourceFunction, SourceStamp } from "@click-to-source-3d/shared";
import {
  allPropsOf,
  ctsCall,
  ctsEnter,
  ctsLeave,
  ctsLoadAsync,
  ctsNew,
  ctsOnLoad,
  ctsSite,
  ctsVia,
  describeValue,
  generatorsOf,
  partsOf,
  recordOf,
  stampOf,
} from "../src/trace.js";
import { resolveSourceRef } from "../src/resolver.js";

const stamp = (line: number, extra: Partial<SourceStamp> = {}): SourceStamp => ({
  file: "src/world.js",
  function: "createTerrain",
  line,
  column: 3,
  ...extra,
});

const fn = (name: string, params: SourceFunction["params"] = []): SourceFunction => ({
  id: `src/world.js#${name}`,
  name,
  file: "src/world.js",
  line: 10,
  column: 1,
  params,
  numbers: [],
  uses: [],
});

beforeEach(() => {
  delete (globalThis as { __CTS_TRACE__?: unknown }).__CTS_TRACE__;
});

describe("ctsNew", () => {
  it("records a mesh, a geometry and a material, and hands each back", () => {
    const mesh = new THREE.Mesh();
    const geometry = new THREE.BoxGeometry();
    const material = new THREE.MeshBasicMaterial();

    expect(ctsNew(mesh, stamp(1))).toBe(mesh);
    expect(ctsNew(geometry, stamp(2))).toBe(geometry);
    expect(ctsNew(material, stamp(3))).toBe(material);

    expect(recordOf(mesh)?.stamp.line).toBe(1);
    expect(recordOf(geometry)?.stamp.line).toBe(2);
    expect(recordOf(material)?.stamp.line).toBe(3);
  });

  it("leaves the object exactly as the application made it", () => {
    const mesh = ctsNew(new THREE.Mesh(), stamp(1));

    expect(mesh.userData).toEqual({});
    expect(JSON.stringify(mesh.toJSON())).not.toContain("src/world.js");
  });

  it("ignores anything that isn't a part of a scene", () => {
    const vector = new THREE.Vector3();
    const plain = { a: 1 };

    expect(ctsNew(vector, stamp(1))).toBe(vector);
    expect(ctsNew(plain, stamp(1))).toBe(plain);
    expect(ctsNew(undefined, stamp(1))).toBeUndefined();
    expect(ctsNew(7, stamp(1))).toBe(7);
    expect(recordOf(vector)).toBeUndefined();
    expect(recordOf(plain)).toBeUndefined();
  });

  // Everything is inside a scene, so a recorded one would be everything's source.
  it("leaves a Scene out, so a library's objects don't claim to come from it", () => {
    const scene = ctsNew(new THREE.Scene(), stamp(1));
    const fromLibrary = new THREE.Mesh();
    scene.add(fromLibrary);

    expect(recordOf(scene)).toBeUndefined();
    expect(resolveSourceRef(fromLibrary)).toBeNull();
  });

  it("is what the resolver finds, from the object or from inside it", () => {
    const group = ctsNew(new THREE.Group(), stamp(5, { function: "Tree" }));
    const child = new THREE.Mesh();
    group.add(child);

    expect(resolveSourceRef(group)?.sourceRef).toMatchObject({ file: "src/world.js", function: "Tree", line: 5 });
    expect(resolveSourceRef(child)?.object).toBe(group);
  });

  it("tells the inspector about a renderer three doesn't announce", () => {
    const hook = new EventTarget();
    const seen: unknown[] = [];
    hook.addEventListener("observe", (event) => seen.push((event as CustomEvent).detail));
    vi.stubGlobal("__THREE_DEVTOOLS__", hook);

    const webgpu = { isRenderer: true, isWebGPURenderer: true };
    const webgl = { isRenderer: true, isWebGLRenderer: true };
    ctsNew(webgpu, stamp(1));
    ctsNew(webgl, stamp(1));

    vi.unstubAllGlobals();
    expect(seen).toEqual([webgpu]);
  });
});

describe("the call stack", () => {
  it("gives an object the calls it was made under, outermost first", () => {
    ctsEnter(fn("buildWorld", [{ name: "seed", arg: 0 }]), [7]);
    ctsEnter(fn("createTerrain", [{ name: "size", arg: 0 }]), [40.5]);
    const mesh = ctsNew(new THREE.Mesh(), stamp(1));
    ctsLeave();
    ctsLeave();

    expect(recordOf(mesh)?.trace.map((frame) => frame.name)).toEqual(["buildWorld", "createTerrain"]);
    expect(recordOf(mesh)?.trace[1].args).toEqual([{ name: "size", value: "40.5" }]);
  });

  it("is empty again for what is made afterwards", () => {
    ctsEnter(fn("buildWorld"), []);
    ctsLeave();

    expect(recordOf(ctsNew(new THREE.Mesh(), stamp(1)))?.trace).toEqual([]);
  });

  it("describes a value as it was when the call was made", () => {
    const position = new THREE.Vector3(1, 2, 3);
    ctsEnter(fn("place", [{ name: "at", arg: 0 }]), [position]);
    const mesh = ctsNew(new THREE.Mesh(), stamp(1));
    ctsLeave();

    position.set(9, 9, 9);

    expect(recordOf(mesh)?.trace[0].args[0].value).toBe("(1, 2, 3)");
  });

  it("keeps only the nearest calls of a very deep chain", () => {
    for (let depth = 0; depth < 20; depth++) {
      ctsEnter(fn(`level${depth}`), []);
    }
    const mesh = ctsNew(new THREE.Mesh(), stamp(1));
    for (let depth = 0; depth < 20; depth++) {
      ctsLeave();
    }

    const trace = recordOf(mesh)?.trace ?? [];
    expect(trace).toHaveLength(12);
    expect(trace[trace.length - 1].name).toBe("level19");
  });

  it("comes back down when a function with no block body throws", () => {
    expect(() =>
      ctsCall(fn("broken"), [], () => {
        throw new Error("nope");
      })
    ).toThrow("nope");

    expect(recordOf(ctsNew(new THREE.Mesh(), stamp(1)))?.trace).toEqual([]);
  });

  it("returns what a function with no block body returns", () => {
    expect(ctsCall(fn("value"), [], () => 42)).toBe(42);
  });
});

describe("call sites", () => {
  const literal = { raw: "40", value: 40, editable: true, line: 9, column: 20 };

  it("hands the call's result straight through", () => {
    expect(ctsVia(ctsSite({ target: "x", file: "a", line: 1, args: [] }), 5)).toBe(5);
  });

  it("makes an argument written as a literal editable where it was written", () => {
    const target = fn("createTerrain", [
      { name: "size", arg: 0 },
      { name: "seed", arg: 1 },
    ]);
    ctsSite({ target: target.id, file: "src/main.js", line: 9, column: 3, args: [literal, null] });
    ctsEnter(target, [40, 7]);
    const mesh = ctsNew(new THREE.Mesh(), stamp(1));
    ctsLeave();

    const frame = recordOf(mesh)!.trace[0];
    expect(frame.calledAt).toEqual({ file: "src/main.js", line: 9, column: 3 });
    expect(frame.args[0]).toEqual({ name: "size", value: "40", literal });
    expect(frame.args[1]).toEqual({ name: "seed", value: "7" });
  });

  it("follows a destructured parameter to its key in an options object", () => {
    const target = fn("createRock", [{ name: "size", arg: 0, key: "size" }]);
    ctsSite({ target: target.id, file: "src/main.js", line: 9, args: [{ keys: { size: literal } }] });
    ctsEnter(target, [40]);
    const mesh = ctsNew(new THREE.Mesh(), stamp(1));
    ctsLeave();

    expect(recordOf(mesh)!.trace[0].args[0].literal).toEqual(literal);
  });

  it("doesn't credit a call site to a different function", () => {
    ctsSite({ target: "src/world.js#other", file: "src/main.js", line: 9, args: [literal] });
    ctsEnter(fn("createTerrain", [{ name: "size", arg: 0 }]), [40]);
    const mesh = ctsNew(new THREE.Mesh(), stamp(1));
    ctsLeave();

    expect(recordOf(mesh)!.trace[0].calledAt).toBeUndefined();
    expect(recordOf(mesh)!.trace[0].args[0].literal).toBeUndefined();
  });

  // A site can go unclaimed: a callee swapped by a hot update, an argument that threw.
  it("doesn't let unclaimed call sites pile up", () => {
    for (let index = 0; index < 1000; index++) {
      ctsSite({ target: "never", file: "a", line: index, args: [] });
    }
    const store = (globalThis as unknown as { __CTS_TRACE__: { sites: unknown[] } }).__CTS_TRACE__;
    expect(store.sites.length).toBeLessThanOrEqual(32);
  });

  it("drops what was left unclaimed above the call it matches", () => {
    const target = fn("outer");
    ctsSite({ target: target.id, file: "a", line: 1, args: [] });
    ctsSite({ target: "abandoned", file: "a", line: 2, args: [] });
    ctsEnter(target, []);
    ctsLeave();

    const store = (globalThis as unknown as { __CTS_TRACE__: { sites: unknown[] } }).__CTS_TRACE__;
    expect(store.sites).toEqual([]);
  });
});

describe("never getting in the application's way", () => {
  const hostile = () =>
    new Proxy({}, {
      get() {
        throw new Error("trap");
      },
      ownKeys() {
        throw new Error("trap");
      },
      getOwnPropertyDescriptor() {
        throw new Error("trap");
      },
    });

  it("describes a value whose every trap throws", () => {
    expect(describeValue(hostile())).toBe("<value>");
  });

  it("hands back an object whose every trap throws", () => {
    const value = hostile();
    expect(ctsNew(value, stamp(1))).toBe(value);
  });

  it("lets a call through with an argument whose every trap throws", () => {
    expect(() => ctsEnter(fn("f", [{ name: "a", arg: 0 }]), [hostile()])).not.toThrow();
    ctsLeave();
  });

  // A getter can do anything, including change the application's state.
  it("doesn't run an options object's getters", () => {
    let ran = false;
    const options = {
      size: 2,
      get expensive() {
        ran = true;
        return 1;
      },
    };

    expect(describeValue(options)).toBe("{ size: 2, … }");
    expect(ran).toBe(false);
  });

  it("gives a loader's callback its result, whatever the result is like", () => {
    const callback = vi.fn();
    const result = {
      get scene(): never {
        throw new Error("trap");
      },
    };

    ctsOnLoad(callback, stamp(1))(result);

    // By identity: comparing by value would run the getter too.
    expect(callback.mock.calls[0][0]).toBe(result);
  });

  it("resolves a loader's promise, whatever the result is like", async () => {
    const result = {
      get scene(): never {
        throw new Error("trap");
      },
    };

    await expect(ctsLoadAsync(Promise.resolve(result), stamp(1))).resolves.toBe(result);
  });
});

describe("a call that never arrives", () => {
  const literal = { raw: "40", value: 40, editable: true, line: 9, column: 20 };
  const target = () => fn("createTerrain", [{ name: "size", arg: 0 }]);
  const pending = () => (globalThis as unknown as { __CTS_TRACE__: { sites: unknown[] } }).__CTS_TRACE__.sites;

  it("forgets its note once the call is over", () => {
    ctsVia(ctsSite({ target: target().id, file: "src/main.js", line: 9, args: [literal] }), 5);

    expect(pending()).toEqual([]);
  });

  // The note of a call whose argument threw stays behind, and a later call to the same
  // function through a callback would otherwise take its literal.
  it("doesn't give its note to a later call from somewhere else", () => {
    ctsSite({ target: target().id, file: "src/main.js", line: 9, args: [literal] });
    ctsEnter(fn("other"), []);
    ctsEnter(target(), [12]);
    const mesh = ctsNew(new THREE.Mesh(), stamp(1));
    ctsLeave();
    ctsLeave();

    const frame = runtime(mesh).trace[1];
    expect(frame.calledAt).toBeUndefined();
    expect(frame.args[0].literal).toBeUndefined();
  });

  it("still gives its note to the call it was made for, inside another call's arguments", () => {
    const outer = fn("outer", [{ name: "child", arg: 0 }]);
    const outerSite = ctsSite({ target: outer.id, file: "src/main.js", line: 3, args: [null] });
    const innerSite = ctsSite({ target: target().id, file: "src/main.js", line: 3, args: [literal] });
    ctsEnter(target(), [40]);
    const mesh = ctsNew(new THREE.Mesh(), stamp(1));
    ctsLeave();
    ctsVia(innerSite, mesh);
    ctsEnter(outer, [mesh]);
    const group = ctsNew(new THREE.Group(), stamp(2));
    ctsLeave();
    ctsVia(outerSite, group);

    expect(runtime(mesh).trace[0].args[0].literal).toEqual(literal);
    expect(runtime(group).trace[0].calledAt).toEqual({ file: "src/main.js", line: 3 });
    expect(pending()).toEqual([]);
  });

  const runtime = (object: object) => recordOf(object)!;
});

describe("describeValue", () => {
  it.each([
    [7, "7"],
    [1.23456789, "1.2346"],
    ["hi", '"hi"'],
    [true, "true"],
    [undefined, "undefined"],
    [null, "null"],
    [[1, 2, 3], "Array(3)"],
    [new Float32Array(4), "Float32Array(4)"],
    [new THREE.Vector2(1, 2), "(1, 2)"],
    [new THREE.Color("#ff0000"), "#ff0000"],
    [new THREE.Mesh(), "<Mesh>"],
    [new THREE.Scene(), "<Scene>"],
    [new THREE.BoxGeometry(), "<BoxGeometry>"],
    [new THREE.MeshBasicMaterial(), "<MeshBasicMaterial>"],
    [new Map(), "<Map>"],
    [{ a: 1, b: "x" }, '{ a: 1, b: "x" }'],
  ])("%s", (value, text) => {
    expect(describeValue(value)).toBe(text);
  });

  it("names a function", () => {
    expect(describeValue(function noise() {})).toBe("<function noise>");
    expect(describeValue(() => 1)).toBe("<function>");
  });

  it("keeps long text short", () => {
    expect(describeValue("x".repeat(200)).length).toBeLessThanOrEqual(40);
  });

  it("doesn't read an options object's nested values", () => {
    expect(describeValue({ nested: { deep: 1 }, size: 2 })).toBe("{ size: 2, … }");
  });
});

describe("loaded models", () => {
  const model = () => {
    const scene = new THREE.Group();
    scene.add(new THREE.Mesh());
    return { scene, scenes: [scene], animations: [] };
  };

  it("credits what a loader returned to the call that asked for it", () => {
    const gltf = model();
    const callback = vi.fn();
    ctsEnter(fn("loadBeacon"), []);
    const wrapped = ctsOnLoad(callback, stamp(4, { how: "load", creates: "GLTFLoader" }));
    ctsLeave();

    wrapped.call("receiver", gltf, "extra");

    expect(callback).toHaveBeenCalledWith(gltf, "extra");
    expect(callback.mock.contexts[0]).toBe("receiver");
    expect(recordOf(gltf.scene)?.stamp.how).toBe("load");
    // The call had returned long before the model arrived.
    expect(recordOf(gltf.scene)?.trace.map((frame) => frame.name)).toEqual(["loadBeacon"]);
    expect(resolveSourceRef(gltf.scene.children[0])?.object).toBe(gltf.scene);
  });

  it("records a loader that returns the object itself", () => {
    const mesh = new THREE.Mesh();
    ctsOnLoad(() => undefined, stamp(4))(mesh);
    expect(recordOf(mesh)?.stamp.line).toBe(4);
  });

  it("leaves a missing callback alone", () => {
    expect(ctsOnLoad(undefined, stamp(4))).toBeUndefined();
  });

  it("does the same for a promise", async () => {
    const gltf = model();
    ctsEnter(fn("loadBeacon"), []);
    const pending = ctsLoadAsync(Promise.resolve(gltf), stamp(4));
    ctsLeave();

    expect(await pending).toBe(gltf);
    expect(recordOf(gltf.scene)?.trace.map((frame) => frame.name)).toEqual(["loadBeacon"]);
  });

  it("passes a failure along", async () => {
    await expect(ctsLoadAsync(Promise.reject(new Error("404")), stamp(4))).rejects.toThrow("404");
  });

  it("ignores something that isn't a promise", () => {
    expect(ctsLoadAsync(5, stamp(4))).toBe(5);
  });
});

describe("what is behind an object", () => {
  const generator = fn("createTerrain");

  it("finds its own stamp, its geometry's and its material's", () => {
    const geometry = ctsNew(new THREE.BoxGeometry(), stamp(1, {
      props: [{ element: "BoxGeometry", name: "args", array: true, values: [] }],
    }));
    const material = ctsNew(new THREE.MeshBasicMaterial(), stamp(2, { file: "src/looks.js" }));
    const mesh = ctsNew(new THREE.Mesh(geometry, material), stamp(3));

    expect(partsOf(mesh).map((part) => [part.part, part.stamp.line])).toEqual([
      ["object", 3],
      ["geometry", 1],
      ["material", 2],
    ]);
    expect(allPropsOf(mesh)).toEqual([
      { element: "BoxGeometry", name: "args", array: true, values: [], file: "src/world.js" },
    ]);
  });

  it("counts a material shared by several slots once", () => {
    const material = ctsNew(new THREE.MeshBasicMaterial(), stamp(2));
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(), [material, material]);

    expect(partsOf(mesh).filter((part) => part.part === "material")).toHaveLength(1);
  });

  // <primitive object={rock} />: placed by JSX, made by plain code in another file.
  it("finds where plain code made an object that JSX placed", () => {
    const mesh = ctsNew(new THREE.Mesh(), stamp(3, { file: "src/helpers.ts", function: "makeRock" }));
    mesh.userData.__ctsSource = stamp(9, { file: "src/App.tsx", function: "Scene" });

    expect(partsOf(mesh).map((part) => [part.part, part.stamp.file])).toEqual([
      ["object", "src/App.tsx"],
      ["made", "src/helpers.ts"],
    ]);
  });

  it("prefers a stamp written on the object, as JSX does", () => {
    const mesh = ctsNew(new THREE.Mesh(), stamp(3));
    mesh.userData.__ctsSource = stamp(9);

    expect(stampOf(mesh)?.line).toBe(9);
  });

  it("lists each function once, its own first", () => {
    const other = fn("makeGeometry");
    const geometry = ctsNew(new THREE.BoxGeometry(), stamp(1, { generator: other }));
    const material = ctsNew(new THREE.MeshBasicMaterial(), stamp(2, { generator }));
    const mesh = ctsNew(new THREE.Mesh(geometry, material), stamp(3, { generator }));

    expect(generatorsOf(mesh).map((entry) => entry.name)).toEqual(["createTerrain", "makeGeometry"]);
  });
});

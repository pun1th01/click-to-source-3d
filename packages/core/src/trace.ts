import type * as THREE from "three";
import type {
  ObjectRecord,
  SourceFunction,
  SourceStamp,
  StampedProp,
  StampedValue,
  TraceFrame,
} from "@click-to-source-3d/shared";

/**
 * What plain three.js code tells the inspector as it runs.
 *
 * In JSX a stamp can go on the object, because the plugin writes the props. A
 * `new THREE.Mesh()` has nowhere like that to put one, and `userData` is the
 * application's: it ends up in `toJSON()` and in GLTFExporter's output. So
 * records live here, in a WeakMap, which leaves the objects exactly as the
 * application made them and lets them be collected as usual.
 *
 * The plugin's transform calls these functions from the application's modules.
 * It only ever adds them in development.
 */

/** A call about to be made, as the build step read it at the call site. */
export type CallSite = {
  /** The `id` of the function being called. */
  target: string;
  file: string;
  line: number;
  column?: number;
  args: Array<StampedValue | { keys: Record<string, StampedValue> } | null>;
};

/** A call noted as it is made, until the function it calls arrives to take it. */
type PendingSite = { site: CallSite; depth: number };

type Store = {
  objects: WeakMap<object, ObjectRecord>;
  stack: TraceFrame[];
  sites: PendingSite[];
};

const KEY = "__CTS_TRACE__";

/**
 * Kept on globalThis because this runs from the inspector's module and core is
 * also bundled elsewhere: two copies have to agree on one table.
 */
function store(): Store {
  const global = globalThis as unknown as Record<string, Store | undefined>;
  return (global[KEY] ??= { objects: new WeakMap(), stack: [], sites: [] });
}

/** The most frames kept with an object. Past that, the nearest ones matter. */
const MAX_FRAMES = 12;
/** Calls waiting to be matched. A callee that was swapped out never collects its own. */
const MAX_PENDING_SITES = 32;
const MAX_VALUE_TEXT = 40;

function shorten(text: string): string {
  return text.length > MAX_VALUE_TEXT ? `${text.slice(0, MAX_VALUE_TEXT - 1)}…` : text;
}

/**
 * A value as a short piece of text, worked out when the call is made.
 *
 * Text rather than the value itself, for two reasons: a record would otherwise
 * keep whatever was passed alive for as long as the object it describes, and a
 * value can change afterwards, while this says what the call was given.
 */
export function describeValue(value: unknown): string {
  // It runs inside the application's own calls, so nothing about a value, a proxy
  // whose traps throw for one, may make the call fail.
  try {
    return describe(value);
  } catch {
    return "<value>";
  }
}

/** Reads a property without running a getter, which could do anything. */
function plainProperty(object: object, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(object, key);
  return descriptor && "value" in descriptor ? descriptor.value : undefined;
}

function describe(value: unknown): string {
  switch (typeof value) {
    case "number":
      return Number.isInteger(value) ? String(value) : String(Number(value.toFixed(4)));
    case "string":
      return shorten(JSON.stringify(value));
    case "boolean":
    case "undefined":
    case "bigint":
      return String(value);
    case "function":
      return (value as { name?: string }).name ? `<function ${(value as { name: string }).name}>` : "<function>";
    case "symbol":
      return "<symbol>";
  }
  if (value === null) {
    return "null";
  }

  const object = value as Record<string, unknown>;
  if (object.isVector3 || object.isVector2 || object.isVector4) {
    const parts = [object.x, object.y, object.z, object.w].filter((part) => part !== undefined);
    return `(${parts.map(describe).join(", ")})`;
  }
  if (object.isColor) {
    return `#${(object as unknown as THREE.Color).getHexString()}`;
  }
  if (object.isObject3D || object.isMaterial || object.isBufferGeometry || object.isTexture) {
    return `<${(object.type as string) || "Object"}>`;
  }
  if (Array.isArray(value)) {
    return `Array(${value.length})`;
  }
  if (ArrayBuffer.isView(value)) {
    return `${value.constructor.name}(${(value as unknown as ArrayLike<number>).length})`;
  }

  const name = (object.constructor as { name?: string } | undefined)?.name;
  if (name && name !== "Object") {
    return `<${name}>`;
  }

  // A plain options object is often the interesting part of a call. Its values are
  // read as data: a getter is left alone.
  const keys = Object.keys(object);
  const shown = keys
    .slice(0, 3)
    .map((key) => [key, plainProperty(object, key)] as const)
    .filter(([, entry]) => entry !== undefined && typeof entry !== "object" && typeof entry !== "function")
    .map(([key, entry]) => `${key}: ${describe(entry)}`);
  return shorten(`{ ${shown.join(", ")}${keys.length > shown.length ? ", …" : ""} }`);
}

/**
 * Finds the call that led to this function, and forgets any left stale above it.
 *
 * A note is only taken by a function arriving at the depth it was made at, which is
 * the depth a call made there arrives at. A call that threw before it arrived leaves
 * its note behind, and a later call to the same function from deeper or shallower,
 * through a callback say, must not take the literals of a call it isn't.
 */
function takeSite(fn: SourceFunction, depth: number): CallSite | undefined {
  const sites = store().sites;
  for (let index = sites.length - 1; index >= 0; index--) {
    const pending = sites[index];
    if (pending.site.target === fn.id && pending.depth === depth) {
      sites.length = index;
      return pending.site;
    }
  }
  return undefined;
}

function literalFor(
  site: CallSite | undefined,
  param: SourceFunction["params"][number]
): StampedValue | undefined {
  const argument = site?.args[param.arg];
  // The rest of the call's arguments, of which the one at this position is only the first.
  if (!argument || param.rest) {
    return undefined;
  }
  if ("keys" in argument) {
    return param.key !== undefined ? argument.keys[param.key] : undefined;
  }
  return param.key === undefined && argument.editable ? argument : undefined;
}

/** Called just before a call the build step knows is to a tracked function. */
export function ctsSite(site: CallSite): PendingSite {
  const { sites, stack } = store();
  const pending = { site, depth: stack.length };
  sites.push(pending);
  if (sites.length > MAX_PENDING_SITES) {
    sites.shift();
  }
  return pending;
}

/**
 * Hands back a call's result. Only here so that the note about a call can be
 * written in front of it, as one expression: `__ctsVia(__ctsSite(site), f(1))`.
 * Arguments are evaluated in order, so the note is made before the call is.
 */
export function ctsVia<T>(pending: PendingSite | void, value: T): T {
  // Still waiting means nothing took it: the function at the other end wasn't the one
  // the build step expected. Left there, a later call might.
  const sites = store().sites;
  const index = pending ? sites.lastIndexOf(pending) : -1;
  if (index >= 0) {
    sites.splice(index, 1);
  }
  return value;
}

export function ctsEnter(fn: SourceFunction, values: unknown[]): void {
  const site = takeSite(fn, store().stack.length);

  store().stack.push({
    name: fn.name,
    file: fn.file,
    line: fn.line,
    column: fn.column,
    args: fn.params.map((param, index) => {
      const literal = literalFor(site, param);
      return {
        name: param.name,
        value: describeValue(values[index]),
        ...(literal ? { literal } : {}),
      };
    }),
    ...(site ? { calledAt: { file: site.file, line: site.line, column: site.column } } : {}),
  });
}

export function ctsLeave(): void {
  store().stack.pop();
}

/** An arrow function with no block body, which has nowhere to put a `finally`. */
export function ctsCall<T>(fn: SourceFunction, values: unknown[], body: () => T): T {
  ctsEnter(fn, values);
  try {
    return body();
  } finally {
    ctsLeave();
  }
}

function currentTrace(): TraceFrame[] {
  return store().stack.slice(-MAX_FRAMES);
}

type Trackable = {
  isObject3D?: boolean;
  isScene?: boolean;
  isBufferGeometry?: boolean;
  isMaterial?: boolean;
  isRenderer?: boolean;
  isWebGPURenderer?: boolean;
  isWebGLRenderer?: boolean;
};

/**
 * Records where an object was made, and hands it back.
 *
 * Every `new Something()` in project code comes through here, whatever class it
 * is, since a subclass or an alias can't be told apart at build time. So this
 * is what decides, and it has to stay cheap for the ones it ignores.
 *
 * A Scene is left out on purpose: the resolver walks up from an object to the
 * nearest thing with a source, and every object is inside a scene. Anything made
 * inside a library would otherwise claim to come from `new THREE.Scene()`.
 */
export function ctsNew<T>(object: T, stamp: SourceStamp): T {
  const candidate = object as Trackable | null | undefined;

  // Whatever an object turns out to be, the application gets it back unharmed.
  try {
    if (candidate && typeof candidate === "object") {
      if (candidate.isObject3D || candidate.isBufferGeometry || candidate.isMaterial) {
        if (!candidate.isScene) {
          store().objects.set(candidate, { stamp, trace: currentTrace() });
        }
      } else if ((candidate.isRenderer || candidate.isWebGPURenderer) && !candidate.isWebGLRenderer) {
        // A renderer the devtools hook may not have heard about yet.
        announceRenderer(candidate);
      }
    }
  } catch {
    // Not something to record.
  }
  return object;
}

function announceRenderer(renderer: object): void {
  const hook = (globalThis as { __THREE_DEVTOOLS__?: EventTarget }).__THREE_DEVTOOLS__;
  hook?.dispatchEvent(new CustomEvent("observe", { detail: renderer }));
}

/** Credits what a loader returned to the call that asked for it. */
function tagLoaded(result: unknown, stamp: SourceStamp, trace: TraceFrame[]): void {
  const loaded = result as (Trackable & { scene?: Trackable; scenes?: Trackable[] }) | null | undefined;
  if (!loaded || typeof loaded !== "object") {
    return;
  }

  // On the way to the application's own callback, which has to get its result whatever this finds.
  try {
    const objects = store().objects;
    const roots = [loaded.scene, ...(Array.isArray(loaded.scenes) ? loaded.scenes : []), loaded];
    for (const root of roots) {
      // A glTF's root is a Scene, which here is one of the application's objects.
      if (root && (root.isObject3D || root.isBufferGeometry || root.isMaterial)) {
        objects.set(root, { stamp, trace });
      }
    }
  } catch {
    // Nothing recorded, and nothing lost.
  }
}

/** Wraps the callback given to `loader.load(url, onLoad)`. */
export function ctsOnLoad<T>(callback: T, stamp: SourceStamp): T {
  if (typeof callback !== "function") {
    return callback;
  }
  // Now, not when it arrives: by then the calls that asked for it have returned.
  const trace = currentTrace();
  return function (this: unknown, result: unknown, ...rest: unknown[]) {
    tagLoaded(result, stamp, trace);
    return (callback as (...args: unknown[]) => unknown).call(this, result, ...rest);
  } as T;
}

/** Wraps the promise from `loader.loadAsync(url)`. */
export function ctsLoadAsync<T>(promise: T, stamp: SourceStamp): T {
  const pending = promise as { then?: unknown } | null | undefined;
  if (!pending || typeof pending.then !== "function") {
    return promise;
  }
  const trace = currentTrace();
  return (promise as unknown as Promise<unknown>).then((result) => {
    tagLoaded(result, stamp, trace);
    return result;
  }) as T;
}

/** What is recorded about an object made by plain three.js code, if anything. */
export function recordOf(object: object | null | undefined): ObjectRecord | undefined {
  return object ? store().objects.get(object) : undefined;
}

/** Where an object came from, however that was recorded. */
export function stampOf(object: THREE.Object3D | null | undefined): SourceStamp | undefined {
  return (object?.userData?.__ctsSource as SourceStamp | undefined) ?? recordOf(object)?.stamp;
}

/** One stamp that says something about an object: its own, its geometry's, its material's. */
export type ObjectPart = {
  /** `made` is where plain code made an object JSX placed. */
  part: "object" | "made" | "geometry" | "material";
  stamp: SourceStamp;
};

/**
 * Every stamp behind an object.
 *
 * In JSX the geometry and material are written inside the mesh, so its one stamp
 * lists their props. In plain code they are usually made on their own lines, or
 * in another file altogether, and only the running object says which belongs
 * with which.
 */
export function partsOf(object: THREE.Object3D): ObjectPart[] {
  const parts: ObjectPart[] = [];
  const own = stampOf(object);
  if (own) {
    parts.push({ part: "object", stamp: own });
  }
  // Placed by JSX, `<primitive object={rock} />`, and made by plain code elsewhere:
  // what that code set on it is as much a part of it as what the JSX did.
  const made = recordOf(object)?.stamp;
  if (made && made !== own) {
    parts.push({ part: "made", stamp: made });
  }

  const mesh = object as THREE.Mesh;
  const geometry = recordOf(mesh.geometry);
  if (geometry) {
    parts.push({ part: "geometry", stamp: geometry.stamp });
  }

  const materials = Array.isArray(mesh.material) ? mesh.material : mesh.material ? [mesh.material] : [];
  const seen = new Set<SourceStamp>();
  for (const material of materials) {
    const record = recordOf(material);
    if (record && !seen.has(record.stamp)) {
      seen.add(record.stamp);
      parts.push({ part: "material", stamp: record.stamp });
    }
  }
  return parts;
}

/** The functions behind an object: its own, then its geometry's and material's. */
export function generatorsOf(object: THREE.Object3D): SourceFunction[] {
  const seen = new Set<string>();
  const functions: SourceFunction[] = [];
  for (const { stamp } of partsOf(object)) {
    if (stamp.generator && !seen.has(stamp.generator.id)) {
      seen.add(stamp.generator.id);
      functions.push(stamp.generator);
    }
  }
  return functions;
}

/** Every prop behind an object, each saying which file it is in. */
export function allPropsOf(object: THREE.Object3D): StampedProp[] {
  return partsOf(object).flatMap(({ stamp }) =>
    (stamp.props ?? []).map((prop) => ({ ...prop, file: stamp.file }))
  );
}

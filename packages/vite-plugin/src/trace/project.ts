import type { SourceNumbers, StampedValue, UsedFunction } from "@click-to-source-3d/shared";
import { analyzeModule, parseSource, type ClassFact, type FunctionFact, type ModuleFacts, type NumberFact, type Node, type Ref, type ScopeFact } from "./facts.js";

/** How an import resolved: to another project file, to a package, or to something else. */
type Resolved =
  | { kind: "project"; file: string }
  | { kind: "package"; name: string }
  | { kind: "asset" };

export type ProjectHost = {
  /** Vite's own resolution, so aliases and extensions behave as they do in the app. */
  resolve(source: string, importer: string): Promise<string | null>;
  read(file: string): Promise<string | null>;
  /** The path a stamp uses for a file: relative to the project root. */
  relative(file: string): string;
};

/** What a reference turned out to name. */
type Target =
  | { kind: "function"; module: ModuleFacts; fn: FunctionFact }
  | { kind: "class"; module: ModuleFacts; cls: ClassFact }
  | { kind: "object"; module: ModuleFacts }
  | { kind: "three"; name: string }
  | { kind: "package"; name: string; package: string };

/** What the instrumenting pass needs to know about one module. */
export type TracePlan = {
  facts: ModuleFacts;
  /** Functions to record calls of, by id. */
  wrap: Set<string>;
  /** Calls to wrapped functions: `start:end` of the call to the function's id. */
  callTargets: Map<string, string>;
  /** `new`s that could make something the inspector cares about, by `start:end`. */
  recordable: Set<string>;
  usesOf(facts: FunctionFact[]): UsedFunction[];
  numbersOf(facts: FunctionFact[]): SourceNumbers[];
  /**
   * What belongs with a top-level statement. Top-level code has no function to
   * gather it: `const geometry = new PlaneGeometry()` can be followed by a loop
   * that moves its vertices with a noise function, and those are separate
   * statements. So: this one, the statements that mention what it declares, and
   * the ones that mention what those declare.
   */
  relatedTo(fact: FunctionFact, holder: string | null): FunctionFact[];
};

/**
 * Classes three.js makes in numbers, or that aren't things in a scene. Math types
 * get allocated in tight loops, so a call around each would be a real cost; the
 * rest would only be ignored at runtime. Names are the exported ones, so an
 * alias such as `import { Vector3 as V3 }` is seen through.
 */
export const IGNORED_THREE_CLASSES =
  /^(Vector[234]|Matrix[234]|Quaternion|Euler|Color|Box[23]|Sphere|Plane|Ray|Triangle|Line3|Frustum|Spherical|Cylindrical|SphericalHarmonics3|Layers|Raycaster|Clock|Timer|Uniform|.*BufferAttribute|InterleavedBuffer.*|.*Loader|.*Controls|.*Pass|.*Composer|.*Exporter|LoadingManager|AnimationMixer|AnimationClip|.*KeyframeTrack|WebGLRenderTarget|WebGLRenderer)$/;

/** Things of the language and the browser, never worth a call. */
export const IGNORED_GLOBALS =
  /^(Object|Array|Map|Set|WeakMap|WeakSet|WeakRef|Date|Promise|RegExp|Proxy|Function|Symbol|Number|String|Boolean|BigInt|ArrayBuffer|SharedArrayBuffer|DataView|.*Array|.*Error|URL|URLSearchParams|Worker|SharedWorker|Blob|File|FileReader|FormData|Image|Audio|AudioContext|Request|Response|Headers|TextEncoder|TextDecoder|WebSocket|EventSource|EventTarget|Event|CustomEvent|AbortController|MutationObserver|ResizeObserver|IntersectionObserver|OffscreenCanvas|ImageData|DOMParser|XMLHttpRequest|Intl|Notification|BroadcastChannel|MessageChannel|Path2D)$/;

/** A package whose name says it is about three.js. */
const isThreePackage = (name: string) => /(^|[/@-])three([/@.-]|$)/.test(name);

/** Packages whose functions are plumbing rather than something that made this object. */
const isPlumbingPackage = (name: string) =>
  isThreePackage(name) || /^(react|react-dom|vue|svelte|preact)(\/|$)/.test(name);

/** What people go looking for, wherever it comes from, even among three's own addons. */
const NOISE = /noise|perlin|simplex|fbm/i;

const MAX_USES = 12;
const MAX_USES_DEPTH = 4;
const MAX_HELPER_NUMBERS = 16;
const MAX_NUMBERS = 48;
const MAX_LINE_TEXT = 80;
const MAX_MODULES = 5000;

/** Past this a module is a bundled library rather than something someone is working on. */
export const MAX_MODULE_SIZE = 1_000_000;
const THREE_BUILD_SIZE = 100_000;
const THREE_BUILD_NAME = /(^|\/)three(\.[\w-]+)*\.[cm]?js$/;

/**
 * A copy of three.js itself, kept in the project rather than installed. Size as
 * well as name, because `src/three.js` is a sensible name for your own setup.
 */
export const isThreeBuild = (file: string, code: string): boolean =>
  code.length > THREE_BUILD_SIZE && THREE_BUILD_NAME.test(file);

const JS_FILE = /\.[cm]?[jt]sx?$/;

function stripQuery(id: string): string {
  return id.split("?")[0];
}

function packageFromSource(source: string): string {
  const parts = source.split("/");
  return source.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0];
}

/** The package a resolved file belongs to. Vite's optimised copies say nothing, so ask the import. */
function packageNameOf(id: string, source: string): string {
  const match = /node_modules\/((?:@[^/]+\/)?[^/]+)/.exec(id.split("\\").join("/"));
  return match && !match[1].startsWith(".") ? match[1] : packageFromSource(source);
}

/** The numbers of some functions, grouped by the line they are on. */
function groupNumbers(numbers: NumberFact[], lines: string[], limit: number): SourceNumbers[] {
  const byLine = new Map<number, StampedValue[]>();
  for (const number of numbers.slice(0, limit)) {
    const values = byLine.get(number.line) ?? [];
    values.push(number);
    byLine.set(number.line, values);
  }
  return [...byLine].map(([line, values]) => {
    const text = (lines[line - 1] ?? "").trim();
    return {
      line,
      text: text.length > MAX_LINE_TEXT ? `${text.slice(0, MAX_LINE_TEXT - 1)}…` : text,
      values,
    };
  });
}

/**
 * What is known across the whole project: which functions end up making three.js
 * objects, however many files and calls away.
 *
 * Deciding that one file at a time isn't enough. `init()` in main.js is part of
 * the story if it calls `buildWorld()` in world.js, which calls `createTerrain()`.
 * So when a module is served, everything it imports is read too, once, and kept
 * until that file changes.
 */
export class ProjectIndex {
  private readonly modules = new Map<string, ModuleFacts>();
  private readonly loading = new Map<string, Promise<ModuleFacts | null>>();
  private readonly resolved = new Map<string, Map<string, Resolved>>();
  /** Modules whose imports have all been read, so a later look can stop there. */
  private readonly complete = new Set<string>();
  /** Goes up whenever a file changes from outside, which can happen during any wait. */
  private revision = 0;
  private byId: Map<string, { module: ModuleFacts; fn: FunctionFact }> | null = null;
  private makers: Set<string> | null = null;
  /** For each module, the absolute path it was read from. */
  private readonly absolute = new WeakMap<ModuleFacts, string>();

  constructor(private readonly host: ProjectHost) {}

  /** Forgets a file that changed. */
  invalidate(file: string): void {
    const clean = stripQuery(file);
    if (this.modules.delete(clean)) {
      this.resolved.delete(clean);
      this.revision++;
      this.forgetConclusions();
    }
  }

  /** Forgets every import that was resolved, for when a file appears or goes. */
  forgetResolutions(): void {
    this.resolved.clear();
    this.revision++;
    this.forgetConclusions();
  }

  private forgetConclusions(): void {
    this.byId = null;
    this.makers = null;
    this.complete.clear();
  }

  private store(file: string, facts: ModuleFacts): void {
    this.modules.set(file, facts);
    this.absolute.set(facts, file);
    this.resolved.delete(file);
    this.forgetConclusions();
  }

  private load(file: string): Promise<ModuleFacts | null> {
    const known = this.modules.get(file);
    if (known) {
      return Promise.resolve(known);
    }
    let pending = this.loading.get(file);
    if (!pending) {
      pending = this.readModule(file).finally(() => this.loading.delete(file));
      this.loading.set(file, pending);
    }
    return pending;
  }

  private async readModule(file: string): Promise<ModuleFacts | null> {
    if (this.modules.size >= MAX_MODULES) {
      return null;
    }
    const code = await this.host.read(file);
    if (code === null || code.length > MAX_MODULE_SIZE) {
      return null;
    }
    const program = parseSource(code, file);
    if (!program) {
      return null;
    }
    const facts = analyzeModule(program, code, this.host.relative(file));
    this.store(file, facts);
    return facts;
  }

  private async classify(source: string, importer: string): Promise<Resolved> {
    const id = await this.host.resolve(source, stripQuery(importer)).catch(() => null);
    const clean = id ? stripQuery(id) : null;

    // A path that leads nowhere is nothing anyone can say anything about.
    if (!clean && /^[./]/.test(source)) {
      return { kind: "asset" };
    }
    if (!clean || clean.startsWith("\0") || /^(https?:)?\/\//.test(clean)) {
      return { kind: "package", name: clean && !clean.startsWith("\0") ? clean : packageFromSource(source) };
    }
    if (clean.includes("/node_modules/")) {
      return { kind: "package", name: packageNameOf(clean, source) };
    }
    if (!JS_FILE.test(clean)) {
      return { kind: "asset" };
    }
    if (THREE_BUILD_NAME.test(clean)) {
      const code = await this.host.read(clean);
      if (code && isThreeBuild(clean, code)) {
        return { kind: "package", name: "three" };
      }
    }
    return { kind: "project", file: clean };
  }

  /**
   * Reads everything a module can reach, and doesn't finish until that is still true.
   *
   * Reading takes a while, and a file can change during it. Saving one does: the
   * write itself makes a temporary file appear and go. What was worked out before
   * that may be gone by the end, so the work is done again until none of it was
   * disturbed, rather than answering from half of what it knew.
   */
  private async followUntilSettled(file: string): Promise<void> {
    for (let attempt = 0; attempt < 8; attempt++) {
      const revision = this.revision;
      await this.follow(file);
      if (revision === this.revision) {
        return;
      }
    }
  }

  private async follow(file: string): Promise<void> {
    if (this.complete.has(file)) {
      return;
    }
    const revision = this.revision;
    const queue = [file];
    const seen = new Set(queue);

    while (queue.length > 0) {
      const current = queue.pop() as string;
      if (this.complete.has(current)) {
        continue;
      }
      const facts = await this.load(current);
      if (!facts) {
        continue;
      }

      const sources = new Set<string>([
        ...Object.values(facts.imports).map((entry) => entry.source),
        ...Object.values(facts.exports).flatMap((entry) => ("source" in entry ? [entry.source] : [])),
        ...facts.exportAll,
      ]);

      let table = this.resolved.get(current);
      if (!table) {
        table = new Map();
        this.resolved.set(current, table);
      }

      for (const source of sources) {
        let target = table.get(source);
        if (!target) {
          target = await this.classify(source, current);
          table.set(source, target);
          // A new edge can change what is reachable from what.
          this.byId = null;
          this.makers = null;
        }
        if (target.kind === "project" && !seen.has(target.file)) {
          seen.add(target.file);
          queue.push(target.file);
        }
      }
    }

    if (revision === this.revision) {
      for (const done of seen) {
        this.complete.add(done);
      }
    }
  }

  private index(): Map<string, { module: ModuleFacts; fn: FunctionFact }> {
    if (!this.byId) {
      this.byId = new Map();
      for (const module of this.modules.values()) {
        for (const fn of module.functions) {
          this.byId.set(fn.id, { module, fn });
        }
      }
    }
    return this.byId;
  }

  private fromSource(
    module: ModuleFacts,
    source: string,
    imported: string,
    seen: Set<string>
  ): Target | null {
    const file = this.absolute.get(module);
    const target = file ? this.resolved.get(file)?.get(source) : undefined;

    if (target?.kind === "asset") {
      return null;
    }
    // Not resolved, so this says nothing about it, and a path isn't a package's name.
    if (!target && /^[./]/.test(source)) {
      return null;
    }
    if (!target || target.kind === "package") {
      const name = target?.name ?? packageFromSource(source);
      return isThreePackage(name) || isThreePackage(source)
        ? { kind: "three", name: imported }
        : { kind: "package", name: imported, package: name };
    }

    const next = this.modules.get(target.file);
    return next ? this.exported(next, imported, seen) : null;
  }

  private exported(module: ModuleFacts, name: string, seen: Set<string>): Target | null {
    const key = `${module.file}#${name}`;
    if (seen.has(key)) {
      return null;
    }
    seen.add(key);

    const entry = module.exports[name];
    if (entry) {
      return "local" in entry
        ? this.lookup(module, entry.local, seen)
        : this.fromSource(module, entry.source, entry.imported, seen);
    }
    for (const source of module.exportAll) {
      const found = this.fromSource(module, source, name, seen);
      if (found && found.kind !== "package") {
        return found;
      }
    }
    return null;
  }

  /** What a name means at the top of a module. */
  private lookup(module: ModuleFacts, name: string, seen = new Set<string>()): Target | null {
    const imported = module.imports[name];
    if (imported) {
      return this.fromSource(module, imported.source, imported.imported, seen);
    }

    const local = module.byName[name]?.[0];
    if (local) {
      const found = this.index().get(local);
      if (found) {
        return { kind: "function", module, fn: found.fn };
      }
    }

    const cls = module.classes[name];
    if (cls) {
      return { kind: "class", module, cls };
    }

    const held = module.vars[name];
    if (held?.object) {
      return { kind: "object", module };
    }
    // `const noise = createNoise2D()`: a function a package made for this module.
    if (held?.calledFrom) {
      const key = `${module.file}=${name}`;
      if (!seen.has(key)) {
        seen.add(key);
        const origin = this.resolve(module, null, held.calledFrom, seen);
        if (origin?.kind === "package") {
          return { kind: "package", name, package: origin.package };
        }
      }
    }
    return null;
  }

  private method(module: ModuleFacts, cls: ClassFact, name: string, depth = 0): Target | null {
    const id = cls.methods[name];
    if (id) {
      const found = this.index().get(id);
      return found ? { kind: "function", module: found.module, fn: found.fn } : null;
    }
    if (cls.extends && depth < 16) {
      const parent = this.resolve(module, null, cls.extends);
      if (parent?.kind === "class") {
        return this.method(parent.module, parent.cls, name, depth + 1);
      }
    }
    return null;
  }

  /** The scope inside a function that declares a name, if one does, nearest first. */
  private bindingOf(module: ModuleFacts, name: string, scope: number | undefined): ScopeFact | null {
    for (let index = scope; index !== undefined && index !== null; ) {
      const binding: ScopeFact | undefined = module.scopes[index];
      // Scope 0 is the module's own, which lookup() reads.
      if (!binding || binding.parent === null) {
        return null;
      }
      if (binding.names.has(name)) {
        return binding;
      }
      index = binding.parent;
    }
    return null;
  }

  /** What a variable holds, from the function that declared it. */
  private varOf(module: ModuleFacts, binding: ScopeFact, name: string) {
    return this.index().get(binding.fact)?.fn.vars[name];
  }

  /**
   * What a reference written in a function names. `scope` is where it is written,
   * from a UseFact; without one, the reference is read at the top of the module.
   */
  private resolve(
    module: ModuleFacts,
    fn: FunctionFact | null,
    ref: Ref,
    seen = new Set<string>(),
    scope?: number
  ): Target | null {
    if (ref.kind === "name") {
      const binding = this.bindingOf(module, ref.name, scope);
      if (binding) {
        const id = binding.functions[ref.name];
        if (id) {
          const found = this.index().get(id);
          return found ? { kind: "function", module, fn: found.fn } : null;
        }
        if (binding.classes.has(ref.name) && module.classes[ref.name]) {
          return { kind: "class", module, cls: module.classes[ref.name] };
        }
        // `const noise = createNoise2D()` inside the function. Anything else a
        // parameter or a variable holds isn't known.
        const held = this.varOf(module, binding, ref.name);
        if (held?.calledFrom) {
          const key = `${binding.fact}=${ref.name}`;
          if (!seen.has(key)) {
            seen.add(key);
            const origin = this.resolve(module, fn, held.calledFrom, seen, module.scopes.indexOf(binding));
            if (origin?.kind === "package") {
              return { kind: "package", name: ref.name, package: origin.package };
            }
          }
        }
        return null;
      }
      return this.lookup(module, ref.name, seen);
    }
    if (ref.kind === "this") {
      const cls = fn?.className ? module.classes[fn.className] : undefined;
      return cls ? this.method(module, cls, ref.name) : null;
    }

    // A local variable hides an import or anything else of the module's with its name.
    const local = this.bindingOf(module, ref.object, scope);
    const imported = local ? undefined : module.imports[ref.object];
    if (imported?.imported === "*") {
      return this.fromSource(module, imported.source, ref.name, seen);
    }
    // Three.js from a script tag.
    if (ref.object === "THREE" && !imported && !local) {
      return { kind: "three", name: ref.name };
    }

    const held = local ? this.varOf(module, local, ref.object) : module.vars[ref.object];
    let base: Target | null = null;

    if (imported) {
      base = this.fromSource(module, imported.source, imported.imported, seen);
    } else if (held?.made) {
      const key = `${local?.fact ?? module.file}.${ref.object}`;
      if (!seen.has(key)) {
        seen.add(key);
        base = this.resolve(module, fn, held.made, seen, local ? module.scopes.indexOf(local) : undefined);
      }
    } else if (held?.object) {
      base = { kind: "object", module };
    }

    switch (base?.kind) {
      case "class":
        return this.method(base.module, base.cls, ref.name);
      case "object": {
        const id = base.module.objectMethods[ref.name]?.[0];
        const found = id ? this.index().get(id) : undefined;
        return found ? { kind: "function", module: found.module, fn: found.fn } : null;
      }
      case "package":
        return {
          kind: "package",
          name: `${imported ? ref.object : base.name}.${ref.name}`,
          package: base.package,
        };
      case "three":
        return { kind: "three", name: `${imported ? ref.object : base.name}.${ref.name}` };
      default:
        return null;
    }
  }

  /** Whether a class is a three.js class, however far down. */
  private isThreeClass(module: ModuleFacts, cls: ClassFact, depth = 0): boolean {
    if (!cls.extends || depth > 16) {
      return false;
    }
    const parent = this.resolve(module, null, cls.extends);
    if (parent?.kind === "three") {
      return !IGNORED_THREE_CLASSES.test(parent.name);
    }
    return parent?.kind === "class" ? this.isThreeClass(parent.module, parent.cls, depth + 1) : false;
  }

  /** Every function that makes a three.js object, directly or through what it calls. */
  private conclude(): Set<string> {
    if (this.makers) {
      return this.makers;
    }
    const makers = new Set<string>();
    const all = [...this.index().values()];
    /** Reverse edges, so news of one maker only visits what calls it. */
    const callers = new Map<string, Set<FunctionFact>>();

    const addEdge = (from: FunctionFact, to: FunctionFact) => {
      const set = callers.get(to.id) ?? new Set<FunctionFact>();
      set.add(from);
      callers.set(to.id, set);
    };

    const pending: FunctionFact[] = [];
    const mark = (fn: FunctionFact) => {
      if (!makers.has(fn.id)) {
        makers.add(fn.id);
        pending.push(fn);
      }
    };

    for (const { module, fn } of all) {
      for (const use of fn.creates) {
        const target = this.resolve(module, fn, use.ref, undefined, use.scope);
        if (target?.kind === "three") {
          // A loader is ignored as an object, but what it loads is in the scene.
          if (!IGNORED_THREE_CLASSES.test(target.name) || /Loader$/.test(target.name)) {
            mark(fn);
          }
        } else if (target?.kind === "class") {
          if (this.isThreeClass(target.module, target.cls)) {
            mark(fn);
          }
          const constructor = this.method(target.module, target.cls, "constructor");
          if (constructor?.kind === "function") {
            addEdge(fn, constructor.fn);
          }
        }
      }
      for (const use of fn.calls) {
        const target = this.resolve(module, fn, use.ref, undefined, use.scope);
        if (target?.kind === "function") {
          addEdge(fn, target.fn);
        } else if (target?.kind === "three" && /Loader\.(load|parse)(Async)?$/.test(target.name)) {
          mark(fn);
        }
      }
    }

    while (pending.length > 0) {
      const maker = pending.pop() as FunctionFact;
      for (const caller of callers.get(maker.id) ?? []) {
        mark(caller);
      }
    }

    this.makers = makers;
    return makers;
  }

  /**
   * The helpers some functions use, following what those use in turn.
   *
   * A function that makes objects of its own isn't one: what it makes has its own
   * source and its own entry here. Listing it would say that a ground plane "uses"
   * the rocks made on the next line.
   */
  private usesOf(module: ModuleFacts, facts: FunctionFact[]): UsedFunction[] {
    const makers = this.conclude();
    const uses: UsedFunction[] = [];
    const seen = new Set<string>(facts.map((fact) => fact.id));

    const visit = (from: ModuleFacts, fn: FunctionFact, depth: number) => {
      if (depth >= MAX_USES_DEPTH) {
        return;
      }
      for (const use of fn.calls) {
        if (uses.length >= MAX_USES) {
          return;
        }
        const target = this.resolve(from, fn, use.ref, undefined, use.scope);
        if (target?.kind === "function") {
          if (!seen.has(target.fn.id) && !makers.has(target.fn.id)) {
            seen.add(target.fn.id);
            uses.push({
              name: target.fn.name,
              depth,
              file: target.fn.file,
              line: target.fn.line,
              column: target.fn.column,
              params: target.fn.params.map((param) => param.name),
              numbers: groupNumbers(target.fn.numbers, target.module.lines, MAX_HELPER_NUMBERS),
            });
            visit(target.module, target.fn, depth + 1);
          }
        } else if (target?.kind === "package" || (target?.kind === "three" && NOISE.test(target.name))) {
          const owner = target.kind === "package" ? target.package : "three";
          const key = `${owner}#${target.name}`;
          if (!seen.has(key) && (target.kind === "three" || !isPlumbingPackage(owner))) {
            seen.add(key);
            uses.push({ name: target.name, depth, package: owner });
          }
        }
      }
    };

    for (const fact of facts) {
      visit(module, fact, 0);
    }
    return uses;
  }

  /**
   * Reads a module about to be served, and everything it reaches, and works out
   * what its instrumentation should do.
   */
  async plan(file: string, code: string, program: Node, firstLine = 1): Promise<TracePlan> {
    let facts = this.modules.get(file);
    if (!facts || facts.code !== code) {
      facts = analyzeModule(program, code, this.host.relative(file), firstLine);
      this.store(file, facts);
    }
    await this.followUntilSettled(file);

    const module = facts;
    const makers = this.conclude();
    const wrap = new Set<string>();
    const isWrapped = (fn: FunctionFact) => makers.has(fn.id) && fn.canWrap && fn.kind !== "statement";

    for (const fn of module.functions) {
      if (isWrapped(fn)) {
        wrap.add(fn.id);
      }
    }

    const callTargets = new Map<string, string>();
    const recordable = new Set<string>();
    for (const fn of module.functions) {
      for (const use of fn.calls) {
        const target = this.resolve(module, fn, use.ref, undefined, use.scope);
        if (target?.kind === "function" && isWrapped(target.fn)) {
          callTargets.set(`${use.start}:${use.end}`, target.fn.id);
        }
      }
      for (const use of fn.creates) {
        const target = this.resolve(module, fn, use.ref, undefined, use.scope);
        const worth = target
          ? target.kind !== "three" || !IGNORED_THREE_CLASSES.test(target.name)
          : !IGNORED_THREE_CLASSES.test(use.ref.name) && !IGNORED_GLOBALS.test(use.ref.name);
        if (worth) {
          recordable.add(`${use.start}:${use.end}`);
        }
        if (target?.kind === "class") {
          const constructor = this.method(target.module, target.cls, "constructor");
          if (constructor?.kind === "function" && isWrapped(constructor.fn)) {
            callTargets.set(`${use.start}:${use.end}`, constructor.fn.id);
          }
        }
      }
    }

    return {
      facts: module,
      wrap,
      callTargets,
      recordable,
      usesOf: (list) => this.usesOf(module, list),
      numbersOf: (list) =>
        groupNumbers(list.flatMap((fact) => fact.numbers), module.lines, MAX_NUMBERS),
      relatedTo: (fact, holder) => {
        const seeds = new Set<string>(fact.declares);
        if (holder) {
          seeds.add(holder);
        }
        const statements = [fact];
        for (const statement of module.functions) {
          if (statement.kind !== "statement" || statement === fact) {
            continue;
          }
          if ([...seeds].some((seed) => statement.names.has(seed))) {
            statements.push(statement);
            for (const name of statement.declares) {
              seeds.add(name);
            }
          }
        }
        return statements.flatMap((statement) =>
          module.functions.filter((inner) => inner.start >= statement.start && inner.end <= statement.end)
        );
      },
    };
  }
}

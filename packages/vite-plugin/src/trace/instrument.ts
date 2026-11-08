import type MagicString from "magic-string";
import type {
  SourceFunction,
  SourceStamp,
  StampedProp,
  StampedValue,
} from "@click-to-source-3d/shared";
import { factAt, refOf, type FunctionFact, type Node } from "./facts.js";
import type { TracePlan } from "./project.js";
import { patternNames, type valueDescriber } from "./values.js";

/** The names the instrumented code uses, which depend on what the file already has. */
export type TraceNames = {
  stamps: string;
  functions: string;
  calls: string;
  cNew: string;
  cEnter: string;
  cLeave: string;
  cCall: string;
  cSite: string;
  cVia: string;
  cOnLoad: string;
  cLoadAsync: string;
};

export type InstrumentContext = {
  code: string;
  magic: MagicString;
  file: string;
  plan: TracePlan;
  names: TraceNames;
  describeValue: ReturnType<typeof valueDescriber>;
  /** Adds a stamp and returns its index. */
  addStamp(stamp: SourceStamp, fact: FunctionFact | undefined, holder: string | null): number;
  /** The table index of a function, adding it if it isn't there yet. */
  functionIndex(fact: FunctionFact, holder: string | null): number;
};

/** Receivers of `.clone()` that are always vectors, colours and the like, often in hot code. */
const MATH_PROPERTY =
  /^(position|rotation|scale|quaternion|matrix|matrixWorld|up|normal|direction|velocity|acceleration|color|center|min|max|start|end|target|origin|point|offset)$/;

/** Properties that are bookkeeping rather than values anyone tunes. */
const SKIPPED_ASSIGNMENTS = /^(needsUpdate|matrixAutoUpdate|matrixWorldNeedsUpdate|userData)$/;

/** Methods of an object that say where it is, shown with the values they were given. */
const POSE_METHODS = /^(rotateX|rotateY|rotateZ|translateX|translateY|translateZ|lookAt)$/;

const MAX_STATEMENTS = 24;

const SKIPPED_KEYS = new Set([
  "loc",
  "extra",
  "leadingComments",
  "trailingComments",
  "innerComments",
  "typeAnnotation",
  "typeParameters",
  "typeArguments",
  "returnType",
  "superTypeParameters",
  "superTypeArguments",
  "implements",
]);

const isTypeOnly = (node: Node) =>
  node.type.startsWith("TS") &&
  !/^TS(As|NonNull|Satisfies|TypeAssertion|Instantiation|ParameterProperty)/.test(node.type);

const isFunctionNode = (node: Node) =>
  node.type === "FunctionDeclaration" ||
  node.type === "FunctionExpression" ||
  node.type === "ArrowFunctionExpression" ||
  node.type === "ObjectMethod" ||
  node.type === "ClassMethod" ||
  node.type === "ClassPrivateMethod";

const isClassNode = (node: Node | undefined) =>
  node?.type === "ClassDeclaration" || node?.type === "ClassExpression";

/** Calls `visit` for each child node. */
function eachChild(node: Node, visit: (child: Node) => void): void {
  for (const key of Object.keys(node)) {
    if (SKIPPED_KEYS.has(key)) {
      continue;
    }
    const value = node[key];
    if (Array.isArray(value)) {
      for (const item of value) {
        if (item && typeof (item as Node).type === "string") {
          visit(item as Node);
        }
      }
    } else if (value && typeof (value as Node).type === "string") {
      visit(value as Node);
    }
  }
}

/** A statement that sets something on a variable: `mesh.position.x = 1`, `mesh.scale.set(1, 2, 1)`. */
type MemberStatement = {
  root: string;
  path: string[];
  start: number;
  /** What the statement does. */
  assign?: { operator: string; value: Node };
  call?: { method: string; args: Node[] };
};

/** `a.b.c` as `["a", "b", "c"]`, with `this.a` as a single first part. */
function pathOf(node: Node): string[] | null {
  if (node.type === "Identifier") {
    return [node.name as string];
  }
  if (node.type === "MemberExpression" && !node.computed) {
    const object = node.object as Node;
    const name = (node.property as Node).name as string | undefined;
    if (!name) {
      return null;
    }
    if (object.type === "ThisExpression") {
      return [`this.${name}`];
    }
    const path = pathOf(object);
    return path ? [...path, name] : null;
  }
  return null;
}

type Declaration = { name: string; start: number; topLevel: boolean };

/** Everything in a module that sets a value on a variable, and every variable declared. */
function indexStatements(program: Node, plan: TracePlan) {
  const statements: MemberStatement[] = [];
  const declarations = new Map<string, Declaration[]>();

  const declare = (name: string, start: number) => {
    const fact = factAt(plan.facts, start);
    const list = declarations.get(name) ?? [];
    list.push({ name, start, topLevel: fact?.kind === "statement" });
    declarations.set(name, list);
  };

  const walk = (node: Node) => {
    if (isTypeOnly(node)) {
      return;
    }
    if (node.type === "VariableDeclarator") {
      for (const name of patternNames(node.id as Node)) {
        declare(name, node.start as number);
      }
    } else if (isFunctionNode(node)) {
      for (const param of node.params as Node[]) {
        for (const name of patternNames(param)) {
          declare(name, (node.body as Node).start as number);
        }
      }
    } else if (node.type === "AssignmentExpression") {
      const left = node.left as Node;
      const path = left.type === "MemberExpression" ? pathOf(left) : null;
      if (path && path.length > 1) {
        statements.push({
          root: path[0],
          path: path.slice(1),
          start: node.start as number,
          assign: { operator: node.operator as string, value: node.right as Node },
        });
      }
    } else if (node.type === "CallExpression") {
      const callee = node.callee as Node;
      const path = callee.type === "MemberExpression" ? pathOf(callee) : null;
      if (path && path.length > 1) {
        statements.push({
          root: path[0],
          path: path.slice(1, -1),
          start: node.start as number,
          call: { method: path[path.length - 1], args: node.arguments as Node[] },
        });
      }
    }
    eachChild(node, walk);
  };

  walk(program);
  return { statements, declarations };
}

/** The name a `new` is held in, if any: `const mesh = new Mesh()`, `this.mesh = new Mesh()`. */
function holderOf(ancestors: Node[], node: Node): { name: string; start: number } | null {
  // Through `new Mesh() as Foo` and the like.
  let index = ancestors.length - 1;
  let child = node;
  while (
    ancestors[index]?.type === "TSAsExpression" ||
    ancestors[index]?.type === "TSNonNullExpression" ||
    ancestors[index]?.type === "TSSatisfiesExpression"
  ) {
    child = ancestors[index];
    index--;
  }
  const parent = ancestors[index];
  if (parent?.type === "VariableDeclarator" && parent.init === child) {
    const id = parent.id as Node;
    return id.type === "Identifier" ? { name: id.name as string, start: parent.start as number } : null;
  }
  if (parent?.type === "AssignmentExpression" && parent.right === child && parent.operator === "=") {
    const path = pathOf(parent.left as Node);
    return path?.length === 1 ? { name: path[0], start: parent.start as number } : null;
  }
  if (parent?.type === "ClassProperty" && parent.value === child) {
    const key = (parent.key as Node).name as string | undefined;
    return key ? { name: `this.${key}`, start: parent.start as number } : null;
  }
  return null;
}

/** What a statement setting a value says, as a prop. */
function propFromStatement(
  statement: MemberStatement,
  element: string,
  describe: InstrumentContext["describeValue"]
): StampedProp | null {
  const { path } = statement;
  if (path.some((part) => SKIPPED_ASSIGNMENTS.test(part)) || path[0] === "geometry" || path.length > 3) {
    return null;
  }

  if (statement.assign) {
    const { operator, value } = statement.assign;
    const name = path.join("-");
    return {
      element,
      // Compound assignment keeps its operator: `rotation-y +=` isn't a value the
      // object holds, but the number in it is often the one to change.
      name: operator === "=" ? name : `${name} ${operator}`,
      array: false,
      values: [describe(value)],
    };
  }

  const { method, args } = statement.call!;
  if (args.length === 0) {
    return null;
  }

  if (path.length === 0) {
    return POSE_METHODS.test(method)
      ? { element, name: `${method}()`, array: true, values: args.map(describe) }
      : null;
  }
  const name = path.join("-");
  if (method === "set" || method === "setScalar") {
    return { element, name, array: args.length > 1, values: args.map(describe) };
  }
  if (method === "setHex" || method === "setStyle") {
    return { element, name, array: false, values: [describe(args[0])] };
  }
  const axis = /^set([XYZW])$/.exec(method);
  if (axis) {
    return { element, name: `${name}-${axis[1].toLowerCase()}`, array: false, values: [describe(args[0])] };
  }
  return null;
}

/** A `new X(...)` as props: its positional arguments, and any options object. */
function propsFromArguments(
  element: string,
  args: Node[],
  describe: InstrumentContext["describeValue"]
): StampedProp[] {
  const props: StampedProp[] = [];

  const values = args.map((arg) =>
    arg.type === "ObjectExpression" ? ({ raw: "{…}", editable: false } as StampedValue) : describe(arg)
  );
  // `new Mesh(geometry, material)` says nothing the panel doesn't already show.
  // A geometry's arguments are its shape, though, even when they are all variables.
  const isGeometry = /Geometry$/.test(element) && args.some((arg) => arg.type !== "ObjectExpression");
  if (values.some((value) => value.editable) || isGeometry) {
    props.push({ element, name: "args", array: true, values });
  }

  for (const arg of args) {
    if (arg.type !== "ObjectExpression") {
      continue;
    }
    for (const property of arg.properties as Node[]) {
      if (property.type !== "ObjectProperty" || property.computed) {
        continue;
      }
      const key = property.key as Node;
      const name = (key.name ?? key.value) as string | undefined;
      const value = property.value as Node;
      if (!name || value.type === "ObjectExpression" || value.type === "AssignmentPattern") {
        continue;
      }
      if (value.type === "ArrayExpression") {
        props.push({
          element,
          name,
          array: true,
          values: (value.elements as Array<Node | null>).map(describe),
        });
      } else {
        props.push({ element, name, array: false, values: [describe(value)] });
      }
    }
  }
  return props;
}

const lastPart = (ref: { name: string }) => ref.name;

/**
 * Adds to a module what records where three.js objects come from.
 *
 * Every edit stays on the line it is made on, so the module's line numbers don't
 * move, and each is a call wrapped around an expression, which keeps the code's
 * meaning and needs nothing from the application's own syntax choices.
 *
 * - `new Mesh(a, b)` becomes `__ctsNew(new Mesh(a, b), stamp)`.
 * - `mesh.clone()` becomes `__ctsNew(mesh.clone(), stamp)`.
 * - `loader.load(url, done)` becomes `loader.load(url, __ctsOnLoad(done, stamp))`.
 * - A function that makes objects, or calls one that does, records its calls in
 *   its body, inside a try so the record is right however it returns.
 * - A call to such a function notes where it was made, which is what makes an
 *   argument written as a literal editable from the panel.
 *
 * Math types and the language's own classes are skipped at this stage, because
 * they get allocated in tight loops. Anything else is left to the runtime to
 * judge: a class made through an alias or a re-export can't be told apart here.
 *
 * Returns the call sites it noted, for the module's table.
 */
export function instrument(program: Node, context: InstrumentContext): { calls: Array<Record<string, unknown>> } {
  const { code, magic, file, plan, names, describeValue, addStamp, functionIndex } = context;
  const { statements, declarations } = indexStatements(program, plan);
  const calls: Array<Record<string, unknown>> = [];

  const ownFact = new Map<number, FunctionFact>();
  for (const fact of plan.facts.functions) {
    if (fact.kind !== "statement") {
      ownFact.set(fact.start, fact);
    }
  }

  /** Finds the statements that set values on what a variable holds. */
  const propsFromStatements = (
    holder: { name: string; start: number },
    fact: FunctionFact | undefined,
    element: string,
    ancestors: Node[]
  ): StampedProp[] => {
    const declared = declarations.get(holder.name) ?? [];
    const isField = holder.name.startsWith("this.");
    const onlyOne = declared.length === 1;

    let scopeStart = fact?.start ?? 0;
    let scopeEnd = fact?.end ?? Number.POSITIVE_INFINITY;
    if (isField) {
      // A field is read and written all over its class.
      const cls = [...ancestors].reverse().find(isClassNode);
      scopeStart = (cls?.start as number | undefined) ?? 0;
      scopeEnd = (cls?.end as number | undefined) ?? Number.POSITIVE_INFINITY;
    } else if (onlyOne && declared[0].topLevel) {
      // `function animate() { cube.rotation.x += 0.01 }`, wherever it is written.
      scopeStart = 0;
      scopeEnd = Number.POSITIVE_INFINITY;
    }

    const props: StampedProp[] = [];
    for (const statement of statements) {
      if (statement.root !== holder.name || statement.start < scopeStart || statement.start >= scopeEnd) {
        continue;
      }
      // Reusing a name: only what comes after this variable and before the next.
      if (!onlyOne && !isField) {
        if (statement.start < holder.start) {
          continue;
        }
        if (declared.some((other) => other.start > holder.start && other.start <= statement.start)) {
          continue;
        }
      }
      const prop = propFromStatement(statement, element, describeValue);
      if (prop) {
        props.push(prop);
        if (props.length >= MAX_STATEMENTS) {
          break;
        }
      }
    }
    return props;
  };

  const stampFor = (
    node: Node,
    how: SourceStamp["how"],
    creates: string,
    props: StampedProp[],
    fact: FunctionFact | undefined,
    holder: string | null,
    ancestors: Node[] = []
  ): number => {
    const start = node.loc!.start;
    // A field's value belongs to its class, though no function holds it.
    const cls = fact?.kind === "statement" ? [...ancestors].reverse().find(isClassNode) : undefined;
    const owner = (cls?.id as Node | null | undefined)?.name as string | undefined;
    return addStamp(
      {
        file,
        function: owner ?? fact?.name ?? "(top level)",
        line: start.line,
        column: start.column + 1,
        creates,
        how,
        ...(props.length > 0 ? { props } : {}),
      },
      fact,
      holder
    );
  };

  /**
   * The arguments of a call as written, for finding the literals among them. Past a
   * spread, a position no longer says which parameter an argument is. In an object,
   * a spread can replace what came before it, but not what comes after.
   */
  const siteArgs = (args: Node[]) => {
    let afterSpread = false;
    return args.map((arg) => {
      if (afterSpread || arg.type === "SpreadElement") {
        afterSpread = true;
        return null;
      }
      if (arg.type === "ObjectExpression") {
        let keys: Record<string, StampedValue> = {};
        for (const property of arg.properties as Node[]) {
          if (property.type === "SpreadElement") {
            keys = {};
          } else if (property.type === "ObjectProperty") {
            const key = property.key as Node;
            const name = property.computed ? undefined : ((key.name ?? key.value) as string | undefined);
            const value = describeValue(property.value as Node);
            if (name && value.editable) {
              keys[name] = value;
            } else if (name) {
              delete keys[name];
            }
          }
        }
        return { keys };
      }
      const value = describeValue(arg);
      return value.editable ? value : null;
    });
  };

  /** Notes where a call is made, around an expression that makes it. */
  const openSite = (node: Node, target: string): string => {
    const start = node.loc!.start;
    calls.push({
      target,
      file,
      line: start.line,
      column: start.column + 1,
      args: siteArgs(node.arguments as Node[]),
    });
    return `${names.cVia}(${names.cSite}(${names.calls}[${calls.length - 1}]),`;
  };

  /** The loader a method is called on, if it looks like one. */
  const loaderOf = (callee: Node, fact: FunctionFact | undefined): string | null => {
    let object = callee.object as Node;
    // `new GLTFLoader().setPath("/models/").load(...)`
    while (object.type === "CallExpression" && (object.callee as Node).type === "MemberExpression") {
      object = (object.callee as Node).object as Node;
    }
    if (object.type === "NewExpression") {
      const ref = refOf(object.callee as Node);
      return ref && /Loader$/.test(lastPart(ref)) ? lastPart(ref) : null;
    }
    if (object.type === "Identifier") {
      const held = fact?.vars[object.name as string]?.made ?? plan.facts.vars[object.name as string]?.made;
      if (held && /Loader$/.test(lastPart(held))) {
        return lastPart(held);
      }
      return /loader$/i.test(object.name as string) ? "Loader" : null;
    }
    const path = pathOf(object);
    return path && /loader$/i.test(path[path.length - 1]) ? "Loader" : null;
  };

  const instrumentFunction = (node: Node, ancestors: Node[], closers: Array<() => void>) => {
    const own = ownFact.get(node.start as number);
    if (!own || !plan.wrap.has(own.id)) {
      return;
    }
    const index = functionIndex(own, null);
    const values = `[${own.params.map((param) => param.name).join(",")}]`;
    const body = node.body as Node;

    if (body.type !== "BlockStatement") {
      magic.appendLeft(
        body.extra?.parenStart ?? (body.start as number),
        `${names.cCall}(${names.functions}[${index}],${values},()=>`
      );
      closers.push(() => magic.appendLeft(node.end as number, ")"));
      return;
    }

    let at: number | null = (body.start as number) + 1;
    let separator = "";
    const directives = (body.directives ?? []) as Node[];
    if (directives.length > 0) {
      at = directives[directives.length - 1].end as number;
      separator = ";";
    }
    if (own.kind === "constructor" && (ancestors[ancestors.length - 2]?.superClass ?? null) !== null) {
      // A subclass can't touch anything before super(). Nor can super() move into
      // a try: TypeScript's parameter properties need it at the top.
      const first = (body.body as Node[]).find(
        (statement) =>
          statement.type === "ExpressionStatement" &&
          ((statement.expression as Node).callee as Node | undefined)?.type === "Super"
      );
      at = first ? (first.end as number) : null;
      separator = ";";
    }
    if (at !== null) {
      magic.appendLeft(at, `${separator}${names.cEnter}(${names.functions}[${index}],${values});try{`);
      closers.push(() => magic.appendLeft((body.end as number) - 1, `}finally{${names.cLeave}()}`));
    }
  };

  const instrumentNew = (node: Node, ancestors: Node[], closers: Array<() => void>) => {
    const ref = refOf(node.callee as Node);
    if (!ref) {
      return;
    }
    const imported = ref.kind === "name" ? plan.facts.imports[ref.name]?.imported : undefined;
    const written = imported && imported !== "default" && imported !== "*" ? imported : ref.name;
    if (!/^[A-Z_$]/.test(written) || !plan.recordable.has(`${node.start}:${node.end}`)) {
      return;
    }
    const fact = factAt(plan.facts, node.start as number);

    const element = lastPart(ref);
    const args = node.arguments as Node[];
    const holder = holderOf(ancestors, node);
    const props = [
      ...propsFromArguments(element, args, describeValue),
      ...(holder ? propsFromStatements(holder, fact, element, ancestors) : []),
    ];
    const stamp = stampFor(node, "new", element, props, fact, holder?.name ?? null, ancestors);

    const target = plan.callTargets.get(`${node.start}:${node.end}`);
    const site = target ? openSite(node, target) : "";
    magic.appendLeft(node.start as number, `${site}${names.cNew}(`);
    closers.push(() =>
      magic.appendLeft(node.end as number, `,${names.stamps}[${stamp}])${site ? ")" : ""}`)
    );
  };

  const instrumentClone = (node: Node, callee: Node, ancestors: Node[], closers: Array<() => void>) => {
    const receiver = callee.object as Node;
    const last =
      receiver.type === "MemberExpression"
        ? ((receiver.property as Node).name as string | undefined)
        : receiver.type === "Identifier"
          ? (receiver.name as string)
          : undefined;
    if (last && MATH_PROPERTY.test(last)) {
      return;
    }
    const fact = factAt(plan.facts, node.start as number);
    const holder = holderOf(ancestors, node);
    const text = code.slice(receiver.start as number, receiver.end as number).replace(/\s+/g, " ");
    const element = text.length > 24 ? "clone" : `${text}.clone`;
    const props = holder ? propsFromStatements(holder, fact, element, ancestors) : [];
    const stamp = stampFor(node, "clone", element, props, fact, holder?.name ?? null, ancestors);
    magic.appendLeft(node.start as number, `${names.cNew}(`);
    closers.push(() => magic.appendLeft(node.end as number, `,${names.stamps}[${stamp}])`));
  };

  const instrumentLoad = (
    node: Node,
    callee: Node,
    property: string,
    closers: Array<() => void>
  ) => {
    const fact = factAt(plan.facts, node.start as number);
    const loader = loaderOf(callee, fact);
    if (!loader) {
      return;
    }
    const args = node.arguments as Node[];
    const url = args[0] ? describeValue(args[0]) : null;
    const props: StampedProp[] =
      url?.editable && typeof url.value === "string"
        ? [{ element: loader, name: "url", array: false, values: [url] }]
        : [];
    const stamp = stampFor(node, "load", loader, props, fact, null);
    const reference = `${names.stamps}[${stamp}]`;

    if (property === "loadAsync" || property === "parseAsync") {
      magic.appendLeft(node.start as number, `${names.cLoadAsync}(`);
      closers.push(() => magic.appendLeft(node.end as number, `,${reference})`));
      return;
    }
    const callback = args[property === "load" ? 1 : 2];
    if (callback && callback.type !== "SpreadElement") {
      // Into the argument, so nothing about the call itself changes.
      magic.appendLeft(callback.start as number, `${names.cOnLoad}(`);
      closers.push(() => magic.appendLeft(callback.end as number, `,${reference})`));
    } else if (property === "parse") {
      // Some loaders' parse returns what it read.
      magic.appendLeft(node.start as number, `${names.cNew}(`);
      closers.push(() => magic.appendLeft(node.end as number, `,${reference})`));
    }
  };

  const walk = (node: Node, ancestors: Node[]): void => {
    if (isTypeOnly(node)) {
      return;
    }

    const closers: Array<() => void> = [];

    // Pre-order for what opens at a position, so the outer call comes first.
    if (isFunctionNode(node)) {
      instrumentFunction(node, ancestors, closers);
    } else if (node.type === "NewExpression") {
      instrumentNew(node, ancestors, closers);
    } else if (node.type === "CallExpression") {
      const callee = node.callee as Node;
      const property =
        callee.type === "MemberExpression" && !callee.computed
          ? ((callee.property as Node).name as string | undefined)
          : undefined;

      if (property === "clone" && (node.arguments as Node[]).length <= 1) {
        instrumentClone(node, callee, ancestors, closers);
      } else if (property === "load" || property === "loadAsync" || property === "parse" || property === "parseAsync") {
        instrumentLoad(node, callee, property, closers);
      }

      const target = plan.callTargets.get(`${node.start}:${node.end}`);
      if (target) {
        magic.appendLeft(node.start as number, openSite(node, target));
        closers.push(() => magic.appendLeft(node.end as number, ")"));
      }
    }

    ancestors.push(node);
    eachChild(node, (child) => walk(child, ancestors));
    ancestors.pop();

    // Post-order for what closes, so the inner call ends first.
    for (let index = closers.length - 1; index >= 0; index--) {
      closers[index]();
    }
  };

  walk(program, []);
  return { calls };
}

/** A function as the panel reads it, leaving out numbers already shown as an object's values. */
export function describeFunction(
  fact: FunctionFact,
  holder: string | null,
  plan: TracePlan,
  shown: Set<string>
): SourceFunction {
  const parts = fact.kind === "statement" ? plan.relatedTo(fact, holder) : [fact];
  const numbers = plan
    .numbersOf(parts)
    .map((group) => ({
      ...group,
      values: group.values.filter((value) => !shown.has(`${value.line}:${value.column}`)),
    }))
    .filter((group) => group.values.length > 0);

  return {
    id: fact.id,
    name: fact.name,
    file: fact.file,
    line: fact.line,
    column: fact.column,
    params: fact.params,
    numbers,
    uses: plan.usesOf(parts),
  };
}

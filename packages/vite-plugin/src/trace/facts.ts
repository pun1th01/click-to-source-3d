import { parse, type ParserPlugin } from "@babel/parser";
import type { SourceParam, StampedValue } from "@click-to-source-3d/shared";
import { patternNames } from "./values.js";

export type Node = {
  type: string;
  start?: number | null;
  end?: number | null;
  loc?: { start: { line: number; column: number } } | null;
  extra?: { parenthesized?: boolean; parenStart?: number; raw?: string };
  [key: string]: unknown;
};

/** The syntax a file is written in, from its extension. */
export function pluginsFor(file: string): ParserPlugin[] {
  if (/\.[cm]?ts$/.test(file)) {
    // Not "jsx": it would read `<T>x` and `<T>(a) => a` as the start of an element.
    return ["typescript", "decorators-legacy"];
  }
  if (/\.tsx$/.test(file) || /\.jsx$/.test(file)) {
    return ["jsx", "typescript", "decorators-legacy"];
  }
  return ["jsx", "decorators-legacy"];
}

/**
 * Parses a module, or returns null for one that can't be understood. `at` is where
 * the code starts in its file, for a script written inside a page.
 */
export function parseSource(
  code: string,
  file: string,
  at?: { startLine: number; startColumn: number }
): Node | null {
  try {
    return parse(code, {
      sourceType: "module",
      errorRecovery: true,
      plugins: pluginsFor(file),
      ...at,
    }).program as unknown as Node;
  } catch {
    return null;
  }
}

/** How a call or `new` names what it calls, before anything is resolved. */
export type Ref =
  | { kind: "name"; name: string }
  | { kind: "member"; object: string; name: string }
  | { kind: "this"; name: string };

/** A call or a `new`, with the scope it is written in, which decides what its name means. */
export type UseFact = { ref: Ref; start: number; end: number; scope: number };

/**
 * The names one function declares: its parameters, variables, and the functions and
 * classes declared in it. A name declared nearer a call is what the call means, so a
 * parameter called `onLoad` is not a function called `onLoad` elsewhere in the file.
 * Scope 0 is the module's own, whose names are read from its imports and declarations.
 */
export type ScopeFact = {
  parent: number | null;
  /** The function whose variables are recorded for this scope. */
  fact: string;
  names: Set<string>;
  /** Names here that are functions this file declares. */
  functions: Record<string, string>;
  /** Names here that are classes this file declares. */
  classes: Set<string>;
};

/** A number or colour written in a function, with where it is. */
export type NumberFact = StampedValue & { line: number; column: number };

/** What a variable was first given, where that helps say what calling it means. */
export type VarFact = { made?: Ref; calledFrom?: Ref; object?: boolean };

/**
 * One function, or one top-level statement, as far as a single file can say.
 *
 * Anonymous functions are not given their own: `items.map((x) => new Mesh())`
 * belongs to whatever function it is written in, which is what a person would
 * say made the mesh.
 */
export type FunctionFact = {
  id: string;
  name: string;
  file: string;
  line: number;
  column: number;
  start: number;
  end: number;
  kind: "function" | "constructor" | "statement";
  params: SourceParam[];
  className: string | null;
  /** Async functions and generators leave the stack before they finish. */
  canWrap: boolean;
  creates: UseFact[];
  calls: UseFact[];
  numbers: NumberFact[];
  vars: Record<string, VarFact>;
  /** For a top-level statement: the names it mentions and the ones it declares. */
  names: Set<string>;
  declares: string[];
};

export type ClassFact = {
  name: string;
  extends: Ref | null;
  methods: Record<string, string>;
};

export type ImportFact = { source: string; imported: string };
export type ExportFact = { local: string } | { source: string; imported: string };

export type ModuleFacts = {
  code: string;
  file: string;
  functions: FunctionFact[];
  /** Functions declared at the top of the module, by name. */
  byName: Record<string, string[]>;
  /** Functions written as an object's properties, by key, for `helpers.fbm()`. */
  objectMethods: Record<string, string[]>;
  scopes: ScopeFact[];
  classes: Record<string, ClassFact>;
  imports: Record<string, ImportFact>;
  exports: Record<string, ExportFact>;
  exportAll: string[];
  /** Module-level variables. */
  vars: Record<string, VarFact>;
  /** Source lines, for showing a number in context. */
  lines: string[];
};

const COMPONENT_WRAPPERS = new Set(["memo", "forwardRef"]);
const COLOUR = /^#[0-9a-f]{3,8}$/i;
const MAX_NUMBERS = 48;

/** What a default export with no name of its own is called: its file's name. */
function defaultExportName(file: string): string {
  const parts = file.split("/");
  const base = (parts.pop() ?? "").replace(/\.[^.]+$/, "");
  return base === "index" && parts.length > 0 ? parts.pop()! : base;
}

/** The names a top-level statement introduces. */
function declaredBy(statement: Node): string[] {
  const inner =
    statement.type === "ExportNamedDeclaration" || statement.type === "ExportDefaultDeclaration"
      ? (statement.declaration as Node | null)
      : statement;
  if (inner?.type === "VariableDeclaration") {
    return (inner.declarations as Node[]).flatMap((declarator) => patternNames(declarator.id as Node));
  }
  if (inner?.type === "FunctionDeclaration" || inner?.type === "ClassDeclaration") {
    const name = (inner.id as Node | null)?.name as string | undefined;
    return name ? [name] : [];
  }
  return [];
}

/** Every name a pattern binds, with which part of the argument it comes from. */
function paramsOf(params: Node[]): SourceParam[] {
  const out: SourceParam[] = [];

  params.forEach((param, arg) => {
    let node = param;
    if (node.type === "TSParameterProperty") {
      node = node.parameter as Node;
    }
    if (node.type === "AssignmentPattern") {
      node = node.left as Node;
    }
    const rest = node.type === "RestElement";
    if (rest) {
      node = node.argument as Node;
    }
    if (node.type === "Identifier") {
      // TypeScript's `this: Foo` is not a parameter.
      if (node.name !== "this") {
        out.push({ name: node.name as string, arg, ...(rest ? { rest: true } : {}) });
      }
    } else if (node.type === "ObjectPattern") {
      for (const property of node.properties as Node[]) {
        if (property.type !== "ObjectProperty" || property.computed) {
          continue;
        }
        const key = (property.key as Node).name as string | undefined;
        let value = property.value as Node;
        if (value.type === "AssignmentPattern") {
          value = value.left as Node;
        }
        if (key && value.type === "Identifier") {
          out.push({ name: value.name as string, arg, key });
        }
      }
    }
  });
  return out;
}

function propertyName(node: Node | undefined): string | null {
  if (!node) {
    return null;
  }
  if (node.type === "Identifier") {
    return node.name as string;
  }
  if (node.type === "PrivateName") {
    return `#${(node.id as Node).name as string}`;
  }
  if (node.type === "StringLiteral") {
    return node.value as string;
  }
  return null;
}

/** The way an expression names something callable, or null if it doesn't simply. */
export function refOf(callee: Node | undefined): Ref | null {
  if (!callee) {
    return null;
  }
  if (callee.type === "TSNonNullExpression") {
    return refOf(callee.expression as Node);
  }
  if (callee.type === "Identifier") {
    return { kind: "name", name: callee.name as string };
  }
  if (callee.type === "MemberExpression" && !callee.computed) {
    const object = callee.object as Node;
    const name = propertyName(callee.property as Node);
    if (!name) {
      return null;
    }
    if (object.type === "ThisExpression") {
      return { kind: "this", name };
    }
    if (object.type === "Identifier") {
      return { kind: "member", object: object.name as string, name };
    }
  }
  return null;
}

const isTypeOnly = (node: Node) =>
  node.type.startsWith("TS") &&
  node.type !== "TSAsExpression" &&
  node.type !== "TSNonNullExpression" &&
  node.type !== "TSSatisfiesExpression" &&
  node.type !== "TSTypeAssertion" &&
  node.type !== "TSParameterProperty" &&
  node.type !== "TSInstantiationExpression";

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
  "decorators",
]);

const isFunction = (node: Node) =>
  node.type === "FunctionDeclaration" ||
  node.type === "FunctionExpression" ||
  node.type === "ArrowFunctionExpression" ||
  node.type === "ObjectMethod" ||
  node.type === "ClassMethod" ||
  node.type === "ClassPrivateMethod";

/**
 * Reads what one module says about itself: its functions and what they make and
 * call, its classes, what it imports and exports, and the numbers it contains.
 *
 * Nothing is resolved here, and no other file is looked at, so the result can be
 * kept and reused until this file changes. Holds no syntax tree, which would
 * otherwise be kept in memory for every module of the application.
 */
export function analyzeModule(program: Node, code: string, file: string, firstLine = 1): ModuleFacts {
  // Without a prototype, because the keys are names from the code: a function can
  // call `toString()`, and a class always has a `constructor`, which a plain object
  // would answer for with its own.
  const facts: ModuleFacts = {
    code,
    file,
    functions: [],
    byName: Object.create(null),
    objectMethods: Object.create(null),
    scopes: [],
    classes: Object.create(null),
    imports: Object.create(null),
    exports: Object.create(null),
    exportAll: [],
    vars: Object.create(null),
    // Indexed by line in the file, which for a script in a page isn't the script's.
    lines: [...Array<string>(firstLine - 1).fill(""), ...code.split(/\r?\n/)],
  };

  const ids = new Set<string>();

  const newScope = (parent: number | null, fact: string): number => {
    facts.scopes.push({ parent, fact, names: new Set(), functions: Object.create(null), classes: new Set() });
    return facts.scopes.length - 1;
  };

  /**
   * By name rather than by position, because other modules keep it. A call site
   * says which function it is calling by this id, and Vite doesn't transform the
   * caller again when a line is added above the function in another file.
   */
  const idFor = (name: string, kind: FunctionFact["kind"], line: number): string => {
    const base = kind === "statement" ? `${file}#top@${line}` : `${file}#${name}`;
    let id = base;
    for (let count = 2; ids.has(id); count++) {
      id = `${base}~${count}`;
    }
    ids.add(id);
    return id;
  };

  const makeFact = (
    node: Node,
    name: string,
    kind: FunctionFact["kind"],
    extra: Partial<FunctionFact> = {}
  ): FunctionFact => {
    const start = node.loc!.start;
    const fact: FunctionFact = {
      id: idFor(name, kind, start.line),
      name,
      file,
      line: start.line,
      column: start.column + 1,
      start: node.start as number,
      end: node.end as number,
      kind,
      params: [],
      className: null,
      canWrap: false,
      creates: [],
      calls: [],
      numbers: [],
      vars: Object.create(null),
      names: new Set(),
      declares: [],
      ...extra,
    };
    facts.functions.push(fact);
    return fact;
  };

  /** The name a function goes by, from where it is written. Null if it has none. */
  const nameFor = (
    node: Node,
    ancestors: Node[],
    className: string | null
  ): { name: string; kind: FunctionFact["kind"]; bare: boolean } | null => {
    if (node.type === "ClassMethod" || node.type === "ClassPrivateMethod") {
      const key = propertyName(node.key as Node);
      if (!key) {
        return null;
      }
      return node.kind === "constructor"
        ? { name: className ?? "constructor", kind: "constructor", bare: false }
        : { name: className ? `${className}.${key}` : key, kind: "function", bare: false };
    }
    if (node.type === "ObjectMethod") {
      const key = propertyName(node.key as Node);
      return key ? { name: key, kind: "function", bare: true } : null;
    }

    const id = node.id as Node | null | undefined;
    if (id?.name) {
      return { name: id.name as string, kind: "function", bare: true };
    }

    // Step out through `memo(forwardRef(...))`.
    let holder = ancestors.length - 1;
    while (
      ancestors[holder]?.type === "CallExpression" &&
      COMPONENT_WRAPPERS.has(
        (refOf(ancestors[holder].callee as Node) as { name?: string } | null)?.name ?? ""
      )
    ) {
      holder--;
    }
    const parent = ancestors[holder];

    switch (parent?.type) {
      case "VariableDeclarator": {
        const declared = (parent.id as Node).name as string | undefined;
        return declared ? { name: declared, kind: "function", bare: true } : null;
      }
      case "ObjectProperty": {
        const key = propertyName(parent.key as Node);
        return key ? { name: key, kind: "function", bare: true } : null;
      }
      case "ClassProperty":
      case "ClassPrivateProperty": {
        const key = propertyName(parent.key as Node);
        return key
          ? { name: className ? `${className}.${key}` : key, kind: "function", bare: false }
          : null;
      }
      case "AssignmentExpression": {
        const left = parent.left as Node;
        if (left.type === "Identifier") {
          return { name: left.name as string, kind: "function", bare: true };
        }
        if (left.type === "MemberExpression") {
          const key = propertyName(left.property as Node);
          return key ? { name: key, kind: "function", bare: true } : null;
        }
        return null;
      }
      case "ExportDefaultDeclaration":
        return { name: defaultExportName(file), kind: "function", bare: true };
      default:
        return null;
    }
  };

  const recordVar = (id: Node, init: Node | undefined, scope: FunctionFact) => {
    if (id.type !== "Identifier" || !init) {
      return;
    }
    let value = init;
    while (value.type === "AwaitExpression" || value.type === "TSNonNullExpression" || value.type === "TSAsExpression") {
      value = (value.argument ?? value.expression) as Node;
    }
    const target = scope.kind === "statement" ? facts.vars : scope.vars;
    if (value.type === "NewExpression") {
      const made = refOf(value.callee as Node);
      if (made) {
        target[id.name as string] = { made };
      }
    } else if (value.type === "CallExpression") {
      const calledFrom = refOf(value.callee as Node);
      if (calledFrom) {
        target[id.name as string] = { calledFrom };
      }
    } else if (value.type === "ObjectExpression") {
      target[id.name as string] = { object: true };
    }
  };

  const addNumber = (scope: FunctionFact, node: Node) => {
    if (scope.numbers.length >= MAX_NUMBERS) {
      return;
    }
    const start = node.loc!.start;
    const raw = code.slice(node.start as number, node.end as number);
    const value =
      node.type === "UnaryExpression"
        ? -((node.argument as Node).value as number)
        : (node.value as number | string);
    scope.numbers.push({
      raw,
      value,
      editable: true,
      line: start.line,
      column: start.column + 1,
    });
  };

  /** The names mentioned by the top-level statement being read. */
  let mentioned = new Set<string>();

  /** The scope a function's own name is declared in, and that name, if it has one. */
  const bindingOf = (node: Node, ancestors: Node[], binding: number): { scope: number; name: string } | null => {
    if (node.type === "FunctionDeclaration") {
      const name = (node.id as Node | null)?.name as string | undefined;
      if (name) {
        return { scope: binding, name };
      }
      // `export default function () {}`
      return ancestors[ancestors.length - 1]?.type === "ExportDefaultDeclaration"
        ? { scope: binding, name: defaultExportName(file) }
        : null;
    }
    if (node.type !== "FunctionExpression" && node.type !== "ArrowFunctionExpression") {
      return null;
    }
    let holder = ancestors.length - 1;
    while (
      ancestors[holder]?.type === "CallExpression" &&
      COMPONENT_WRAPPERS.has((refOf(ancestors[holder].callee as Node) as { name?: string } | null)?.name ?? "")
    ) {
      holder--;
    }
    const parent = ancestors[holder];
    if (parent?.type === "VariableDeclarator" && (parent.id as Node).type === "Identifier") {
      return { scope: binding, name: (parent.id as Node).name as string };
    }
    if (parent?.type === "ExportDefaultDeclaration") {
      return { scope: binding, name: defaultExportName(file) };
    }
    return null;
  };

  /** Walks a subtree that belongs to `scope`, whose names are declared in `binding`. */
  const walk = (
    node: Node,
    ancestors: Node[],
    scope: FunctionFact,
    className: string | null,
    inLoopHead: boolean,
    binding: number
  ): void => {
    if (isTypeOnly(node)) {
      return;
    }

    const parent = ancestors[ancestors.length - 1];
    let nextScope = scope;
    let nextClass = className;
    let nextBinding = binding;

    if (isFunction(node)) {
      const named = nameFor(node, ancestors, className);
      let fact: FunctionFact | null = null;
      if (named) {
        const isGetterOrSetter = node.kind === "get" || node.kind === "set";
        fact = makeFact(node, named.name, named.kind, {
          params: paramsOf(node.params as Node[]),
          className,
          canWrap: !node.async && !node.generator && !isGetterOrSetter,
        });
        if (node.type === "ObjectMethod" || parent?.type === "ObjectProperty") {
          (facts.objectMethods[named.name] ??= []).push(fact.id);
        }
        if (className && named.kind === "constructor") {
          facts.classes[className].methods[named.kind as string] = fact.id;
        } else if (className && (node.type === "ClassMethod" || node.type === "ClassPrivateMethod")) {
          const key = propertyName(node.key as Node);
          if (key) {
            facts.classes[className].methods[key] = fact.id;
          }
        } else if (
          className &&
          (parent?.type === "ClassProperty" || parent?.type === "ClassPrivateProperty")
        ) {
          const key = propertyName(parent.key as Node);
          if (key) {
            facts.classes[className].methods[key] = fact.id;
          }
        }
        nextScope = fact;
      }

      // The function's own name, where it is declared, then a scope for what it declares.
      const declared = bindingOf(node, ancestors, binding);
      if (declared) {
        facts.scopes[declared.scope].names.add(declared.name);
        if (fact) {
          facts.scopes[declared.scope].functions[declared.name] = fact.id;
        }
      }
      nextBinding = newScope(binding, nextScope.id);
      const own = facts.scopes[nextBinding];
      for (const param of node.params as Node[]) {
        for (const name of patternNames(param)) {
          own.names.add(name);
        }
      }
      // A named function expression can call itself by its name.
      if (node.type === "FunctionExpression" && (node.id as Node | null)?.name && fact) {
        own.names.add((node.id as Node).name as string);
        own.functions[(node.id as Node).name as string] = fact.id;
      }
    }

    switch (node.type) {
      case "Identifier": {
        const isKey =
          !parent?.computed &&
          ((parent?.type === "MemberExpression" && parent.property === node) ||
            ((parent?.type === "ObjectProperty" || parent?.type === "ObjectMethod" || parent?.type === "ClassProperty" || parent?.type === "ClassMethod") &&
              parent.key === node));
        if (!isKey) {
          mentioned.add(node.name as string);
        }
        return;
      }
      case "ClassDeclaration":
      case "ClassExpression": {
        const declared = (node.id as Node | null)?.name as string | undefined;
        const fromVar =
          parent?.type === "VariableDeclarator" ? ((parent.id as Node).name as string | undefined) : undefined;
        const name = declared ?? fromVar ?? (parent?.type === "ExportDefaultDeclaration" ? defaultExportName(file) : null);
        if (name) {
          facts.classes[name] = {
            name,
            extends: refOf(node.superClass as Node | undefined),
            methods: Object.create(null),
          };
          nextClass = name;
          if (declared || fromVar) {
            facts.scopes[binding].names.add(name);
            facts.scopes[binding].classes.add(name);
          }
        }
        break;
      }
      case "VariableDeclarator":
        for (const name of patternNames(node.id as Node)) {
          facts.scopes[binding].names.add(name);
        }
        recordVar(node.id as Node, node.init as Node | undefined, scope);
        break;
      case "CatchClause":
        for (const name of patternNames(node.param as Node | null)) {
          facts.scopes[binding].names.add(name);
        }
        break;
      case "NewExpression": {
        const ref = refOf(node.callee as Node);
        if (ref) {
          scope.creates.push({ ref, start: node.start as number, end: node.end as number, scope: binding });
        }
        break;
      }
      case "CallExpression": {
        const ref = refOf(node.callee as Node);
        if (ref) {
          scope.calls.push({ ref, start: node.start as number, end: node.end as number, scope: binding });
        }
        break;
      }
      case "NumericLiteral": {
        const isKey =
          (parent?.type === "ObjectProperty" || parent?.type === "ClassProperty" || parent?.type === "ObjectMethod") &&
          parent.key === node &&
          !parent.computed;
        const isIndex = parent?.type === "MemberExpression" && parent.property === node;
        const isLoopStart = inLoopHead && ((node.value as number) === 0 || (node.value as number) === 1);
        if (!isKey && !isIndex && !isLoopStart) {
          addNumber(scope, node);
        }
        return;
      }
      case "UnaryExpression":
        if (node.operator === "-" && (node.argument as Node).type === "NumericLiteral") {
          addNumber(scope, node);
          return;
        }
        break;
      case "StringLiteral":
        if (COLOUR.test(node.value as string)) {
          addNumber(scope, node);
        }
        return;
    }

    ancestors.push(node);
    for (const key of Object.keys(node)) {
      if (SKIPPED_KEYS.has(key)) {
        continue;
      }
      const value = node[key];
      const loopHead = inLoopHead || (node.type === "ForStatement" && key === "init");
      // A function's name and its parameters' defaults belong to it, its body to its own scope.
      if (Array.isArray(value)) {
        for (const item of value) {
          if (item && typeof (item as Node).type === "string") {
            walk(item as Node, ancestors, nextScope, nextClass, loopHead, nextBinding);
          }
        }
      } else if (value && typeof (value as Node).type === "string") {
        walk(value as Node, ancestors, nextScope, nextClass, loopHead, nextBinding);
      }
    }
    ancestors.pop();
  };

  const moduleScope = newScope(null, "");

  for (const statement of program.body as Node[]) {
    switch (statement.type) {
      case "ImportDeclaration": {
        if (statement.importKind === "type") {
          break;
        }
        const source = (statement.source as Node).value as string;
        for (const specifier of statement.specifiers as Node[]) {
          const local = (specifier.local as Node).name as string;
          facts.imports[local] = {
            source,
            imported:
              specifier.type === "ImportNamespaceSpecifier"
                ? "*"
                : specifier.type === "ImportDefaultSpecifier"
                  ? "default"
                  : (((specifier.imported as Node).name ?? (specifier.imported as Node).value) as string),
          };
        }
        break;
      }
      case "ExportAllDeclaration":
        facts.exportAll.push((statement.source as Node).value as string);
        break;
      case "ExportNamedDeclaration": {
        const source = (statement.source as Node | null)?.value as string | undefined;
        for (const specifier of (statement.specifiers ?? []) as Node[]) {
          const exported = ((specifier.exported as Node).name ?? (specifier.exported as Node).value) as string;
          if (specifier.type === "ExportNamespaceSpecifier") {
            facts.exports[exported] = { source: source as string, imported: "*" };
          } else {
            const local = (specifier.local as Node).name as string;
            facts.exports[exported] = source ? { source, imported: local } : { local };
          }
        }
        const declaration = statement.declaration as Node | null;
        if (declaration?.type === "VariableDeclaration") {
          for (const declarator of declaration.declarations as Node[]) {
            const name = (declarator.id as Node).name as string | undefined;
            if (name) {
              facts.exports[name] = { local: name };
            }
          }
        } else if (declaration) {
          const name = (declaration.id as Node | null)?.name as string | undefined;
          if (name) {
            facts.exports[name] = { local: name };
          }
        }
        break;
      }
      case "ExportDefaultDeclaration": {
        const declaration = statement.declaration as Node;
        const name =
          declaration.type === "Identifier"
            ? (declaration.name as string)
            : (((declaration.id as Node | null)?.name as string | undefined) ?? defaultExportName(file));
        facts.exports.default = { local: name };
        break;
      }
    }

    if (statement.type !== "ImportDeclaration" && statement.type !== "ExportAllDeclaration") {
      mentioned = new Set();
      const fact = makeFact(statement, "(top level)", "statement", { declares: declaredBy(statement) });
      walk(statement, [], fact, null, false, moduleScope);
      fact.names = mentioned;
    }
  }

  for (const [name, id] of Object.entries(facts.scopes[moduleScope].functions)) {
    facts.byName[name] = [id];
  }

  return facts;
}

/** The innermost function or top-level statement holding a position. */
export function factAt(facts: ModuleFacts, position: number): FunctionFact | undefined {
  let best: FunctionFact | undefined;
  for (const fact of facts.functions) {
    if (fact.start <= position && position < fact.end && (!best || fact.start >= best.start)) {
      best = fact;
    }
  }
  return best;
}

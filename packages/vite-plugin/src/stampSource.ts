import path from "node:path";
import MagicString from "magic-string";
import type { SourceStamp, StampedProp } from "@click-to-source-3d/shared";
import { factAt, parseSource, type FunctionFact, type Node } from "./trace/facts.js";
import { describeFunction, instrument, type TraceNames } from "./trace/instrument.js";
import type { TracePlan } from "./trace/project.js";
import { constantsOf, valueDescriber } from "./trace/values.js";

/**
 * Host elements that carry no transform of their own and are never the answer
 * to "where did this come from". Geometries and materials do have userData, so
 * stamping them costs nothing but adds noise the panel would never show.
 */
const SKIPPED_SUFFIXES = ["Geometry", "Material"];

/**
 * Lowercase JSX means "host element", which in a React app covers DOM tags as
 * well as R3F intrinsics — the two are indistinguishable by case alone.
 * Stamping a <div> puts a userData attribute on a DOM node, which React warns
 * about and which means nothing.
 *
 * A denylist rather than an allowlist of three elements: the HTML and SVG tag
 * sets are fixed and knowable, while the R3F set is open-ended because
 * `extend()` lets an application register its own, as this project's own
 * <waterMaterial> does.
 */
const DOM_TAGS = new Set([
  "a", "abbr", "address", "area", "article", "aside", "audio", "b", "base",
  "bdi", "bdo", "big", "blockquote", "body", "br", "button", "canvas",
  "caption", "cite", "code", "col", "colgroup", "data", "datalist", "dd",
  "del", "details", "dfn", "dialog", "div", "dl", "dt", "em", "embed",
  "fieldset", "figcaption", "figure", "footer", "form", "h1", "h2", "h3",
  "h4", "h5", "h6", "head", "header", "hgroup", "hr", "html", "i", "iframe",
  "img", "input", "ins", "kbd", "label", "legend", "li", "link", "main",
  "map", "mark", "menu", "meta", "meter", "nav", "noscript", "object", "ol",
  "optgroup", "option", "output", "p", "param", "picture", "pre", "progress",
  "q", "rp", "rt", "ruby", "s", "samp", "script", "section", "select",
  "slot", "small", "source", "span", "strong", "style", "sub", "summary",
  "sup", "table", "tbody", "td", "template", "textarea", "tfoot", "th",
  "thead", "time", "title", "tr", "track", "u", "ul", "var", "video", "wbr",
  // SVG, which React also treats as host elements
  "circle", "clipPath", "defs", "ellipse", "foreignObject", "g", "image",
  "line", "linearGradient", "marker", "mask", "path", "pattern", "polygon",
  "polyline", "radialGradient", "rect", "stop", "svg", "text", "tspan",
]);

export type StampOptions = {
  /** Absolute path the emitted `file` values are made relative to. */
  root: string;
  /**
   * Also record where objects made by plain three.js code come from, for a module
   * the dev server is about to send to the browser. Without it, only JSX is
   * stamped, which is all a production build can ever want.
   */
  trace?: {
    program: Node;
    plan: TracePlan;
    /** The module the recording functions are imported from. */
    client: string;
  };
};

/**
 * Props that are never values a developer tunes: React's own, R3F's wiring,
 * the stamp's own target, and the object handed to a <primitive>.
 */
const SKIPPED_PROPS = new Set([
  "key",
  "ref",
  "children",
  "userData",
  "attach",
  "dispose",
  "object",
  "geometry",
  "material",
]);

function isGeometryOrMaterial(name: string): boolean {
  return SKIPPED_SUFFIXES.some((suffix) => name.endsWith(suffix));
}

/**
 * Calls that wrap a component without renaming it. The function inside
 * `const Tree = memo(() => <mesh />)` is `Tree` for every purpose a developer
 * cares about, but its parent is the call, not the declaration.
 */
const COMPONENT_WRAPPERS = new Set(["memo", "forwardRef"]);

/**
 * Any lowercase JSX name, before any other name has been ruled out.
 *
 * Cheaper than a parse, and most modules in an application have none: hooks,
 * stores, utilities, and components that only compose other components. A
 * member expression counts when its last part is lowercase, so
 * `<animated.mesh>` is found.
 */
const MAY_CONTAIN_HOST_ELEMENT = /<[a-z]|<[\w$]+(?:\.[\w$]+)*\.[a-z]/;

function isHostElement(name: string): boolean {
  // R3F intrinsics are lowercase; uppercase names are React components, whose
  // own JSX is stamped where it is declared rather than where it is used.
  return name.length > 0 && name[0] === name[0].toLowerCase();
}

/**
 * The name that decides whether an element is a host element.
 *
 * A plain `<mesh>` is its own name. For `<animated.mesh>` or `<motion.mesh>`
 * it is the last part: react-spring and framer-motion wrap an R3F intrinsic
 * and render it, and the wrapper's own name says nothing about what it draws.
 * `<motion.div>` resolves to `div` and is excluded as DOM, the same as a bare
 * `<div>`.
 */
function hostName(name: Node | undefined): string | null {
  if (name?.type === "JSXIdentifier") {
    return (name.name as string) || null;
  }

  if (name?.type === "JSXMemberExpression") {
    const property = name.property as { name?: string } | undefined;
    return property?.name ?? null;
  }

  return null;
}

function isComponentWrapper(call: Node): boolean {
  const callee = call.callee as Node | undefined;

  if (callee?.type === "Identifier") {
    return COMPONENT_WRAPPERS.has(callee.name as string);
  }

  // React.memo, React.forwardRef
  if (callee?.type === "MemberExpression" && !callee.computed) {
    const property = callee.property as { name?: string } | undefined;
    return COMPONENT_WRAPPERS.has(property?.name ?? "");
  }

  return false;
}

/**
 * What an anonymous default export is called by convention: its file's name,
 * or its folder's for an index file, since `Trees/index.tsx` is imported as
 * `Trees`.
 */
function defaultExportName(file: string): string {
  const parts = file.split("/");
  const base = (parts.pop() ?? "").replace(/\.[^.]+$/, "");
  const name = base === "index" && parts.length > 0 ? parts.pop()! : base;

  return `${name} (default export)`;
}

function isStampable(name: string): boolean {
  if (!isHostElement(name)) {
    return false;
  }

  if (DOM_TAGS.has(name)) {
    return false;
  }

  return !SKIPPED_SUFFIXES.some((suffix) => name.endsWith(suffix));
}

/**
 * Name of the nearest enclosing function, walking outward.
 *
 * Handles the shapes a component is written in: a function declaration, an
 * arrow assigned to a const, an object method, a default export, and any of
 * those wrapped in `memo` or `forwardRef`. A function with no name of its own
 * — a `.map` callback, say — is skipped in favour of the one around it.
 */
function enclosingFunctionName(ancestors: Node[], file: string): string {
  for (let i = ancestors.length - 1; i >= 0; i--) {
    const node = ancestors[i];

    if (
      node.type === "FunctionDeclaration" ||
      node.type === "FunctionExpression" ||
      node.type === "ArrowFunctionExpression" ||
      node.type === "ObjectMethod" ||
      node.type === "ClassMethod"
    ) {
      const id = node.id as { name?: string } | undefined;
      if (id?.name) {
        return id.name;
      }

      const key = node.key as { name?: string } | undefined;
      if (key?.name) {
        return key.name;
      }

      // Step out through wrappers: memo(forwardRef((props, ref) => ...)).
      let holder = i - 1;
      while (
        ancestors[holder]?.type === "CallExpression" &&
        isComponentWrapper(ancestors[holder])
      ) {
        holder--;
      }

      const parent = ancestors[holder];
      if (parent?.type === "VariableDeclarator") {
        const declId = parent.id as { name?: string } | undefined;
        if (declId?.name) {
          return declId.name;
        }
      }
      if (parent?.type === "ObjectProperty") {
        const propKey = parent.key as { name?: string } | undefined;
        if (propKey?.name) {
          return propKey.name;
        }
      }
      if (parent?.type === "ExportDefaultDeclaration") {
        return defaultExportName(file);
      }
    }
  }

  return "unknown";
}

/**
 * Path as it should appear in `sourceRef.file`: relative to the project root
 * with forward slashes, never an absolute filesystem path.
 *
 * This is not cosmetic. Absolute paths carry the developer's directory
 * structure, and a stamp that reaches a production bundle would publish it to
 * every visitor. Normalising here means the opt-in production mode cannot leak
 * it even by accident.
 */
export function relativeFile(root: string, filename: string): string {
  const relative = path.relative(root, filename);

  return relative.split(path.sep).join("/");
}

/** A name that means nothing else in this file. */
function freeName(code: string, base: string): string {
  let name = base;
  while (code.includes(name)) {
    name += "_";
  }
  return name;
}

/**
 * Stamps every stampable host element with its own source location, merged
 * into whatever `userData` the author already wrote.
 *
 * Returns null when the file contains nothing to stamp, so the caller can skip
 * emitting a sourcemap for an unchanged file.
 */
export function stampSource(
  code: string,
  filename: string,
  options: StampOptions
): { code: string; map: ReturnType<MagicString["generateMap"]> } | null {
  const { trace } = options;

  // Measured at ~8ms to parse a 400-line .tsx that turned out to have nothing
  // to stamp — paid on every dev-server transform of every such module.
  const mayHaveElements = MAY_CONTAIN_HOST_ELEMENT.test(code);
  if (!mayHaveElements && !trace) {
    return null;
  }

  // A file this can't read isn't this plugin's to complain about: whatever
  // compiles it next says what is wrong, and says it better.
  const program = trace?.program ?? parseSource(code, filename);
  if (!program) {
    return null;
  }

  const magic = new MagicString(code);
  const file = relativeFile(options.root, filename);
  const describeValue = valueDescriber(code, constantsOf(program));
  const stamps: SourceStamp[] = [];

  // Every stamp in the module lives in one table, declared once, and an
  // element refers to its entry. Inlining each stamp as an object literal
  // would allocate it on every render, and now that a stamp carries its
  // element's props, would repeat them through the JSX as well. The name is
  // lengthened until it collides with nothing in the file.
  //
  // Plain code can run before the module's body does, when a circular import
  // calls one of its functions, so there the tables are built on first use by
  // a hoisted function rather than held in a const that isn't initialised yet.
  const data = trace ? freeName(code, "__ctsData") : "";
  const table = trace ? `${data}().s` : freeName(code, "__ctsStamps");

  /** Each stamp's function, as an index into the table of functions. */
  const generators = new Map<number, number>();
  const functions: Array<{ fact: FunctionFact; holder: string | null }> = [];
  const functionKeys = new Map<string, number>();
  /** Literals shown as an object's values, which needn't be listed again as numbers. */
  const shown = new Set<string>();

  const functionIndex = (fact: FunctionFact, holder: string | null): number => {
    const key = fact.kind === "statement" ? `${fact.id}|${holder ?? ""}` : fact.id;
    let index = functionKeys.get(key);
    if (index === undefined) {
      index = functions.length;
      functions.push({ fact, holder });
      functionKeys.set(key, index);
    }
    return index;
  };

  const addStamp = (stamp: SourceStamp, fact: FunctionFact | undefined, holder: string | null): number => {
    stamps.push(stamp);
    for (const prop of stamp.props ?? []) {
      for (const value of prop.values) {
        if (value.editable && value.line !== undefined) {
          shown.add(`${value.line}:${value.column}`);
        }
      }
    }
    if (fact) {
      generators.set(stamps.length - 1, functionIndex(fact, holder));
    }
    return stamps.length - 1;
  };

  const ancestors: Node[] = [];

  /** The props written on one opening element, as the panel lists them. */
  const propsOf = (opening: Node, element: string): StampedProp[] => {
    const props: StampedProp[] = [];

    for (const attribute of (opening.attributes ?? []) as Node[]) {
      const nameNode = attribute.name as Node | undefined;
      if (attribute.type !== "JSXAttribute" || nameNode?.type !== "JSXIdentifier") {
        continue;
      }
      const name = nameNode.name as string;
      if (SKIPPED_PROPS.has(name) || /^on[A-Z]/.test(name)) {
        continue;
      }

      const value = attribute.value as Node | null;

      if (value === null) {
        // `<mesh castShadow />`: true, but there is no literal to rewrite.
        props.push({ element, name, array: false, values: [{ raw: "true", value: true, editable: false }] });
        continue;
      }
      if (value.type === "StringLiteral") {
        props.push({ element, name, array: false, values: [describeValue(value)] });
        continue;
      }
      if (value.type !== "JSXExpressionContainer") {
        continue;
      }

      const expression = value.expression as Node;
      if (expression.type === "JSXEmptyExpression") {
        continue;
      }
      if (expression.type === "ArrayExpression") {
        props.push({
          element,
          name,
          array: true,
          values: (expression.elements as Array<Node | null>).map(describeValue),
        });
        continue;
      }
      props.push({ element, name, array: false, values: [describeValue(expression)] });
    }

    return props;
  };

  const visit = (node: Node | null | undefined): void => {
    if (!node || typeof node.type !== "string") {
      return;
    }

    if (node.type === "JSXElement") {
      stampElement(node.openingElement as Node, node);
    }

    ancestors.push(node);

    for (const key of Object.keys(node)) {
      if (key === "loc" || key === "leadingComments" || key === "trailingComments") {
        continue;
      }

      const value = node[key];

      if (Array.isArray(value)) {
        for (const item of value) {
          visit(item as Node);
        }
      } else if (value && typeof value === "object") {
        visit(value as Node);
      }
    }

    ancestors.pop();
  };

  const stampElement = (element: Node, jsx: Node): boolean => {
    const name = hostName(element.name as Node | undefined);

    if (!name || !isStampable(name)) {
      return false;
    }

    const start = element.loc?.start;
    if (start === undefined) {
      return false;
    }

    // The element's own props, then those of the geometry and material
    // written directly inside it: `<boxGeometry args={[1, 2, 1]} />` is never
    // stamped itself, but its args are what a developer reaches for when they
    // click the mesh.
    const props = propsOf(element, name);
    for (const child of (jsx.children ?? []) as Node[]) {
      if (child.type !== "JSXElement") {
        continue;
      }
      const childOpening = child.openingElement as Node;
      const childName = hostName(childOpening.name as Node | undefined);
      if (childName && isHostElement(childName) && isGeometryOrMaterial(childName)) {
        props.push(...propsOf(childOpening, childName));
      }
    }

    const entry: SourceStamp = {
      file,
      function: enclosingFunctionName(ancestors, file),
      line: start.line,
      column: start.column + 1,
    };
    if (props.length > 0) {
      entry.props = props;
    }
    const fact = trace ? factAt(trace.plan.facts, element.start as number) : undefined;
    const stamp = `${table}[${addStamp(entry, fact, null)}]`;

    // With no explicit userData the stamp is a pierced prop, which R3F
    // resolves as `object.userData.__ctsSource = stamp`, adding one key to
    // whatever userData the object already has.
    //
    // It used to be `userData={{ __ctsSource }}`, which R3F applies by
    // replacing userData outright. On an object R3F creates that replaces an
    // empty object and nothing is lost; on `<primitive object={gltf.scene} />`
    // it discarded the model's own userData — the extras a glTF carries from
    // Blender — in dev only, so an app reading them behaved differently in dev
    // and production.
    //
    // An explicit userData attribute keeps the merge below instead. Piercing
    // after it throws inside R3F when the author's value is null, a string, or
    // frozen; the merge builds a fresh object and handles all three.
    const pierced = `userData-__ctsSource={${stamp}}`;

    const attributes = (element.attributes ?? []) as Node[];
    const existing = attributes.find(
      (attribute) =>
        attribute.type === "JSXAttribute" &&
        (attribute.name as { name?: string } | undefined)?.name === "userData"
    );

    if (!existing) {
      const firstSpread = attributes.find(
        (attribute) => attribute.type === "JSXSpreadAttribute"
      );

      if (firstSpread) {
        // Ahead of the spread, not after it.
        //
        // A spread can carry userData, and appending after it made the stamp
        // win — silently destroying a hand-written sourceRef, which is the
        // documented escape hatch for anything the transform gets wrong.
        // Whether a given spread carries userData is a runtime value and
        // cannot be read here, so the fix is positional: emitted first, the
        // stamp is overwritten by a spread that has userData and survives one
        // that does not. That is the same precedence the resolver applies
        // everywhere else — manual outranks stamped — and it costs no
        // re-evaluation of the spread expression.
        //
        // The trade is real: an element whose spread carries userData loses
        // its stamp and resolves through the parent walk instead. Piercing
        // after the spread would keep both, but throws inside R3F when the
        // spread's userData is null or frozen, and re-evaluating the spread to
        // merge it is wrong for `{...getProps()}`.
        magic.appendLeft(firstSpread.start as number, `${pierced} `);
        return true;
      }

      // Insert before the closing bracket of the opening element. A
      // self-closing tag already has a space before its slash, so only add one
      // when the preceding character is not whitespace.
      const insertAt = (element.end as number) - (element.selfClosing ? 2 : 1);
      const needsSpace = !/\s/.test(code[insertAt - 1] ?? "");
      magic.appendLeft(
        insertAt,
        `${needsSpace ? " " : ""}${pierced}${element.selfClosing ? " " : ""}`
      );
      return true;
    }

    const value = existing.value as Node | null | undefined;

    if (!value || value.type !== "JSXExpressionContainer") {
      // userData="literal" is not a shape we can merge into; leave it alone
      // rather than guessing.
      generators.delete(stamps.length - 1);
      stamps.pop();
      return false;
    }

    const expression = value.expression as Node;

    // Spread the author's value first so their keys survive, then add ours.
    magic.appendLeft(expression.start as number, "{ ...");
    magic.appendRight(expression.end as number, `, __ctsSource: ${stamp} }`);
    return true;
  };

  if (mayHaveElements) {
    visit(program);
  }

  // On the first line, so no line of the module moves and a stack trace or a
  // stamped line reads the same with or without a sourcemap. After any
  // directive prologue, which has to stay first to mean anything.
  const directives = (program.directives ?? []) as Node[];
  const tableAt = directives.length > 0 ? (directives[directives.length - 1].end as number) : 0;
  const lead = tableAt === 0 ? "" : code[tableAt - 1] === ";" ? " " : "; ";

  if (trace) {
    const names: TraceNames = {
      stamps: table,
      functions: `${data}().f`,
      calls: `${data}().c`,
      cNew: freeName(code, "__ctsNew"),
      cEnter: freeName(code, "__ctsEnter"),
      cLeave: freeName(code, "__ctsLeave"),
      cCall: freeName(code, "__ctsCall"),
      cSite: freeName(code, "__ctsSite"),
      cVia: freeName(code, "__ctsVia"),
      cOnLoad: freeName(code, "__ctsOnLoad"),
      cLoadAsync: freeName(code, "__ctsLoadAsync"),
    };
    const { calls } = instrument(program, {
      code,
      magic,
      file,
      plan: trace.plan,
      names,
      describeValue,
      addStamp,
      functionIndex,
    });

    if (!magic.hasChanged()) {
      return null;
    }

    const functionTable = functions
      .map(({ fact, holder }) => JSON.stringify(describeFunction(fact, holder, trace.plan, shown)))
      .join(",");
    const stampTable = stamps
      .map((stamp, index) => {
        const generator = generators.get(index);
        const json = JSON.stringify(stamp);
        return generator === undefined ? json : `${json.slice(0, -1)},"generator":f[${generator}]}`;
      })
      .join(",");

    magic.appendLeft(
      tableAt,
      `${lead}import { ctsNew as ${names.cNew}, ctsEnter as ${names.cEnter}, ctsLeave as ${names.cLeave}, ctsCall as ${names.cCall}, ctsSite as ${names.cSite}, ctsVia as ${names.cVia}, ctsOnLoad as ${names.cOnLoad}, ctsLoadAsync as ${names.cLoadAsync} } from ${JSON.stringify(trace.client)}; ` +
        `function ${data}(){if(!${data}.v){var f=[${functionTable}];${data}.v={f:f,c:${JSON.stringify(calls)},s:[${stampTable}]}}return ${data}.v}${tableAt > 0 ? "" : " "}`
    );
  } else {
    if (stamps.length === 0) {
      return null;
    }
    magic.appendLeft(
      tableAt,
      `${lead}const ${table} = ${JSON.stringify(stamps)};${tableAt > 0 ? "" : " "}`
    );
  }

  return {
    code: magic.toString(),
    // Mappings at word boundaries rather than at every character: far smaller,
    // and the resolution stack traces and breakpoints actually use.
    map: magic.generateMap({ source: filename, hires: "boundary" }),
  };
}

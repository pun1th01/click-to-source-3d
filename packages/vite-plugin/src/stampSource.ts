import path from "node:path";
import { parse } from "@babel/parser";
import MagicString from "magic-string";

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
};

type Node = {
  type: string;
  start?: number | null;
  end?: number | null;
  loc?: { start: { line: number } } | null;
  [key: string]: unknown;
};

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
function relativeFile(root: string, filename: string): string {
  const relative = path.relative(root, filename);

  return relative.split(path.sep).join("/");
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
  // Measured at ~8ms to parse a 400-line .tsx that turned out to have nothing
  // to stamp — paid on every dev-server transform of every such module.
  if (!MAY_CONTAIN_HOST_ELEMENT.test(code)) {
    return null;
  }

  const ast = parse(code, {
    sourceType: "module",
    errorRecovery: true,
    plugins: ["jsx", "typescript"],
  });

  const magic = new MagicString(code);
  const file = relativeFile(options.root, filename);
  let stamped = 0;

  const ancestors: Node[] = [];

  const visit = (node: Node | null | undefined): void => {
    if (!node || typeof node.type !== "string") {
      return;
    }

    if (node.type === "JSXOpeningElement") {
      stamped += stampElement(node) ? 1 : 0;
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

  const stampElement = (element: Node): boolean => {
    const name = hostName(element.name as Node | undefined);

    if (!name || !isStampable(name)) {
      return false;
    }

    const line = element.loc?.start.line;
    if (line === undefined) {
      return false;
    }

    const stamp =
      `{ file: ${JSON.stringify(file)}, ` +
      `function: ${JSON.stringify(enclosingFunctionName(ancestors, file))}, ` +
      `line: ${line} }`;

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
      return false;
    }

    const expression = value.expression as Node;
    const start = expression.start as number;
    const end = expression.end as number;

    // Spread the author's value first so their keys survive, then add ours.
    magic.appendLeft(start, "{ ...");
    magic.appendRight(end, `, __ctsSource: ${stamp} }`);
    return true;
  };

  visit(ast.program as unknown as Node);

  if (stamped === 0) {
    return null;
  }

  return {
    code: magic.toString(),
    // Mappings at word boundaries rather than at every character: far smaller,
    // and the resolution stack traces and breakpoints actually use.
    map: magic.generateMap({ source: filename, hires: "boundary" }),
  };
}

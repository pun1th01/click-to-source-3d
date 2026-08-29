import path from "node:path";
import { parse } from "@babel/parser";
import MagicString from "magic-string";

/**
 * Host elements that carry no transform of their own and are never the answer
 * to "where did this come from". Geometries and materials do have userData, so
 * stamping them costs nothing but adds noise the panel would never show.
 */
const SKIPPED_SUFFIXES = ["Geometry", "Material"];

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

function isHostElement(name: string): boolean {
  // R3F intrinsics are lowercase; uppercase names are React components, whose
  // own JSX is stamped where it is declared rather than where it is used.
  return name.length > 0 && name[0] === name[0].toLowerCase();
}

function isStampable(name: string): boolean {
  if (!isHostElement(name)) {
    return false;
  }

  return !SKIPPED_SUFFIXES.some((suffix) => name.endsWith(suffix));
}

/**
 * Name of the nearest enclosing function, walking outward.
 *
 * Handles the four shapes a component is written in: a function declaration, an
 * arrow assigned to a const, an object method, and a default export.
 */
function enclosingFunctionName(ancestors: Node[]): string {
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

      const parent = ancestors[i - 1];
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
    const name = element.name as { type: string; name?: string } | undefined;

    if (!name || name.type !== "JSXIdentifier" || !name.name) {
      return false;
    }
    if (!isStampable(name.name)) {
      return false;
    }

    const line = element.loc?.start.line;
    if (line === undefined) {
      return false;
    }

    const stamp =
      `{ file: ${JSON.stringify(file)}, ` +
      `function: ${JSON.stringify(enclosingFunctionName(ancestors))}, ` +
      `line: ${line} }`;

    const attributes = (element.attributes ?? []) as Node[];
    const existing = attributes.find(
      (attribute) =>
        attribute.type === "JSXAttribute" &&
        (attribute.name as { name?: string } | undefined)?.name === "userData"
    );

    if (!existing) {
      // Insert before the closing bracket of the opening element.
      const insertAt = (element.end as number) - (element.selfClosing ? 2 : 1);
      magic.appendLeft(insertAt, ` userData={{ __ctsSource: ${stamp} }}`);
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
    map: magic.generateMap({ source: filename, hires: true }),
  };
}

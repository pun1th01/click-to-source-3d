import { parse } from "@babel/parser";
import MagicString from "magic-string";

export const PLUGIN_PACKAGE = "@click-to-source-3d/vite-plugin";

export const MANUAL_SNIPPET = [
  `import { clickToSource } from "${PLUGIN_PACKAGE}";`,
  "",
  "// first in the plugins array:",
  "plugins: [clickToSource()],",
].join("\n");

/** A config for a project that has none. */
export const NEW_CONFIG = `import { defineConfig } from "vite";
import { clickToSource } from "${PLUGIN_PACKAGE}";

export default defineConfig({
  plugins: [clickToSource()],
});
`;

export type PatchResult =
  | { status: "patched"; code: string }
  | { status: "already" }
  | { status: "unsupported"; reason: string };

type Node = {
  type: string;
  start?: number | null;
  end?: number | null;
  [key: string]: unknown;
};

function keyName(property: Node): string | null {
  const key = property.key as Node | undefined;
  if (!key || property.computed) {
    return null;
  }
  if (key.type === "Identifier") {
    return key.name as string;
  }
  if (key.type === "StringLiteral") {
    return key.value as string;
  }
  return null;
}

/** Every `return` of a function, leaving out those of functions inside it. */
function returnsOf(node: unknown, found: Node[] = []): Node[] {
  if (Array.isArray(node)) {
    node.forEach((item) => returnsOf(item, found));
  } else if (node && typeof (node as Node).type === "string") {
    const current = node as Node;
    if (current.type === "ReturnStatement") {
      found.push(current);
    } else if (!/Function|ObjectMethod|ClassMethod/.test(current.type)) {
      for (const [key, value] of Object.entries(current)) {
        if (key !== "loc" && typeof value === "object") {
          returnsOf(value, found);
        }
      }
    }
  }
  return found;
}

/**
 * The one object a config is written as, wherever it is. Null when there isn't
 * just one: a function that can return several is different in each case, and a
 * call to anything but defineConfig may do anything with what it is given.
 */
function configObject(node: Node | undefined): Node | null {
  if (!node) {
    return null;
  }
  switch (node.type) {
    case "ObjectExpression":
      return node;
    case "CallExpression": {
      const callee = node.callee as Node;
      return callee.type === "Identifier" && callee.name === "defineConfig"
        ? configObject((node.arguments as Node[])[0])
        : null;
    }
    case "ArrowFunctionExpression":
    case "FunctionExpression":
    case "FunctionDeclaration": {
      const body = node.body as Node;
      if (body.type !== "BlockStatement") {
        return configObject(body);
      }
      const returns = returnsOf(body.body);
      return returns.length === 1 ? configObject(returns[0].argument as Node | undefined) : null;
    }
    case "TSAsExpression":
    case "TSSatisfiesExpression":
    case "ParenthesizedExpression":
      return configObject(node.expression as Node);
    default:
      return null;
  }
}

function addImport(magic: MagicString, body: Node[], statement: string): void {
  // After the last one already there, or first.
  const imports = body.filter((entry) => entry.type === "ImportDeclaration");
  if (imports.length > 0) {
    magic.appendLeft(imports[imports.length - 1].end as number, `\n${statement}`);
  } else {
    magic.prepend(`${statement}\n`);
  }
}

function parsesAfter(patched: string): boolean {
  try {
    parse(patched, { sourceType: "module", plugins: ["typescript", "jsx"] });
    return true;
  } catch {
    return false;
  }
}

/** `module.exports = ...`, in a config that isn't an ES module. */
function patchCommonJs(code: string, body: Node[]): PatchResult | null {
  for (const statement of body) {
    const expression = statement.expression as Node | undefined;
    const left = expression?.left as Node | undefined;
    if (
      statement.type === "ExpressionStatement" &&
      expression?.type === "AssignmentExpression" &&
      left?.type === "MemberExpression" &&
      (left.object as Node).name === "module" &&
      (left.property as Node).name === "exports"
    ) {
      const magic = new MagicString(code);
      const right = expression.right as Node;
      magic.appendLeft(right.start as number, "withClickToSource(");
      magic.appendRight(right.end as number, ")");
      magic.prepend(`const { withClickToSource } = require("${PLUGIN_PACKAGE}");\n`);
      const patched = magic.toString();
      return parsesAfter(patched) ? { status: "patched", code: patched } : null;
    }
  }
  return null;
}

/**
 * Adds `clickToSource()` to the front of a Vite config's plugins.
 *
 * Edits only what it must — one import, one call — so the developer's own
 * formatting survives untouched. Where a config is one object, the plugin goes in
 * its `plugins`. Where it isn't, because a function returns different ones, or it
 * is built by a call or spread from elsewhere, the whole thing is wrapped:
 *
 *   export default withClickToSource(whatever it was)
 *
 * which works for anything Vite accepts, so a config with an `export default` is
 * never something to edit by hand. Only one that exports nothing, or can't be
 * read, is reported as unsupported.
 *
 * The result is checked, not assumed: a library that reported success here
 * while adding only the import is why this exists.
 */
export function patchViteConfig(code: string): PatchResult {
  if (code.includes(PLUGIN_PACKAGE)) {
    return { status: "already" };
  }

  let ast: Node;
  try {
    ast = parse(code, {
      sourceType: "module",
      plugins: ["typescript", "jsx"],
    }).program as unknown as Node;
  } catch (error) {
    return { status: "unsupported", reason: `could not parse it (${(error as Error).message})` };
  }

  const body = ast.body as Node[];
  const exported = body.find((statement) => statement.type === "ExportDefaultDeclaration");
  if (!exported) {
    return (
      patchCommonJs(code, body) ?? { status: "unsupported", reason: "it has no `export default`" }
    );
  }

  let declaration = exported.declaration as Node;

  // `const config = defineConfig({...}); export default config`
  if (declaration.type === "Identifier") {
    for (const statement of body) {
      if (statement.type !== "VariableDeclaration") {
        continue;
      }
      for (const declarator of statement.declarations as Node[]) {
        const id = declarator.id as Node;
        if (id.type === "Identifier" && id.name === declaration.name && declarator.init) {
          declaration = declarator.init as Node;
        }
      }
    }
  }

  const patched = addToObject(code, body, configObject(declaration)) ?? wrapExport(code, body, exported);
  return patched ?? { status: "unsupported", reason: "the edit did not produce valid code" };
}

/** Puts the plugin in the config's `plugins`, if that is certain to mean what it says. */
function addToObject(code: string, body: Node[], config: Node | null): PatchResult | null {
  if (!config) {
    return null;
  }
  const properties = config.properties as Node[];
  // A spread can carry `plugins` of its own, which would replace these or be replaced.
  if (properties.some((property) => property.type !== "ObjectProperty" && property.type !== "ObjectMethod")) {
    return null;
  }

  const magic = new MagicString(code);
  const plugins = properties.find(
    (property) => property.type === "ObjectProperty" && keyName(property) === "plugins"
  );

  if (plugins) {
    const value = plugins.value as Node;
    if (value.type === "ArrayExpression") {
      const elements = value.elements as Array<Node | null>;
      magic.appendLeft(
        (value.start as number) + 1,
        elements.length > 0 ? "clickToSource(), " : "clickToSource()"
      );
    } else if (plugins.shorthand) {
      // Vite flattens nested arrays and waits for promises in them.
      magic.overwrite(plugins.start as number, plugins.end as number, "plugins: [clickToSource(), plugins]");
    } else {
      magic.appendLeft(value.start as number, "[clickToSource(), ");
      magic.appendRight(value.end as number, "]");
    }
  } else {
    magic.appendLeft((config.start as number) + 1, "\n  plugins: [clickToSource()],");
  }

  addImport(magic, body, `import { clickToSource } from "${PLUGIN_PACKAGE}";`);

  const patched = magic.toString();
  // The guarantee: the plugin is called inside the config's plugins.
  if (!parsesAfter(patched) || !/plugins\s*:\s*\[\s*clickToSource\(\)/.test(patched)) {
    return null;
  }
  return { status: "patched", code: patched };
}

/** Wraps whatever is exported, for a config that isn't one object. */
function wrapExport(code: string, body: Node[], exported: Node): PatchResult | null {
  const declaration = exported.declaration as Node;
  const magic = new MagicString(code);

  magic.appendLeft(declaration.start as number, "withClickToSource(");
  magic.appendRight(declaration.end as number, ")");
  addImport(magic, body, `import { withClickToSource } from "${PLUGIN_PACKAGE}";`);

  const patched = magic.toString();
  return parsesAfter(patched) ? { status: "patched", code: patched } : null;
}

export const VITE_CONFIG_NAMES = [
  "vite.config.ts",
  "vite.config.mts",
  "vite.config.js",
  "vite.config.mjs",
  "vite.config.cts",
  "vite.config.cjs",
];

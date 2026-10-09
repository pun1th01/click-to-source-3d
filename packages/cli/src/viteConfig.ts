import { parse } from "@babel/parser";
import MagicString from "magic-string";

export const PLUGIN_PACKAGE = "@click-to-source-3d/vite-plugin";

export const MANUAL_SNIPPET = [
  `import { clickToSource } from "${PLUGIN_PACKAGE}";`,
  "",
  "// first in the plugins array:",
  "plugins: [clickToSource(), react()],",
].join("\n");

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

/** The object a call such as defineConfig(...) is configured with, wherever it is written. */
function configObject(node: Node | undefined): Node | null {
  if (!node) {
    return null;
  }
  switch (node.type) {
    case "ObjectExpression":
      return node;
    case "CallExpression":
      // defineConfig({...}) and defineConfig(() => ...)
      return configObject((node.arguments as Node[])[0]);
    case "ArrowFunctionExpression":
    case "FunctionExpression": {
      const body = node.body as Node;
      if (body.type !== "BlockStatement") {
        return configObject(body);
      }
      const ret = (body.body as Node[]).find((statement) => statement.type === "ReturnStatement");
      return configObject(ret?.argument as Node | undefined);
    }
    case "TSAsExpression":
    case "TSSatisfiesExpression":
    case "ParenthesizedExpression":
      return configObject(node.expression as Node);
    default:
      return null;
  }
}

/**
 * Adds `clickToSource()` to the front of a Vite config's plugins.
 *
 * Edits only what it must — one import, one call — so the developer's own
 * formatting survives untouched. Finds the config in the shapes Vite's own
 * templates and docs use: `export default defineConfig({...})`, a plain
 * object, a function returning one (arrow or with a body), and a config held
 * in a variable and exported. Anything else is reported as unsupported
 * rather than guessed at, and the caller prints the lines to paste.
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
    return { status: "unsupported", reason: "it has no `export default`" };
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

  const config = configObject(declaration);
  if (!config) {
    return { status: "unsupported", reason: "its exported config is not an object Vite's templates write" };
  }

  const magic = new MagicString(code);
  const properties = config.properties as Node[];
  const plugins = properties.find(
    (property) => property.type === "ObjectProperty" && keyName(property) === "plugins"
  );

  if (plugins) {
    const value = plugins.value as Node;
    if (value.type !== "ArrayExpression") {
      return { status: "unsupported", reason: "its `plugins` is not an array literal" };
    }
    const elements = value.elements as Array<Node | null>;
    magic.appendLeft(
      (value.start as number) + 1,
      elements.length > 0 ? "clickToSource(), " : "clickToSource()"
    );
  } else {
    magic.appendLeft((config.start as number) + 1, "\n  plugins: [clickToSource()],");
  }

  // The import goes after the last one already there, or first.
  const imports = body.filter((statement) => statement.type === "ImportDeclaration");
  const statement = `import { clickToSource } from "${PLUGIN_PACKAGE}";`;
  if (imports.length > 0) {
    magic.appendLeft(imports[imports.length - 1].end as number, `\n${statement}`);
  } else {
    magic.prepend(`${statement}\n`);
  }

  const patched = magic.toString();

  // The guarantee: the plugin is called inside the config's plugins.
  try {
    parse(patched, { sourceType: "module", plugins: ["typescript", "jsx"] });
  } catch {
    return { status: "unsupported", reason: "the edit did not produce valid code" };
  }
  if (!/plugins\s*:\s*\[\s*clickToSource\(\)/.test(patched)) {
    return { status: "unsupported", reason: "the plugin could not be placed in `plugins`" };
  }

  return { status: "patched", code: patched };
}

export const VITE_CONFIG_NAMES = [
  "vite.config.ts",
  "vite.config.mts",
  "vite.config.js",
  "vite.config.mjs",
  "vite.config.cts",
  "vite.config.cjs",
];

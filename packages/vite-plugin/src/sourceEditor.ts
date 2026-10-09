import { parse } from "@babel/parser";
import MagicString from "magic-string";
import type { EditRequest, SourceEditErrorCode } from "@click-to-source-3d/shared";

export class SourceEditError extends Error {
  readonly code: SourceEditErrorCode;

  constructor(code: SourceEditErrorCode, message: string) {
    super(message);
    this.name = "SourceEditError";
    this.code = code;
  }
}

type SourcePosition = {
  line: number;
};

type BabelNode = {
  type: string;
  start?: number | null;
  end?: number | null;
  loc?: {
    start: SourcePosition;
  } | null;
  [key: string]: unknown;
};

type EditCandidate = {
  argName: string;
  valueNode: BabelNode;
  locationLines: number[];
  syntax: "jsx-string" | "expression";
};

const NON_NODE_KEYS = new Set([
  "comments",
  "extra",
  "leadingComments",
  "loc",
  "start",
  "end",
  "innerComments",
  "trailingComments",
  "tokens",
]);

function isNode(value: unknown): value is BabelNode {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { type?: unknown }).type === "string"
  );
}

function getLine(node: BabelNode | undefined): number | null {
  const line = node?.loc?.start.line;
  return typeof line === "number" ? line : null;
}

function getNodeRange(node: BabelNode): { start: number; end: number } {
  if (
    typeof node.start !== "number" ||
    typeof node.end !== "number" ||
    node.start < 0 ||
    node.end < node.start
  ) {
    throw new SourceEditError(
      "PARSE_ERROR",
      "The parser did not provide a valid source range"
    );
  }

  return { start: node.start, end: node.end };
}

function getPropertyName(node: BabelNode | undefined): string | null {
  if (!node) {
    return null;
  }

  if (
    (node.type === "Identifier" || node.type === "JSXIdentifier") &&
    typeof node.name === "string"
  ) {
    return node.name;
  }

  if (node.type === "StringLiteral" && typeof node.value === "string") {
    return node.value;
  }

  return null;
}

function getSiteLines(ancestors: BabelNode[]): number[] {
  const lines: number[] = [];

  for (const ancestor of ancestors) {
    if (
      ancestor.type === "JSXOpeningElement" ||
      ancestor.type === "CallExpression" ||
      ancestor.type === "NewExpression" ||
      ancestor.type === "ObjectExpression"
    ) {
      const line = getLine(ancestor);

      if (line !== null) {
        lines.push(line);
      }
    }
  }

  return lines;
}

function addCandidate(
  candidates: EditCandidate[],
  argName: string | null,
  valueNode: BabelNode | undefined,
  node: BabelNode,
  ancestors: BabelNode[],
  syntax: EditCandidate["syntax"]
) {
  if (!argName || !valueNode) {
    return;
  }

  const locationLines = [getLine(node), ...getSiteLines(ancestors)].filter(
    (line): line is number => line !== null
  );

  candidates.push({ argName, valueNode, locationLines, syntax });
}

function isSupportedLiteral(node: BabelNode | undefined): node is BabelNode {
  if (!node) return false;
  if (
    node.type === "StringLiteral" ||
    node.type === "NumericLiteral" ||
    node.type === "BooleanLiteral" ||
    node.type === "NullLiteral"
  ) {
    return true;
  }
  
  if (node.type === "UnaryExpression" && node.operator === "-" && (node.argument as BabelNode)?.type === "NumericLiteral") {
    return true;
  }
  
  return false;
}

/**
 * Names under which provenance metadata is written by hand.
 *
 * Everything beneath them describes a value rather than being one. An author
 * who writes `args: { radius: 0.6 }` beside `<sphereGeometry args={[0.6]} />`
 * has two literals named or standing for "radius", and only the second one
 * draws anything. The copy inside the metadata used to be a candidate, and
 * since its line sits inside the mesh's own element it matched the panel's
 * request: Save rewrote the label, reported success, and the sphere did not
 * change.
 */
const METADATA_KEYS = new Set(["sourceRef", "instanceSourceRefs"]);

function isMetadata(node: BabelNode): boolean {
  if (node.type === "ObjectProperty" && node.computed !== true) {
    const key = getPropertyName(node.key as BabelNode | undefined);
    return key !== null && METADATA_KEYS.has(key);
  }

  if (node.type === "VariableDeclarator") {
    const id = node.id as BabelNode | undefined;
    return id?.type === "Identifier" && METADATA_KEYS.has(id.name as string);
  }

  return false;
}

function collectCandidates(sourceAst: BabelNode): EditCandidate[] {
  const candidates: EditCandidate[] = [];

  function visit(value: unknown, ancestors: BabelNode[]) {
    if (!isNode(value)) {
      if (Array.isArray(value)) {
        for (const item of value) {
          visit(item, ancestors);
        }
      }
      return;
    }

    if (isMetadata(value)) {
      return;
    }

    const nextAncestors = [...ancestors, value];

    if (value.type === "JSXAttribute") {
      const name = value.name as BabelNode | undefined;
      const attributeValue = value.value as BabelNode | undefined;
      const nameText = getPropertyName(name);

      if (attributeValue?.type === "StringLiteral") {
        addCandidate(
          candidates,
          nameText,
          attributeValue,
          value,
          ancestors,
          "jsx-string"
        );
      } else if (attributeValue?.type === "JSXExpressionContainer") {
        const expression = attributeValue.expression as BabelNode | undefined;

        if (isSupportedLiteral(expression)) {
          addCandidate(
            candidates,
            nameText,
            expression,
            value,
            ancestors,
            "expression"
          );
        }
      }
    }

    if (value.type === "ObjectProperty" && value.computed !== true) {
      const key = value.key as BabelNode | undefined;
      const propertyValue = value.value as BabelNode | undefined;

      if (isSupportedLiteral(propertyValue)) {
        addCandidate(
          candidates,
          getPropertyName(key),
          propertyValue,
          value,
          ancestors,
          "expression"
        );
      }
    }

    if (value.type === "VariableDeclarator") {
      const id = value.id as BabelNode | undefined;
      const init = value.init as BabelNode | undefined;

      if (id?.type === "Identifier" && typeof id.name === "string") {
        if (isSupportedLiteral(init)) {
          addCandidate(
            candidates,
            id.name,
            init,
            value,
            ancestors,
            "expression"
          );
        }
      }
    }

    for (const [key, child] of Object.entries(value)) {
      if (NON_NODE_KEYS.has(key)) {
        continue;
      }

      visit(child, nextAncestors);
    }
  }

  visit(sourceAst, []);
  return candidates;
}

function serializeValue(value: unknown): string {
  if (value === null) {
    return "null";
  }

  if (typeof value === "string") {
    return JSON.stringify(value);
  }

  if (typeof value === "boolean") {
    return value ? "true" : "false";
  }

  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }

  throw new SourceEditError(
    "UNSUPPORTED_VALUE",
    "Only string, finite number, boolean, and null values are supported"
  );
}

function serializeJsxAttributeString(value: unknown): string {
  if (typeof value !== "string") {
    throw new SourceEditError(
      "UNSUPPORTED_VALUE",
      "Raw JSX attribute values can only be replaced with strings"
    );
  }

  const escaped = value
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\r/g, "&#13;")
    .replace(/\n/g, "&#10;");

  return `"${escaped}"`;
}

function serializeReplacement(candidate: EditCandidate, newValue: unknown) {
  if (candidate.syntax === "jsx-string") {
    return serializeJsxAttributeString(newValue);
  }

  return serializeValue(newValue);
}

/**
 * The literal starting at a 1-based line and column, outside any hand-written
 * metadata, with the attribute it sits directly in if any.
 */
function findLiteralAt(
  sourceAst: BabelNode,
  line: number,
  column: number
): { node: BabelNode; parent: BabelNode | undefined } | null {
  let found: { node: BabelNode; parent: BabelNode | undefined } | null = null;

  function visit(value: unknown, parent: BabelNode | undefined) {
    if (found) {
      return;
    }
    if (!isNode(value)) {
      if (Array.isArray(value)) {
        for (const item of value) {
          visit(item, parent);
        }
      }
      return;
    }
    if (isMetadata(value)) {
      return;
    }

    const start = value.loc?.start as { line: number; column: number } | undefined;
    if (
      start &&
      start.line === line &&
      start.column + 1 === column &&
      isSupportedLiteral(value)
    ) {
      found = { node: value, parent };
      return;
    }

    for (const [key, child] of Object.entries(value)) {
      if (!NON_NODE_KEYS.has(key)) {
        visit(child, value);
      }
    }
  }

  visit(sourceAst, undefined);
  return found;
}

/**
 * Rewrites the literal at an exact position, if it still reads `expected`.
 *
 * The inspector learns positions at build time, and a file can change before
 * Save is pressed — an edit in the editor, or a previous Save that shifted
 * the line. Checking the text at the position, not just that a literal is
 * there, is what keeps a stale position from landing on a different value
 * that happens to start in the same place.
 */
function editAtPosition(source: string, ast: BabelNode, request: EditRequest): string {
  const line = request.line;
  const column = request.column as number;
  const expected = request.expected as string;
  const hit = findLiteralAt(ast, line, column);

  if (!hit) {
    throw new SourceEditError(
      "STALE_LOCATION",
      `No editable value starts at line ${line}, column ${column} of ${request.file}. ` +
        "The file has changed since the inspector read it; select the object again."
    );
  }

  const range = getNodeRange(hit.node);
  const current = source.slice(range.start, range.end);

  if (current !== expected) {
    throw new SourceEditError(
      "STALE_LOCATION",
      `Line ${line}, column ${column} of ${request.file} now reads ${current}, not ` +
        `${expected}. The file has changed since the inspector read it; select the ` +
        "object again."
    );
  }

  const replacement =
    hit.node.type === "StringLiteral" && hit.parent?.type === "JSXAttribute"
      ? serializeJsxAttributeString(request.newValue)
      : serializeValue(request.newValue);

  const magicString = new MagicString(source);
  magicString.overwrite(range.start, range.end, replacement);
  return magicString.toString();
}

export function editSource(source: string, request: EditRequest): string {
  const byPosition = request.column !== undefined;

  if (
    typeof source !== "string" ||
    typeof request.file !== "string" ||
    request.file.length === 0 ||
    !Number.isInteger(request.line) ||
    request.line < 1 ||
    (byPosition
      ? !Number.isInteger(request.column) ||
        (request.column as number) < 1 ||
        typeof request.expected !== "string" ||
        request.expected.length === 0
      : typeof request.argName !== "string" || request.argName.length === 0)
  ) {
    throw new SourceEditError("INVALID_REQUEST", "Invalid source edit request");
  }

  let ast: BabelNode;

  try {
    ast = parse(source, {
      sourceFilename: request.file,
      sourceType: "module",
      plugins: ["jsx", "typescript"],
    }) as unknown as BabelNode;
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown parse error";
    throw new SourceEditError("PARSE_ERROR", `Unable to parse ${request.file}: ${message}`);
  }

  if (byPosition) {
    return editAtPosition(source, ast, request);
  }

  const candidates = collectCandidates(ast).filter(
    (candidate) => candidate.argName === request.argName
  );

  if (candidates.length === 0) {
    throw new SourceEditError(
      "ARGUMENT_NOT_FOUND",
      `Argument "${request.argName}" was not found in ${request.file}`
    );
  }

  const locationMatches = candidates.filter((candidate) =>
    candidate.locationLines.includes(request.line)
  );

  if (locationMatches.length === 0) {
    // The argument exists in this file, just not at the line asked for. Saying
    // where it does live turns a dead end into something the caller can act
    // on, and it is the difference between the two failures a consumer
    // actually hits: a stale line, and a name that is not editable at all.
    //
    // The panel reaches this constantly and cannot get past it on its own. It
    // sends `sourceRef.line`, which names the generator's call site, while a
    // hoisted constant's only location is its own declaration — so the
    // `waterLevel` -> `WATER_LEVEL` mapping that `argSources` exists to
    // support lands here every time. Reporting the declaration line does not
    // make that edit work; it makes the reason legible instead of looking
    // like the argument does not exist.
    const found = [
      ...new Set(candidates.flatMap((candidate) => candidate.locationLines)),
    ].sort((a, b) => a - b);

    throw new SourceEditError(
      "LOCATION_NOT_FOUND",
      `Argument "${request.argName}" was not found at line ${request.line} in ` +
        `${request.file}. It is declared at ${
          found.length === 1 ? `line ${found[0]}` : `lines ${found.join(", ")}`
        }.`
    );
  }

  if (locationMatches.length > 1) {
    throw new SourceEditError(
      "AMBIGUOUS_LOCATION",
      `Argument "${request.argName}" has multiple matches at line ${request.line}`
    );
  }

  const candidate = locationMatches[0];
  const range = getNodeRange(candidate.valueNode);
  const replacement = serializeReplacement(candidate, request.newValue);
  const magicString = new MagicString(source);

  magicString.overwrite(range.start, range.end, replacement);
  return magicString.toString();
}

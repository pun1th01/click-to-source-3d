import { parse } from "@babel/parser";
import MagicString from "magic-string";

export type EditRequest = {
  file: string;
  line: number;
  argName: string;
  newValue: unknown;
};

export type SourceEditErrorCode =
  | "INVALID_REQUEST"
  | "PARSE_ERROR"
  | "ARGUMENT_NOT_FOUND"
  | "LOCATION_NOT_FOUND"
  | "AMBIGUOUS_LOCATION"
  | "UNSUPPORTED_VALUE";

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
  return (
    node?.type === "StringLiteral" ||
    node?.type === "NumericLiteral" ||
    node?.type === "BooleanLiteral" ||
    node?.type === "NullLiteral"
  );
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

export function editSource(source: string, request: EditRequest): string {
  if (
    typeof source !== "string" ||
    typeof request.file !== "string" ||
    request.file.length === 0 ||
    !Number.isInteger(request.line) ||
    request.line < 1 ||
    typeof request.argName !== "string" ||
    request.argName.length === 0
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
    throw new SourceEditError(
      "LOCATION_NOT_FOUND",
      `Argument "${request.argName}" was not found at line ${request.line} in ${request.file}`
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

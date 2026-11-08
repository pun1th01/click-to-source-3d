import type { StampedValue } from "@click-to-source-3d/shared";
import type { Node } from "./facts.js";

/** Longest expression text kept for a value the panel can only show. */
const MAX_EXPRESSION = 80;

export function isLiteral(node: Node | null | undefined): boolean {
  if (!node) {
    return false;
  }
  if (
    node.type === "StringLiteral" ||
    node.type === "NumericLiteral" ||
    node.type === "BooleanLiteral" ||
    node.type === "NullLiteral"
  ) {
    return true;
  }
  return (
    node.type === "UnaryExpression" &&
    node.operator === "-" &&
    (node.argument as Node | undefined)?.type === "NumericLiteral"
  );
}

export function literalValue(node: Node): string | number | boolean | null {
  if (node.type === "NullLiteral") {
    return null;
  }
  if (node.type === "UnaryExpression") {
    return -((node.argument as Node).value as number);
  }
  return node.value as string | number | boolean;
}

/** Every name a pattern binds: `a`, `{ a, b: [c] }`, `...rest`, `x = 1`. */
export function patternNames(pattern: Node | null | undefined, out: string[] = []): string[] {
  if (!pattern) {
    return out;
  }
  switch (pattern.type) {
    case "Identifier":
      out.push(pattern.name as string);
      break;
    case "AssignmentPattern":
      patternNames(pattern.left as Node, out);
      break;
    case "RestElement":
      patternNames(pattern.argument as Node, out);
      break;
    case "ObjectPattern":
      for (const property of pattern.properties as Node[]) {
        patternNames(
          (property.type === "RestElement" ? property : property.value) as Node,
          out
        );
      }
      break;
    case "ArrayPattern":
      for (const element of pattern.elements as Array<Node | null>) {
        patternNames(element, out);
      }
      break;
    case "TSParameterProperty":
      patternNames(pattern.parameter as Node, out);
      break;
  }
  return out;
}

/**
 * The constants an identifier can safely be followed to.
 *
 * `args={[1.2, BOX_HEIGHT]}` is only editable at `const BOX_HEIGHT = 1.4`, and
 * only if that declaration is what the identifier means. Scope is not
 * modelled, so the rule is conservative instead: a name resolves only when the
 * file binds it exactly once, by a `const` with a literal value. A parameter,
 * a `let`, an import or a second declaration of the same name anywhere in the
 * file makes it ambiguous, and the value is shown read-only rather than
 * edited at a declaration that may not be the one in scope.
 */
export function constantsOf(program: Node): Map<string, Node> {
  const bindings = new Map<string, number>();
  const literals = new Map<string, Node>();
  const bind = (name: string) => bindings.set(name, (bindings.get(name) ?? 0) + 1);

  const walk = (node: Node | null | undefined, inConst: boolean) => {
    if (!node || typeof node.type !== "string") {
      return;
    }

    switch (node.type) {
      case "VariableDeclaration":
        for (const declarator of node.declarations as Node[]) {
          for (const name of patternNames(declarator.id as Node)) {
            bind(name);
          }
          const id = declarator.id as Node;
          const init = declarator.init as Node | undefined;
          if (node.kind === "const" && id.type === "Identifier" && isLiteral(init)) {
            literals.set(id.name as string, init!);
          }
          walk(init, false);
        }
        return;
      case "FunctionDeclaration":
      case "FunctionExpression":
      case "ArrowFunctionExpression":
      case "ObjectMethod":
      case "ClassMethod":
        if (node.type === "FunctionDeclaration" && (node.id as Node | null)) {
          bind((node.id as Node).name as string);
        }
        for (const param of node.params as Node[]) {
          for (const name of patternNames(param)) {
            bind(name);
          }
        }
        break;
      case "ClassDeclaration":
        if (node.id as Node | null) {
          bind((node.id as Node).name as string);
        }
        break;
      case "ImportDeclaration":
        for (const specifier of node.specifiers as Node[]) {
          bind((specifier.local as Node).name as string);
        }
        return;
      case "CatchClause":
        for (const name of patternNames(node.param as Node | null)) {
          bind(name);
        }
        break;
    }

    for (const key of Object.keys(node)) {
      if (key === "loc" || key.endsWith("Comments")) {
        continue;
      }
      const value = node[key];
      if (Array.isArray(value)) {
        for (const item of value) {
          walk(item as Node, inConst);
        }
      } else if (value && typeof value === "object") {
        walk(value as Node, inConst);
      }
    }
  };

  walk(program, false);

  for (const name of [...literals.keys()]) {
    if (bindings.get(name) !== 1) {
      literals.delete(name);
    }
  }
  return literals;
}

/** Reads one value as the panel shows it: a literal it can edit, or text it cannot. */
export function valueDescriber(code: string, constants: Map<string, Node>) {
  return (node: Node | null | undefined): StampedValue => {
    if (!node || node.type === "SpreadElement") {
      return { raw: node ? code.slice(node.start as number, node.end as number) : "", editable: false };
    }

    if (isLiteral(node)) {
      return {
        raw: code.slice(node.start as number, node.end as number),
        value: literalValue(node),
        editable: true,
        line: node.loc!.start.line,
        column: node.loc!.start.column + 1,
      };
    }

    if (node.type === "Identifier") {
      const declared = constants.get(node.name as string);
      if (declared) {
        return {
          raw: code.slice(declared.start as number, declared.end as number),
          value: literalValue(declared),
          editable: true,
          line: declared.loc!.start.line,
          column: declared.loc!.start.column + 1,
          via: node.name as string,
        };
      }
    }

    const text = code.slice(node.start as number, node.end as number).replace(/\s+/g, " ");
    return {
      raw: text.length > MAX_EXPRESSION ? `${text.slice(0, MAX_EXPRESSION - 1)}…` : text,
      editable: false,
    };
  };
}

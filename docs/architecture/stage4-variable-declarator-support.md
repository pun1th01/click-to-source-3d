# Stage 4 Addendum: VariableDeclarator Support

This document serves as an addendum to `metadata-convention.pdf` and the `Stage 3 Implementation Validation Report`. 

## Finding
During Stage 4 dogfooding in the Procedural Low-Poly World Generator, it was discovered that developers naturally hoist shared literal values into local variables (e.g., `const noiseFloor = -26;`) rather than repeating them in JSX props or Object properties.

The Stage 3 implementation of `sourceEditor` relied on an AST visitor that strictly targeted `JSXAttribute` and `ObjectProperty` nodes. As a result, hoisted variables were ignored entirely, returning an `ARGUMENT_NOT_FOUND` error.

## Resolution
The `collectCandidates` visitor in `@click-to-source/core/src/sourceEditor.ts` has been extended to natively support `VariableDeclarator` nodes.

**Supported Shapes:**
- `JSXAttribute` (`<mesh scale={0.5} />`)
- `ObjectProperty` (`{ scale: 0.5 }`)
- **[NEW] `VariableDeclarator`** (`const scale = 0.5;`)

**AST Matching Rules:**
The parser safely matches ANY `VariableDeclarator` where:
1. `id` is a simple `Identifier` (no destructuring).
2. `init` is a Supported Literal (`StringLiteral`, `NumericLiteral`, `BooleanLiteral`, `NullLiteral`, or a `UnaryExpression` representing a negative number).

**Disambiguation:**
The existing `AMBIGUOUS_LOCATION` and `LOCATION_NOT_FOUND` protections apply transparently to `VariableDeclarator`. The user's `__cts/write-file` request provides the exact `line` number, eliminating any risk of editing a variable with a duplicated name in a different scope.

## Constraints for Multiple Arguments
The `SourceRef` schema specifies a single `line: number` property. If an object passes multiple arguments mapping to hoisted variables, those variables **must be declared on the exact same line** (e.g. `const noiseFloor = -26, lakeBedLevel = -20;`) so they share the `locationLines` attribution in the AST.

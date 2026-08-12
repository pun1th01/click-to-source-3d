# Stage 3 Step 7 - Isolated Source Edit Pipeline Verification

## Purpose

Step 7 adds a filesystem-agnostic source transformation primitive for the
later editing workflow. It accepts source text plus a typed edit request,
parses the source with Babel, resolves the requested literal through the AST,
and replaces only that literal's character range with `magic-string`.

Step 7 does not connect to the Step 6 HTTP endpoints and does not modify the
GenerationTrace UI, Zustand state, SelectionHighlight, R3F integration,
resolver, HMR behavior, or automatic instrumentation.

## Implementation Location

The utility belongs to `@click-to-source/core`, which already contains the
non-React provenance logic:

- `packages/core/src/sourceEditor.ts`
- `packages/core/src/index.ts`
- `packages/core/package.json`

The required runtime dependencies are:

- `@babel/parser` `7.29.8`
- `magic-string` `0.30.21`

## API Contract

```ts
export type EditRequest = {
  file: string;
  line: number;
  argName: string;
  newValue: unknown;
};

export function editSource(source: string, request: EditRequest): string;
```

Transformation failures throw `SourceEditError`, which exposes a typed
`code`:

- `INVALID_REQUEST`
- `PARSE_ERROR`
- `ARGUMENT_NOT_FOUND`
- `LOCATION_NOT_FOUND`
- `AMBIGUOUS_LOCATION`
- `UNSUPPORTED_VALUE`

The `file` field is used as the parser's source filename and in diagnostic
messages. The utility does not read or write it.

## Babel Resolution Strategy

The parser uses module, JSX, and TypeScript parsing:

```ts
parse(source, {
  sourceFilename: request.file,
  sourceType: "module",
  plugins: ["jsx", "typescript"],
});
```

The AST walker collects only the narrow literal edit sites needed by the
Stage 3 MVP:

1. JSX attributes such as `color="hotpink"` and `scale={0.35}`.
2. Object properties such as `color: "hotpink"` and `scale: 0.35`.

Candidates are matched by the exact `argName`. The supplied line must match
the candidate property/attribute line or a relevant enclosing JSX opening
element, call, new-expression, or object-expression site line. A missing
argument, invalid location, or ambiguous match fails instead of falling back
to an unrelated occurrence.

No `source.indexOf(argName)` or `source.indexOf(oldValue)` matching is used.

## Magic-String Patching

The selected Babel literal node's `start` and `end` offsets define the exact
replacement range. `magic-string.overwrite(start, end, replacement)` changes
only that range and returns the resulting source text. The original input
string is never mutated, and failed validation occurs before a patch is
created.

## Supported Values

Supported replacement values are:

- strings
- finite numbers
- booleans
- `null`

Strings in JavaScript expressions and object properties use JSON string
serialization. Raw JSX string attributes retain valid JSX syntax with entity
escaping where needed. Objects, arrays, functions, `undefined`, non-finite
numbers, and arbitrary expressions are rejected explicitly.

## Isolated Tests

`packages/core/test/sourceEditor.test.ts` verifies exact resulting source text
for:

1. JSX string literal replacement.
2. JSX numeric literal replacement.
3. Boolean and null replacements.
4. Duplicate values disambiguated by line.
5. Tabs, spaces, trailing commas, and multiline JSX formatting preservation.
6. Missing argument failure.
7. Invalid location failure.
8. Unsupported value failure with unchanged original source.

The duplicate-value fixture contains two `color: "hotpink"` properties; only
the property on the requested line changes.

## Verification Results

```text
npm run test --workspace=@click-to-source/core
2 test files passed, 14 tests passed

npx tsc -b packages/shared packages/core
passed
```

The existing overlay tests, Step 6 endpoint tests, and examples Vite build
remain part of the final verification run for this step.

## Limitations

This is intentionally not a general AST transformation system. It does not
support arbitrary expressions, function calls, imports, declarations, shader
code, multiple files, automatic instrumentation, source discovery, or
filesystem access. Step 8 must later connect this pure utility to the UI and
Step 6 file transport.

## Files Changed

| File | Change |
|---|---|
| `packages/core/package.json` | Added Babel parser and magic-string runtime dependencies. |
| `package-lock.json` | Recorded the new dependency tree. |
| `packages/core/src/sourceEditor.ts` | Added the typed AST-based edit utility and errors. |
| `packages/core/src/index.ts` | Exported the Step 7 API. |
| `packages/core/test/sourceEditor.test.ts` | Added isolated transformation tests. |
| `docs/architecture/stage3-step7-verification.md` | Added this verification record. |

## Step 7 Result

**Stage 3 Step 7 complete. Stage 3 Step 8 has NOT started.**

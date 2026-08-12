# Stage 3 Fixture Metadata Correction

This correction updates only the existing hand-authored demo `SourceRef` values. It does not change Step 6, Step 7, the metadata architecture, or the editor API.

## Diagnosis

The fixture in `packages/examples/src/main.tsx` originally used:

| Fixture | Original `SourceRef.file` | Original `SourceRef.line` | Metadata `args` line | Actual editable color line |
| --- | --- | ---: | ---: | ---: |
| Pink cube | `main.tsx` | 33 | 55 | 77 |
| Cyan sphere | `main.tsx` | 39 | 62 | 83 |

Step 6 serves files relative to the Vite project root, which is `packages/examples`. Therefore the source file value must be `src/main.tsx`, not `main.tsx`.

## Existing `SourceRef` meaning

The shared `SourceRef` shape continues to be:

```ts
{ file, function, line, args, schemaVersion? }
```

The Stage 2 metadata convention defines `file` as a path relative to the project root and `line` as the source location associated with the generated object. Step 7's existing `editSource()` implementation uses the supplied line as the source-edit location: it matches JSX attributes and object properties on that line, including their enclosing JSX element or object/call site.

For this hand-authored fixture, lines 55 and 62 are the `SourceRef.args` object properties. Editing those lines changes only the metadata object. They do not identify the rendered material color. The actual editable `color` arguments are the JSX attributes on lines 77 and 83, so those are the values required for the current Step 7 API to reach the intended source literals.

## Correction

The fixture now uses:

```ts
const sampleSourceRefA: SourceRef = {
  file: "src/main.tsx",
  function: "Scene",
  line: 77,
  args: { color: "hotpink" },
};

const sampleSourceRefB: SourceRef = {
  file: "src/main.tsx",
  function: "Scene",
  line: 83,
  args: { color: "cyan" },
};
```

The `args` values remain unchanged. No line-mapping layer or new metadata convention was introduced.

## Step 7 resolution proof

Using the existing `editSource()` API against the actual `packages/examples/src/main.tsx` fixture:

- `{ file: "src/main.tsx", line: 77, argName: "color", newValue: "magenta" }` changed only line 77 from `<meshStandardMaterial color="hotpink" />` to `<meshStandardMaterial color="magenta" />`.
- `{ file: "src/main.tsx", line: 83, argName: "color", newValue: "lime" }` changed only line 83 from `<meshStandardMaterial color="cyan" />` to `<meshStandardMaterial color="lime" />`.
- The comparison changed exactly one source line in each case; no unrelated source text changed.
- The comparison also established that lines 55 and 62 resolve the metadata `args` properties instead, which is why they were not selected.

## Automated verification

- Core and Step 7 tests: 14 passed.
- Step 6 Vite file-I/O tests: 3 passed.
- Overlay tests: 4 passed.
- TypeScript build: passed with `npx tsc -b packages/shared packages/core packages/overlay`.
- Examples Vite build: passed with `npm run build --workspace=@click-to-source/examples`.
- `git diff --check`: passed.

The Vite build still reports its existing non-blocking config-loader and large-chunk warnings.

Stage 3 Step 8 has NOT started.

Stage 3 Step 9 has NOT started.

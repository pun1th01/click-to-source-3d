# Stage 3 Step 8 — Generation Trace File Editing

## Scope

Step 8 makes the existing `GenerationTrace` argument fields editable and wires
them to the Step 6 development-server file transport. The implementation uses
the existing Step 7 `editSource()` pipeline and leaves Vite responsible for
the normal HMR update.

No AI, MCP, automatic instrumentation, multi-file editing, shader editing,
VS Code integration, custom scene reload, or Stage 4 functionality was added.

## Implementation

### GenerationTrace

`packages/overlay/src/components/GenerationTrace.tsx` now renders one text
input and Save button for each selected `SourceRef.args` entry. The selected
`SourceRef` remains the source of truth for:

- `file`: the Step 6 project-relative file path;
- `line`: the Step 7 source location; and
- the argument name: the selected `args` key.

The UI does not parse source text or perform AST edits. After a successful
write, the selected argument value in the Zustand overlay state is updated so
the trace reflects the saved value.

### Overlay transport

`packages/overlay/src/sourceEditClient.ts` performs this request sequence:

```text
GenerationTrace input
  -> POST /__cts/read-file { file }
  -> POST /__cts/write-file {
       file, content, line, argName, newValue
     }
```

The read response is sent with the edit request so the write operation edits
the exact source snapshot displayed by the pipeline. Transport failures are
shown in the panel and do not update the selected argument state.

### Vite write pipeline

`packages/examples/vite-file-io.ts` now accepts the Step 8 edit fields on the
existing write endpoint. For an edit request it calls the existing core
`editSource()` function, then writes the returned source text. The Step 6 raw
`{ file, content }` write form remains supported for backward compatibility.

The UI imports no parser or `magic-string` logic. The only source transformation
remains `packages/core/src/sourceEditor.ts`.

## Verification

### Automated tests

- Core and Step 7 tests: 14 passed.
- Overlay tests: 7 passed, including the transport request sequence and
  selected-argument state update.
- Step 6/Step 8 Vite file-I/O tests: 4 passed, including an endpoint edit that
  changes only the selected literal and preserves the other color.
- TypeScript build passed:
  `npx tsc -b packages/shared packages/core packages/overlay`.
- Examples Vite build passed:
  `npm run build --workspace=@click-to-source/examples`.
- `git diff --check` passed.

### Live demo verification

Using the running Vite demo and the existing corrected fixture metadata:

| Selection | SourceRef location | Edit | Result |
| --- | --- | --- | --- |
| Pink cube | `src/main.tsx`, line 77, `color` | `hotpink` → `rebeccapurple` | The rendered cube changed through Vite HMR. |
| Cyan sphere | `src/main.tsx`, line 83, `color` | `cyan` → `gold` | The rendered sphere changed through Vite HMR. |

The file contents observed during the live check changed only the intended
`<meshStandardMaterial color="..." />` literal in each case. The fixture was
restored to `hotpink` and `cyan` after verification.

The existing demo entry point recreates its React root when Vite refreshes the
module, which produces React's existing `createRoot()` warning and resets the
trace panel during HMR. The rendered object still updated through normal Vite
HMR; no custom reload logic was introduced in Step 8.

## Files changed

| File | Change |
| --- | --- |
| `packages/overlay/src/components/GenerationTrace.tsx` | Added editable argument controls and save/error state. |
| `packages/overlay/src/sourceEditClient.ts` | Added Step 6 read/write transport using selected `SourceRef` data. |
| `packages/overlay/src/store/overlayStore.ts` | Added the successful-edit argument state update. |
| `packages/overlay/src/index.ts` | Exported the transport helper. |
| `packages/overlay/test/sourceEditClient.test.ts` | Added transport sequencing/error tests. |
| `packages/overlay/test/overlayStore.test.ts` | Added selected-argument update coverage. |
| `packages/examples/vite-file-io.ts` | Added the Step 7-backed edit form of the existing write endpoint. |
| `packages/examples/test/vite-file-io.test.ts` | Added endpoint integration coverage for literal-only edits. |
| `docs/architecture/stage3-step8-verification.md` | Added this verification record. |

## Limitations

The current MVP edits supported literal values through the existing Step 7
constraints. It does not support arbitrary expressions, multiple files, or
custom reload behavior. The existing React root/HMR warning described above
remains outside Step 8 scope.

Stage 3 Step 9 has NOT started.

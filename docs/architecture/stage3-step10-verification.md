# Stage 3 Step 10 — Final Success-Criterion Validation

## Criterion

> Within 30 seconds of clicking an object, a developer who did not write the
> scene can find and edit the parameter responsible for its appearance.

## Validation method

This was a strict **developer simulation**, not independent validation by
another person. The simulation started from the rendered scene and the
Generation Trace UI. It did not use source line numbers to discover which
field to edit; the UI exposed the file, line, argument name, and current value.

The examples dev server was started fresh at `http://127.0.0.1:5173/`. The
fixture was restored to its original values after testing. This rerun used the
fixture-coupling fix documented in Step 9.

## Results

### A. Pink cube

From the rendered pink cube, the simulation clicked the object and used the
trace panel. The panel showed:

```text
File: src/main.tsx
Function: Scene
Line: 77
Argument: color
Current value: hotpink
```

The value was changed to `rebeccapurple` and saved. Observed time from click
to the saved HMR result: **2.424 seconds**.

The actual source result was:

```text
line 77: color="hotpink" → color="rebeccapurple"
line 83: color="cyan"       (unchanged)
line 89: color="orange"     (unchanged)
```

The rendered cube changed appearance through Vite HMR without a manual page
reload or custom reload mechanism. After HMR, reselecting the cube showed
`rebeccapurple` in the trace. A second edit changed it to `royalblue`; after
the second HMR update, reselecting the cube showed `royalblue`.

Result: **Pass**.

### B. Cyan sphere

Independently, the simulation clicked the cyan sphere after the pink edit. The
panel showed:

```text
File: src/main.tsx
Function: Scene
Line: 83
Argument: color
Current value: cyan
```

The value was changed to `gold` and saved. Observed time from click to the
saved HMR result: **2.279 seconds**.

The actual source result was:

```text
line 77: color="rebeccapurple" (unchanged)
line 83: color="cyan" → color="gold"
line 89: color="orange"       (unchanged)
```

The rendered sphere changed appearance through Vite HMR without a manual page
reload. After HMR, reselecting the sphere showed `gold` in the trace.

Result: **Pass**.

## C. Navigation and context clarity

The Generation Trace made the following information visible without source
search:

- project-relative file: `src/main.tsx`;
- component/function: `Scene`;
- relevant edit line: `77` for the pink cube or `83` for the cyan sphere;
- editable argument: `color`;
- current displayed value: `hotpink` or `cyan` on initial selection.

The input and Save control made the appearance parameter directly editable.

Result: **Pass**.

## D. Editing reliability

The first and second pink edits changed only the pink color literal at line
77. The cyan edit changed only the cyan color literal at line 83. The `args`
metadata objects at lines 55 and 62, the other object's material, and the
untagged orange cube were not modified in the source file.

Result: **Pass**.

## E. Selection correctness

Selecting pink showed line 77 and highlighted only the pink cube. Selecting
cyan showed line 83 and highlighted only the cyan sphere. Selecting the orange
untagged cube cleared the Generation Trace and highlight. The selection and
trace remained synchronized during the simulation.

Result: **Pass**.

## F. Trace freshness after HMR

The fixture-only `SourceRefMaterial` wrapper derives `SourceRef.args.color`
from the same color prop that drives the rendered material. After HMR,
reselecting the edited pink cube showed `rebeccapurple`, then `royalblue`
after the second edit. Reselecting the edited cyan sphere showed `gold`.
No stale original `hotpink` or `cyan` value was observed.

Result: **Pass** for the current tagged demo fixture. This remains a fixture
coupling fix, not a generalized stale-provenance system.

## HMR correctness fix

During validation, the examples entrypoint was found to call `createRoot()`
again when Vite re-executed `main.tsx`, producing React HMR and DOM-removal
errors. The entrypoint now reuses one React root across updates. After this
minimal fix, the live edits completed with no new browser errors, and the
rendered objects updated normally through Vite HMR.

## Automated regression verification

- Shared TypeScript build: passed.
- Core TypeScript build: passed.
- Overlay TypeScript build: passed.
- Root `npx tsc -b`: passed after adding solution project references.
- Core tests, including Step 7 source-editor tests: **14 passed**.
- Overlay tests: **7 passed**.
- Step 6 endpoint tests, including Step 8 edit integration: **4 passed**.
- Examples Vite production build: passed.
- `git diff --check`: passed.

The Vite build retains existing non-blocking config-loader and large-chunk
warnings.

## Final verdict

**PASS for the revalidated demo criterion; final Stage 3 acceptance remains
the project owner's decision.**

The developer simulation identified and edited both appearance parameters,
changed the correct source literals, updated the rendered objects through
normal Vite HMR, and showed fresh trace values after HMR. No automated
browser/WebGL suite was added, and no Stage 4 functionality has started.

This document records the revalidation evidence only; it does not declare
Stage 3 complete.

No Stage 4 functionality has started.

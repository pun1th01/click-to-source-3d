# Stage 3 Step 9 — End-to-End MVP Validation

## Scope

This document records the final Stage 3 MVP validation using the existing
examples scene. No new editing architecture, instrumentation, source
discovery, browser integration, or Stage 4 functionality was added.

One minimal correctness fix was required during validation: Vite re-executed
`packages/examples/src/main.tsx` on a source update, and the entrypoint called
`createRoot()` again for the same DOM container. That caused React HMR
`createRoot()` and DOM-removal errors. The entrypoint now reuses one React root
through the browser global before calling `root.render()`.

The validation also confirmed the earlier stale-value diagnosis. The fixture
had separate hardcoded `SourceRef.args.color` values and JSX color literals.
The demo now leaves `args` empty and derives it from the actual color prop in
the fixture-only `SourceRefMaterial` wrapper. The editable literals remain at
lines 77 and 83, so the existing Step 7 location convention is unchanged.

## End-to-end flow tested

```text
click object
  -> resolve SourceRef
  -> SelectionHighlight outlines the object
  -> GenerationTrace shows file/line/argument/value
  -> edit and Save
  -> POST /__cts/read-file
  -> POST /__cts/write-file
  -> core editSource()
  -> actual source file changes
  -> Vite HMR updates the scene
```

The source transformation remained exclusively in
`packages/core/src/sourceEditor.ts`.

## Manual validation

### Test 1 — Pink cube

- Clicked the pink cube.
- Confirmed the green highlight was attached to the cube.
- Confirmed the trace showed `src/main.tsx`, `Scene`, line `77`, argument
  `color`, and `hotpink`.
- Edited `hotpink` to `rebeccapurple` and saved.
- Confirmed only line 77 changed:
  `<SourceRefMaterial ... color="hotpink" />` →
  `<SourceRefMaterial ... color="rebeccapurple" />`.
- Confirmed the cube rendered purple through Vite HMR without a manual page
  reload.
- After HMR, clicked the cube again and confirmed the trace displayed
  `rebeccapurple`, not the original `hotpink`.
- Edited the same cube a second time, `rebeccapurple` to `royalblue`. After the
  second HMR update, reselected it and confirmed the trace displayed
  `royalblue`.

Result: **Pass**.

### Test 2 — Cyan sphere

- Clicked the cyan sphere.
- Confirmed the green highlight was attached to the sphere.
- Confirmed the trace showed `src/main.tsx`, `Scene`, line `83`, argument
  `color`, and `cyan`.
- Edited `cyan` to `gold` and saved.
- Confirmed only line 83 changed:
  `<SourceRefMaterial ... color="cyan" />` →
  `<SourceRefMaterial ... color="gold" />`.
- Confirmed the sphere rendered gold through Vite HMR without a manual page
  reload.
- After HMR, clicked the sphere again and confirmed the trace displayed
  `gold`, not the original `cyan`.

Result: **Pass**.

### Test 3 — Selection after editing

After each edit, selecting the other tagged object and returning to the edited
object continued to resolve the correct object and source line, with only the
selected object highlighted. The reselected trace displayed the new edited
argument value after HMR. The second pink-cube edit confirmed this persisted
across multiple edit cycles, not only the first update.

Result: **Pass**.

### Test 4 — Camera movement

With tagged objects selected, substantially orbiting, zooming in, zooming out,
switching to the other tagged object, and orbiting again preserved the outline
on the correct object and kept the trace associated with the selected
`SourceRef` line.

Result: **Pass**.

### Test 5 — Untagged/background behavior

Clicking the orange untagged cube cleared the highlight and removed the trace.
Clicking the background kept the selection cleared. No Generation Trace edit
control or edit request was available in either state.

Result: **Pass**.

### Test 6 — Rapid switching

Performed the sequence:

```text
Pink → Cyan → Pink → Cyan → Orange → Pink
```

The final trace identified `src/main.tsx` line 77, and only the final pink cube
was highlighted. Editing the final selected object to `mediumseagreen` changed
only line 77 and updated the rendered cube through HMR.

Result: **Pass**. The final selected object displayed the current fixture
argument value after the HMR update.

### Stale-provenance sanity check

After each edit, the rendered scene updated through HMR. Immediate clicks on
the cyan sphere and pink cube resolved the correct objects and lines (`83` and
`77`), applied the correct highlight, and displayed the current edited
argument value. No stale original fixture value was observed.

Result: resolver/object identity and trace value freshness both passed for the
tagged demo path.

## Source files observed

The fixture was restored after validation to its baseline values:

```text
packages/examples/src/main.tsx:77  color="hotpink"
packages/examples/src/main.tsx:83  color="cyan"
packages/examples/src/main.tsx:89  color="orange"
```

During the live edits, only the selected color literal on line 77 or 83
changed, respectively. The fixture-only wrapper copied that same prop value
into the selected `SourceRef.args` object after each module evaluation.

## Automated verification

- Shared TypeScript build: passed.
- Core TypeScript build: passed.
- Overlay TypeScript build: passed.
- Root `npx tsc -b`: passed after converting the root config to a solution
  config with shared/core/overlay project references.
- Core tests, including Step 7 source-editor tests: 14 passed.
- Overlay tests: 7 passed.
- Step 6 endpoint tests, including Step 8 edit integration: 4 passed.
- Examples Vite production build: passed.
- `git diff --check`: passed.

The examples build retains its existing non-blocking Vite config-loader and
large-chunk warnings.

## Success criterion

Criterion:

> Within 30 seconds of clicking an object, a developer who did not write the
> scene can find and edit the parameter responsible for its appearance.

This was a **developer-simulated fresh-user-style validation**, not an
independent validation by another person. The live panel exposed the correct
file, line, argument, and editable value quickly. Both tagged objects were
edited successfully end to end, and the pink cube was edited twice with the
post-HMR trace checked after each edit. The criterion is therefore **validated
for the current tagged demo edit path** by developer simulation; this is not
an independent validation by another person or an automated browser/WebGL
test.

## Bugs discovered and fixed

- Fixed the examples entrypoint so HMR reuses the existing React root instead
  of calling `createRoot()` repeatedly. This removed the React HMR/DOM errors
  that interfered with reliable live validation.
- Fixed the demo fixture/data coupling by deriving `SourceRef.args.color`
  from the same color prop that drives the rendered material. This prevents
  the trace metadata from reverting to the original hardcoded value after HMR.
- Converted the root TypeScript config to a solution config referencing the
  shared, core, and overlay projects so `npx tsc -b` succeeds from the root.
- No source editor, endpoint, resolver, or overlay architecture redesign was
  required.

Stage 3 Step 10 was rechecked as part of this validation, but this document
does not declare Stage 3 complete.

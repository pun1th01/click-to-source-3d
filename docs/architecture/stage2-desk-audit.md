# Stage 2 Desk Audit

## Purpose

Stage 1 was completed before the Stage 2 Metadata Convention became the official architectural contract. The seven experiments were designed, implemented, and validated as exploratory work to prove that provenance tagging on Three.js meshes is technically viable within the React Three Fiber lifecycle.

The Stage 2 Metadata Convention was subsequently defined to formalize the tagging pattern that emerged from those experiments into a canonical rule.

The purpose of this audit is to verify that the completed Stage 1 implementation already conforms to the finalized Stage 2 convention — without modification.

This is a documentation review, not a new experiment. No code is executed. No runtime behaviour is tested. The audit examines source files only.

---

## Audit Criteria

The canonical Stage 2 rule:

Every runtime mesh must attach provenance declaratively using:

```jsx
<mesh
  userData={{ sourceRef }}
>
```

or an equivalent JSX object expression (e.g., `userData={{ sourceRef: cubeData.sourceRef }}` or `userData={{ sourceRef: { ...tree.sourceRef, part: 'trunk' } }}`).

The audit specifically checks that provenance is:

- Attached **declaratively** — as a JSX prop on the `<mesh>` element.
- Attached **during JSX creation** — as part of the component's render return, not after the element is mounted.
- **Never** attached imperatively after mount (e.g., `mesh.userData.sourceRef = ...`).
- **Never** written through refs (e.g., `meshRef.current.userData.sourceRef = ...`).
- **Never** written inside `useEffect`.
- **Never** written inside callbacks or event handlers.

---

## Experiment Audit

| # | Experiment | Tagging Method | Canonical | Changes Required |
|---|---|---|---|---|
| 1 | Single Cube | Inline `sourceRef` object literal in `userData` JSX prop | ✓ | None |
| 2 | Multiple Cubes | `sourceRef` from generator, passed as prop, applied via `userData={{ sourceRef }}` | ✓ | None |
| 3 | Re-Render | `sourceRef` from generator, passed as prop, applied via `userData={{ sourceRef }}` | ✓ | None |
| 4 | Mesh Recreation | Inline `sourceRef` object literal in `userData` JSX prop | ✓ | None |
| 5 | HMR | Inline `sourceRef` object literal in `userData` JSX prop | ✓ | None |
| 6 | Trees | `sourceRef` from generator, spread with `part` discriminator in `userData` JSX prop | ✓ | None |
| 7 | Memoized Generation | `sourceRef` from memoized generator result, applied via `userData={{ sourceRef: cubeData.sourceRef }}` | ✓ | None |

### Exp1 — Single Cube

[Exp1_SingleCube.jsx](file:///c:/Users/sarma/OneDrive/Desktop/My%20FIles/My%20Project/experimentalFolder/click-to-source-poc/src/Exp1_SingleCube.jsx)

The `TaggedCube` component returns a `<mesh>` element with `userData={{ sourceRef: { file, function, line, args } }}` written directly as a JSX prop. The `sourceRef` is an inline object literal — no indirection, no imperative assignment. The `onClick` handler reads `e.object.userData.sourceRef` but never writes to it.

**Conforms to Stage 2 convention.** No modification required.

### Exp2 — Multiple Cubes

[Exp2_MultipleCubes.jsx](file:///c:/Users/sarma/OneDrive/Desktop/My%20FIles/My%20Project/experimentalFolder/click-to-source-poc/src/Exp2_MultipleCubes.jsx)

The `createCube(seed)` generator function produces a descriptor object containing a `sourceRef` field. This descriptor is spread into `ClickableCube` as props. The `ClickableCube` component receives `sourceRef` as a prop and attaches it declaratively via `userData={{ sourceRef }}` on the `<mesh>` JSX element. The `onClick` handler reads but never writes.

**Conforms to Stage 2 convention.** No modification required.

### Exp3 — Re-Render

[Exp3_ReRender.jsx](file:///c:/Users/sarma/OneDrive/Desktop/My%20FIles/My%20Project/experimentalFolder/click-to-source-poc/src/Exp3_ReRender.jsx)

Identical pattern to Exp2. The `createCube(seed)` generator produces `sourceRef`. The `ClickableCube` component attaches it via `userData={{ sourceRef }}`. Unrelated state changes (`counter`) trigger parent re-renders, but the tagging mechanism is always declarative. No `useEffect` is present in this file.

**Conforms to Stage 2 convention.** No modification required.

### Exp4 — Mesh Recreation

[Exp4_MeshRecreation.jsx](file:///c:/Users/sarma/OneDrive/Desktop/My%20FIles/My%20Project/experimentalFolder/click-to-source-poc/src/Exp4_MeshRecreation.jsx)

The `RecreatableCube` component returns a `<mesh key={version}>` with `userData={{ sourceRef: { file, function, line, args: { version } } }}` as a JSX prop. The `key={version}` forces React to unmount and remount the mesh when version changes, but the new mesh instance receives its `sourceRef` declaratively during JSX creation — not imperatively after mount.

**Conforms to Stage 2 convention.** No modification required.

### Exp5 — HMR

[Exp5_HMR.jsx](file:///c:/Users/sarma/OneDrive/Desktop/My%20FIles/My%20Project/experimentalFolder/click-to-source-poc/src/Exp5_HMR.jsx)

The `TaggedCube` component returns a `<mesh>` with an inline `sourceRef` object literal in the `userData` JSX prop. HMR triggers a full module re-evaluation, but the tagging mechanism is declarative — the `sourceRef` is reapplied as part of the component's render output. No `useEffect` or imperative assignment is present.

**Conforms to Stage 2 convention.** No modification required.

### Exp6 — Trees

[Exp6_Trees.jsx](file:///c:/Users/sarma/OneDrive/Desktop/My%20FIles/My%20Project/experimentalFolder/click-to-source-poc/src/Exp6_Trees.jsx)

The `createTree(x, z, seed)` generator produces a descriptor containing a `sourceRef` field. The `TreeMesh` component renders two `<mesh>` elements (trunk and crown), each with a declarative `userData` JSX prop that spreads the base `sourceRef` and adds a `part` discriminator: `userData={{ sourceRef: { ...tree.sourceRef, part: 'trunk' } }}` and `userData={{ sourceRef: { ...tree.sourceRef, part: 'crown' } }}`. The `onClick` handler reads but never writes.

**Conforms to Stage 2 convention.** The spread-with-discriminator pattern (`{ ...tree.sourceRef, part }`) is an equivalent JSX object expression — it produces the same `sourceRef` shape with an additional field and remains fully declarative. No modification required.

### Exp7 — Memoized Generation

[Exp7_MemoizedGeneration.jsx](file:///c:/Users/sarma/OneDrive/Desktop/My%20FIles/My%20Project/experimentalFolder/click-to-source-poc/src/Exp7_MemoizedGeneration.jsx)

The `MemoizedCube` component calls `createCube(seed)` inside a `useMemo` callback. The memoized result (`cubeData`) contains a `sourceRef` field. This is attached to the `<mesh>` declaratively via `userData={{ sourceRef: cubeData.sourceRef }}`. The `useMemo` controls when the data object is created, but the attachment to the mesh is always a declarative JSX prop — never an imperative assignment. The `useRef` (`prevDataRef`) is used only for object-identity tracking in console logs and never writes to `userData`.

**Conforms to Stage 2 convention.** No modification required.

---

## Findings

### Finding 1

Every experiment attaches provenance declaratively. All seven experiments use the `userData={{ sourceRef }}` JSX prop pattern (or an equivalent JSX object expression) on `<mesh>` elements. No experiment defers attachment to a lifecycle hook or post-mount callback.

### Finding 2

No experiment performs imperative assignment. The string `mesh.userData.sourceRef =` does not appear anywhere in the codebase. Every `.userData.sourceRef` access is a read operation inside an `onClick` handler for console logging.

### Finding 3

No experiment requires refactoring. The existing implementation in every experiment already satisfies the Stage 2 canonical rule without any source code modification.

### Finding 4

The metadata convention accurately describes the implementation that was experimentally validated during Stage 1. The convention was not aspirational — it codified an already-working pattern.

### Finding 5

No `useEffect` exists in any experiment file. Imperative post-mount tagging was never used, even in experiments specifically designed to stress lifecycle scenarios (re-render, mesh recreation, HMR, memoization).

---

## Conclusion

The Stage 2 Metadata Convention was not created independently of Stage 1.

Rather, it formally documents and standardizes the implementation pattern already proven across all seven experiments.

The convention captures the invariant that emerged organically during Stage 1 development: provenance is always a declarative JSX prop, never an imperative side effect. This invariant held across every lifecycle scenario tested — single meshes, generated collections, parent re-renders, mesh destruction and recreation, hot module replacement, multi-part structures, and memoized generation pipelines.

Therefore:

- No experiment requires modification.
- No behavioral differences exist between the audited implementation and the Stage 2 architectural contract.
- The Stage 2 convention is a faithful formalization of Stage 1 practice.

---

## Audit Result

✓ Stage 1 fully complies with the Stage 2 Metadata Convention.

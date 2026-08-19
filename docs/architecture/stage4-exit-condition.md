# Stage 4 Exit Condition: Dogfooding Outcomes

This document closes Stage 4 and records what was fixed, what was deliberately dropped, and what unplanned capability work was absorbed. It is the reference for why Stage 4's delivered scope differs from its original definition.

## Original Scope — Three Regressions

Stage 4 was defined as applying the tool to a real project (the Procedural Low-Poly World Generator) to fix three known regressions.

| Regression | Status |
|---|---|
| Lake bed height clamp | Resolved |
| Normals ordering | Resolved |
| Weather freeze | **Out of scope — deliberately dropped** |

### Lake bed clamp — resolved

The clamp itself predates the tool: it was implemented in `b939b0c` and refined in `ca34a46`, both before the Click-to-Source integration in `1e8b2a1`. What the tool contributed was surfacing it. `0542070` changed Terrain's `sourceRef.args` to derive `noiseFloor` and `lakeBedLevel` from the actual component-scope variables rather than hand-typed literals, making both inspectable in the Generation Trace panel.

That commit also caught a metadata-drift bug in the process — the args read `{ noiseFloor: -26, lakeBedLevel: -20 }` while the code had moved to `-30`. This is the first recorded instance of the drift pattern that manual tagging makes structurally possible.

### Normals ordering — resolved via Option B

`computeVertexNormals()` ran after `toNonIndexed()`, so all 115,200 terrain triangles carried identical per-face normals and no smooth normals existed anywhere in the buffer. This broke the normal blend at `Terrain.jsx:146`:

    normal = normalize(mix(normal, flatNrm, flatFactor));

whose documented intent is smooth normals on grass and flat normals on mountains and cliffs. With the attribute normals already flat, the smooth end of the blend was unreachable and the mix was a no-op in one direction.

Two fixes were evaluated:

- **Option A** — reorder to `computeVertexNormals()` then `toNonIndexed()`.
- **Option B** — drop `toNonIndexed()` entirely and keep the geometry indexed.

Option B was chosen. The conversion was vestigial, not merely mis-ordered: the shader derives its flat normal from screen-space derivatives (lines 137-139) and seeds its per-face colour hash from the same derivatives (line 168). Neither reads the normal attribute or depends on topology, so the conversion bought nothing.

Both options were verified to produce identical shader inputs — max delta 0.000e+0 across 115,200 triangles on geometric face normals, the `faceID` hash, `terrainMasks` per-triangle values, and vertex normals. Option B additionally reduced the geometry from 345,600 to 58,081 vertices (~14.50 MB to ~3.10 MB) and cut vertex shader invocations by roughly 6x.

Fixed in `741d9d8`. GroundCover's `toNonIndexed()`/`computeVertexNormals()` calls are a different pattern — flattening a blade template into a vertex soup, then computing normals on a geometry built without an index — and were deliberately left untouched.

### Weather freeze — out of scope, deliberately

**Not fixed.** The weather system was removed entirely in `1e8b2a1` rather than repaired. Two rebuild attempts were made and abandoned; the second introduced a new mount-transition bug.

The root cause was a performance freeze — camera unresponsive — traced to the cumulative per-frame cost of the particle system, fog overrides, and related work on low-end hardware.

Weather is hereby moved **out of Stage 4 scope** and recorded as a possible future feature with no scheduled stage. This is a deliberate scope decision, not an oversight and not an unresolved bug. `docs/weather-v2-notes.md` in the LowPolyWorldGen repository is preserved as the record of what was learned across the v1 implementation and both rebuild attempts, and is the starting point if weather is ever revisited.

## Capability Work Absorbed Beyond Original Scope

Dogfooding surfaced engine gaps that were fixed inside Stage 4 rather than deferred, because each blocked the stage's own objectives:

- **InstancedMesh per-instance provenance.** The original engine had no support for instanced objects, which cover most of the scene. Added the `InstanceSourceRef` type, the `resolveInstanceSourceRef` lookup keyed by `instanceId`, a read-only UI mode for procedurally placed objects with no editable source literal, and 8 resolver tests. See `stage5-instanced-mesh-support.md`.
- **VariableDeclarator support in the AST editor.** Real generators hoist literals into local variables; the editor handled only JSX attributes and object properties. See `stage4-variable-declarator-support.md`.
- **`argSources` display-key-to-identifier mapping.** `editSource` matches the identifier as declared in source, which silently failed for any object whose `args` display keys differed from its declarations.
- **Four objects tagged** — Terrain, Trees, GroundCover, and Water.

## Verification Status

Verification depth differs by object and by capability. It is recorded precisely here rather than summarised, because "verified" has meant different things at different points in this stage.

**Resolution — browser-verified for all four objects.** Clicking each object in a running scene returns the correct provenance. Per-instance isolation was confirmed for GroundCover specifically: clicking different grass instances returns different `variant`, `x`, `z`, and `yaw` values.

**Editing — verified to different depths:**

| Value | Depth of verification |
|---|---|
| `Water.waterLevel` | **End-to-end in a running browser**: panel edit → disk write → HMR → correct value on reselection, then restored |
| `Water.deepColor`, `Water.shallowColor` | Direct `editSourceFile` calls only — **not** verified in-browser |
| `Terrain.noiseFloor`, `Terrain.lakeBedLevel` | Direct `editSource` calls only — **not** verified in-browser |
| Trees, GroundCover instance args | Read-only by construction; no edit path exists to verify |

**Known gap carried forward:** clicking one instance outlines the entire InstancedMesh rather than the specific instance. Resolution is correctly isolated; only the visual highlight is mesh-wide. Recorded in `stage5-instanced-mesh-support.md`.

## Triage Rule for Future Stages

Dogfooding will keep surfacing engine gaps. Stage 4 accumulated four unplanned capability changes because there was no rule for deciding what belonged in the stage. Going forward:

**In-stage** — a gap is fixed within the current stage only if it blocks that stage's stated objective. The InstancedMesh work qualified: most of the scene is instanced, so per-instance provenance could not be demonstrated at all without it.

**Deferred** — a gap that is real but does not block the stated objective is recorded in the relevant architecture document's Known Gaps section and scheduled, not fixed in-stage. The mesh-wide selection highlight and the read-only validation follow-up are both examples.

Every deferred gap must be written down when found. A stage closes when its stated objectives are met and its deferrals are recorded — not when no known gaps remain.

# Stage 5 Addendum: InstancedMesh Per-Instance Provenance

This document serves as an addendum to `metadata-convention.pdf` and the `Stage 3 Implementation Validation Report`. It is the reference cited by the `@see` comment on `InstanceSourceRef` in `@click-to-source/shared`.

## Finding

Stage 3 resolution walked `userData.sourceRef` up the parent chain. That model assumes one object maps to one generating call site. `THREE.InstancedMesh` breaks the assumption: thousands of instances share a single `Object3D`, a single `userData`, and a single material. Clicking any tree in the Procedural Low-Poly World Generator resolved to whatever the parent walk found — the containing group, or the terrain behind it — never the specific instance.

The generating call site for an instance is also not a fixed literal. Each instance's position, scale, and yaw come from a seeded RNG inside a placement loop. There is no literal in source corresponding to "the tree at x=41.2".

## Resolution — Phase 1: Per-Instance Lookup

**Shape.** `InstanceSourceRef` in `@click-to-source/shared` wraps a standard `SourceRef`:

    export type InstanceSourceRef = {
      sourceRef: SourceRef;
    };

Generators store an array of these on the mesh as `userData.instanceSourceRefs`, indexed 1:1 by Three.js `instanceId`. The wrapper exists so per-instance entries can later carry fields a plain `SourceRef` should not have, without widening `SourceRef` itself.

**Lookup.** `resolveInstanceSourceRef` in `@click-to-source/core/src/resolver.ts` is module-private and reached only through `resolveSourceRef(object, instanceId)`. It returns `null` — never throws — when:

1. `instanceId` is `undefined` or `null`.
2. `userData.instanceSourceRefs` is absent or not an array.
3. `instanceId` is negative or `>= refs.length`.
4. The entry at that index has no `.sourceRef`.

**Fall-through is the compatibility guarantee.** Every `null` above falls through to the Stage 3 parent walk unchanged. A non-instanced object, or an InstancedMesh clicked without an `instanceId`, resolves exactly as it did before Stage 5. This is the property most worth preserving in future changes.

**Transport.** `resolveObjectAtPoint` reads `instanceId` off the `THREE.Intersection` and forwards it; `useClickToSource` forwards `event.instanceId` from the R3F synthetic event.

## Resolution — Phase 2: Read-Only Presentation

Per-instance provenance is **read-only by construction**. `resolveInstanceSourceRef` hardcodes `readonly: true`, because an instance's args are RNG outputs with no editable literal behind them. Offering an input for them would promise a write-back that cannot exist.

`overlayStore` stores `result.readonly ?? false`, so the standard non-instanced path is unaffected. `GenerationTrace` renders args as plain text instead of inputs when the flag is set.

Note on ordering: the read-only UI landed in `eff2c21`, *before* the core resolution in `5d03a07` — despite the latter carrying the "Phase 1" label. The phases here describe layers, not chronology.

## Resolution — Display Keys vs. Declared Identifiers

`editSource` matches its `argName` against the identifier **as declared in source**. Nothing previously required `sourceRef.args` keys to equal those identifiers, and the coupling was undocumented.

Terrain satisfied it by accident: `args: { noiseFloor, lakeBedLevel }` uses JS shorthand, so keys and declarations are identical. Water did not — `args: { waterLevel: WATER_LEVEL, ... }` pairs camelCase display keys with SCREAMING_CASE module constants. Every Water edit failed with `ARGUMENT_NOT_FOUND`, and the failure surfaced only after Save was clicked.

**Fix.** `SourceRef` gained an optional `argSources` map from display key to declared identifier. Keys absent from the map resolve to themselves, so omitting the field entirely preserves prior behaviour.

    argSources: {
      waterLevel: 'WATER_LEVEL',
      deepColor: 'WATER_DEEP_COLOR',
      shallowColor: 'WATER_SHALLOW_COLOR',
    }

**Why the overlay and not core.** Resolution happens in `editSourceFile`, which already owns the `SourceRef` to `EditRequest` translation. Core's contract stays narrow and unambiguous: *given a file, a line, and a declared identifier, rewrite the literal.* Threading the map into `editSource` would have widened `EditRequest` and made core responsible for a presentation concern.

**Limits.** `argSources` maps names; it cannot conjure a literal that does not exist. Water's `terrainSize` is a prop, traceable only to `ALPINE_TERRAIN.worldSize`, which is shared by Terrain, Trees, and GroundCover — editing it from the Water panel would silently resize the whole world. It was removed from `args` rather than shipped as a field that always fails.

## Consumer Requirements

`InstancedMesh` raycasting requires explicit bounding volumes. Without `computeBoundingBox()` and `computeBoundingSphere()` after the matrices are written, raycasts fall through the instanced mesh entirely and resolve to whatever geometry sits behind it. This cost the Trees integration a debugging cycle (`63604ba`) — trees resolved to Terrain until the volumes were computed.

## Known Gaps

**Args are not validated when the panel opens.** An arg with no resolvable literal — a prop, a member expression, a mismatched identifier — still renders as an editable input and only reports `ARGUMENT_NOT_FOUND` after Save. The `readonly` render path already produces exactly the needed state, so the fix is to resolve each arg against the source at panel-open time and mark the unresolvable ones read-only. `argSources` makes the mismatch *expressible*; it does not make it *detectable*. Tracked by a TODO in `GenerationTrace.tsx`.

**The raycast to `instanceId` integration path is untested.** The 8 tests in `resolver.test.ts` all enter through `resolveSourceRef` with an `instanceId` supplied directly. Nothing verifies that `resolveObjectAtPoint` extracts `instanceId` from a real `THREE.Intersection` and forwards it — which is precisely the path that failed in `63604ba`. A test needs `setMatrixAt` per instance, explicit bounding-volume computation, and a camera aimed at a known instance. Whether Three's InstancedMesh raycast yields `instanceId` correctly under headless vitest has not been established, and is the first thing to confirm.

**Selection highlighting is mesh-wide, not instance-specific.** Clicking a single instance outlines every instance sharing that `InstancedMesh` — every tree in the same foliage colour group, or every grass tuft or bush of the same variant. The chain is `resolveInstanceSourceRef` returning the InstancedMesh itself as `result.object`, `overlayStore` storing that as `selectedObject`, and `SelectionHighlight` assigning it to `outlinePass.selectedObjects`. `OutlinePass` has no native concept of highlighting one instance within a mesh, so the whole mesh lights up.

Per-instance *resolution* is correctly isolated — manual testing confirms that clicking different grass instances returns different `variant`, `x`, `z`, and `yaw` values. Only the visual highlight is wrong. Editing is unaffected, since instanced provenance is read-only by construction. A fix likely requires either per-instance colour attributes or a separate highlighting mechanism for instanced objects, such as a transient outline proxy positioned at the instance matrix. Note that `instanceId` is already stored in `overlayStore`; `SelectionHighlight` simply does not consume it. Out of scope for Stage 5.

**End-to-end browser behaviour is unverified by automation.** Instance resolution has been confirmed by direct calls against the built resolver and by unit tests. Clicking an actual tree, grass tuft, bush, or the water surface in a running browser remains a manual check.

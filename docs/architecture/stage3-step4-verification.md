# Stage 3 Step 4 — Visual Selection Feedback Verification

## Purpose

Step 4 implements visual selection feedback for the interactive overlay. When a user clicks a tagged mesh in the R3F scene, the selected object receives a green outline rendered via Three.js postprocessing. This provides immediate visual confirmation that the provenance system correctly identified the clicked object.

Step 4 is the final visual integration step before Step 5 (source-info panel overlay). It validates that the full pipeline — from click event through core resolution, Zustand state management, and postprocessing rendering — functions correctly under real interaction conditions including camera movement.

---

## Implementation

### OutlinePass / EffectComposer

The visual highlight is implemented in [`SelectionHighlight.tsx`](file:///c:/Users/sarma/OneDrive/Desktop/My%20FIles/My%20Project/click-to-source/packages/overlay/src/components/SelectionHighlight.tsx) using Three.js postprocessing classes imported directly from `three/examples/jsm/postprocessing/`:

- **`EffectComposer`** — Manages the postprocessing pipeline. Created once per R3F context and attached to the WebGL renderer.
- **`RenderPass`** — Renders the scene normally as the first pass.
- **`OutlinePass`** — Draws a configurable outline around selected objects as the second pass.

OutlinePass configuration:

| Parameter | Value | Description |
|-----------|-------|-------------|
| `edgeStrength` | 5 | Outline intensity |
| `edgeGlow` | 1 | Glow spread |
| `edgeThickness` | 2 | Edge width in pixels |
| `visibleEdgeColor` | `#00ff00` | Green for visible edges |
| `hiddenEdgeColor` | `#00aa00` | Darker green for occluded edges |

### Data Flow: Zustand → SelectionHighlight → OutlinePass

The selection data flow follows this path:

```
User Click (R3F onPointerUp)
  → useClickToSource() hook
    → resolveSourceRef() (core resolver — walks parent chain for userData.sourceRef)
      → useOverlayStore.getState().select(result)
        → Zustand state update: { selectedObject, sourceRef, panelOpen }
          → SelectionHighlight subscribes via useOverlayStore(state => state.selectedObject)
            → useEffect sets outlinePass.selectedObjects = [selectedObject]
              → OutlinePass renders outline on next frame
```

Deselection follows the inverse path:

- Clicking an untagged mesh: `resolveSourceRef()` returns `null` → `clearSelection()` → `selectedObjects = []`
- Clicking the background: `Canvas.onPointerMissed` → `clearSelection()` → `selectedObjects = []`

### R3F Render Lifecycle Integration

`SelectionHighlight` integrates with the R3F render loop via:

1. **`useThree()`** — Accesses `gl` (WebGLRenderer), `scene`, `camera`, and `size` from the R3F context.
2. **`useMemo()`** — Creates `EffectComposer`, `RenderPass`, and `OutlinePass` once, keyed on `[gl, scene, camera]`.
3. **`useEffect()` (resize)** — Updates `composer.setSize()` and `outlinePass.setSize()` when viewport dimensions change.
4. **`useEffect()` (selection)** — Updates `outlinePass.selectedObjects` when Zustand selection state changes.
5. **`useFrame(() => composer.render(), 1)`** — Takes over final rendering at priority 1 (after R3F's internal updates), ensuring the postprocessing pipeline produces the final frame.
6. **`useEffect()` (cleanup)** — Disposes `EffectComposer` and `OutlinePass` on component unmount.

The component returns `null` — it is a non-visual R3F component that only participates in the render lifecycle.

### OrbitControls (Examples Demo Only)

OrbitControls were added to the examples demo ([`main.tsx`](file:///c:/Users/sarma/OneDrive/Desktop/My%20FIles/My%20Project/click-to-source/packages/examples/src/main.tsx)) to enable camera movement testing. This is strictly a demo testing aid and is not part of `@click-to-source/core` or `@click-to-source/overlay`.

Implementation:

- Imported from `three/examples/jsm/controls/OrbitControls.js` (same import pattern as `SelectionHighlight` uses for postprocessing).
- Implemented as a dedicated `SceneOrbitControls` React component.
- Created imperatively via `useEffect` with proper `controls.dispose()` cleanup.
- Updated every frame via `useFrame(() => controls.update())`.
- `enableDamping = true` with `dampingFactor = 0.1` for smooth orbiting.
- **No new dependencies were added** — uses the already-installed `three` package.

---

## Build Note: Stale `dist/index.js`

During initial testing, the examples demo rendered a blank white screen. The browser console reported:

```
SyntaxError: The requested module '.../packages/overlay/dist/index.js'
does not provide an export named 'SelectionHighlight'
```

**Root cause:** The overlay package's `dist/` output was stale. While `packages/overlay/src/index.ts` correctly exported `SelectionHighlight`, the compiled `dist/index.js` had not been regenerated after `SelectionHighlight.tsx` was added to the source barrel file.

**Resolution:** Running `npm run build` (`tsc -b`) in `packages/overlay` regenerated `dist/index.js` to include the `SelectionHighlight` re-export. Vite's HMR picked up the change and the demo loaded successfully.

This is a standard monorepo workflow issue — when consuming packages via their `dist/` output (as configured by `"main": "dist/index.js"` in `package.json`), the build must be re-run after source changes.

---

## Automated Verification

### Core Tests

```
packages/core — vitest run
✓ test/resolver.test.ts (6 tests) — 11ms
Test Files  1 passed (1)
Tests       6 passed (6)
```

### Overlay Tests

```
packages/overlay — vitest run
✓ test/overlayStore.test.ts (4 tests) — 8ms
Test Files  1 passed (1)
Tests       4 passed (4)
```

### Examples Vite Build

```
packages/examples — vite build
✓ 47 modules transformed
✓ built in 1.25s
dist/index.html                    0.49 kB
dist/assets/index-X_rzg29T.js  1,311.85 kB
```

All automated checks pass. No errors. No test failures.

---

## Manual Verification

The following tests were performed manually by the developer against the running Vite dev server at `http://localhost:5173/` with OrbitControls active.

### Selection Tests

| Test | Description | Result |
|------|-------------|--------|
| A | Select pink cube → green OutlinePass highlight appears | ✅ Pass |
| B | Orbit/rotate camera substantially → highlight remains correctly attached to the pink cube | ✅ Pass |
| C | Zoom in and out → highlight remains correctly aligned with the selected mesh | ✅ Pass |
| D | Select cyan sphere after moving the camera → sphere becomes highlighted and pink loses its highlight | ✅ Pass |
| E | Orbit again with sphere selected → highlight remains correctly attached | ✅ Pass |
| F | Click orange untagged cube → highlight clears and `No sourceRef (null)` is shown | ✅ Pass |
| G | Click background → highlight remains cleared | ✅ Pass |
| H | Rapidly switch selections after camera movement → selection/highlighting remains correct | ✅ Pass |

All 8 manual verification tests pass.

### Visual Observation: Outline Thickness

The OutlinePass outline is rendered in pixel space (screen-space edge detection). As a result:

- The apparent outline becomes **thinner** when zoomed out (object occupies fewer pixels).
- The apparent outline becomes **thicker** when zoomed in (object occupies more pixels).

This is standard OutlinePass behavior and is **not** considered a correctness bug. The outline is correctly attached to the selected object at all camera distances and angles. No change is required.

---

## Files Modified

| File | Package | Change |
|------|---------|--------|
| `packages/examples/src/main.tsx` | `@click-to-source/examples` | Added `SceneOrbitControls` component for camera movement testing |
| `packages/overlay/dist/*` | `@click-to-source/overlay` | Regenerated from source via `tsc -b` (no source changes) |

No source files were modified in `@click-to-source/core`, `@click-to-source/overlay`, or `@click-to-source/shared`.

---

## Conclusion

Stage 3 Step 4 validates the complete visual feedback pipeline:

1. **Core resolver** correctly identifies tagged meshes via `userData.sourceRef` and walks the parent chain for untagged children.
2. **Zustand store** correctly manages selection state transitions (`select`, `clearSelection`).
3. **SelectionHighlight** correctly subscribes to Zustand state and drives `OutlinePass.selectedObjects`.
4. **OutlinePass** correctly renders green edge outlines on the selected object.
5. **R3F render lifecycle** integration works correctly — `useFrame` with priority 1 ensures postprocessing runs after scene updates.
6. **Camera movement** does not break selection state or outline rendering — the outline remains correctly attached to the selected mesh during orbit, zoom, and pan.
7. **Selection switching** works correctly — selecting a new object clears the previous highlight and applies it to the new target.
8. **Deselection** works correctly — clicking untagged objects or the background clears all highlights.

---

## Step 4 Result

✓ Stage 3 Step 4 is **COMPLETE**.

Step 5 (source-info panel overlay) has **not** been started.

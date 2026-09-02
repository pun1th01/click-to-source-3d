// @vitest-environment jsdom
import { describe, expect, it, beforeEach, vi } from "vitest";
import * as THREE from "three";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";

/**
 * Covers the frame request the outline depends on.
 *
 * Under `frameloop="demand"` R3F runs a frame only when something asks for
 * one. The selection arrives from a store R3F does not observe, so without an
 * explicit request no frame is scheduled and the outline never updates —
 * silently, which is what made the original incident reach a consumer instead
 * of a test.
 *
 * What this proves, and what it does not. `@react-three/fiber` is stubbed at
 * the hook boundary: no WebGL exists under Node, and SelectionHighlight builds
 * an EffectComposer during render. So this asserts that the component *asks*
 * for a frame, not that one is drawn, and it would keep passing if R3F renamed
 * `invalidate` — the stub would go on agreeing. Drawing is confirmed by a live
 * probe against a consumer app, recorded with the fix itself.
 *
 * The selection store is deliberately not stubbed. It is the real trigger, and
 * substituting it would leave the test asserting its own setup.
 */

const invalidate = vi.fn();
let frameCallback: ((state: unknown) => void) | null = null;
let framePriority: number | undefined;
const gl = {
  getPixelRatio: () => 1,
  getSize: (target: THREE.Vector2) => target.set(800, 600),
};

vi.mock("@react-three/fiber", () => ({
  // Only the two hooks the component uses. useFrame is inert: a frame that
  // actually ran would need a GL context, and this test is about whether one
  // is requested.
  useThree: () => ({
    gl,
    scene: new THREE.Scene(),
    camera: new THREE.PerspectiveCamera(),
    size: { width: 800, height: 600 },
    invalidate,
    frameloop: "demand" as const,
  }),
  useFrame: (callback: (state: unknown) => void, priority?: number) => {
    frameCallback = callback;
    framePriority = priority;
  },
}));

const { SelectionHighlight } = await import(
  "../src/components/SelectionHighlight.js"
);
const { useOverlayStore } = await import("../src/store/overlayStore.js");

function mount(): Root {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(React.createElement(SelectionHighlight));
  });
  return root;
}

describe("SelectionHighlight frame requests", () => {
  beforeEach(() => {
    invalidate.mockClear();
    act(() => {
      useOverlayStore.getState().clearSelection();
    });
    invalidate.mockClear();
  });

  it("asks for a frame when an object becomes selected", () => {
    mount();
    invalidate.mockClear();

    const object = new THREE.Mesh(
      new THREE.BoxGeometry(),
      new THREE.MeshBasicMaterial()
    );

    act(() => {
      useOverlayStore.setState({ selectedObject: object });
    });

    expect(invalidate).toHaveBeenCalled();
  });

  // Deselection needs a frame just as much: the outline has to be taken away,
  // and nothing else is going to schedule that.
  it("asks for a frame when the selection is cleared", () => {
    mount();

    act(() => {
      useOverlayStore.setState({
        selectedObject: new THREE.Mesh(
          new THREE.BoxGeometry(),
          new THREE.MeshBasicMaterial()
        ),
      });
    });

    invalidate.mockClear();

    act(() => {
      useOverlayStore.getState().clearSelection();
    });

    expect(invalidate).toHaveBeenCalled();
  });
});

/**
 * With nothing selected, the component must render the way R3F would have.
 *
 * A useFrame with priority above 0 makes R3F stop rendering entirely — its own
 * call is `gl.render(scene, camera)`, made only when no subscriber has claimed
 * a priority. So every frame in the host application goes through this
 * callback for as long as the component is mounted, and sending them all
 * through the EffectComposer cost the whole app its antialiasing: the default
 * render target is built without `samples`.
 *
 * Only the idle branch is exercised. The selected branch calls
 * composer.render(), which needs a GL context that does not exist here — the
 * same boundary the frame-request tests above run into.
 */
describe("SelectionHighlight idle rendering", () => {
  beforeEach(() => {
    frameCallback = null;
    framePriority = undefined;
    act(() => {
      useOverlayStore.getState().clearSelection();
    });
  });

  it("claims a priority, which is what makes R3F hand over the render", () => {
    mount();

    expect(framePriority).toBeGreaterThan(0);
  });

  it("renders through R3F's own path while nothing is selected", () => {
    mount();

    const render = vi.fn();
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera();

    frameCallback?.({ gl: { render }, scene, camera });

    expect(render).toHaveBeenCalledWith(scene, camera);
  });
});

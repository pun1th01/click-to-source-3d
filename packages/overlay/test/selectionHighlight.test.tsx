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
  useFrame: () => undefined,
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

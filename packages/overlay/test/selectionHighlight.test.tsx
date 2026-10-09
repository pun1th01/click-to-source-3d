// @vitest-environment jsdom
import { describe, expect, it, beforeEach, vi } from "vitest";
import * as THREE from "three";
import React, { act } from "react";
import { createRoot } from "react-dom/client";

/**
 * SelectionHighlight draws through a wrapper on the renderer's own render(),
 * so these drive it with a stand-in renderer that records what is drawn.
 * R3F's hooks are stubbed at the boundary because no WebGL exists under
 * Node; the selection store is the real one, since it is the trigger.
 */

const invalidate = vi.fn();
const drawn: THREE.Object3D[] = [];
const appScene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera();
const gl = {
  autoClear: true,
  xr: { isPresenting: false },
  getRenderTarget: () => null,
  render: (scene: THREE.Object3D) => {
    drawn.push(scene);
  },
};
const useFrame = vi.fn();

vi.mock("@react-three/fiber", () => {
  const state = { gl, camera, invalidate, frameloop: "demand" as const };
  return {
    useThree: (selector?: (s: typeof state) => unknown) => (selector ? selector(state) : state),
    useFrame,
  };
});

const { SelectionHighlight } = await import("../src/components/SelectionHighlight.js");
const { useOverlayStore } = await import("../src/store/overlayStore.js");

function mount() {
  const container = document.createElement("div");
  const root = createRoot(container);
  act(() => {
    root.render(React.createElement(SelectionHighlight));
  });
  return root;
}

const box = () => new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshBasicMaterial());

describe("SelectionHighlight", () => {
  beforeEach(() => {
    invalidate.mockClear();
    drawn.length = 0;
    act(() => useOverlayStore.getState().clearSelection());
  });

  // The regression: priority 1 made R3F hand this component the whole loop.
  it("never claims the render loop", () => {
    const root = mount();

    expect(useFrame).not.toHaveBeenCalled();
    act(() => root.unmount());
  });

  it("draws nothing extra while nothing is selected", () => {
    const root = mount();

    gl.render(appScene);

    expect(drawn).toEqual([appScene]);
    act(() => root.unmount());
  });

  it("draws the highlight after the application's frame once something is selected", () => {
    const root = mount();
    act(() => useOverlayStore.setState({ selectedObject: box(), instanceId: null }));

    drawn.length = 0;
    gl.render(appScene);

    expect(drawn[0]).toBe(appScene);
    expect(drawn).toHaveLength(2);
    expect((drawn[1] as THREE.Scene).isScene).toBe(true);
    act(() => root.unmount());
  });

  // Under frameloop="demand" nothing else would schedule a frame.
  it("asks for a frame when the selection changes either way", () => {
    const root = mount();
    invalidate.mockClear();

    act(() => useOverlayStore.setState({ selectedObject: box() }));
    expect(invalidate).toHaveBeenCalled();

    invalidate.mockClear();
    act(() => useOverlayStore.getState().clearSelection());
    expect(invalidate).toHaveBeenCalled();
    act(() => root.unmount());
  });

  it("removes its wrapper from the renderer on unmount", () => {
    const original = gl.render;
    const root = mount();
    expect(gl.render).not.toBe(original);

    act(() => root.unmount());

    expect(gl.render).toBe(original);
  });
});

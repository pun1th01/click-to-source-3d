import { describe, it, expect, beforeEach } from "vitest";
import * as THREE from "three";
import { useOverlayStore } from "../src/store/overlayStore";

describe("overlayStore", () => {
  beforeEach(() => {
    useOverlayStore.setState({ selectedObject: null, sourceRef: null, panelOpen: false });
  });

  it("should have correct initial state", () => {
    const state = useOverlayStore.getState();
    expect(state.selectedObject).toBeNull();
    expect(state.sourceRef).toBeNull();
    expect(state.instanceId).toBeNull();
    expect(state.readonly).toBe(false);
    expect(state.panelOpen).toBe(false);
  });

  it("should update state on select", () => {
    const mesh = new THREE.Mesh();
    const sourceRef = { file: "App.tsx", function: "App", line: 10, args: {} };
    
    useOverlayStore.getState().select({ object: mesh, sourceRef });

    const state = useOverlayStore.getState();
    expect(state.selectedObject).toBe(mesh);
    expect(state.sourceRef).toEqual(sourceRef);
    expect(state.instanceId).toBeNull();
    expect(state.readonly).toBe(false);
    expect(state.panelOpen).toBe(true);
  });

  it("should clear state on clearSelection", () => {
    useOverlayStore.getState().clearSelection();

    const state = useOverlayStore.getState();
    expect(state.selectedObject).toBeNull();
    expect(state.sourceRef).toBeNull();
    expect(state.instanceId).toBeNull();
    expect(state.readonly).toBe(false);
    expect(state.panelOpen).toBe(false);
  });

  it("should set panel visibility without affecting selection", () => {
    const mesh = new THREE.Mesh();
    const sourceRef = { file: "Box.tsx", function: "Box", line: 5, args: {} };
    
    useOverlayStore.getState().select({ object: mesh, sourceRef });
    
    // Close panel
    useOverlayStore.getState().setPanelOpen(false);
    
    let state = useOverlayStore.getState();
    expect(state.panelOpen).toBe(false);
    expect(state.selectedObject).toBe(mesh);
    expect(state.sourceRef).toEqual(sourceRef);

    // Open panel
    useOverlayStore.getState().setPanelOpen(true);
    
    state = useOverlayStore.getState();
    expect(state.panelOpen).toBe(true);
    expect(state.selectedObject).toBe(mesh);
    expect(state.sourceRef).toEqual(sourceRef);
  });

  it("should update the selected argument after a source edit succeeds", () => {
    const mesh = new THREE.Mesh();
    const sourceRef = {
      file: "src/main.tsx",
      function: "Scene",
      line: 77,
      args: { color: "hotpink" },
    };

    useOverlayStore.getState().select({ object: mesh, sourceRef });
    useOverlayStore.getState().updateSourceRefArg("color", "cyan");

    expect(useOverlayStore.getState().sourceRef).toEqual({
      ...sourceRef,
      args: { color: "cyan" },
    });
  });

  describe("meshDetailsOpen", () => {
    it("is closed by default", () => {
      useOverlayStore.setState({ meshDetailsOpen: false });

      expect(useOverlayStore.getState().meshDetailsOpen).toBe(false);
    });

    it("toggles through setMeshDetailsOpen", () => {
      useOverlayStore.getState().setMeshDetailsOpen(true);
      expect(useOverlayStore.getState().meshDetailsOpen).toBe(true);

      useOverlayStore.getState().setMeshDetailsOpen(false);
      expect(useOverlayStore.getState().meshDetailsOpen).toBe(false);
    });

    // It is a preference, not selection state. Resetting it on either
    // transition would mean re-opening the disclosure on every click.
    it("survives select", () => {
      useOverlayStore.getState().setMeshDetailsOpen(true);

      useOverlayStore.getState().select({
        object: new THREE.Mesh(),
        sourceRef: { file: "a.tsx", function: "A", line: 1, args: {} },
      });

      expect(useOverlayStore.getState().meshDetailsOpen).toBe(true);
    });

    it("survives clearSelection", () => {
      useOverlayStore.getState().setMeshDetailsOpen(true);

      useOverlayStore.getState().clearSelection();

      expect(useOverlayStore.getState().meshDetailsOpen).toBe(true);
      expect(useOverlayStore.getState().selectedObject).toBeNull();
    });
  });

});

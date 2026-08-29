import { create } from "zustand";
import type * as THREE from "three";
import type { ResolutionResult } from "@click-to-source/core";
import type { SourceRef } from "@click-to-source/shared";

export type OverlayState = {
  selectedObject: THREE.Object3D | null;
  sourceRef: SourceRef | null;
  instanceId: number | null;
  readonly: boolean;
  panelOpen: boolean;
  /**
   * Whether the mesh attributes disclosure is expanded. A preference rather
   * than selection state: deliberately untouched by select and
   * clearSelection, so it survives from one click to the next.
   */
  meshDetailsOpen: boolean;

  select: (result: ResolutionResult) => void;
  clearSelection: () => void;
  setPanelOpen: (open: boolean) => void;
  setMeshDetailsOpen: (open: boolean) => void;
  updateSourceRefArg: (argName: string, value: unknown) => void;
};

export const useOverlayStore = create<OverlayState>((set) => ({
  selectedObject: null,
  sourceRef: null,
  instanceId: null,
  readonly: false,
  panelOpen: false,
  meshDetailsOpen: false,

  select: (result) =>
    set({
      selectedObject: result.object,
      sourceRef: result.sourceRef,
      instanceId: result.instanceId ?? null,
      readonly: result.readonly ?? false,
      panelOpen: true,
    }),

  clearSelection: () =>
    set({
      selectedObject: null,
      sourceRef: null,
      instanceId: null,
      readonly: false,
      panelOpen: false,
    }),

  setPanelOpen: (open) => set({ panelOpen: open }),

  // Intentionally omitted from select and clearSelection above: resetting it
  // per selection would defeat the point of persisting it.
  setMeshDetailsOpen: (open) => set({ meshDetailsOpen: open }),

  updateSourceRefArg: (argName, value) =>
    set((state) => {
      if (!state.sourceRef) {
        return state;
      }

      return {
        sourceRef: {
          ...state.sourceRef,
          args: {
            ...state.sourceRef.args,
            [argName]: value,
          },
        },
      };
    }),
}));

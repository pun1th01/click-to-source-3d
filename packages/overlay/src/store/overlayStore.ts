import { create } from "zustand";
import type * as THREE from "three";
import type { ResolutionResult } from "@click-to-source/core";
import type { SourceRef } from "@click-to-source/shared";

export type OverlayState = {
  selectedObject: THREE.Object3D | null;
  sourceRef: SourceRef | null;
  panelOpen: boolean;

  select: (result: ResolutionResult) => void;
  clearSelection: () => void;
  setPanelOpen: (open: boolean) => void;
  updateSourceRefArg: (argName: string, value: unknown) => void;
};

export const useOverlayStore = create<OverlayState>((set) => ({
  selectedObject: null,
  sourceRef: null,
  panelOpen: false,

  select: (result) =>
    set({
      selectedObject: result.object,
      sourceRef: result.sourceRef,
      panelOpen: true,
    }),

  clearSelection: () =>
    set({
      selectedObject: null,
      sourceRef: null,
      panelOpen: false,
    }),

  setPanelOpen: (open) => set({ panelOpen: open }),

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

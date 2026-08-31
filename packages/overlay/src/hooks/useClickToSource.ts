import { ThreeEvent } from "@react-three/fiber";
import { resolveSourceRef, ResolutionResult } from "@click-to-source-3d/core";

/**
 * A thin R3F wrapper that translates pointer events into core provenance resolution.
 */
export function useClickToSource() {
  return function resolveClick(
    event: ThreeEvent<PointerEvent | MouseEvent>
  ): ResolutionResult | null {
    // The R3F synthetic event already contains the intersected object.
    // We pass it directly to the core resolver, avoiding a redundant second raycast.
    return resolveSourceRef(event.object, event.instanceId);
  };
}

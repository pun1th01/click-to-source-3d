import React, { useEffect, useMemo, useRef } from "react";
import { useThree } from "@react-three/fiber";
import { attachHighlight, HighlightLayer } from "@click-to-source-3d/core/devtools";
import { useOverlayStore } from "../store/overlayStore.js";
import { DEV } from "../env.js";

/**
 * Warn once per page, not once per mount. StrictMode mounts effects twice in
 * development, so an unguarded warning arrives in pairs and reads like two
 * separate problems.
 */
const warned = new Set<string>();

function warnOnce(key: string, message: string): void {
  if (warned.has(key)) {
    return;
  }

  warned.add(key);
  console.warn(message);
}

/**
 * Highlights the selected object. Renders nothing in a production build.
 */
export function SelectionHighlight() {
  return DEV ? <SelectionBox /> : null;
}

/**
 * Draws a box around the selected object — or, for an InstancedMesh, around
 * the one instance that was clicked — after each frame R3F renders.
 *
 * It used to be an OutlinePass driven from useFrame at priority 1, which made
 * R3F hand it the whole render loop. That fought any other post-processing
 * for the loop, and its render target had no multisampling, so the app lost
 * antialiasing while anything was selected. It also outlined every instance
 * of an instanced mesh, since an outline pass only knows whole objects.
 *
 * Now it shares the injected inspector's highlight: a separate pass drawn
 * after the application's own frame, which leaves the render loop alone.
 *
 * Under frameloop="demand" a frame only runs when something asks for one.
 * The selection arrives from a store R3F does not observe, so the effect
 * below asks; without it the box would never appear and nothing would say
 * why.
 */
function SelectionBox() {
  const gl = useThree((state) => state.gl);
  const camera = useThree((state) => state.camera);
  const invalidate = useThree((state) => state.invalidate);
  const frameloop = useThree((state) => state.frameloop);
  const selectedObject = useOverlayStore((state) => state.selectedObject);
  const instanceId = useOverlayStore((state) => state.instanceId);

  // Read when each frame is drawn, so a camera swapped by the application is
  // followed without re-attaching.
  const cameraRef = useRef(camera);
  cameraRef.current = camera;

  const layer = useMemo(() => new HighlightLayer(), []);

  useEffect(() => {
    if (!gl) {
      return;
    }
    const detach = attachHighlight(gl, layer, () => cameraRef.current);
    return () => {
      detach();
    };
  }, [gl, layer]);

  useEffect(() => () => layer.dispose(), [layer]);

  useEffect(() => {
    layer.set("selected", selectedObject ? { object: selectedObject, instanceId } : null);
    invalidate();
  }, [selectedObject, instanceId, layer, invalidate]);

  // Dev-only, and only for the cases invalidate() cannot rescue.
  useEffect(() => {
    if (!gl) {
      warnOnce(
        "no-renderer",
        "[click-to-source] SelectionHighlight has no renderer. It must be " +
          "rendered inside a <Canvas>; outside one there is nothing to draw to."
      );
      return;
    }

    if (frameloop === "never") {
      warnOnce(
        "frameloop-never",
        '[click-to-source] SelectionHighlight is inside a Canvas with ' +
          'frameloop="never", so the highlight shows only when your application ' +
          "next renders. Call advance() after changing the selection, or use " +
          '"demand", which this component invalidates for.'
      );
    }
  }, [gl, frameloop]);

  return null;
}

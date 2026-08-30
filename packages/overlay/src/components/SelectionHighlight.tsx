import React, { useEffect, useMemo } from "react";
import { useFrame, useThree } from "@react-three/fiber";
import * as THREE from "three";
import { EffectComposer } from "three/examples/jsm/postprocessing/EffectComposer.js";
import { RenderPass } from "three/examples/jsm/postprocessing/RenderPass.js";
import { OutlinePass } from "three/examples/jsm/postprocessing/OutlinePass.js";
import { OutputPass } from "three/examples/jsm/postprocessing/OutputPass.js";
import { useOverlayStore } from "../store/overlayStore.js";

declare const process: { env: { NODE_ENV?: string } };

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
 * True unless a bundler has told us this is a production build.
 *
 * Written as a bare `process.env.NODE_ENV` read because that is the literal
 * every bundler substitutes; routing it through a variable would defeat the
 * substitution. The catch covers an unbundled consumer, where `process` is
 * simply not defined — treated as development, since the only cost is a
 * warning and the alternative is a ReferenceError inside a component.
 */
const DEV = (() => {
  try {
    return process.env.NODE_ENV !== "production";
  } catch {
    return true;
  }
})();

/**
 * Outlines the selected object.
 *
 * Must be rendered inside the Canvas, and it takes over rendering: the
 * useFrame below runs at priority 1, and any priority above 0 makes R3F stop
 * rendering the scene itself and hand the job to the subscriber. Two
 * consequences a consumer needs to know about, neither of which is obvious
 * from the outside:
 *
 * It will not compose with other post-processing that also claims a priority
 * — whichever renders last wins, and the other's output is discarded.
 *
 * Under `frameloop="demand"` a frame only runs when something asks for one.
 * Selection arrives from a store outside R3F, which does not ask, so the
 * outline would never appear and nothing would report why. That is what the
 * invalidate() call below exists for; it was a real silent failure, not a
 * hypothetical.
 */
export function SelectionHighlight() {
  const { gl, scene, camera, size, invalidate, frameloop } = useThree();
  const selectedObject = useOverlayStore((state) => state.selectedObject);

  const { composer, outlinePass } = useMemo(() => {
    const composer = new EffectComposer(gl);
    const renderPass = new RenderPass(scene, camera);
    composer.addPass(renderPass);

    const outlinePass = new OutlinePass(
      new THREE.Vector2(size.width, size.height),
      scene,
      camera
    );
    
    // Sensible minimal defaults for OutlinePass
    outlinePass.edgeStrength = 5;
    outlinePass.edgeGlow = 1;
    outlinePass.edgeThickness = 2;
    outlinePass.visibleEdgeColor.set("#00ff00"); // Green for visible
    outlinePass.hiddenEdgeColor.set("#00aa00");  // Darker green for hidden edges
    
    composer.addPass(outlinePass);

    const outputPass = new OutputPass();
    composer.addPass(outputPass);

    return { composer, outlinePass };
  }, [gl, scene, camera]); // Intentionally not including 'size' to avoid recreation on resize

  // Handle resize
  useEffect(() => {
    // Both composer and outlinePass need to be informed of size changes
    const pixelRatio = gl.getPixelRatio();
    composer.setSize(size.width, size.height);
    composer.setPixelRatio(pixelRatio);
    // OutlinePass takes raw width/height, often adjusted for pixel ratio internally but usually just the same size as composer is fine.
    // three.js OutlinePass sometimes requires explicit setSize with logical resolution.
    outlinePass.setSize(size.width, size.height);
  }, [composer, outlinePass, size, gl]);

  // Handle selection updates
  useEffect(() => {
    if (selectedObject) {
      outlinePass.selectedObjects = [selectedObject];
    } else {
      outlinePass.selectedObjects = [];
    }

    // Ask for a frame. Under frameloop="demand" nothing else will: the
    // selection came from a store R3F does not observe, so without this the
    // outline changes only if some other cause happens to schedule a frame.
    invalidate();
  }, [selectedObject, outlinePass, invalidate]);

  // The failure this component shipped with was silent — no error, no
  // warning, an overlay that simply did not draw. Dev-only, and only for the
  // cases invalidate() cannot rescue.
  useEffect(() => {
    if (!DEV) {
      return;
    }

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
          'frameloop="never", so the highlight will not render. This ' +
          "component draws through the render loop, and with frameloop " +
          '"never" the application drives frames itself — call advance() ' +
          "after changing the selection, or use \"demand\", which this " +
          "component invalidates for."
      );
    }
  }, [gl, frameloop]);

  // Handle rendering lifecycle
  // priority 1 ensures this runs after R3F's internal updates but we take over the final render
  useFrame(() => {
    composer.render();
  }, 1);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      // EffectComposer and some passes have a dispose method
      if (typeof composer.dispose === "function") {
        composer.dispose();
      }
      if (typeof outlinePass.dispose === "function") {
        outlinePass.dispose();
      }
    };
  }, [composer, outlinePass]);

  return null;
}

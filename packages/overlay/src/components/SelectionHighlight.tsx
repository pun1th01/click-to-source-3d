import React, { useEffect, useMemo } from "react";
import { useFrame, useThree } from "@react-three/fiber";
import * as THREE from "three";
import { EffectComposer } from "three/examples/jsm/postprocessing/EffectComposer.js";
import { RenderPass } from "three/examples/jsm/postprocessing/RenderPass.js";
import { OutlinePass } from "three/examples/jsm/postprocessing/OutlinePass.js";
import { OutputPass } from "three/examples/jsm/postprocessing/OutputPass.js";
import { useOverlayStore } from "../store/overlayStore.js";

export function SelectionHighlight() {
  const { gl, scene, camera, size } = useThree();
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
  }, [selectedObject, outlinePass]);

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

import { useEffect } from "react";
import { useThree } from "@react-three/fiber";
import { connectBridge, setBridgeScene } from "@click-to-source/core";

/**
 * Connects the running scene to the bridge, so an out-of-process client can
 * ask the page about its own contents.
 *
 * Must be rendered inside the Canvas. The bridge needs a scene and a camera,
 * and only a component inside the R3F tree can supply them — which is why
 * this is a component the consumer adds rather than something the Vite plugin
 * can inject, as it does for the capture probe.
 *
 * Renders nothing.
 */
export function ClickToSourceBridge() {
  const scene = useThree((state) => state.scene);
  const camera = useThree((state) => state.camera);

  useEffect(() => {
    setBridgeScene({ scene, camera });
    const disconnect = connectBridge();

    return () => {
      // Detaching the scene on unmount matters more than closing the stream:
      // a query arriving mid-teardown must report no_scene rather than
      // raycasting against a graph that is being dismantled.
      setBridgeScene(null);
      disconnect();
    };
  }, [scene, camera]);

  return null;
}

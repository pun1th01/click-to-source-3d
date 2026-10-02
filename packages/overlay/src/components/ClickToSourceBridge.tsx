import { useEffect } from "react";
import { useThree } from "@react-three/fiber";
import { connectBridge, setBridgeScene } from "@click-to-source-3d/core";
import { DEV } from "../env.js";

/**
 * Connects the running scene to the bridge, so an out-of-process client can
 * ask the page about its own contents.
 *
 * Must be rendered inside the Canvas. The bridge needs a scene and a camera,
 * and only a component inside the R3F tree can supply them.
 *
 * Renders nothing, and in a production build connects nothing: the endpoint
 * it would open exists only on the dev server, and EventSource retries a
 * missing one indefinitely.
 */
export function ClickToSourceBridge() {
  return DEV ? <BridgeConnection /> : null;
}

function BridgeConnection() {
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

import React, { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { Canvas, ThreeEvent, useFrame, useThree } from "@react-three/fiber";
import { useClickToSource, useOverlayStore, SelectionHighlight, GenerationTrace } from "@click-to-source/overlay";
import { ResolutionResult } from "@click-to-source/core";
import { SourceRef } from "@click-to-source/shared";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";

/**
 * Imperative OrbitControls component using Three.js's built-in OrbitControls.
 * No additional dependencies required — uses the same three/examples/jsm pattern
 * as SelectionHighlight uses for postprocessing.
 */
function SceneOrbitControls() {
  const { camera, gl } = useThree();
  const controlsRef = useRef<OrbitControls | null>(null);

  useEffect(() => {
    const controls = new OrbitControls(camera, gl.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.1;
    controlsRef.current = controls;
    return () => {
      controls.dispose();
    };
  }, [camera, gl]);

  useFrame(() => {
    controlsRef.current?.update();
  });

  return null;
}

function Scene({ onResolve }: { onResolve: (res: ResolutionResult | null) => void }) {
  // Connect R3F pointer events to core resolver
  const resolveClick = useClickToSource();

  const handlePointerUp = (e: ThreeEvent<PointerEvent>) => {
    e.stopPropagation();
    const resolved = resolveClick(e);
    onResolve(resolved);

    if (resolved) {
      useOverlayStore.getState().select(resolved);
    } else {
      useOverlayStore.getState().clearSelection();
    }
  };

  const sampleSourceRefA: SourceRef = {
    file: "src/main.tsx",
    function: "Scene",
    line: 77,
    args: {},
  };

  const sampleSourceRefB: SourceRef = {
    file: "src/main.tsx",
    function: "Scene",
    line: 83,
    args: {},
  };

  return (
    <>
      <SelectionHighlight />
      <SceneOrbitControls />
      <ambientLight intensity={Math.PI / 2} />
      <spotLight position={[10, 10, 10]} angle={0.15} penumbra={1} decay={0} intensity={Math.PI} />
      <pointLight position={[-10, -10, -10]} decay={0} intensity={Math.PI} />
      
      <group onPointerUp={handlePointerUp}>
        {/* Tagged Mesh A */}
        <mesh position={[-1.5, 0, 0]} userData={{ sourceRef: sampleSourceRefA }}>
          <boxGeometry />
          <SourceRefMaterial sourceRef={sampleSourceRefA} color="hotpink" />
        </mesh>

        {/* Tagged Mesh B */}
        <mesh position={[0, 0, 0]} userData={{ sourceRef: sampleSourceRefB }}>
          <sphereGeometry args={[0.6, 32, 32]} />
          <SourceRefMaterial sourceRef={sampleSourceRefB} color="cyan" />
        </mesh>
        
        {/* Untagged Mesh */}
        <mesh position={[1.5, 0, 0]}>
          <boxGeometry />
          <meshStandardMaterial color="orange" />
        </mesh>
      </group>
    </>
  );
}

function SourceRefMaterial({
  sourceRef,
  color,
}: {
  sourceRef: SourceRef;
  color: string;
}) {
  // Keep the hand-authored fixture metadata derived from the same literal
  // that drives the rendered material. This avoids stale args after HMR.
  sourceRef.args = { ...sourceRef.args, color };

  return <meshStandardMaterial color={color} />;
}

function App() {
  const [result, setResult] = useState<ResolutionResult | null>(null);

  const handlePointerMissed = () => {
    setResult(null);
    useOverlayStore.getState().clearSelection();
  };

  return (
    <>
      <Canvas onPointerMissed={handlePointerMissed}>
        <Scene onResolve={setResult} />
      </Canvas>
      <GenerationTrace />
    </>
  );
}

const rootRegistry = globalThis as typeof globalThis & {
  __clickToSourceReactRoot?: ReturnType<typeof createRoot>;
};
const root =
  rootRegistry.__clickToSourceReactRoot ??=
    createRoot(document.getElementById("root")!);
root.render(<App />);

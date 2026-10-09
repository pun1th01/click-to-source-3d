import React, { useEffect, useRef } from "react";
import { createRoot } from "react-dom/client";
import * as THREE from "three";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";

// ─── A plain React Three Fiber scene ───────────────────────────────────────
//
// Nothing in this file mentions click-to-source. The plugin in vite.config.ts
// is the whole setup: run `npm run dev`, press Alt+Shift+C (or the button in
// the corner of the canvas), and click anything.
//
// The constants below show a value being followed to its declaration: click
// the box, change "BOX_HEIGHT" in the panel, press Enter, and this line is
// rewritten and the box hot-reloads.
const BOX_HEIGHT = 1.4;
const SPHERE_RADIUS = 0.6;

const TREE_COUNT = 120;

/** Deterministic placement, so a reload puts every tree back where it was. */
function mulberry32(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * One InstancedMesh, many trees. Placed the way the three.js docs place
 * instances: one shared dummy, its matrix handed to setMatrixAt each time.
 * Clicking a tree in the inspector shows that one tree's transform.
 */
function InstancedTrees() {
  const meshRef = useRef<THREE.InstancedMesh>(null);

  useEffect(() => {
    const mesh = meshRef.current;
    if (!mesh) return;

    const random = mulberry32(1337);
    const dummy = new THREE.Object3D();

    for (let i = 0; i < TREE_COUNT; i++) {
      dummy.position.set(random() * 40 - 20, 0, random() * 40 - 20);
      dummy.rotation.set(0, random() * Math.PI * 2, 0);
      dummy.scale.setScalar(0.6 + random() * 0.9);
      dummy.updateMatrix();
      mesh.setMatrixAt(i, dummy.matrix);
    }

    mesh.instanceMatrix.needsUpdate = true;
  }, []);

  // frustumCulled off because the trees are placed after the mesh first
  // renders: culled against bounds computed before placement, they could
  // vanish. That is three's behaviour, not the inspector's — the inspector
  // picks instances correctly either way.
  return (
    <instancedMesh
      ref={meshRef}
      args={[undefined, undefined, TREE_COUNT]}
      frustumCulled={false}
    >
      <coneGeometry args={[0.5, 2, 7]} />
      <meshStandardMaterial color="#3f7d4f" />
    </instancedMesh>
  );
}

function Scene() {
  return (
    <>
      <SceneOrbitControls />

      <ambientLight intensity={Math.PI / 3} />
      <directionalLight position={[10, 20, 8]} intensity={2} />

      <InstancedTrees />

      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -0.01, 0]}>
        <planeGeometry args={[60, 60]} />
        <meshStandardMaterial color="#2b2f3a" />
      </mesh>

      <mesh position={[-2.2, BOX_HEIGHT / 2, 6]}>
        <boxGeometry args={[1.2, BOX_HEIGHT, 1.2]} />
        <meshStandardMaterial color="#c2643c" />
      </mesh>

      <mesh position={[2.2, SPHERE_RADIUS, 6]}>
        <sphereGeometry args={[SPHERE_RADIUS, 32, 32]} />
        <meshStandardMaterial color="#4a86c8" roughness={0.4} />
      </mesh>
    </>
  );
}

/**
 * OrbitControls straight from three's examples, so this demo needs no
 * dependency beyond R3F.
 */
function SceneOrbitControls() {
  const { camera, gl } = useThree();
  const controlsRef = useRef<OrbitControls | null>(null);

  useEffect(() => {
    const controls = new OrbitControls(camera, gl.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.1;
    controls.target.set(0, 1, 2);
    controlsRef.current = controls;

    return () => controls.dispose();
  }, [camera, gl]);

  useFrame(() => controlsRef.current?.update());

  return null;
}

function App() {
  return (
    <Canvas camera={{ position: [0, 6, 18], fov: 50 }}>
      {/* Without a scene background the canvas is transparent, and
          everything above the ground shows the white page through it. */}
      <color attach="background" args={["#1a1d26"]} />
      <Scene />
    </Canvas>
  );
}

const rootRegistry = globalThis as typeof globalThis & {
  __clickToSourceReactRoot?: ReturnType<typeof createRoot>;
};
const root = (rootRegistry.__clickToSourceReactRoot ??= createRoot(
  document.getElementById("root")!
));
root.render(<App />);

import React, { useEffect, useMemo, useRef } from "react";
import { createRoot } from "react-dom/client";
import * as THREE from "three";
import { Canvas, ThreeEvent, useFrame, useThree } from "@react-three/fiber";
import {
  useClickToSource,
  useOverlayStore,
  SelectionHighlight,
  GenerationTrace,
  ClickToSourceBridge,
} from "@click-to-source-3d/overlay";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";

// ─── Editable parameters ───────────────────────────────────────────────────
//
// These two exist to demonstrate the edit path: click the box or the sphere,
// change the value in the panel, press Save, and the plugin rewrites the
// literal below through its AST editor. Vite hot-reloads and the shape
// changes on screen.
//
// The `line:` in each sourceRef further down must name the line its constant
// is declared on — that is the location the editor matches against, and it is
// not the line the mesh sits on. Keeping both constants here, near the top,
// is what stops the two drifting apart when the scene below is edited.
//
const BOX_HEIGHT = 1.4; // line 26 — referenced by the box's sourceRef
const SPHERE_RADIUS = 0.6; // line 27 — referenced by the sphere's sourceRef

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
 * One InstancedMesh, many trees, each with its own provenance.
 *
 * There is no object per instance for the resolver to read, so the transforms
 * are recovered by the capture probe the plugin installs under
 * `captureInstances: true`. Two things this component does are load-bearing
 * for that, and both fail silently if you skip them:
 *
 * 1. `setMatrixAt` is handed a *clone*. The probe pairs a transform to a slot
 *    by the identity of the Matrix4 that `clone()` returned, so the common
 *    `dummy.updateMatrix(); mesh.setMatrixAt(i, dummy.matrix)` — passing the
 *    same object every iteration — records nothing at all.
 *
 * 2. The bounding volumes are recomputed afterwards. A raycast tests an
 *    instanced mesh's bounds before its instances, and a mesh built before
 *    its matrices were written has bounds that do not cover them: clicks miss
 *    entirely and the trees look like they have no provenance.
 */
function InstancedTrees() {
  const meshRef = useRef<THREE.InstancedMesh>(null);

  const matrices = useMemo(() => {
    const random = mulberry32(1337);
    const dummy = new THREE.Object3D();

    return Array.from({ length: TREE_COUNT }, () => {
      dummy.position.set(random() * 40 - 20, 0, random() * 40 - 20);
      dummy.rotation.set(0, random() * Math.PI * 2, 0);
      dummy.scale.setScalar(0.6 + random() * 0.9);
      dummy.updateMatrix();

      // The clone is what the probe keys on. Passing dummy.matrix directly
      // would render identically and capture nothing.
      return dummy.matrix.clone();
    });
  }, []);

  useEffect(() => {
    const mesh = meshRef.current;
    if (!mesh) return;

    matrices.forEach((matrix, i) => mesh.setMatrixAt(i, matrix));
    mesh.instanceMatrix.needsUpdate = true;
    mesh.computeBoundingBox();
    mesh.computeBoundingSphere();
  }, [matrices]);

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
  const resolveClick = useClickToSource();

  const handlePointerUp = (event: ThreeEvent<PointerEvent>) => {
    event.stopPropagation();
    const resolved = resolveClick(event);

    if (resolved) {
      useOverlayStore.getState().select(resolved);
    } else {
      useOverlayStore.getState().clearSelection();
    }
  };

  return (
    <>
      <SelectionHighlight />
      <SceneOrbitControls />

      <ambientLight intensity={Math.PI / 3} />
      <directionalLight position={[10, 20, 8]} intensity={2} />

      <group onPointerUp={handlePointerUp}>
        <InstancedTrees />

        {/* Ground. Stamped automatically — click it and the panel names this
            file, this function and this line, with no metadata written by
            hand. That is what `stampSource: true` buys on its own. */}
        <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -0.01, 0]}>
          <planeGeometry args={[60, 60]} />
          <meshStandardMaterial color="#2b2f3a" />
        </mesh>

        {/* The two editable meshes. `args` is written by hand because a stamp
            knows where a call site is, not which of its values are worth
            editing; file, function and line come from `line:` below, which
            points at the constant rather than at this element. `argSources`
            maps the panel's display key onto the identifier in source. */}
        <mesh
          position={[-2.2, BOX_HEIGHT / 2, 6]}
          userData={{
            sourceRef: {
              file: "src/main.tsx",
              function: "Scene",
              line: 26,
              args: { height: BOX_HEIGHT },
              argSources: { height: "BOX_HEIGHT" },
            },
          }}
        >
          <boxGeometry args={[1.2, BOX_HEIGHT, 1.2]} />
          <meshStandardMaterial color="#c2643c" />
        </mesh>

        <mesh
          position={[2.2, SPHERE_RADIUS, 6]}
          userData={{
            sourceRef: {
              file: "src/main.tsx",
              function: "Scene",
              line: 27,
              args: { radius: SPHERE_RADIUS },
              argSources: { radius: "SPHERE_RADIUS" },
            },
          }}
        >
          <sphereGeometry args={[SPHERE_RADIUS, 32, 32]} />
          <meshStandardMaterial color="#4a86c8" />
        </mesh>
      </group>
    </>
  );
}

/**
 * OrbitControls straight from three's examples, so this demo needs no
 * dependency beyond the ones the tool itself brings.
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
  const handlePointerMissed = () => {
    useOverlayStore.getState().clearSelection();
  };

  return (
    <>
      <Canvas
        camera={{ position: [0, 6, 18], fov: 50 }}
        onPointerMissed={handlePointerMissed}
      >
        {/* Without a scene background the canvas is transparent, and
            everything above the ground plane shows the white page through it,
            which reads as a rendering fault rather than an empty sky. */}
        <color attach="background" args={["#1a1d26"]} />

        {/* Inside the Canvas: the bridge needs a scene and a camera, which
            only a component in the R3F tree can supply. */}
        <ClickToSourceBridge />
        <Scene />
      </Canvas>

      {/* Outside the Canvas: GenerationTrace renders DOM, not scene objects. */}
      <GenerationTrace />
    </>
  );
}

const rootRegistry = globalThis as typeof globalThis & {
  __clickToSourceReactRoot?: ReturnType<typeof createRoot>;
};
const root = (rootRegistry.__clickToSourceReactRoot ??= createRoot(
  document.getElementById("root")!
));
root.render(<App />);

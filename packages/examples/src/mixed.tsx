import { useEffect, useMemo, useRef } from "react";
import { createRoot } from "react-dom/client";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import * as THREE from "three";
import { Lamp, makeRock, makeTower, wobble } from "./mixedHelpers";

// React Three Fiber and plain three.js in one scene, as many projects are.
function Scene() {
  const { scene } = useThree();
  const rock = useMemo(() => makeRock(1.2), []);
  const lamp = useMemo(() => new Lamp(0.8), []);
  const ring = useMemo(() => new THREE.TorusGeometry(0.8, 0.3, 12, 24), []);
  const spinner = useRef<THREE.Mesh>(null);

  useEffect(() => {
    const tower = makeTower(3);
    scene.add(tower);
    return () => {
      scene.remove(tower);
    };
  }, [scene]);

  useFrame(() => {
    if (spinner.current) spinner.current.rotation.y += 0.01;
  });

  return (
    <>
      <ambientLight intensity={2} />
      <mesh position={[-4, 0, 0]}>
        <boxGeometry args={[1.5, 1.5, 1.5]} />
        <meshStandardMaterial color="#c2643c" />
      </mesh>
      <primitive object={rock} position={[-1.5, 0, 0]} />
      <primitive object={lamp} position={[1.5, 0, 0]} />
      <mesh ref={spinner} geometry={ring} position={[0, 2.5, wobble(0)]}>
        <meshStandardMaterial color="#44cc88" />
      </mesh>
    </>
  );
}

createRoot(document.getElementById("root")!).render(
  <Canvas camera={{ position: [0, 0, 11] }}>
    <Scene />
  </Canvas>
);

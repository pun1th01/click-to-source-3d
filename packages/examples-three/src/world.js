import * as THREE from "three";
import { fbm } from "./noise.js";
import { loadBeacon } from "./beacon.js";
import { Tree } from "./tree.ts";

const TERRAIN_SIZE = 40;

export function buildWorld(scene, seed) {
  scene.add(createTerrain(TERRAIN_SIZE, seed));

  for (let i = 0; i < 6; i++) {
    const angle = (i / 6) * Math.PI * 2;
    const tree = new Tree(3 + i * 0.4);
    tree.position.set(Math.cos(angle) * 14, 2, Math.sin(angle) * 14);
    scene.add(tree);
  }

  const rock = createRock(1.6, "#8a8f98");
  rock.position.set(7, 3, 7);
  scene.add(rock);

  const secondRock = rock.clone();
  secondRock.position.set(-7, 3, 8);
  scene.add(secondRock);

  scene.add(createStones(64));
  loadBeacon(scene);
}

export function createTerrain(size, seed) {
  const geometry = new THREE.PlaneGeometry(size, size, 96, 96);
  geometry.rotateX(-Math.PI / 2);

  const position = geometry.attributes.position;
  for (let i = 0; i < position.count; i++) {
    const height = fbm(position.getX(i) * 0.08 + seed, position.getZ(i) * 0.08, 4) * 6;
    position.setY(i, height);
  }
  geometry.computeVertexNormals();

  const terrain = new THREE.Mesh(
    geometry,
    new THREE.MeshStandardMaterial({ color: "#4f7a4a", roughness: 0.9 })
  );
  terrain.name = "terrain";
  return terrain;
}

function createRock(radius, color) {
  const geometry = new THREE.IcosahedronGeometry(radius, 1);
  const material = new THREE.MeshStandardMaterial({ color, flatShading: true });
  return new THREE.Mesh(geometry, material);
}

function createStones(count) {
  const stones = new THREE.InstancedMesh(
    new THREE.DodecahedronGeometry(0.4),
    new THREE.MeshStandardMaterial({ color: "#9a9a9a" }),
    count
  );

  const dummy = new THREE.Object3D();
  for (let i = 0; i < count; i++) {
    const angle = i * 2.4;
    const distance = 2 + i * 0.25;
    dummy.position.set(Math.cos(angle) * distance, 3, Math.sin(angle) * distance);
    dummy.updateMatrix();
    stones.setMatrixAt(i, dummy.matrix);
  }
  stones.name = "stones";
  return stones;
}

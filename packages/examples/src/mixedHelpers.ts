import * as THREE from "three";

export function wobble(x: number) {
  return Math.sin(x * 2.5) * 0.2;
}

// Plain three.js, handed to JSX through <primitive>.
export function makeRock(radius: number) {
  const geometry = new THREE.IcosahedronGeometry(radius, 1);
  geometry.translate(0, wobble(radius), 0);
  const rock = new THREE.Mesh(geometry, new THREE.MeshStandardMaterial({ color: "#8a8f98", roughness: 0.7 }));
  rock.name = "rock";
  return rock;
}

// Plain three.js, added to R3F's scene by hand.
export function makeTower(height: number) {
  const tower = new THREE.Mesh(
    new THREE.BoxGeometry(1, height, 1),
    new THREE.MeshStandardMaterial({ color: "#4a86c8" })
  );
  tower.name = "tower";
  tower.position.set(4, 0, 0);
  return tower;
}

// A class of its own, handed to JSX through <primitive>.
export class Lamp extends THREE.Group {
  constructor(size: number) {
    super();
    this.add(new THREE.Mesh(new THREE.SphereGeometry(size), new THREE.MeshStandardMaterial({ color: "#e0b85a" })));
  }
}

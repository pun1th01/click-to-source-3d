import * as THREE from "three";

export function makePart() {
  const part = new THREE.Group();
  part.name = "part";
  part.add(new THREE.Mesh(new THREE.SphereGeometry(1), new THREE.MeshBasicMaterial({ color: "#ffcc33" })));
  return part;
}

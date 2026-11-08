import * as THREE from "three";

export class Tree extends THREE.Group {
  readonly trunk: THREE.Mesh;

  constructor(public height: number, crownColor: string = "#2f6b3a") {
    super();

    this.trunk = new THREE.Mesh(
      new THREE.CylinderGeometry(0.25, 0.35, height, 8),
      new THREE.MeshStandardMaterial({ color: "#6b4a2f" })
    );
    this.trunk.position.y = height / 2;
    this.add(this.trunk);

    const crown = new THREE.Mesh(
      new THREE.ConeGeometry(1.4, height, 10),
      new THREE.MeshStandardMaterial({ color: crownColor })
    );
    crown.position.y = height * 1.2;
    this.add(crown);
  }
}

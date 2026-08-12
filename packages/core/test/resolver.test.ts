import { describe, it, expect } from "vitest";
import * as THREE from "three";
import { resolveObjectAtPoint, resolveSourceRef } from "../src/resolver";

describe("resolveSourceRef", () => {
  it("should return object and sourceRef for a valid tagged hit", () => {
    const geometry = new THREE.BoxGeometry(2, 2, 2);
    const material = new THREE.MeshBasicMaterial();
    const mesh = new THREE.Mesh(geometry, material);

    mesh.userData.sourceRef = {
      file: "DemoScene.jsx",
      function: "createTree",
      line: 42,
      args: { x: 4, z: 2, seed: 17 }
    };

    const result = resolveSourceRef(mesh);
    expect(result).not.toBeNull();
    expect(result?.object).toBe(mesh);
    expect(result?.sourceRef).toEqual(mesh.userData.sourceRef);
  });

  it("should return parent SourceRef when child object is passed", () => {
    const group = new THREE.Group();
    group.userData.sourceRef = {
      file: "Parent.jsx",
      function: "ParentComp",
      line: 10,
      args: {}
    };

    const mesh = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshBasicMaterial());
    group.add(mesh);

    const result = resolveSourceRef(mesh);
    expect(result).not.toBeNull();
    expect(result?.object).toBe(group);
    expect(result?.sourceRef).toEqual(group.userData.sourceRef);
  });

  it("should return null for an object with no provenance", () => {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshBasicMaterial());
    const result = resolveSourceRef(mesh);
    expect(result).toBeNull();
  });
});

describe("resolveObjectAtPoint", () => {
  it("should return object and sourceRef for a valid tagged hit", () => {
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(75, 1, 0.1, 100);
    camera.position.z = 5;
    camera.updateMatrixWorld();

    const geometry = new THREE.BoxGeometry(2, 2, 2);
    const material = new THREE.MeshBasicMaterial();
    const mesh = new THREE.Mesh(geometry, material);

    // Tag the mesh with the Stage 2 contract shape
    mesh.userData.sourceRef = {
      file: "DemoScene.jsx",
      function: "createTree",
      line: 42,
      args: {
        x: 4,
        z: 2,
        seed: 17
      }
    };
    scene.add(mesh);
    
    // Ensure world matrices are updated for raycasting
    scene.updateMatrixWorld(true);

    // Center of screen should hit the mesh
    const pointer = new THREE.Vector2(0, 0);
    const result = resolveObjectAtPoint(scene, camera, pointer);

    expect(result).not.toBeNull();
    expect(result?.object).toBe(mesh);
    expect(result?.sourceRef).toEqual({
      file: "DemoScene.jsx",
      function: "createTree",
      line: 42,
      args: {
        x: 4,
        z: 2,
        seed: 17
      }
    });
  });

  it("should return null when the ray misses", () => {
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(75, 1, 0.1, 100);
    camera.position.z = 5;
    camera.updateMatrixWorld();

    const geometry = new THREE.BoxGeometry(1, 1, 1);
    const material = new THREE.MeshBasicMaterial();
    const mesh = new THREE.Mesh(geometry, material);

    mesh.userData.sourceRef = {
      file: "DemoScene.jsx",
      function: "createTree",
      line: 42,
      args: {}
    };
    scene.add(mesh);
    scene.updateMatrixWorld(true);

    // Point far away from the center should miss the 1x1x1 box at origin
    const pointer = new THREE.Vector2(100, 100);
    const result = resolveObjectAtPoint(scene, camera, pointer);

    expect(result).toBeNull();
  });

  it("should return null for an untagged hit (no fake provenance)", () => {
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(75, 1, 0.1, 100);
    camera.position.z = 5;
    camera.updateMatrixWorld();

    const geometry = new THREE.BoxGeometry(2, 2, 2);
    const material = new THREE.MeshBasicMaterial();
    const mesh = new THREE.Mesh(geometry, material);

    // NO userData.sourceRef added to this mesh
    scene.add(mesh);
    scene.updateMatrixWorld(true);

    const pointer = new THREE.Vector2(0, 0);
    const result = resolveObjectAtPoint(scene, camera, pointer);

    expect(result).toBeNull();
  });
});

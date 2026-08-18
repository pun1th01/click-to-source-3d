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

describe("resolveSourceRef — per-instance (InstancedMesh)", () => {
  const instanceRefs = [
    { sourceRef: { file: "Trees.jsx", function: "Trees", line: 178, args: { x: 1.5, z: 2.5 } } },
    { sourceRef: { file: "Trees.jsx", function: "Trees", line: 178, args: { x: 9.9, z: 8.8 } } },
  ];

  function taggedInstancedMesh(userData: Record<string, unknown>) {
    const mesh = new THREE.InstancedMesh(
      new THREE.BoxGeometry(),
      new THREE.MeshBasicMaterial(),
      2
    );
    Object.assign(mesh.userData, userData);
    return mesh;
  }

  it("should resolve the instance-specific SourceRef and mark it read-only", () => {
    const mesh = taggedInstancedMesh({ instanceSourceRefs: instanceRefs });

    const result = resolveSourceRef(mesh, 1);

    expect(result).not.toBeNull();
    expect(result?.object).toBe(mesh);
    expect(result?.sourceRef).toEqual(instanceRefs[1].sourceRef);
    expect(result?.instanceId).toBe(1);
    expect(result?.readonly).toBe(true);
  });

  it("should return null for an out-of-bounds instanceId with no fallback provenance", () => {
    const mesh = taggedInstancedMesh({ instanceSourceRefs: instanceRefs });

    expect(resolveSourceRef(mesh, 99)).toBeNull();
  });

  it("should return null when userData carries no instanceSourceRefs array", () => {
    const mesh = taggedInstancedMesh({});

    expect(resolveSourceRef(mesh, 0)).toBeNull();
  });

  it("should ignore per-instance data and walk to the parent when instanceId is undefined", () => {
    const group = new THREE.Group();
    group.userData.sourceRef = {
      file: "Scene.jsx",
      function: "Scene",
      line: 10,
      args: {},
    };

    const mesh = taggedInstancedMesh({ instanceSourceRefs: instanceRefs });
    group.add(mesh);

    const result = resolveSourceRef(mesh);

    expect(result).not.toBeNull();
    expect(result?.object).toBe(group);
    expect(result?.sourceRef).toEqual(group.userData.sourceRef);
    expect(result?.instanceId).toBeUndefined();
    expect(result?.readonly).toBeUndefined();
  });

  it("should fall through to a tagged parent when instanceId is out of bounds", () => {
    const group = new THREE.Group();
    group.userData.sourceRef = {
      file: "Scene.jsx",
      function: "Scene",
      line: 10,
      args: {},
    };
    const mesh = taggedInstancedMesh({ instanceSourceRefs: instanceRefs });
    group.add(mesh);

    const result = resolveSourceRef(mesh, 99);

    expect(result?.object).toBe(group);
    expect(result?.readonly).toBeUndefined();
  });

  it("should return null for a negative instanceId", () => {
    const mesh = taggedInstancedMesh({ instanceSourceRefs: instanceRefs });

    expect(resolveSourceRef(mesh, -1)).toBeNull();
  });

  it("should return null when the instance entry has no sourceRef", () => {
    const mesh = taggedInstancedMesh({ instanceSourceRefs: [{ notASourceRef: true }] });

    expect(resolveSourceRef(mesh, 0)).toBeNull();
  });

  it("should prefer per-instance provenance over the mesh's own sourceRef", () => {
    const mesh = taggedInstancedMesh({ instanceSourceRefs: instanceRefs });
    mesh.userData.sourceRef = { file: "Own.jsx", function: "Own", line: 1, args: {} };

    const result = resolveSourceRef(mesh, 0);

    expect(result?.sourceRef).toEqual(instanceRefs[0].sourceRef);
    expect(result?.readonly).toBe(true);
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

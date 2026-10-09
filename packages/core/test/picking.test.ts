import { describe, expect, it } from "vitest";
import * as THREE from "three";
import { ndcFromClient, pickAt } from "../src/picking.js";

function cameraLookingAtOrigin() {
  const camera = new THREE.PerspectiveCamera(50, 1, 0.1, 1000);
  camera.position.set(0, 0, 10);
  camera.lookAt(0, 0, 0);
  camera.updateMatrixWorld(true);
  return camera;
}

function box(name: string, z = 0) {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(2, 2, 2), new THREE.MeshBasicMaterial());
  mesh.name = name;
  mesh.position.z = z;
  return mesh;
}

describe("pickAt", () => {
  it("returns the nearest visible hit, with its provenance", () => {
    const scene = new THREE.Scene();
    const front = box("front", 2);
    front.userData.__ctsSource = { file: "src/A.tsx", function: "A", line: 4 };
    scene.add(front, box("back", -2));
    scene.updateMatrixWorld(true);

    const pick = pickAt(scene, cameraLookingAtOrigin(), { x: 0, y: 0 });

    expect(pick?.object.name).toBe("front");
    expect(pick?.resolution?.sourceRef).toMatchObject({ file: "src/A.tsx", line: 4 });
  });

  // What is clicked is what is seen. An invisible object still raycasts in
  // three, and reporting it would name something not on screen.
  it("skips objects hidden by themselves or by a parent", () => {
    const scene = new THREE.Scene();
    const hiddenParent = new THREE.Group();
    hiddenParent.visible = false;
    hiddenParent.add(box("inside hidden", 3));
    const hidden = box("hidden", 2);
    hidden.visible = false;
    scene.add(hiddenParent, hidden, box("visible", -2));
    scene.updateMatrixWorld(true);

    expect(pickAt(scene, cameraLookingAtOrigin(), { x: 0, y: 0 })?.object.name).toBe("visible");
  });

  it("returns a hit with no provenance rather than nothing", () => {
    const scene = new THREE.Scene();
    scene.add(box("untagged"));
    scene.updateMatrixWorld(true);

    const pick = pickAt(scene, cameraLookingAtOrigin(), { x: 0, y: 0 });

    expect(pick?.object.name).toBe("untagged");
    expect(pick?.resolution).toBeNull();
  });

  it("returns null when nothing is under the point", () => {
    expect(pickAt(new THREE.Scene(), cameraLookingAtOrigin(), { x: 0, y: 0 })).toBeNull();
  });

  // The README used to tell users to recompute bounds after placing
  // instances, because a sphere computed before the writes misses every
  // click. The inspector must not depend on that.
  it("picks an instance whose mesh has a stale bounding sphere, and leaves it stale", () => {
    const scene = new THREE.Scene();
    const mesh = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicMaterial(), 2);
    mesh.computeBoundingSphere(); // before the writes: covers only the origin
    const stale = mesh.boundingSphere;

    const dummy = new THREE.Object3D();
    dummy.position.set(100, 0, 0);
    dummy.updateMatrix();
    mesh.setMatrixAt(0, dummy.matrix);
    dummy.position.set(0, 0, 0);
    dummy.updateMatrix();
    mesh.setMatrixAt(1, dummy.matrix);
    mesh.instanceMatrix.needsUpdate = true;
    scene.add(mesh);
    scene.updateMatrixWorld(true);

    // A camera aimed at the instance far from the stale sphere.
    const camera = new THREE.PerspectiveCamera(50, 1, 0.1, 1000);
    camera.position.set(100, 0, 10);
    camera.lookAt(100, 0, 0);
    camera.updateMatrixWorld(true);

    const pick = pickAt(scene, camera, { x: 0, y: 0 });

    expect(pick?.object).toBe(mesh);
    expect(pick?.instanceId).toBe(0);
    // The application's own sphere is put back untouched.
    expect(mesh.boundingSphere).toBe(stale);
  });
});

describe("ndcFromClient", () => {
  it("maps a client point to normalised device coordinates for the canvas", () => {
    const canvas = {
      getBoundingClientRect: () => ({ left: 100, top: 50, width: 400, height: 200 }),
    } as unknown as Element;

    expect(ndcFromClient(canvas, 300, 150)).toEqual({ x: 0, y: 0 });
    expect(ndcFromClient(canvas, 100, 50)).toEqual({ x: -1, y: 1 });
    expect(ndcFromClient(canvas, 500, 250)).toEqual({ x: 1, y: -1 });
  });
});

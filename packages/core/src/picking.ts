import * as THREE from "three";
import { resolveSourceRef, type ResolutionResult } from "./resolver.js";

/** The first visible object under a point, whether or not it has provenance. */
export type Pick = {
  object: THREE.Object3D;
  instanceId: number | null;
  point: THREE.Vector3;
  distance: number;
  /** Null when nothing in the object's parent chain names a source. */
  resolution: ResolutionResult | null;
};

/** Normalised device coordinates for a point in the page, relative to a canvas. */
export function ndcFromClient(
  canvas: Element,
  clientX: number,
  clientY: number
): { x: number; y: number } {
  const rect = canvas.getBoundingClientRect();

  return {
    x: ((clientX - rect.left) / rect.width) * 2 - 1,
    y: -((clientY - rect.top) / rect.height) * 2 + 1,
  };
}

function isVisible(object: THREE.Object3D): boolean {
  for (let current: THREE.Object3D | null = object; current; current = current.parent) {
    if (!current.visible) {
      return false;
    }
  }
  return true;
}

type CachedSphere = { version: number; count: number; sphere: THREE.Sphere };

const instanceSpheres = new WeakMap<THREE.InstancedMesh, CachedSphere>();
const _matrix = new THREE.Matrix4();
const _piece = new THREE.Sphere();

/**
 * The sphere around every instance as currently placed, cached until the
 * instance buffer changes.
 */
function currentInstanceSphere(mesh: THREE.InstancedMesh): THREE.Sphere {
  const cached = instanceSpheres.get(mesh);
  const version = mesh.instanceMatrix.version;

  if (cached && cached.version === version && cached.count === mesh.count) {
    return cached.sphere;
  }

  const geometry = mesh.geometry;
  if (geometry.boundingSphere === null) {
    geometry.computeBoundingSphere();
  }

  const sphere = new THREE.Sphere().makeEmpty();
  for (let i = 0; i < mesh.count; i++) {
    mesh.getMatrixAt(i, _matrix);
    sphere.union(_piece.copy(geometry.boundingSphere!).applyMatrix4(_matrix));
  }

  instanceSpheres.set(mesh, { version, count: mesh.count, sphere });
  return sphere;
}

/**
 * The first visible object under a point, resolved to its source.
 *
 * Returns the hit even when it has no provenance, so a caller can say what
 * was clicked rather than act as if nothing was.
 *
 * An InstancedMesh is raycast against a sphere fitted to its instances as
 * they are now. three tests a mesh's stored bounding sphere before its
 * instances, and a sphere computed before the instances were written misses
 * every click — the mesh looks as if it has no provenance at all. The stored
 * sphere belongs to the application, which may have sized it on purpose for
 * culling, so it is swapped only for the duration of this raycast and then
 * put back.
 */
export function pickAt(
  scene: THREE.Object3D,
  camera: THREE.Camera,
  ndc: { x: number; y: number },
  raycaster: THREE.Raycaster = new THREE.Raycaster()
): Pick | null {
  camera.updateMatrixWorld();
  raycaster.setFromCamera(new THREE.Vector2(ndc.x, ndc.y), camera);

  const swapped: Array<[THREE.InstancedMesh, THREE.Sphere | null]> = [];

  scene.traverse((object) => {
    const mesh = object as THREE.InstancedMesh;
    if (mesh.isInstancedMesh && mesh.count > 0) {
      swapped.push([mesh, mesh.boundingSphere]);
      mesh.boundingSphere = currentInstanceSphere(mesh);
    }
  });

  let hits: THREE.Intersection[];
  try {
    hits = raycaster.intersectObject(scene, true);
  } finally {
    for (const [mesh, original] of swapped) {
      mesh.boundingSphere = original;
    }
  }

  for (const hit of hits) {
    if (!isVisible(hit.object)) {
      continue;
    }

    const instanceId = hit.instanceId ?? null;

    return {
      object: hit.object,
      instanceId,
      point: hit.point,
      distance: hit.distance,
      resolution: resolveSourceRef(hit.object, instanceId ?? undefined),
    };
  }

  return null;
}

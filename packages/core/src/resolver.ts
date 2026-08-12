import * as THREE from "three";
import { SourceRef } from "@click-to-source/shared";

/**
 * The core resolution result providing both the intersected object
 * and its resolved SourceRef metadata.
 */
export interface ResolutionResult {
  object: THREE.Object3D;
  sourceRef: SourceRef;
}

/**
 * Resolves the SourceRef metadata by inspecting a specific object
 * and walking up its parent chain if necessary.
 * 
 * @param object The THREE.Object3D to inspect.
 * @returns The resolved object and its SourceRef, or null if no tagged object is found.
 */
export function resolveSourceRef(object: THREE.Object3D): ResolutionResult | null {
  let current: THREE.Object3D | null = object;
  
  // Minimal walk up the parent chain to find the nearest ancestor carrying userData.sourceRef.
  while (current) {
    if (current.userData && current.userData.sourceRef) {
      return {
        object: current,
        sourceRef: current.userData.sourceRef as SourceRef,
      };
    }
    current = current.parent;
  }

  return null;
}

/**
 * Resolves the SourceRef metadata of a 3D object at a given screen coordinate.
 * 
 * @param scene The root THREE.Scene or THREE.Object3D to raycast against.
 * @param camera The THREE.Camera used to render the scene.
 * @param pointer Normalized device coordinates (x, y) between -1 and 1.
 * @returns The resolved object and its SourceRef, or null if no tagged object is hit.
 */
export function resolveObjectAtPoint(
  scene: THREE.Object3D,
  camera: THREE.Camera,
  pointer: THREE.Vector2
): ResolutionResult | null {
  const raycaster = new THREE.Raycaster();
  raycaster.setFromCamera(pointer, camera);

  const intersects = raycaster.intersectObject(scene, true);

  for (const intersect of intersects) {
    const result = resolveSourceRef(intersect.object);
    if (result) {
      return result;
    }
  }

  return null;
}

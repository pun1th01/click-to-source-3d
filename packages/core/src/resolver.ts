import * as THREE from "three";
import { SourceRef, InstanceSourceRef } from "@click-to-source/shared";

/**
 * The core resolution result providing both the intersected object
 * and its resolved SourceRef metadata.
 */
export interface ResolutionResult {
  object: THREE.Object3D;
  sourceRef: SourceRef;
  /** Present when the hit landed on a specific instance within an InstancedMesh. */
  instanceId?: number;
  /** When true, the panel should disable editing controls (e.g. procedural instances). */
  readonly?: boolean;
}

/**
 * Attempts per-instance resolution on an object whose `userData.instanceSourceRefs`
 * array is keyed 1:1 by Three.js instanceId.
 *
 * Returns null if the object has no per-instance data, if instanceId is not
 * provided, or if the index is out of bounds — callers should fall through
 * to the standard parent-walk resolution path.
 */
function resolveInstanceSourceRef(
  object: THREE.Object3D,
  instanceId: number | undefined
): ResolutionResult | null {
  if (instanceId === undefined || instanceId === null) {
    return null;
  }

  const refs: InstanceSourceRef[] | undefined =
    object.userData?.instanceSourceRefs;

  if (!Array.isArray(refs) || instanceId < 0 || instanceId >= refs.length) {
    return null;
  }

  const entry = refs[instanceId];
  if (!entry?.sourceRef) {
    return null;
  }

  return {
    object,
    sourceRef: entry.sourceRef,
    instanceId,
    readonly: true, // Per-instance provenance is read-only (procedural — no editable literal in source)
  };
}

/**
 * Resolves the SourceRef metadata by inspecting a specific object
 * and walking up its parent chain if necessary.
 *
 * When `instanceId` is provided (e.g. from an InstancedMesh raycast),
 * the resolver first checks `userData.instanceSourceRefs[instanceId]`.
 * If that lookup fails, it falls through to the standard parent-walk path,
 * preserving full backward compatibility with non-instanced objects.
 *
 * @param object The THREE.Object3D to inspect.
 * @param instanceId Optional — the instance index from a Three.js InstancedMesh intersection.
 * @returns The resolved object and its SourceRef, or null if no tagged object is found.
 */
export function resolveSourceRef(
  object: THREE.Object3D,
  instanceId?: number
): ResolutionResult | null {
  // Fast path: per-instance resolution for InstancedMesh objects.
  const instanceResult = resolveInstanceSourceRef(object, instanceId);
  if (instanceResult) {
    return instanceResult;
  }

  // Standard path: walk up the parent chain looking for userData.sourceRef.
  let current: THREE.Object3D | null = object;

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
 * For InstancedMesh objects, this also checks intersection.instanceId and
 * attempts per-instance resolution before falling back to the parent walk.
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
    // THREE.Intersection carries instanceId when the hit object is an InstancedMesh.
    const instanceId = (intersect as { instanceId?: number }).instanceId;
    const result = resolveSourceRef(intersect.object, instanceId);
    if (result) {
      return result;
    }
  }

  return null;
}

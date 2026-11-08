import * as THREE from "three";
import type { SourceRef } from "@click-to-source-3d/shared";

/**
 * One instance's transform, read from the mesh's own instance buffer.
 */
export type InstanceRecord = {
  /** Slot within the mesh. */
  index: number;
  /**
   * `mesh.count` when the transform was read. Kept for the shape consumers
   * already hold; since the read is live, it is always the current count.
   */
  countAtWrite: number;
  position: [number, number, number];
  /** Euler angles in radians, YXZ order, normalised to [0, 2*PI). */
  rotation: [number, number, number];
  scale: [number, number, number];
};

const scratchMatrix = new THREE.Matrix4();
const decomposePosition = new THREE.Vector3();
const decomposeRotation = new THREE.Quaternion();
const decomposeScale = new THREE.Vector3();
const decomposeEuler = new THREE.Euler();

function decompose(matrix: THREE.Matrix4) {
  matrix.decompose(decomposePosition, decomposeRotation, decomposeScale);
  decomposeEuler.setFromQuaternion(decomposeRotation, "YXZ");

  // Euler yaw lands in (-PI, PI]; generation code usually thinks in [0, 2*PI).
  // Normalising here means a yaw reads the same as the value the placement
  // loop wrote, rather than its negative complement.
  const normalise = (angle: number) => (angle < 0 ? angle + Math.PI * 2 : angle);

  return {
    position: decomposePosition.toArray() as [number, number, number],
    rotation: [
      normalise(decomposeEuler.x),
      normalise(decomposeEuler.y),
      normalise(decomposeEuler.z),
    ] as [number, number, number],
    scale: decomposeScale.toArray() as [number, number, number],
  };
}

/**
 * The transform one slot currently holds, or null.
 *
 * Null for anything that is not an InstancedMesh and for a slot outside
 * `[0, count)`. A slot past a shrunken count may still hold an old matrix in
 * the buffer, but three neither renders nor raycasts it, so it has no
 * provenance to report.
 */
export function getInstanceRecord(
  mesh: THREE.Object3D,
  index: number
): InstanceRecord | null {
  const instanced = mesh as THREE.InstancedMesh;

  if (!instanced.isInstancedMesh) {
    return null;
  }

  if (!Number.isInteger(index) || index < 0 || index >= instanced.count) {
    return null;
  }

  instanced.getMatrixAt(index, scratchMatrix);

  return {
    index,
    countAtWrite: instanced.count,
    ...decompose(scratchMatrix),
  };
}

/**
 * Builds the SourceRef an instance resolves to, given the location its mesh
 * already carries and the transform read for the slot.
 */
export function instanceSourceRefFrom(
  location: Pick<SourceRef, "file" | "function" | "line">,
  record: InstanceRecord
): SourceRef {
  const round = (value: number) => Number(value.toFixed(3));

  return {
    ...location,
    args: {
      x: round(record.position[0]),
      y: round(record.position[1]),
      z: round(record.position[2]),
      scale: round(record.scale[0]),
      yaw: round(record.rotation[1]),
    },
  };
}

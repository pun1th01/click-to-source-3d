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

/**
 * Diagnostics from the capture probe, which no longer exists.
 *
 * @deprecated Transforms are read live from `instanceMatrix`, so there is no
 * probe to report on. Retained so 0.1.x consumers keep compiling; removed in
 * 0.2.0.
 */
export type ProbeStats = {
  installed: boolean;
  intercepted: number;
  constructorFill: number;
  applicationWrites: number;
  unjoined: number;
  unfilteredSuspectedFill: number;
};

const stats: ProbeStats = {
  installed: false,
  intercepted: 0,
  constructorFill: 0,
  applicationWrites: 0,
  unjoined: 0,
  unfilteredSuspectedFill: 0,
};

/** @deprecated See {@link ProbeStats}. */
export function getProbeStats(): Readonly<ProbeStats> {
  return { ...stats };
}

/**
 * Formerly patched `Matrix4.prototype.clone` and
 * `InstancedMesh.prototype.setMatrixAt` to record transforms as they were
 * written.
 *
 * That design paired each write with an earlier `clone()` of the same matrix,
 * so the canonical placement loop — `mesh.setMatrixAt(i, dummy.matrix)`,
 * passing one shared matrix every iteration — was measured capturing 0 of 500
 * instances, silently. It also had to be installed before the first scene
 * mounted, because writes had no replay.
 *
 * None of that was necessary. `setMatrixAt` copies the matrix into
 * `instanceMatrix`, which `getMatrixAt` reads back at any time, and the same
 * 500 instances decomposed from that buffer agreed with the probe's records
 * on every field. Reading at resolve time covers every way a transform can be
 * written, needs no install ordering, and patches nothing.
 *
 * @deprecated Now a no-op that patches nothing. Removed in 0.2.0.
 */
export function installInstanceProbe(): void {
  stats.installed = true;
}

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

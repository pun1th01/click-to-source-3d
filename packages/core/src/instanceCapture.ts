import * as THREE from "three";
import type { SourceRef } from "@click-to-source/shared";

/**
 * One captured instance write: the transform that was live at the moment the
 * matrix was cloned, joined to the slot it was eventually written to.
 */
export type InstanceRecord = {
  /** Slot within the mesh. */
  index: number;
  /** `mesh.count` at the moment of the write, for the staleness sweep below. */
  countAtWrite: number;
  position: [number, number, number];
  /** Euler angles in radians, YXZ order, normalised to [0, 2*PI). */
  rotation: [number, number, number];
  scale: [number, number, number];
};

type MeshRecords = Map<number, InstanceRecord>;

/**
 * Captured records keyed by mesh object identity.
 *
 * A WeakMap rather than a Map because HMR churns meshes: a single edit to
 * Trees.jsx was measured taking mesh uuids from 8 to 11 and writes from 1,205
 * to 1,605. Keying on the object lets the discarded generation collect.
 */
const records = new WeakMap<THREE.InstancedMesh, MeshRecords>();

/** Diagnostics, readable by a consumer to confirm the probe is doing its job. */
export type ProbeStats = {
  installed: boolean;
  /** Total setMatrixAt calls seen, including constructor fill. */
  intercepted: number;
  /** Calls attributed to three's constructor fill and discarded. */
  constructorFill: number;
  /** Calls recorded as application writes. */
  applicationWrites: number;
  /** Writes whose matrix had no paired clone, so carried no transform. */
  unjoined: number;
  /**
   * Writes that looked like constructor fill but could not be filtered because
   * the identity singleton had not been learned yet. Non-zero means some
   * records may be meaningless; it is surfaced rather than hidden.
   */
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

export function getProbeStats(): Readonly<ProbeStats> {
  return { ...stats };
}

/**
 * Transform state captured at `updateMatrix()` time, keyed by the identity of
 * the Matrix4 that `clone()` returned.
 *
 * `dummy.matrix` is the same object on every iteration of a placement loop, so
 * only the clone creates an identity the join can key on.
 */
type CapturedTransform = {
  position: [number, number, number];
  rotation: [number, number, number];
  scale: [number, number, number];
};

const pendingClones = new WeakMap<THREE.Matrix4, CapturedTransform>();

/**
 * three's InstancedMesh constructor runs `setMatrixAt(i, _identity)` for every
 * slot, so a prototype patch sees double traffic, half of it meaningless.
 *
 * `_identity` is module-private inside three — it cannot be imported and
 * compared directly. It is instead learned by observation: a constructor fill
 * is `count` consecutive calls at indices 0..count-1 on a mesh that has only
 * just come into existence, every one passing the same object. An application
 * cannot write to a mesh before that mesh exists, so the signature is
 * unambiguous. Once learned, filtering is exact reference equality.
 *
 * This matters for a case a "same object twice" heuristic would get wrong: an
 * application legitimately writing one Matrix4 into two slots. That object is
 * not three's private singleton, so it is never filtered and both slots are
 * captured.
 */
let identityRef: THREE.Matrix4 | null = null;

/** Per-mesh bootstrap state, used only until `identityRef` is known. */
const learning = new WeakMap<
  THREE.InstancedMesh,
  { matrix: THREE.Matrix4; nextIndex: number; consistent: boolean }
>();

function isIdentityValued(matrix: THREE.Matrix4): boolean {
  const e = matrix.elements;

  for (let i = 0; i < 16; i++) {
    const expected = i % 5 === 0 ? 1 : 0;
    if (e[i] !== expected) {
      return false;
    }
  }

  return true;
}

/**
 * Decides whether a write is three's constructor fill.
 *
 * Returns true only when it is certain. While the singleton is still being
 * learned the call is counted in `unfilteredSuspectedFill` rather than being
 * guessed at, so an unlearned probe is visible instead of quietly producing
 * identity-valued records.
 */
function isConstructorFill(
  mesh: THREE.InstancedMesh,
  index: number,
  matrix: THREE.Matrix4
): boolean {
  if (identityRef !== null) {
    if (matrix === identityRef) {
      stats.constructorFill++;
      return true;
    }
    return false;
  }

  const state = learning.get(mesh);

  if (!state) {
    if (index === 0 && isIdentityValued(matrix)) {
      learning.set(mesh, { matrix, nextIndex: 1, consistent: true });
      stats.unfilteredSuspectedFill++;
      return true;
    }
    return false;
  }

  const continues =
    state.consistent && state.matrix === matrix && index === state.nextIndex;

  if (!continues) {
    state.consistent = false;
    return false;
  }

  state.nextIndex++;
  stats.unfilteredSuspectedFill++;

  // A full sweep of the mesh's slots by one object confirms the singleton.
  if (state.nextIndex >= mesh.count) {
    identityRef = matrix;
    // Those calls were fill after all, so they are no longer suspect.
    stats.unfilteredSuspectedFill -= mesh.count;
    stats.constructorFill += mesh.count;
  }

  return true;
}

const decomposePosition = new THREE.Vector3();
const decomposeRotation = new THREE.Quaternion();
const decomposeScale = new THREE.Vector3();
const decomposeEuler = new THREE.Euler();

function decompose(matrix: THREE.Matrix4) {
  matrix.decompose(decomposePosition, decomposeRotation, decomposeScale);
  decomposeEuler.setFromQuaternion(decomposeRotation, "YXZ");

  // Euler yaw lands in (-PI, PI]; generation code usually thinks in [0, 2*PI).
  // Normalising here means a captured yaw reads the same as the value the
  // placement loop wrote, rather than its negative complement.
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
 * Installs the capture probe. Idempotent: repeated calls are ignored, which
 * matters because HMR re-evaluates modules.
 *
 * Deliberately has no uninstall. Writes are once-only with no replay, so a
 * window in which the patch is absent loses a mount's worth of provenance
 * with no way to recover it. The patches are process-global and stay for the
 * process lifetime; per-mesh state lives in WeakMaps and collects normally.
 */
export function installInstanceProbe(): void {
  if (stats.installed) {
    return;
  }

  stats.installed = true;

  const originalClone = THREE.Matrix4.prototype.clone;

  THREE.Matrix4.prototype.clone = function patchedClone(
    this: THREE.Matrix4
  ): THREE.Matrix4 {
    const clone = originalClone.call(this) as THREE.Matrix4;

    // The receiver is the object whose transform this clone froze. Pairing is
    // by receiver identity, never by counting: the clone ratio is 2:1 in one
    // real component and 1:1 in another, so any count rule is
    // codebase-specific and would ship a silent failure.
    pendingClones.set(clone, decompose(this));

    return clone;
  };

  const originalSetMatrixAt = THREE.InstancedMesh.prototype.setMatrixAt;

  THREE.InstancedMesh.prototype.setMatrixAt = function patchedSetMatrixAt(
    this: THREE.InstancedMesh,
    index: number,
    matrix: THREE.Matrix4
  ): void {
    stats.intercepted++;

    if (isConstructorFill(this, index, matrix)) {
      return originalSetMatrixAt.call(this, index, matrix);
    }

    stats.applicationWrites++;

    const captured = pendingClones.get(matrix);

    if (captured) {
      let meshRecords = records.get(this);

      if (!meshRecords) {
        meshRecords = new Map();
        records.set(this, meshRecords);
      }

      meshRecords.set(index, {
        index,
        countAtWrite: this.count,
        ...captured,
      });
    } else {
      stats.unjoined++;
    }

    return originalSetMatrixAt.call(this, index, matrix);
  };
}

/**
 * The captured transform for one slot, or null.
 *
 * Applies the count-aware sweep. If an instance count shrinks on a reused mesh
 * — 200 instances becoming 150 — slots 150 to 199 still hold the previous
 * generation's matrices and still render, and their records are
 * indistinguishable from live ones by (mesh, index) alone. Comparing the live
 * count against the count recorded at write time discards them, because
 * confidently showing stale provenance for a visible object is worse than
 * showing none.
 */
export function getInstanceRecord(
  mesh: THREE.Object3D,
  index: number
): InstanceRecord | null {
  const instanced = mesh as THREE.InstancedMesh;

  if (!instanced.isInstancedMesh) {
    return null;
  }

  const meshRecords = records.get(instanced);
  const record = meshRecords?.get(index);

  if (!record) {
    return null;
  }

  if (index >= instanced.count) {
    return null;
  }

  if (record.countAtWrite !== instanced.count) {
    return null;
  }

  return record;
}

/**
 * Whether the probe ever recorded a write for this mesh.
 *
 * Distinguishes two failures that `getInstanceRecord` returns null for
 * alike, and which need opposite responses. A mesh the probe never saw was
 * placed before the probe was installed, or with capture switched off, and
 * no amount of retrying will help. A mesh with records where one slot is
 * missing has been swept, and a different slot may still resolve.
 *
 * Reported rather than inferred, because guessing the first case as the
 * second tells a consumer their instance count changed when in fact nothing
 * was ever captured.
 */
export function hasInstanceRecords(mesh: THREE.Object3D): boolean {
  const instanced = mesh as THREE.InstancedMesh;

  if (!instanced.isInstancedMesh) {
    return false;
  }

  const meshRecords = records.get(instanced);

  return meshRecords !== undefined && meshRecords.size > 0;
}

/**
 * Builds the SourceRef an instance resolves to, given the location its mesh
 * already carries and the transform captured for the slot.
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

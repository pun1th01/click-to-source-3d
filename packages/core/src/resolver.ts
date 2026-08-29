import * as THREE from "three";
import {
  SourceRef,
  InstanceSourceRef,
  SourceStamp,
} from "@click-to-source/shared";
import {
  getInstanceRecord,
  instanceSourceRefFrom,
} from "./instanceCapture.js";

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
 * Per-instance resolution from transforms captured by the instance probe.
 *
 * Runs only after the hand-written array has been consulted, and is decided
 * per instance rather than per mesh. A partially populated
 * `instanceSourceRefs` — fewer entries than the mesh has instances — must not
 * cost the uncovered slots their provenance: the existing out-of-bounds path
 * already degrades per instance, and mesh-level precedence would step past
 * captured data that is present and correct in favour of something less
 * specific.
 *
 * The location comes from the mesh's own provenance, since a captured
 * transform knows the values but not the call site that produced them.
 */
function resolveCapturedInstance(
  object: THREE.Object3D,
  instanceId: number | undefined
): ResolutionResult | null {
  if (instanceId === undefined || instanceId === null) {
    return null;
  }

  const record = getInstanceRecord(object, instanceId);

  if (!record) {
    return null;
  }

  const manual = object.userData?.sourceRef as Partial<SourceRef> | undefined;
  const stamp = object.userData?.__ctsSource as SourceStamp | undefined;
  const location = { ...(stamp ?? {}), ...(manual ?? {}) } as Partial<SourceRef>;

  if (!location.file || !location.function || location.line === undefined) {
    // Nothing names the call site, so a transform alone would be provenance
    // with no provenance. Fall through to the ordinary walk.
    return null;
  }

  return {
    object,
    sourceRef: instanceSourceRefFrom(
      {
        file: location.file,
        function: location.function,
        line: location.line,
      },
      record
    ),
    instanceId,
    readonly: true,
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
  // Per-instance resolution, most specific source first. Hand-written entries
  // outrank captured ones for the same reason manual outranks stamped
  // elsewhere, and for one more: the probe cannot always tell a stale slot
  // from a live one on a mesh whose instance count shrank, whereas an
  // authored array has no such failure mode.
  const instanceResult = resolveInstanceSourceRef(object, instanceId);
  if (instanceResult) {
    return instanceResult;
  }

  const capturedResult = resolveCapturedInstance(object, instanceId);
  if (capturedResult) {
    return capturedResult;
  }

  // Standard path: two passes up the parent chain. Manual provenance anywhere
  // in the chain outranks an automatic stamp anywhere in the chain, even when
  // the stamp sits on a nearer object.
  //
  // That ordering looks wrong at first glance, because everywhere else here
  // the innermost match wins. The reason it inverts: stamps are applied by the
  // build transform to every host element indiscriminately, while a
  // hand-written sourceRef is a deliberate statement that this call site is
  // the one worth showing. If the nearest stamp won, switching the transform
  // on would silently shadow every existing hand-written ref that happens to
  // have stamped descendants — the feature would break the escape hatch it is
  // meant to complement. Manual is the override path, so it wins outright.
  //
  // Within a single object the two merge field by field, manual winning per
  // field. That is what lets an author write only `args` and inherit file,
  // function and line from the stamp.
  let current: THREE.Object3D | null = object;

  while (current) {
    const manual = current.userData?.sourceRef as
      | Partial<SourceRef>
      | undefined;

    if (manual) {
      const stamp = current.userData?.__ctsSource as SourceStamp | undefined;

      return {
        object: current,
        sourceRef: { ...(stamp ?? {}), ...manual, args: manual.args ?? {} } as SourceRef,
      };
    }

    current = current.parent;
  }

  // Second pass: no manual ref anywhere, so the nearest stamp wins.
  current = object;

  while (current) {
    const stamp = current.userData?.__ctsSource as SourceStamp | undefined;

    if (stamp) {
      return {
        object: current,
        // A stamp names a call site but knows nothing about which values are
        // editable, so args is empty and the panel renders no argument rows.
        sourceRef: { ...stamp, args: {} },
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

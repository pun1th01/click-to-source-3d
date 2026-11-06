import * as THREE from "three";
import type {
  ObjectRef,
  PointedObject,
  ProvenanceAddress,
  SourceStamp,
} from "@click-to-source-3d/shared";
import { getInstanceRecord, resolveSourceRef } from "@click-to-source-3d/core";
import { describeMesh, measureObject, type Pick } from "@click-to-source-3d/core/devtools";
import type { Discovery, View } from "./discovery.js";

/** An object the inspector is holding on to: selected, pointed at, or pinned. */
export type Target = { view: View; pick: Pick };

/** Enough to find a target again after a remount or a full reload. */
export type Address = {
  file: string;
  line: number;
  column?: number;
  ordinal: number;
  instanceId: number | null;
};

export function kindOf(object: THREE.Object3D): string {
  // three gives InstancedMesh no type string of its own.
  return (object as THREE.InstancedMesh).isInstancedMesh ? "InstancedMesh" : object.type;
}

export function stampOf(object: THREE.Object3D | undefined): SourceStamp | undefined {
  return object?.userData?.__ctsSource as SourceStamp | undefined;
}

function sameSite(a: SourceStamp, b: { file: string; line: number; column?: number }): boolean {
  return a.file === b.file && a.line === b.line && (b.column === undefined || a.column === b.column);
}

export function isInside(object: THREE.Object3D, root: THREE.Object3D): boolean {
  for (let current: THREE.Object3D | null = object; current; current = current.parent) {
    if (current === root) {
      return true;
    }
  }
  return false;
}

export function sameTarget(a: Target, b: Target): boolean {
  return a.pick.object === b.pick.object && a.pick.instanceId === b.pick.instanceId;
}

function targetFor(view: View, object: THREE.Object3D, instanceId: number | null): Target {
  return {
    view,
    pick: {
      object,
      instanceId,
      point: object.getWorldPosition(new THREE.Vector3()),
      distance: 0,
      resolution: resolveSourceRef(object, instanceId ?? undefined),
    },
  };
}

export function addressOf(target: Target): Address | null {
  const resolved = target.pick.resolution?.object;
  const stamp = stampOf(resolved);
  const scene = target.view.scene();
  if (!resolved || !stamp || !scene) {
    return null;
  }

  let ordinal = 0;
  let found = -1;
  scene.traverse((object) => {
    const other = stampOf(object);
    if (other && sameSite(other, stamp)) {
      if (object === resolved) {
        found = ordinal;
      }
      ordinal++;
    }
  });

  return found < 0
    ? null
    : {
        file: stamp.file,
        line: stamp.line,
        column: stamp.column,
        ordinal: found,
        instanceId: target.pick.instanceId,
      };
}

export function findAddress(discovery: Discovery, address: Address): Target | null {
  for (const view of discovery.all()) {
    const scene = view.scene();
    if (!scene) {
      continue;
    }
    let ordinal = 0;
    let match: THREE.Object3D | null = null;
    scene.traverse((object) => {
      const stamp = stampOf(object);
      if (!match && stamp && sameSite(stamp, address)) {
        if (ordinal === address.ordinal) {
          match = object;
        }
        ordinal++;
      }
    });
    if (match) {
      return targetFor(view, match, address.instanceId);
    }
  }
  return null;
}

/** Everything in the scene a reference from outside it names. */
export function findRefs(discovery: Discovery, ref: ObjectRef): Target[] {
  const found: Target[] = [];

  for (const view of discovery.all()) {
    let ordinal = 0;
    view.scene()?.traverse((object) => {
      const stamp =
        stampOf(object) ?? (object.userData?.sourceRef as Partial<SourceStamp> | undefined);
      if (stamp?.file !== ref.file || stamp.line !== ref.line) {
        return;
      }
      if (ref.ordinal === undefined || ref.ordinal === ordinal) {
        found.push(targetFor(view, object, ref.instanceId ?? null));
      }
      ordinal++;
    });
  }
  return found;
}

/** The address `get_instance_provenance` takes, counted the way the bridge counts. */
function provenanceAddress(target: Target): ProvenanceAddress | null {
  const resolved = target.pick.resolution?.object;
  const stamp = stampOf(resolved);
  const scene = target.view.scene();
  if (!resolved || !stamp || !scene) {
    return null;
  }

  let ordinal = 0;
  let found = -1;
  scene.traverse((object) => {
    const other = stampOf(object);
    if (other?.file === stamp.file && other.function === stamp.function && other.line === stamp.line) {
      if (object === resolved) {
        found = ordinal;
      }
      ordinal++;
    }
  });
  if (found < 0) {
    return null;
  }

  return {
    file: stamp.file,
    function: stamp.function,
    line: stamp.line,
    ordinal: found,
    ...(target.pick.instanceId !== null ? { instanceId: target.pick.instanceId } : {}),
  };
}

const round = (values: ArrayLike<number>): number[] =>
  Array.from(values, (value) => Number(value.toFixed(4)));

function parentsOf(object: THREE.Object3D): string[] {
  const parents: string[] = [];
  for (let current = object.parent; current && parents.length < 6; current = current.parent) {
    parents.push(current.name ? `${kindOf(current)} "${current.name}"` : kindOf(current));
  }
  return parents;
}

/** Where a target is. For an instance, where that instance is. */
function transformOf(target: Target): PointedObject["transform"] {
  const { object, instanceId } = target.pick;
  object.updateWorldMatrix(true, false);

  const record = instanceId !== null ? getInstanceRecord(object, instanceId) : null;
  if (record) {
    const world = new THREE.Vector3(...record.position).applyMatrix4(object.matrixWorld);
    return {
      position: round(record.position),
      rotation: round(record.rotation),
      scale: round(record.scale),
      worldPosition: round(world.toArray()),
    };
  }

  return {
    position: round(object.position.toArray()),
    rotation: round([object.rotation.x, object.rotation.y, object.rotation.z]),
    scale: round(object.scale.toArray()),
    worldPosition: round(new THREE.Vector3().setFromMatrixPosition(object.matrixWorld).toArray()),
  };
}

/**
 * A target as plain data: what an assistant reads through `get_selection`, and
 * what a bug report and a comparison are written from.
 */
export function describeTarget(target: Target): PointedObject {
  const { object, instanceId, resolution } = target.pick;
  const ref = resolution?.sourceRef;
  const stamp = stampOf(resolution?.object);
  const details = describeMesh(object, instanceId);

  return {
    kind: kindOf(object),
    name: object.name || null,
    instanceId,
    source: ref
      ? {
          file: ref.file,
          function: ref.function,
          line: ref.line,
          ...(stamp?.column !== undefined && stamp.line === ref.line ? { column: stamp.column } : {}),
        }
      : null,
    address: provenanceAddress(target),
    parents: ref ? [] : parentsOf(object),
    props: stamp?.props ?? [],
    transform: transformOf(target),
    materials: (details?.materials ?? []).map((material) =>
      material.color ? `${material.type} ${material.color}` : material.type
    ),
    cost: measureObject(object),
  };
}

/** One line naming a target, for a list: `Mesh · src/World.tsx:41`. */
export function labelOf(target: Target): { what: string; where: string | null } {
  const { object, instanceId, resolution } = target.pick;
  const ref = resolution?.sourceRef;
  return {
    what: `${kindOf(object)}${instanceId !== null ? ` #${instanceId}` : ""}${object.name ? ` "${object.name}"` : ""}`,
    where: ref ? `${ref.file}:${ref.line}` : null,
  };
}

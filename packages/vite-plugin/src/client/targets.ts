import * as THREE from "three";
import type {
  ObjectRef,
  PointedObject,
  ProvenanceAddress,
  SourceFunction,
  SourceStamp,
} from "@click-to-source-3d/shared";
import { getInstanceRecord, resolveSourceRef } from "@click-to-source-3d/core";
import {
  describeMesh,
  generatorsOf,
  measureObject,
  partsOf,
  recordOf,
  stampOf,
  type ObjectPart,
  type Pick,
} from "@click-to-source-3d/core/devtools";
import type { Discovery, View } from "./discovery.js";

export { stampOf };

/** An object the inspector is holding on to: selected, pointed at, or pinned. */
export type Target = { view: View; pick: Pick };

/** Enough to find a target again after a remount or a full reload. */
export type Address = {
  file: string;
  line: number;
  column?: number;
  ordinal: number;
  instanceId: number | null;
  /** For a part of what is at that source, such as a node of a loaded model. */
  path?: number[];
};

export function kindOf(object: THREE.Object3D): string {
  // three gives InstancedMesh no type string of its own.
  return (object as THREE.InstancedMesh).isInstancedMesh ? "InstancedMesh" : object.type;
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

  if (found < 0) {
    return null;
  }

  const path: number[] = [];
  for (let current = target.pick.object; current !== resolved && current.parent; current = current.parent) {
    path.unshift(current.parent.children.indexOf(current));
  }

  return {
    file: stamp.file,
    line: stamp.line,
    column: stamp.column,
    ordinal: found,
    instanceId: target.pick.instanceId,
    ...(path.length > 0 ? { path } : {}),
  };
}

export function findAddress(discovery: Discovery, address: Address): Target | null {
  // By column first, then without: rewriting a value can move what follows it on
  // the same line, and that shouldn't lose the object.
  return (
    searchAddress(discovery, address) ??
    (address.column !== undefined ? searchAddress(discovery, { ...address, column: undefined }) : null)
  );
}

function searchAddress(discovery: Discovery, address: Address): Target | null {
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
      let object: THREE.Object3D = match;
      for (const index of address.path ?? []) {
        object = object.children[index] ?? object;
      }
      return targetFor(view, object, address.instanceId);
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

/** A stamp behind a target, and whether changing the live object can preview its values. */
export type TargetPart = ObjectPart & { live: boolean };

/**
 * Every stamp behind a target. What is at its source first, and then, for a part
 * of something, what is known about that part alone.
 */
export function partsOfTarget(target: Target): TargetPart[] {
  const { object, resolution } = target.pick;
  const resolved = resolution?.object;
  const seen = new Set<SourceStamp>();
  const parts: TargetPart[] = [];

  for (const [owner, live] of [[resolved, true], [object, false]] as const) {
    for (const part of owner ? partsOf(owner) : []) {
      if (!seen.has(part.stamp)) {
        seen.add(part.stamp);
        parts.push({ ...part, live });
      }
    }
  }
  return parts;
}

/** The functions behind a target, without repeats. */
export function generatorsOfTarget(target: Target): SourceFunction[] {
  const { object, resolution } = target.pick;
  const seen = new Set<string>();
  return [...(resolution ? generatorsOf(resolution.object) : []), ...generatorsOf(object)].filter((fn) => {
    const fresh = !seen.has(fn.id);
    seen.add(fn.id);
    return fresh;
  });
}

/** Where a target sits inside what its source made: `beacon › left blade`. */
export function modelPathOf(target: Target): string | null {
  const { object, resolution } = target.pick;
  const resolved = resolution?.object;
  if (!resolved || resolved === object) {
    return null;
  }
  const names: string[] = [];
  for (let current: THREE.Object3D | null = object; current && current !== resolved; current = current.parent) {
    names.unshift(current.name || kindOf(current));
  }
  return names.join(" › ");
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
    props: partsOfTarget(target).flatMap((part) =>
      (part.stamp.props ?? []).map((prop) => ({ ...prop, file: part.stamp.file }))
    ),
    transform: transformOf(target),
    materials: (details?.materials ?? []).map((material) =>
      material.color ? `${material.type} ${material.color}` : material.type
    ),
    cost: measureObject(object),
    trace: recordOf(resolution?.object)?.trace ?? [],
    generators: generatorsOfTarget(target),
    how: stamp?.how ?? null,
    modelPath: modelPathOf(target),
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

import type * as THREE from "three";

/**
 * three's side constants are plain numbers: FrontSide 0, BackSide 1,
 * DoubleSide 2. Mapping them here keeps this module free of a runtime three
 * import — everything else it reads is a plain property access.
 */
const SIDE_NAMES = ["Front", "Back", "Double"] as const;

export type MaterialDetails = {
  type: string;
  /** Hex string, or null for materials with no colour such as MeshNormalMaterial. */
  color: string | null;
  transparent: boolean;
  opacity: number;
  depthWrite: boolean;
  side: string;
};

export type GeometryDetails = {
  /** Null when the geometry carries no position attribute. */
  vertexCount: number | null;
  /** Null for non-mesh objects, where triangles are meaningless. */
  triangleCount: number | null;
  indexed: boolean;
  attributes: string[];
  /** Null until something computes it. This module never computes it. */
  boundingBox: {
    min: [number, number, number];
    max: [number, number, number];
  } | null;
  /** Null until something computes it. This module never computes it. */
  boundingSphere: {
    center: [number, number, number];
    radius: number;
  } | null;
};

export type MeshDetails = {
  /** InstancedMesh reports type "Mesh", so the flag is the only discriminator. */
  kind: string;
  /** Non-null only for an instanced mesh with a resolved instance. */
  instance: { index: number; count: number } | null;
  object: {
    type: string;
    uuid: string;
    renderOrder: number;
    frustumCulled: boolean;
  };
  /** Null for objects that carry no geometry, such as Group or Object3D. */
  geometry: GeometryDetails | null;
  /** Always an array; a single material is a one-element array. */
  materials: MaterialDetails[];
};

function describeMaterial(material: THREE.Material): MaterialDetails {
  const withColor = material as THREE.Material & { color?: THREE.Color };

  return {
    type: material.type,
    color: withColor.color ? `#${withColor.color.getHexString()}` : null,
    transparent: material.transparent,
    opacity: material.opacity,
    depthWrite: material.depthWrite,
    side: SIDE_NAMES[material.side] ?? String(material.side),
  };
}

function describeGeometry(
  geometry: THREE.BufferGeometry,
  isMesh: boolean
): GeometryDetails {
  const attributes = geometry.attributes ?? {};
  const position = attributes.position;
  const vertexCount = position ? position.count : null;
  const indexed = geometry.index !== null && geometry.index !== undefined;

  let triangleCount: number | null = null;

  // Triangles only mean something for a mesh. Points and Line share the same
  // geometry type but draw no faces.
  if (isMesh) {
    if (indexed) {
      triangleCount = geometry.index!.count / 3;
    } else if (vertexCount !== null) {
      triangleCount = vertexCount / 3;
    }
  }

  const box = geometry.boundingBox;
  const sphere = geometry.boundingSphere;

  return {
    vertexCount,
    triangleCount,
    indexed,
    attributes: Object.keys(attributes),
    boundingBox: box
      ? {
          min: [box.min.x, box.min.y, box.min.z],
          max: [box.max.x, box.max.y, box.max.z],
        }
      : null,
    boundingSphere: sphere
      ? {
          center: [sphere.center.x, sphere.center.y, sphere.center.z],
          radius: sphere.radius,
        }
      : null,
  };
}

/**
 * Reads what the selected object already knows about itself.
 *
 * Every field is a property read on an object held at click time, so nothing
 * here can go stale and nothing needs capturing at build time. Deliberately
 * free of side effects: bounding volumes are reported as null rather than
 * computed, because computing them would mutate the object being inspected.
 */
export function describeMesh(
  object: THREE.Object3D | null | undefined,
  instanceId: number | null
): MeshDetails | null {
  if (!object) {
    return null;
  }

  const maybeMesh = object as THREE.Mesh & {
    isInstancedMesh?: boolean;
    count?: number;
  };
  const isInstanced = maybeMesh.isInstancedMesh === true;
  const isMesh = maybeMesh.isMesh === true;

  const rawMaterial = maybeMesh.material as
    | THREE.Material
    | THREE.Material[]
    | undefined;
  const materials = !rawMaterial
    ? []
    : Array.isArray(rawMaterial)
      ? rawMaterial.map(describeMaterial)
      : [describeMaterial(rawMaterial)];

  return {
    kind: isInstanced ? "InstancedMesh" : object.type,
    instance:
      isInstanced && instanceId !== null
        ? { index: instanceId, count: maybeMesh.count ?? 0 }
        : null,
    object: {
      type: object.type,
      uuid: object.uuid,
      renderOrder: object.renderOrder,
      frustumCulled: object.frustumCulled,
    },
    geometry: maybeMesh.geometry
      ? describeGeometry(maybeMesh.geometry, isMesh)
      : null,
    materials,
  };
}

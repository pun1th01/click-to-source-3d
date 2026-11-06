import type * as THREE from "three";
import type { ObjectCost } from "@click-to-source-3d/shared";

// three's DoubleSide. Kept as a number so this module has no runtime three import.
const DOUBLE_SIDE = 2;

type Materials = THREE.Material | THREE.Material[] | undefined;

function materialsOf(object: THREE.Object3D): THREE.Material[] {
  const material = (object as THREE.Mesh).material as Materials;
  if (!material) {
    return [];
  }
  return Array.isArray(material) ? material : [material];
}

function bufferBytes(attribute: { array?: { byteLength?: number } } | null | undefined): number {
  return attribute?.array?.byteLength ?? 0;
}

/** A geometry's buffers, counting an interleaved one once however many attributes view it. */
function geometryBytes(geometry: THREE.BufferGeometry, seen: Set<unknown>): number {
  let total = 0;
  const count = (attribute: unknown) => {
    const interleaved = (attribute as { data?: { array?: { byteLength?: number } } }).data;
    const owner = interleaved ?? attribute;
    if (!seen.has(owner)) {
      seen.add(owner);
      total += bufferBytes(owner as { array?: { byteLength?: number } });
    }
  };

  for (const attribute of Object.values(geometry.attributes ?? {})) {
    count(attribute);
  }
  if (geometry.index) {
    count(geometry.index);
  }
  return total;
}

function triangleCount(geometry: THREE.BufferGeometry): number {
  // A draw range narrower than the buffers is what the GPU is actually asked for.
  const available = geometry.index?.count ?? geometry.attributes?.position?.count ?? 0;
  const ranged = Math.min(available, geometry.drawRange?.count ?? Infinity);
  return Math.floor(ranged / 3);
}

/**
 * One draw per material group a mesh actually uses, and two for a transparent
 * double-sided material, which three draws back faces then front faces.
 */
function drawCallsOf(mesh: THREE.Mesh): number {
  const materials = mesh.material as Materials;
  const twice = (material: THREE.Material | undefined) =>
    material?.transparent &&
    material.side === DOUBLE_SIDE &&
    (material as { forceSinglePass?: boolean }).forceSinglePass === false
      ? 2
      : 1;

  if (Array.isArray(materials)) {
    const groups = mesh.geometry?.groups ?? [];
    if (groups.length === 0) {
      return materials.length;
    }
    return groups.reduce(
      (calls, group) =>
        materials[group.materialIndex ?? 0] ? calls + twice(materials[group.materialIndex ?? 0]) : calls,
      0
    );
  }
  return twice(materials);
}

/** What a texture holds on the GPU, as near as can be told from outside it. */
function textureBytesOf(texture: THREE.Texture): { width: number | null; height: number | null; bytes: number | null } {
  const compressed = (texture as THREE.CompressedTexture).isCompressedTexture
    ? (texture as THREE.CompressedTexture).mipmaps
    : null;
  if (compressed?.length) {
    const first = compressed[0] as { width?: number; height?: number };
    const bytes = compressed.reduce(
      (total, level) => total + ((level as { data?: { byteLength?: number } }).data?.byteLength ?? 0),
      0
    );
    return { width: first.width ?? null, height: first.height ?? null, bytes };
  }

  const raw = texture.image as
    | { width?: number; height?: number; depth?: number; data?: { byteLength?: number } }
    | Array<{ width?: number; height?: number }>
    | null
    | undefined;
  // A cube texture's image is its six faces.
  const faces = Array.isArray(raw) ? raw.length : 1;
  const image = Array.isArray(raw) ? raw[0] : raw;
  const width = image?.width ?? null;
  const height = image?.height ?? null;

  const data = (image as { data?: { byteLength?: number } } | undefined)?.data?.byteLength;
  if (data !== undefined) {
    return { width, height, bytes: data * faces };
  }
  if (width === null || height === null) {
    return { width, height, bytes: null };
  }
  // Four bytes a texel, and a third again for the mipmap chain.
  const base = width * height * 4 * faces;
  return {
    width,
    height,
    bytes: Math.round(texture.generateMipmaps === false ? base : (base * 4) / 3),
  };
}

function texturesOf(material: THREE.Material): Array<[string, THREE.Texture]> {
  const found: Array<[string, THREE.Texture]> = [];

  for (const [slot, value] of Object.entries(material)) {
    if ((value as THREE.Texture | null)?.isTexture) {
      found.push([slot, value as THREE.Texture]);
    }
  }
  const uniforms = (material as THREE.ShaderMaterial).uniforms;
  for (const [slot, uniform] of Object.entries(uniforms ?? {})) {
    if ((uniform?.value as THREE.Texture | null)?.isTexture) {
      found.push([slot, uniform.value as THREE.Texture]);
    }
  }
  return found;
}

/**
 * What drawing an object costs, across it and everything under it.
 *
 * Reads properties and changes nothing, so it is safe on a live scene. Shared
 * geometry, materials and textures count once for memory, the way the GPU
 * holds them, but every mesh drawing them counts for draw calls and triangles.
 *
 * Returns null for an object with nothing to draw, such as an empty group or
 * a light: "no cost" is a different statement from "zero triangles".
 */
export function measureObject(object: THREE.Object3D | null | undefined): ObjectCost | null {
  if (!object) {
    return null;
  }

  const cost: ObjectCost = {
    meshes: 0,
    drawCalls: 0,
    triangles: 0,
    vertices: 0,
    instances: null,
    geometryBytes: 0,
    materials: 0,
    textures: [],
    textureBytes: 0,
    castsShadow: false,
  };
  const seenBuffers = new Set<unknown>();
  const seenMaterials = new Set<THREE.Material>();
  const seenTextures = new Set<THREE.Texture>();

  object.traverse((child) => {
    const mesh = child as THREE.Mesh & { isLine?: boolean; isPoints?: boolean };
    const drawable = mesh.isMesh || mesh.isLine || mesh.isPoints;
    if (!drawable || !mesh.geometry?.isBufferGeometry) {
      return;
    }

    const instanced = mesh as unknown as THREE.InstancedMesh;
    const copies = instanced.isInstancedMesh ? instanced.count : 1;

    cost.meshes++;
    cost.drawCalls += drawCallsOf(mesh);
    if (mesh.isMesh) {
      cost.triangles += triangleCount(mesh.geometry) * copies;
    }
    cost.vertices += (mesh.geometry.attributes?.position?.count ?? 0) * copies;
    cost.geometryBytes += geometryBytes(mesh.geometry, seenBuffers);
    cost.castsShadow ||= mesh.castShadow;

    if (instanced.isInstancedMesh) {
      cost.instances = (cost.instances ?? 0) + copies;
      // The per-instance matrices are a vertex buffer like any other.
      if (!seenBuffers.has(instanced.instanceMatrix)) {
        seenBuffers.add(instanced.instanceMatrix);
        cost.geometryBytes += bufferBytes(instanced.instanceMatrix);
      }
    }

    for (const material of materialsOf(mesh)) {
      if (seenMaterials.has(material)) {
        continue;
      }
      seenMaterials.add(material);
      cost.materials++;

      for (const [slot, texture] of texturesOf(material)) {
        if (seenTextures.has(texture)) {
          continue;
        }
        seenTextures.add(texture);
        const size = textureBytesOf(texture);
        cost.textures.push({ slot, ...size });
        cost.textureBytes += size.bytes ?? 0;
      }
    }
  });

  return cost.meshes > 0 ? cost : null;
}

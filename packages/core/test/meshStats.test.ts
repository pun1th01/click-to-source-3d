import { describe, expect, it } from "vitest";
import * as THREE from "three";
import { measureObject } from "../src/meshStats.js";

function texture(width: number, height: number, generateMipmaps = true) {
  const texture = new THREE.Texture({ width, height } as never);
  texture.generateMipmaps = generateMipmaps;
  return texture;
}

describe("measureObject", () => {
  it("counts one mesh", () => {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshBasicMaterial());

    expect(measureObject(mesh)).toMatchObject({
      meshes: 1,
      drawCalls: 1,
      triangles: 12,
      vertices: 24,
      instances: null,
      materials: 1,
      textures: [],
      castsShadow: false,
    });
  });

  it("counts a buffer's real size", () => {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(new Float32Array(9), 3));
    geometry.setIndex([0, 1, 2]);

    const cost = measureObject(new THREE.Mesh(geometry))!;

    // 9 floats, and an index three.js stores in 16 bits.
    expect(cost.geometryBytes).toBe(36 + 6);
    expect(cost.triangles).toBe(1);
  });

  // The whole point of instancing: every instance's triangles, one draw call.
  it("counts an InstancedMesh as many triangles and one draw", () => {
    const mesh = new THREE.InstancedMesh(new THREE.BoxGeometry(), new THREE.MeshBasicMaterial(), 100);

    const cost = measureObject(mesh)!;

    expect(cost).toMatchObject({ drawCalls: 1, triangles: 1200, instances: 100, vertices: 2400 });
    // 16 floats per instance on top of the box.
    expect(cost.geometryBytes).toBeGreaterThan(100 * 16 * 4);
  });

  it("adds up everything under a group, and shares what is shared", () => {
    const geometry = new THREE.BoxGeometry();
    const material = new THREE.MeshBasicMaterial({ map: texture(4, 4) });
    const group = new THREE.Group();
    group.add(new THREE.Mesh(geometry, material), new THREE.Mesh(geometry, material));
    const alone = measureObject(new THREE.Mesh(geometry, material))!;

    const cost = measureObject(group)!;

    // Each mesh is drawn, but the GPU holds the geometry and texture once.
    expect(cost).toMatchObject({ meshes: 2, drawCalls: 2, triangles: 24, materials: 1 });
    expect(cost.textures).toHaveLength(1);
    expect(cost.geometryBytes).toBe(alone.geometryBytes);
    expect(cost.textureBytes).toBe(alone.textureBytes);
  });

  it("costs a draw per material group in use", () => {
    const box = new THREE.BoxGeometry(); // six groups, one per face
    const materials = [0, 1, 2, 3, 4, 5].map(() => new THREE.MeshBasicMaterial());

    expect(measureObject(new THREE.Mesh(box, materials))!.drawCalls).toBe(6);
    // A group naming a material that is not there draws nothing.
    expect(measureObject(new THREE.Mesh(box, materials.slice(0, 2)))!.drawCalls).toBe(2);
  });

  // three draws a transparent double-sided material twice: back faces, then front.
  it("counts a transparent double-sided material twice", () => {
    const material = new THREE.MeshBasicMaterial({ transparent: true, side: THREE.DoubleSide });
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(), material);

    expect(measureObject(mesh)!.drawCalls).toBe(2);

    material.forceSinglePass = true;
    expect(measureObject(mesh)!.drawCalls).toBe(1);
  });

  it("estimates texture memory, mipmaps included", () => {
    const material = new THREE.MeshStandardMaterial({
      map: texture(1024, 1024),
      normalMap: texture(512, 512, false),
    });

    const cost = measureObject(new THREE.Mesh(new THREE.BoxGeometry(), material))!;

    expect(cost.textures).toEqual([
      expect.objectContaining({ slot: "map", width: 1024, height: 1024, bytes: Math.round((1024 * 1024 * 4 * 4) / 3) }),
      expect.objectContaining({ slot: "normalMap", width: 512, height: 512, bytes: 512 * 512 * 4 }),
    ]);
    expect(cost.textureBytes).toBe(cost.textures[0].bytes! + cost.textures[1].bytes!);
  });

  it("finds a texture in a shader material's uniforms", () => {
    const material = new THREE.ShaderMaterial({ uniforms: { uNoise: { value: texture(8, 8) } } });

    const cost = measureObject(new THREE.Mesh(new THREE.BoxGeometry(), material))!;

    expect(cost.textures.map((entry) => entry.slot)).toEqual(["uNoise"]);
  });

  it("does not guess at a texture whose image has not loaded", () => {
    const material = new THREE.MeshBasicMaterial({ map: new THREE.Texture() });

    const cost = measureObject(new THREE.Mesh(new THREE.BoxGeometry(), material))!;

    expect(cost.textures[0]).toMatchObject({ width: null, height: null, bytes: null });
    expect(cost.textureBytes).toBe(0);
  });

  it("says when an object casts a shadow", () => {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry());
    mesh.castShadow = true;

    expect(measureObject(mesh)!.castsShadow).toBe(true);
  });

  // "No cost" is a different statement from "zero triangles".
  it("has nothing to report for an object that draws nothing", () => {
    expect(measureObject(new THREE.Group())).toBeNull();
    expect(measureObject(new THREE.PointLight())).toBeNull();
    expect(measureObject(null)).toBeNull();
  });

  it("reads and changes nothing on the object", () => {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry());

    measureObject(mesh);

    // Computing bounds would mutate what is being inspected.
    expect(mesh.geometry.boundingBox).toBeNull();
    expect(mesh.geometry.boundingSphere).toBeNull();
  });
});

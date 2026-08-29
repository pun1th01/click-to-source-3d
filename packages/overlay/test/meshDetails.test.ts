import { describe, it, expect } from "vitest";
import * as THREE from "three";
import { describeMesh } from "../src/meshDetails.js";

describe("describeMesh", () => {
  it("returns null when nothing is selected", () => {
    expect(describeMesh(null, null)).toBeNull();
    expect(describeMesh(undefined, 3)).toBeNull();
  });

  it("reports an instanced mesh by flag, since its type is still Mesh", () => {
    const mesh = new THREE.InstancedMesh(
      new THREE.BoxGeometry(),
      new THREE.MeshStandardMaterial(),
      1284
    );

    const details = describeMesh(mesh, 42);

    expect(mesh.type).toBe("Mesh");
    expect(details?.kind).toBe("InstancedMesh");
    expect(details?.object.type).toBe("Mesh");
    expect(details?.instance).toEqual({ index: 42, count: 1284 });
  });

  it("omits the instance segment for a plain mesh", () => {
    const mesh = new THREE.Mesh(
      new THREE.BoxGeometry(),
      new THREE.MeshStandardMaterial()
    );

    const details = describeMesh(mesh, null);

    expect(details?.kind).toBe("Mesh");
    expect(details?.instance).toBeNull();
  });

  it("omits the instance segment when an instanced mesh has no resolved instance", () => {
    const mesh = new THREE.InstancedMesh(
      new THREE.BoxGeometry(),
      new THREE.MeshStandardMaterial(),
      8
    );

    expect(describeMesh(mesh, null)?.instance).toBeNull();
  });

  it("handles objects that carry no geometry or material", () => {
    for (const object of [new THREE.Object3D(), new THREE.Group()]) {
      const details = describeMesh(object, null);

      expect(details?.geometry).toBeNull();
      expect(details?.materials).toEqual([]);
      expect(details?.object.type).toBe(object.type);
    }
  });

  it("survives a geometry with no position attribute", () => {
    const mesh = new THREE.Mesh();

    const details = describeMesh(mesh, null);

    expect(details?.geometry).not.toBeNull();
    expect(details?.geometry?.vertexCount).toBeNull();
    expect(details?.geometry?.triangleCount).toBeNull();
    expect(details?.geometry?.attributes).toEqual([]);
  });

  it("counts triangles from the index when the geometry is indexed", () => {
    const geometry = new THREE.PlaneGeometry(1, 1, 4, 4);
    const details = describeMesh(
      new THREE.Mesh(geometry, new THREE.MeshStandardMaterial()),
      null
    );

    expect(details?.geometry?.indexed).toBe(true);
    expect(details?.geometry?.vertexCount).toBe(geometry.attributes.position.count);
    expect(details?.geometry?.triangleCount).toBe(geometry.index!.count / 3);
  });

  it("counts triangles from the position attribute when not indexed", () => {
    const geometry = new THREE.PlaneGeometry(1, 1, 4, 4).toNonIndexed();
    const details = describeMesh(
      new THREE.Mesh(geometry, new THREE.MeshStandardMaterial()),
      null
    );

    expect(details?.geometry?.indexed).toBe(false);
    expect(details?.geometry?.triangleCount).toBe(
      geometry.attributes.position.count / 3
    );
  });

  it("reports no triangle count for objects that draw no faces", () => {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute(
      "position",
      new THREE.BufferAttribute(new Float32Array(9), 3)
    );

    const details = describeMesh(
      new THREE.Points(geometry, new THREE.PointsMaterial()),
      null
    );

    expect(details?.kind).toBe("Points");
    expect(details?.geometry?.vertexCount).toBe(3);
    expect(details?.geometry?.triangleCount).toBeNull();
  });

  it("lists custom attributes alongside the built-in ones", () => {
    const geometry = new THREE.PlaneGeometry(1, 1, 2, 2);
    geometry.setAttribute(
      "terrainMasks",
      new THREE.BufferAttribute(
        new Float32Array(geometry.attributes.position.count * 3),
        3
      )
    );

    expect(describeMesh(new THREE.Mesh(geometry), null)?.geometry?.attributes)
      .toEqual(["position", "normal", "uv", "terrainMasks"]);
  });

  it("reports bounds as null and does not compute them", () => {
    const geometry = new THREE.PlaneGeometry(200, 200, 2, 2);
    const mesh = new THREE.Mesh(geometry, new THREE.MeshStandardMaterial());

    const details = describeMesh(mesh, null);

    expect(details?.geometry?.boundingBox).toBeNull();
    expect(details?.geometry?.boundingSphere).toBeNull();
    // the read must not have had the side effect of computing them
    expect(geometry.boundingBox).toBeNull();
    expect(geometry.boundingSphere).toBeNull();
  });

  it("reports bounds once something else has computed them", () => {
    const geometry = new THREE.PlaneGeometry(200, 200, 2, 2);
    geometry.computeBoundingBox();
    geometry.computeBoundingSphere();

    const details = describeMesh(new THREE.Mesh(geometry), null);

    expect(details?.geometry?.boundingBox).toEqual({
      min: [-100, -100, 0],
      max: [100, 100, 0],
    });
    expect(details?.geometry?.boundingSphere?.radius).toBeCloseTo(
      geometry.boundingSphere!.radius
    );
  });

  it("returns one entry per material when the mesh has an array", () => {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(), [
      new THREE.MeshStandardMaterial({ color: 0xff0000 }),
      new THREE.MeshBasicMaterial({ color: 0x00ff00 }),
    ]);

    const details = describeMesh(mesh, null);

    expect(details?.materials).toHaveLength(2);
    expect(details?.materials[0].type).toBe("MeshStandardMaterial");
    expect(details?.materials[0].color).toBe("#ff0000");
    expect(details?.materials[1].color).toBe("#00ff00");
  });

  it("reports a null colour for materials that have none", () => {
    const details = describeMesh(
      new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshNormalMaterial()),
      null
    );

    expect(details?.materials[0].type).toBe("MeshNormalMaterial");
    expect(details?.materials[0].color).toBeNull();
  });

  it("names each side constant", () => {
    const sides = [THREE.FrontSide, THREE.BackSide, THREE.DoubleSide];
    const named = sides.map(
      (side) =>
        describeMesh(
          new THREE.Mesh(
            new THREE.BoxGeometry(),
            new THREE.MeshStandardMaterial({ side })
          ),
          null
        )?.materials[0].side
    );

    expect(named).toEqual(["Front", "Back", "Double"]);
  });

  it("carries the object fields the panel renders", () => {
    const mesh = new THREE.Mesh(
      new THREE.BoxGeometry(),
      new THREE.MeshStandardMaterial()
    );
    mesh.renderOrder = 2;
    mesh.frustumCulled = false;

    const details = describeMesh(mesh, null);

    expect(details?.object.uuid).toBe(mesh.uuid);
    expect(details?.object.renderOrder).toBe(2);
    expect(details?.object.frustumCulled).toBe(false);
  });
});

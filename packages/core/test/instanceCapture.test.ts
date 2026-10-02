import { describe, expect, it } from "vitest";
import * as THREE from "three";
import {
  installInstanceProbe,
  getInstanceRecord,
  getProbeStats,
} from "../src/instanceCapture.js";
import { resolveSourceRef } from "../src/resolver.js";

type Transform = { x: number; y: number; z: number; scale: number; yaw: number };

/**
 * Places instances the way the three.js docs do: one shared dummy whose
 * matrix is handed to setMatrixAt directly, the same object every iteration.
 * The capture probe this replaced recorded nothing for this loop.
 */
function place(mesh: THREE.InstancedMesh, transforms: Transform[]) {
  const dummy = new THREE.Object3D();

  transforms.forEach((t, i) => {
    dummy.position.set(t.x, t.y, t.z);
    dummy.rotation.set(0, t.yaw, 0);
    dummy.scale.setScalar(t.scale);
    dummy.updateMatrix();
    mesh.setMatrixAt(i, dummy.matrix);
  });
}

/** The other common loop: a clone per instance, often built ahead of time. */
function placeCloned(mesh: THREE.InstancedMesh, transforms: Transform[]) {
  const dummy = new THREE.Object3D();

  const matrices = transforms.map((t) => {
    dummy.position.set(t.x, t.y, t.z);
    dummy.rotation.set(0, t.yaw, 0);
    dummy.scale.setScalar(t.scale);
    dummy.updateMatrix();
    return dummy.matrix.clone();
  });

  matrices.forEach((matrix, i) => mesh.setMatrixAt(i, matrix));
}

function instanced(count: number) {
  return new THREE.InstancedMesh(
    new THREE.ConeGeometry(1, 2, 6),
    new THREE.MeshStandardMaterial(),
    count
  );
}

/** Deterministic transforms across the ranges a scene generator produces. */
function transforms(count: number): Transform[] {
  let seed = 7;
  const random = () => (seed = (seed * 16807) % 2147483647) / 2147483647;

  return Array.from({ length: count }, () => ({
    x: random() * 400 - 200,
    y: random() * 30,
    z: random() * 400 - 200,
    scale: 0.4 + random() * 2,
    yaw: random() * Math.PI * 2,
  }));
}

describe("instance transforms, read live", () => {
  // The regression. This is the loop the three.js documentation teaches, and
  // the probe resolved none of its 500 instances.
  it("reads every slot written from a shared dummy.matrix", () => {
    const written = transforms(500);
    const mesh = instanced(500);
    place(mesh, written);

    for (let i = 0; i < written.length; i++) {
      const record = getInstanceRecord(mesh, i);

      expect(record, `slot ${i}`).not.toBeNull();
      expect(record!.position[0]).toBeCloseTo(written[i].x, 3);
      expect(record!.position[1]).toBeCloseTo(written[i].y, 3);
      expect(record!.position[2]).toBeCloseTo(written[i].z, 3);
      expect(record!.scale[0]).toBeCloseTo(written[i].scale, 3);
      expect(record!.rotation[1]).toBeCloseTo(written[i].yaw, 3);
    }
  });

  it("reads slots written from per-instance clones", () => {
    const mesh = instanced(3);
    placeCloned(mesh, [
      { x: 12.481, y: 4.117, z: -33.902, scale: 1.234, yaw: 0.785 },
      { x: -87.01, y: 9.88, z: 61.555, scale: 0.612, yaw: 3.4 },
      { x: 0, y: 0, z: 0, scale: 2, yaw: 5.9 },
    ]);

    const record = getInstanceRecord(mesh, 1);

    expect(record).toMatchObject({ index: 1, countAtWrite: 3 });
    expect(record!.position[0]).toBeCloseTo(-87.01, 3);
    expect(record!.position[1]).toBeCloseTo(9.88, 3);
    expect(record!.position[2]).toBeCloseTo(61.555, 3);
    expect(record!.scale[0]).toBeCloseTo(0.612, 3);
  });

  // setMatrixAt is not the only way into the buffer. A write-time hook could
  // never see these; a read of the buffer cannot miss them.
  it("reads a transform written straight into instanceMatrix", () => {
    const mesh = instanced(2);
    new THREE.Matrix4()
      .makeTranslation(7, 8, 9)
      .toArray(mesh.instanceMatrix.array as unknown as number[], 16);

    expect(getInstanceRecord(mesh, 1)?.position).toEqual([7, 8, 9]);
  });

  it("normalises yaw past PI, so it reads as the loop wrote it", () => {
    const mesh = instanced(1);
    place(mesh, [{ x: 0, y: 0, z: 0, scale: 1, yaw: 3.4 }]);

    // Raw Euler yaw for 3.4 rad is -2.883; the value read must not be that.
    expect(getInstanceRecord(mesh, 0)!.rotation[1]).toBeCloseTo(3.4, 3);
  });

  it("reports the current transform, not the first one written", () => {
    const mesh = instanced(1);
    place(mesh, [{ x: 1, y: 0, z: 0, scale: 1, yaw: 0 }]);
    place(mesh, [{ x: 42, y: 0, z: 0, scale: 1, yaw: 0 }]);

    expect(getInstanceRecord(mesh, 0)?.position[0]).toBe(42);
  });

  // A slot past a shrunken count keeps its old matrix in the buffer, but
  // three neither renders nor raycasts it. Slots still in range are exactly
  // what is on screen, so they keep resolving.
  it("refuses slots outside the current count and keeps the rest", () => {
    const mesh = instanced(4);
    place(mesh, [0, 1, 2, 3].map((n) => ({ x: n, y: 0, z: 0, scale: 1, yaw: 0 })));

    mesh.count = 2;

    expect(getInstanceRecord(mesh, 3)).toBeNull();
    expect(getInstanceRecord(mesh, 1)).toMatchObject({ index: 1, countAtWrite: 2 });
    expect(getInstanceRecord(mesh, 1)!.position).toEqual([1, 0, 0]);
    expect(getInstanceRecord(mesh, -1)).toBeNull();
  });

  it("ignores non-instanced objects", () => {
    expect(getInstanceRecord(new THREE.Mesh(), 0)).toBeNull();
  });

  // What HMR does: same call site, same geometry and material, new object.
  // Each mesh reads its own buffer, so one generation cannot leak into another.
  it("keeps each mesh's transforms to itself", () => {
    const first = instanced(1);
    const second = instanced(1);
    place(first, [{ x: 10, y: 0, z: 0, scale: 1, yaw: 0 }]);
    place(second, [{ x: 20, y: 0, z: 0, scale: 1, yaw: 0 }]);

    expect(getInstanceRecord(first, 0)?.position[0]).toBe(10);
    expect(getInstanceRecord(second, 0)?.position[0]).toBe(20);
  });
});

describe("the deprecated probe entry points", () => {
  it("install patches nothing", () => {
    const setMatrixAt = THREE.InstancedMesh.prototype.setMatrixAt;
    const clone = THREE.Matrix4.prototype.clone;

    installInstanceProbe();
    installInstanceProbe();

    expect(THREE.InstancedMesh.prototype.setMatrixAt).toBe(setMatrixAt);
    expect(THREE.Matrix4.prototype.clone).toBe(clone);
    expect(getProbeStats().installed).toBe(true);
  });
});

describe("resolveSourceRef — instances", () => {
  function meshWithLocation() {
    const mesh = instanced(2);
    mesh.userData.__ctsSource = {
      file: "src/components/Trees.jsx",
      function: "Trees",
      line: 264,
    };
    place(mesh, [
      { x: 1.5, y: 2.5, z: 3.5, scale: 0.8, yaw: 1.2 },
      { x: 4.5, y: 5.5, z: 6.5, scale: 1.6, yaw: 2.4 },
    ]);
    return mesh;
  }

  it("resolves an instance from its transform plus the mesh's location", () => {
    const result = resolveSourceRef(meshWithLocation(), 1);

    expect(result?.sourceRef.file).toBe("src/components/Trees.jsx");
    expect(result?.sourceRef.function).toBe("Trees");
    expect(result?.instanceId).toBe(1);
    expect(result?.readonly).toBe(true);
    expect(result?.sourceRef.args).toEqual({
      x: 4.5,
      y: 5.5,
      z: 6.5,
      scale: 1.6,
      yaw: 2.4,
    });
  });

  it("prefers a hand-written entry over the live transform", () => {
    const mesh = meshWithLocation();
    mesh.userData.instanceSourceRefs = [
      {
        sourceRef: {
          file: "src/components/Trees.jsx",
          function: "Trees",
          line: 178,
          args: { authored: true },
        },
      },
    ];

    const result = resolveSourceRef(mesh, 0);

    expect(result?.sourceRef.line).toBe(178);
    expect(result?.sourceRef.args).toEqual({ authored: true });
  });

  // Partial coverage must not cost the uncovered slots their provenance.
  it("falls to the live transform for slots the authored array does not cover", () => {
    const mesh = meshWithLocation();
    mesh.userData.instanceSourceRefs = [
      {
        sourceRef: {
          file: "src/components/Trees.jsx",
          function: "Trees",
          line: 178,
          args: { authored: true },
        },
      },
    ];

    const covered = resolveSourceRef(mesh, 0);
    const uncovered = resolveSourceRef(mesh, 1);

    expect(covered?.sourceRef.args).toEqual({ authored: true });
    expect(uncovered?.sourceRef.line).toBe(264);
    expect(uncovered?.sourceRef.args.x).toBe(4.5);
  });

  it("falls through to the parent walk when nothing names the call site", () => {
    const mesh = instanced(1);
    place(mesh, [{ x: 1, y: 1, z: 1, scale: 1, yaw: 0 }]);

    // A transform with no location is provenance without provenance.
    expect(resolveSourceRef(mesh, 0)).toBeNull();
  });
});

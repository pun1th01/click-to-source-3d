import { describe, expect, it, beforeAll } from "vitest";
import * as THREE from "three";
import {
  installInstanceProbe,
  getInstanceRecord,
  getProbeStats,
} from "../src/instanceCapture.js";
import { resolveSourceRef } from "../src/resolver.js";

// The probe patches prototypes process-globally and has no uninstall, so it is
// installed once for the whole file — which also exercises the idempotence
// guard, since a second call must be a no-op.
beforeAll(() => {
  installInstanceProbe();
  installInstanceProbe();
});

/** Places instances the way a real placement loop does: one shared dummy. */
function place(
  mesh: THREE.InstancedMesh,
  transforms: Array<{ x: number; y: number; z: number; scale: number; yaw: number }>,
  clonesPerInstance = 1
) {
  const dummy = new THREE.Object3D();

  transforms.forEach((t, i) => {
    dummy.position.set(t.x, t.y, t.z);
    dummy.rotation.set(0, t.yaw, 0);
    dummy.scale.setScalar(t.scale);
    dummy.updateMatrix();

    // Trees pushes the same matrix into two arrays, GroundCover into one.
    const clones = [];
    for (let c = 0; c < clonesPerInstance; c++) {
      clones.push(dummy.matrix.clone());
    }

    mesh.setMatrixAt(i, clones[0]);
  });
}

describe("instance capture probe", () => {
  it("installs once and reports itself", () => {
    expect(getProbeStats().installed).toBe(true);
  });

  it("captures a transform and joins it to the written slot", () => {
    const mesh = new THREE.InstancedMesh(
      new THREE.ConeGeometry(1, 2, 6),
      new THREE.MeshStandardMaterial(),
      3
    );

    place(mesh, [
      { x: 12.481, y: 4.117, z: -33.902, scale: 1.234, yaw: 0.785 },
      { x: -87.01, y: 9.88, z: 61.555, scale: 0.612, yaw: 3.4 },
      { x: 0, y: 0, z: 0, scale: 2, yaw: 5.9 },
    ]);

    const record = getInstanceRecord(mesh, 1);

    expect(record).not.toBeNull();
    expect(record!.position[0]).toBeCloseTo(-87.01, 3);
    expect(record!.position[1]).toBeCloseTo(9.88, 3);
    expect(record!.position[2]).toBeCloseTo(61.555, 3);
    expect(record!.scale[0]).toBeCloseTo(0.612, 3);
  });

  it("normalises yaw past PI, so it reads as the loop wrote it", () => {
    const mesh = new THREE.InstancedMesh(
      new THREE.BoxGeometry(),
      new THREE.MeshStandardMaterial(),
      1
    );

    place(mesh, [{ x: 0, y: 0, z: 0, scale: 1, yaw: 3.4 }]);

    // Raw Euler yaw for 3.4 rad is -2.883; the captured value must not be that.
    expect(getInstanceRecord(mesh, 0)!.rotation[1]).toBeCloseTo(3.4, 3);
  });

  // three's constructor runs setMatrixAt(i, _identity) for every slot, so a
  // prototype patch sees double traffic.
  //
  // Asserting only that no record exists would be vacuous: the constructor's
  // matrix is never cloned, so the join would reject it anyway. What the
  // filter is actually for is keeping that traffic out of the application
  // counters — without it every construction inflates applicationWrites and
  // unjoined, and the unjoined diagnostic stops meaning anything.
  it("attributes constructor fill to the constructor, not the application", () => {
    const before = getProbeStats();

    const mesh = new THREE.InstancedMesh(
      new THREE.BoxGeometry(),
      new THREE.MeshStandardMaterial(),
      4
    );

    const after = getProbeStats();

    expect(after.intercepted - before.intercepted).toBe(4);
    expect(after.constructorFill - before.constructorFill).toBe(4);
    expect(after.applicationWrites - before.applicationWrites).toBe(0);
    expect(after.unjoined - before.unjoined).toBe(0);

    expect(getInstanceRecord(mesh, 0)).toBeNull();
    expect(getInstanceRecord(mesh, 3)).toBeNull();
  });

  // The case a "same object twice" heuristic gets wrong. The application's own
  // Matrix4 is not three's private singleton, so both slots must be captured.
  it("captures an application matrix written to two slots", () => {
    const mesh = new THREE.InstancedMesh(
      new THREE.BoxGeometry(),
      new THREE.MeshStandardMaterial(),
      2
    );

    const dummy = new THREE.Object3D();
    dummy.position.set(5, 6, 7);
    dummy.updateMatrix();
    const shared = dummy.matrix.clone();

    mesh.setMatrixAt(0, shared);
    mesh.setMatrixAt(1, shared);

    for (const index of [0, 1]) {
      const record = getInstanceRecord(mesh, index);
      expect(record, `slot ${index}`).not.toBeNull();
      expect(record!.position[0]).toBeCloseTo(5, 3);
    }
  });

  // The clone ratio is 2:1 in one real component and 1:1 in another, so the
  // pairing must key on receiver identity and never on counting.
  it("pairs by receiver identity regardless of clone ratio", () => {
    const mesh = new THREE.InstancedMesh(
      new THREE.BoxGeometry(),
      new THREE.MeshStandardMaterial(),
      2
    );

    place(
      mesh,
      [
        { x: 1, y: 2, z: 3, scale: 1, yaw: 0 },
        { x: 4, y: 5, z: 6, scale: 1, yaw: 0 },
      ],
      2 // two clones per instance, as Trees does
    );

    expect(getInstanceRecord(mesh, 0)!.position).toEqual([1, 2, 3]);
    expect(getInstanceRecord(mesh, 1)!.position).toEqual([4, 5, 6]);
  });

  it("survives a foreign clone interleaved with the placement loop", () => {
    const mesh = new THREE.InstancedMesh(
      new THREE.BoxGeometry(),
      new THREE.MeshStandardMaterial(),
      1
    );

    const dummy = new THREE.Object3D();
    dummy.position.set(9, 9, 9);
    dummy.updateMatrix();
    const wanted = dummy.matrix.clone();

    // something unrelated clones a matrix in between
    new THREE.Matrix4().clone();

    mesh.setMatrixAt(0, wanted);

    expect(getInstanceRecord(mesh, 0)!.position).toEqual([9, 9, 9]);
  });

  it("records nothing for a write whose matrix was never cloned", () => {
    const mesh = new THREE.InstancedMesh(
      new THREE.BoxGeometry(),
      new THREE.MeshStandardMaterial(),
      1
    );

    const before = getProbeStats().unjoined;
    mesh.setMatrixAt(0, new THREE.Matrix4().makeTranslation(1, 1, 1));

    expect(getInstanceRecord(mesh, 0)).toBeNull();
    expect(getProbeStats().unjoined).toBe(before + 1);
  });

  // A shrinking count leaves stale slots that still render and are otherwise
  // indistinguishable from live ones by (mesh, index) alone.
  it("discards records for slots past a shrunken count", () => {
    const mesh = new THREE.InstancedMesh(
      new THREE.BoxGeometry(),
      new THREE.MeshStandardMaterial(),
      4
    );

    place(
      mesh,
      [0, 1, 2, 3].map((n) => ({ x: n, y: 0, z: 0, scale: 1, yaw: 0 }))
    );

    expect(getInstanceRecord(mesh, 3)).not.toBeNull();

    mesh.count = 2;

    expect(getInstanceRecord(mesh, 3)).toBeNull();
    expect(getInstanceRecord(mesh, 1)).toBeNull(); // countAtWrite no longer matches
  });

  it("ignores non-instanced objects", () => {
    expect(getInstanceRecord(new THREE.Mesh(), 0)).toBeNull();
  });

  /**
   * What can and cannot be asserted about the registry's lifetime.
   *
   * The registry is a WeakMap keyed on the mesh, so a discarded HMR
   * generation becomes collectable when the last reference to its mesh goes.
   * That reclamation is not deterministically testable: WeakMap is not
   * enumerable by design, and WeakRef and FinalizationRegistry only tell you
   * anything after a collection the runtime is free never to schedule. A test
   * built on either passes or fails on GC timing rather than on this code,
   * which is worse than no test.
   *
   * What is deterministic is the observable consequence the WeakMap exists to
   * produce: records belong to one mesh identity and never leak into its
   * replacement. That is what an HMR reload actually depends on, and it is
   * asserted below. Reclamation itself was measured out of band — 200
   * generations of 255 instances, every mesh released, heap 43.9MB -> 9.1MB
   * after collection — and is not re-asserted here.
   */
  it("does not let a replacement mesh inherit the previous generation's records", () => {
    const geometry = new THREE.BoxGeometry();
    const material = new THREE.MeshStandardMaterial();

    const first = new THREE.InstancedMesh(geometry, material, 2);
    place(first, [
      { x: 10, y: 0, z: 0, scale: 1, yaw: 0 },
      { x: 20, y: 0, z: 0, scale: 1, yaw: 0 },
    ]);

    expect(getInstanceRecord(first, 0)?.position[0]).toBe(10);

    // What HMR does: same call site, same geometry and material, new object.
    const second = new THREE.InstancedMesh(geometry, material, 2);

    expect(getInstanceRecord(second, 0)).toBeNull();
    expect(getInstanceRecord(second, 1)).toBeNull();

    // The surviving generation is untouched by the arrival of the new one.
    expect(getInstanceRecord(first, 0)?.position[0]).toBe(10);
  });

  it("stays installed once, so a re-evaluated module does not double-count", () => {
    const before = getProbeStats();

    // What HMR does to the probe module itself. Installation is deliberately
    // one-way: there is no uninstall, because instance writes are once-only
    // with no replay and a window without the patch loses a mount's
    // provenance unrecoverably.
    installInstanceProbe();
    installInstanceProbe();

    const mesh = new THREE.InstancedMesh(
      new THREE.BoxGeometry(),
      new THREE.MeshStandardMaterial(),
      1
    );
    place(mesh, [{ x: 1, y: 2, z: 3, scale: 1, yaw: 0 }]);

    // One write, counted once — not once per install call.
    expect(getProbeStats().applicationWrites).toBe(before.applicationWrites + 1);
    expect(getInstanceRecord(mesh, 0)?.position).toEqual([1, 2, 3]);
  });
});

describe("resolveSourceRef — captured instances", () => {
  function meshWithLocation() {
    const mesh = new THREE.InstancedMesh(
      new THREE.ConeGeometry(1, 2, 6),
      new THREE.MeshStandardMaterial(),
      2
    );
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

  it("resolves an instance from a captured transform plus the mesh's location", () => {
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

  it("prefers a hand-written entry over a captured one", () => {
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
  it("falls to the captured record for slots the authored array does not cover", () => {
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
    const mesh = new THREE.InstancedMesh(
      new THREE.BoxGeometry(),
      new THREE.MeshStandardMaterial(),
      1
    );
    place(mesh, [{ x: 1, y: 1, z: 1, scale: 1, yaw: 0 }]);

    // A captured transform with no location is provenance without provenance.
    expect(resolveSourceRef(mesh, 0)).toBeNull();
  });
});

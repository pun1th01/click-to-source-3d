import { describe, expect, it, beforeAll } from "vitest";
import * as THREE from "three";
import { installInstanceProbe } from "../src/instanceCapture.js";
import { answerBridgeQuery, setBridgeScene } from "../src/bridgeClient.js";

/**
 * These drive `answerBridgeQuery` directly, which is the function the event
 * stream calls when a query arrives. Nothing here is a stand-in: a real
 * probe, real THREE objects, a real scene graph, and for resolve_at_point a
 * real raycast.
 *
 * That matters because the failure being guarded against is a tool that
 * answers wrongly while every collaborator around it behaves. A test built
 * on a substitute for the registry or the bridge would agree with whatever
 * the code does and report success either way.
 */

beforeAll(() => {
  installInstanceProbe();
});

/** Places instances the way a real placement loop does: one shared dummy. */
function place(
  mesh: THREE.InstancedMesh,
  transforms: Array<{ x: number; y: number; z: number; scale: number; yaw: number }>
) {
  const dummy = new THREE.Object3D();

  transforms.forEach((t, i) => {
    dummy.position.set(t.x, t.y, t.z);
    dummy.rotation.set(0, t.yaw, 0);
    dummy.scale.setScalar(t.scale);
    dummy.updateMatrix();
    mesh.setMatrixAt(i, dummy.matrix.clone());
  });
}

function stamped(mesh: THREE.Object3D, line: number, fn = "InstancedTreeMesh") {
  mesh.userData.__ctsSource = { file: "src/Trees.jsx", function: fn, line };
  return mesh;
}

function instancedMesh(count: number, line = 240) {
  return stamped(
    new THREE.InstancedMesh(
      new THREE.ConeGeometry(1, 2, 6),
      new THREE.MeshStandardMaterial(),
      count
    ),
    line
  ) as THREE.InstancedMesh;
}

function sceneWith(...objects: THREE.Object3D[]) {
  const scene = new THREE.Scene();
  objects.forEach((o) => scene.add(o));
  const camera = new THREE.PerspectiveCamera(50, 1, 0.1, 1000);
  camera.position.set(0, 0, 5);
  camera.lookAt(0, 0, 0);
  camera.updateMatrixWorld(true);
  camera.updateProjectionMatrix();
  scene.updateMatrixWorld(true);
  setBridgeScene({ scene, camera });
  return { scene, camera };
}

function ask(address: {
  file: string;
  function: string;
  line: number;
  ordinal: number;
  instanceId?: number;
}) {
  return answerBridgeQuery({ kind: "get_instance_provenance", address }) as {
    status: string;
    cause?: string;
    reason?: string;
    count?: number;
    sourceRef?: { args?: Record<string, number> };
    record?: { index: number; countAtWrite: number };
  };
}

const ADDRESS = {
  file: "src/Trees.jsx",
  function: "InstancedTreeMesh",
  line: 240,
  ordinal: 0,
};

describe("answerBridgeQuery, against a real scene", () => {
  it("resolves an instance to its captured transform", () => {
    const mesh = instancedMesh(3);
    place(mesh, [
      { x: 12.481, y: 4.117, z: -33.902, scale: 1.234, yaw: 0.785 },
      { x: -87.01, y: 9.88, z: 61.555, scale: 0.612, yaw: 3.4 },
      { x: 0, y: 0, z: 0, scale: 2, yaw: 5.9 },
    ]);
    sceneWith(mesh);

    const out = ask({ ...ADDRESS, instanceId: 1 });

    expect(out.status).toBe("ready");
    expect(out.record).toMatchObject({ index: 1, countAtWrite: 3 });
    expect(out.sourceRef?.args?.x).toBeCloseTo(-87.01, 3);
    expect(out.sourceRef?.args?.yaw).toBeCloseTo(3.4, 3);
  });

  // The scenario a single-mesh fixture cannot express: two meshes sharing one
  // call site, where an address that ignored `ordinal` would resolve to
  // whichever came first and look perfectly healthy doing it.
  it("distinguishes two meshes at the same call site by ordinal", () => {
    const first = instancedMesh(2);
    const second = instancedMesh(2);
    place(first, [
      { x: 1, y: 0, z: 0, scale: 1, yaw: 0 },
      { x: 2, y: 0, z: 0, scale: 1, yaw: 0 },
    ]);
    place(second, [
      { x: 100, y: 0, z: 0, scale: 1, yaw: 0 },
      { x: 200, y: 0, z: 0, scale: 1, yaw: 0 },
    ]);
    sceneWith(first, second);

    const a = ask({ ...ADDRESS, ordinal: 0, instanceId: 0 });
    const b = ask({ ...ADDRESS, ordinal: 1, instanceId: 0 });

    expect(a.status).toBe("ready");
    expect(b.status).toBe("ready");
    expect(a.sourceRef?.args?.x).toBeCloseTo(1, 3);
    expect(b.sourceRef?.args?.x).toBeCloseTo(100, 3);
  });

  it("reports an address that names nothing, with the addresses that exist", () => {
    sceneWith(instancedMesh(2));

    const out = answerBridgeQuery({
      kind: "get_instance_provenance",
      address: { ...ADDRESS, ordinal: 9, instanceId: 0 },
    }) as { status: string; nearest: Array<{ ordinal: number }> };

    expect(out.status).toBe("address_not_found");
    expect(out.nearest).toHaveLength(1);
    expect(out.nearest[0].ordinal).toBe(0);
  });

  describe("why a slot has no record", () => {
    it("separates a slot past the count from one that was swept", () => {
      const mesh = instancedMesh(3);
      place(mesh, [
        { x: 1, y: 0, z: 0, scale: 1, yaw: 0 },
        { x: 2, y: 0, z: 0, scale: 1, yaw: 0 },
        { x: 3, y: 0, z: 0, scale: 1, yaw: 0 },
      ]);
      sceneWith(mesh);

      expect(ask({ ...ADDRESS, instanceId: 7 })).toMatchObject({
        status: "instance_not_recorded",
        cause: "instance_out_of_range",
        count: 3,
      });

      // Shrinking the count strands slot 1: it is in range, and its record
      // belongs to the generation that is gone.
      mesh.count = 2;

      expect(ask({ ...ADDRESS, instanceId: 1 })).toMatchObject({
        status: "instance_not_recorded",
        cause: "record_swept",
      });
    });

    // The case that produced the misleading message: nothing was ever
    // captured for this mesh, and the old text called that a count change.
    it("names a mesh the probe never saw, rather than blaming the count", () => {
      sceneWith(instancedMesh(4));

      const out = ask({ ...ADDRESS, instanceId: 0 });

      expect(out.status).toBe("instance_not_recorded");
      expect(out.cause).toBe("no_records_for_mesh");
      expect(out.reason).not.toMatch(/count changed/i);
      expect(out.reason).toMatch(/before the probe was live/i);
    });
  });

  // resolve_at_point is the tool reported as broken. This is a real raycast
  // against a real camera, so it fails if the resolution path regresses.
  it("resolves whatever a real raycast hits", () => {
    const box = stamped(
      new THREE.Mesh(new THREE.BoxGeometry(2, 2, 2), new THREE.MeshBasicMaterial()),
      12,
      "Terrain"
    );
    box.userData.sourceRef = {
      file: "src/Terrain.jsx",
      function: "Terrain",
      line: 12,
      args: { size: 2 },
    };
    sceneWith(box);

    const out = answerBridgeQuery({
      kind: "resolve_at_point",
      x: 0,
      y: 0,
    }) as {
      status: string;
      address: { function: string; ordinal: number } | null;
      sourceRef: { args?: Record<string, unknown> } | null;
      distance: number;
    };

    expect(out.status).toBe("ready");
    expect(out.address).toMatchObject({ function: "Terrain", ordinal: 0 });
    expect(out.sourceRef?.args).toEqual({ size: 2 });
    expect(out.distance).toBeGreaterThan(0);
  });

  it("reports no_scene once the scene detaches", () => {
    setBridgeScene(null);

    expect(answerBridgeQuery({ kind: "list_scene_provenance" })).toMatchObject({
      status: "no_scene",
    });
  });
});

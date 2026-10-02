import { describe, expect, it } from "vitest";
import * as THREE from "three";
import { answerBridgeQuery, setBridgeScene } from "../src/bridgeClient.js";

/**
 * Its own file on purpose: Vitest isolates modules per file, so nothing here
 * has imported the deprecated probe entry or called installInstanceProbe.
 *
 * Instance provenance used to depend on a probe installed before the first
 * scene mounted, and without one this query could only explain why it had no
 * answer. Transforms are now read live, so the uninstalled case must answer
 * like any other.
 */

describe("answerBridgeQuery with no probe ever installed", () => {
  it("still resolves an instance", () => {
    const mesh = new THREE.InstancedMesh(
      new THREE.ConeGeometry(1, 2, 6),
      new THREE.MeshStandardMaterial(),
      50
    );
    mesh.userData.__ctsSource = {
      file: "src/Trees.jsx",
      function: "InstancedTreeMesh",
      line: 240,
    };

    const dummy = new THREE.Object3D();
    dummy.position.set(3, 4, 5);
    dummy.updateMatrix();
    mesh.setMatrixAt(25, dummy.matrix);

    const scene = new THREE.Scene();
    scene.add(mesh);
    const camera = new THREE.PerspectiveCamera(50, 1, 0.1, 1000);
    scene.updateMatrixWorld(true);
    setBridgeScene({ scene, camera });

    const out = answerBridgeQuery({
      kind: "get_instance_provenance",
      address: {
        file: "src/Trees.jsx",
        function: "InstancedTreeMesh",
        line: 240,
        ordinal: 0,
        instanceId: 25,
      },
    }) as { status: string; sourceRef: { args: Record<string, number> } };

    expect(out.status).toBe("ready");
    expect(out.sourceRef.args).toMatchObject({ x: 3, y: 4, z: 5 });
  });
});

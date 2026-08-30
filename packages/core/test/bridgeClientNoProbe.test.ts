import { describe, expect, it } from "vitest";
import * as THREE from "three";
import { answerBridgeQuery, setBridgeScene } from "../src/bridgeClient.js";

/**
 * Its own file on purpose. The probe patches prototypes process-globally and
 * has no uninstall, so "never installed" is a state that exists only in a
 * module registry where nothing has installed it. Vitest isolates per file,
 * which makes this the one place the uninstalled case can be observed.
 *
 * Ordering it first inside the main file would work today and break silently
 * the moment someone reorders the tests — the same silence this whole change
 * is about.
 */

describe("answerBridgeQuery with the capture probe absent", () => {
  it("names the missing probe instead of blaming the instance count", () => {
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
    }) as { status: string; cause: string; reason: string };

    expect(out.status).toBe("instance_not_recorded");
    expect(out.cause).toBe("probe_not_installed");
    // The specific wrong answer this replaced: a count that never changed.
    expect(out.reason).not.toMatch(/count changed/i);
    expect(out.reason).toMatch(/captureInstances/);
  });
});

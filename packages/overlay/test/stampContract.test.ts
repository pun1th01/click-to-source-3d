import { describe, expect, it } from "vitest";
import * as THREE from "three";
import { applyProps } from "@react-three/fiber";

/**
 * The R3F behaviour the vite plugin's source stamp depends on.
 *
 * The plugin emits `userData-__ctsSource={...}` for any element without an
 * explicit userData attribute. That is correct only because R3F resolves a
 * dashed prop by piercing into the object — setting one key on the existing
 * userData — rather than replacing it. Pinned here, against the real R3F,
 * so an upgrade that changed piercing fails a test instead of silently
 * dropping a loaded model's userData again.
 */

const STAMP = { file: "src/Model.tsx", function: "Model", line: 12 };

describe("R3F piercing, as the source stamp uses it", () => {
  // <primitive object={gltf.scene} /> wraps an object that already has
  // userData: a glTF's extras, exported from Blender.
  it("adds the stamp to an existing userData instead of replacing it", () => {
    const scene = new THREE.Group();
    scene.userData = { blenderExtra: "keep-me" };

    applyProps(scene, { "userData-__ctsSource": STAMP });

    expect(scene.userData).toEqual({ blenderExtra: "keep-me", __ctsSource: STAMP });
  });

  // The stamp goes ahead of the first spread, so a hand-written userData in
  // the spread is applied after it and wins, as manual outranks stamped.
  it("yields to a userData applied after it", () => {
    const mesh = new THREE.Mesh();
    const manual = { sourceRef: { file: "src/Model.tsx", args: { r: 1 } } };

    applyProps(mesh, { "userData-__ctsSource": STAMP, userData: manual });

    expect(mesh.userData).toBe(manual);
  });

  // Why the plugin keeps merging into an explicit userData attribute rather
  // than piercing after it: these are the values that would throw.
  it("throws when the userData it pierces into is not an object", () => {
    for (const userData of [null, "opaque"]) {
      const mesh = new THREE.Mesh();

      expect(() =>
        applyProps(mesh, { userData, "userData-__ctsSource": STAMP })
      ).toThrow();
    }
  });
});

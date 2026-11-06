import { describe, expect, it } from "vitest";
import * as THREE from "three";
import type { StampedProp } from "@click-to-source-3d/shared";
import { PreviewSession } from "../../src/client/preview.js";

/** A prop as the stamp would write it, with numeric literals. */
function prop(element: string, name: string, values: number[], array = true): StampedProp {
  return {
    element,
    name,
    array,
    values: values.map((value) => ({ raw: String(value), value, editable: true, line: 1, column: 1 })),
  };
}

function box() {
  return new THREE.Mesh(new THREE.BoxGeometry(1, 2, 3), new THREE.MeshStandardMaterial({ roughness: 0.5 }));
}

describe("PreviewSession", () => {
  describe("the object's own props", () => {
    it("moves one axis of position={[...]}, and puts it back", () => {
      const mesh = box();
      mesh.position.set(1, 2, 3);
      const preview = new PreviewSession(mesh).previewOf(prop("mesh", "position", [1, 2, 3]), 1)!;

      preview.set(9);
      expect(mesh.position.toArray()).toEqual([1, 9, 3]);

      preview.reset();
      expect(mesh.position.toArray()).toEqual([1, 2, 3]);
    });

    it("turns an axis of rotation, keeping the quaternion in step", () => {
      const mesh = box();
      const preview = new PreviewSession(mesh).previewOf(prop("mesh", "rotation", [0, 0, 0]), 1)!;

      preview.set(Math.PI / 2);

      // three renders from the quaternion. A value written past the Euler's
      // setter would change the number and not the picture.
      expect(mesh.quaternion.y).toBeCloseTo(Math.SQRT1_2);
    });

    it("sets a scalar prop", () => {
      const light = new THREE.PointLight(0xffffff, 2);
      const preview = new PreviewSession(light).previewOf(prop("pointLight", "intensity", [2], false), 0)!;

      preview.set(5);
      expect(light.intensity).toBe(5);

      preview.reset();
      expect(light.intensity).toBe(2);
    });

    // R3F accepts scale={2} and applies it to all three axes.
    it("applies a scalar to a whole vector, as R3F does", () => {
      const mesh = box();
      mesh.scale.setScalar(2);
      const preview = new PreviewSession(mesh).previewOf(prop("mesh", "scale", [2], false), 0)!;

      preview.set(4);
      expect(mesh.scale.toArray()).toEqual([4, 4, 4]);

      preview.reset();
      expect(mesh.scale.toArray()).toEqual([2, 2, 2]);
    });

    it("follows a dash prop into the object", () => {
      const mesh = box();
      const rotation = new PreviewSession(mesh).previewOf(prop("mesh", "rotation-y", [0], false), 0)!;
      const roughness = new PreviewSession(mesh).previewOf(prop("mesh", "material-roughness", [0.5], false), 0)!;

      rotation.set(1);
      roughness.set(0.1);

      expect(mesh.rotation.y).toBe(1);
      expect((mesh.material as THREE.MeshStandardMaterial).roughness).toBe(0.1);
    });
  });

  describe("materials", () => {
    it("reaches the material inside the mesh", () => {
      const mesh = box();
      const preview = new PreviewSession(mesh).previewOf(prop("meshStandardMaterial", "roughness", [0.5], false), 0)!;

      preview.set(0.9);
      expect((mesh.material as THREE.MeshStandardMaterial).roughness).toBe(0.9);

      preview.reset();
      expect((mesh.material as THREE.MeshStandardMaterial).roughness).toBe(0.5);
    });

    it("picks the named one out of several", () => {
      const basic = new THREE.MeshBasicMaterial();
      const standard = new THREE.MeshStandardMaterial({ roughness: 0.5 });
      const mesh = new THREE.Mesh(new THREE.BoxGeometry(), [basic, standard]);

      const preview = new PreviewSession(mesh).previewOf(prop("meshStandardMaterial", "roughness", [0.5], false), 0)!;
      preview.set(0.2);

      expect(standard.roughness).toBe(0.2);
      expect(new PreviewSession(mesh).previewOf(prop("meshPhongMaterial", "shininess", [1], false), 0)).toBeNull();
    });
  });

  describe("a geometry's args", () => {
    const args = prop("boxGeometry", "args", [1, 2, 3]);

    it("builds a new geometry, since args went to a constructor", () => {
      const mesh = box();
      const original = mesh.geometry;
      const preview = new PreviewSession(mesh).previewOf(args, 1)!;

      preview.set(10);

      expect(mesh.geometry).not.toBe(original);
      expect((mesh.geometry as THREE.BoxGeometry).parameters).toMatchObject({ width: 1, height: 10, depth: 3 });
      // Nothing happens to the one R3F owns.
      expect((original as THREE.BoxGeometry).parameters.height).toBe(2);
    });

    it("names the parameter, for a slider to judge its range by", () => {
      expect(new PreviewSession(box()).previewOf(args, 1)!.paramName).toBe("height");

      const sphere = new THREE.Mesh(new THREE.SphereGeometry(1, 32, 16));
      const sphereArgs = prop("sphereGeometry", "args", [1, 32, 16]);
      expect(new PreviewSession(sphere).previewOf(sphereArgs, 1)!.paramName).toBe("widthSegments");
    });

    // Previewed separately, the second rebuild would start from the original
    // values and undo the first.
    it("keeps every changed value through each rebuild", () => {
      const mesh = box();
      const session = new PreviewSession(mesh);

      session.previewOf(args, 0)!.set(7);
      session.previewOf(args, 2)!.set(8);

      expect((mesh.geometry as THREE.BoxGeometry).parameters).toMatchObject({ width: 7, height: 2, depth: 8 });
    });

    it("resets one value without losing another", () => {
      const mesh = box();
      const session = new PreviewSession(mesh);
      const width = session.previewOf(args, 0)!;
      const depth = session.previewOf(args, 2)!;

      width.set(7);
      depth.set(8);
      depth.reset();

      expect((mesh.geometry as THREE.BoxGeometry).parameters).toMatchObject({ width: 7, height: 2, depth: 3 });
    });

    it("works through an InstancedMesh", () => {
      const mesh = new THREE.InstancedMesh(new THREE.ConeGeometry(0.5, 2, 7), undefined, 3);
      const preview = new PreviewSession(mesh).previewOf(prop("coneGeometry", "args", [0.5, 2, 7]), 1)!;

      preview.set(4);

      expect((mesh.geometry as THREE.ConeGeometry).parameters.height).toBe(4);
    });
  });

  describe("putting things back", () => {
    it("restores everything, and gets rid of what it built", () => {
      const mesh = box();
      mesh.position.set(1, 2, 3);
      const original = mesh.geometry;
      const session = new PreviewSession(mesh);
      let disposed = false;

      session.previewOf(prop("mesh", "position", [1, 2, 3]), 0)!.set(50);
      session.previewOf(prop("boxGeometry", "args", [1, 2, 3]), 0)!.set(50);
      mesh.geometry.addEventListener("dispose", () => (disposed = true));

      session.restore();

      expect(mesh.position.x).toBe(1);
      expect(mesh.geometry).toBe(original);
      expect(disposed).toBe(true);
    });

    // After a save, R3F is about to apply the same values. Putting the old ones
    // back in between would flicker.
    it("leaves the scene as it is when a save settles", () => {
      const mesh = box();
      mesh.position.set(1, 2, 3);
      const session = new PreviewSession(mesh);

      session.previewOf(prop("mesh", "position", [1, 2, 3]), 0)!.set(50);
      session.settle();

      expect(mesh.position.x).toBe(50);
    });

    it("drops a built geometry once R3F has replaced it", () => {
      const mesh = box();
      const session = new PreviewSession(mesh);
      session.previewOf(prop("boxGeometry", "args", [1, 2, 3]), 0)!.set(50);
      const built = mesh.geometry;
      let disposed = false;
      built.addEventListener("dispose", () => (disposed = true));

      const fromR3F = new THREE.BoxGeometry(50, 2, 3);
      mesh.geometry = fromR3F;
      session.settle();

      expect(mesh.geometry).toBe(fromR3F);
      expect(disposed).toBe(true);
    });

    it("puts back the geometry R3F owns if nothing replaced the built one", () => {
      const mesh = box();
      const original = mesh.geometry;
      const session = new PreviewSession(mesh);
      session.previewOf(prop("boxGeometry", "args", [1, 2, 3]), 0)!.set(50);

      session.settle();

      expect(mesh.geometry).toBe(original);
    });
  });

  describe("what cannot be previewed", () => {
    it("has nothing to offer for an element's own args", () => {
      const mesh = new THREE.InstancedMesh(new THREE.BoxGeometry(), undefined, 3);

      expect(new PreviewSession(mesh).previewOf(prop("instancedMesh", "args", [0, 0, 3]), 2)).toBeNull();
    });

    it("has nothing to offer for a custom geometry with no parameters", () => {
      const mesh = new THREE.Mesh(new THREE.BufferGeometry());

      expect(new PreviewSession(mesh).previewOf(prop("myGeometry", "args", [1]), 0)).toBeNull();
    });

    it("has nothing to offer for a geometry argument that is not a number", () => {
      const mesh = new THREE.Mesh(new THREE.ExtrudeGeometry(new THREE.Shape(), { depth: 1 }));

      expect(new PreviewSession(mesh).previewOf(prop("extrudeGeometry", "args", [1]), 0)).toBeNull();
    });

    it("has nothing to offer for a property the object does not have", () => {
      const mesh = box();

      expect(new PreviewSession(mesh).previewOf(prop("mesh", "customThing", [1], false), 0)).toBeNull();
      expect(new PreviewSession(mesh).previewOf(prop("mesh", "customThing", [1]), 0)).toBeNull();
      expect(new PreviewSession(mesh).previewOf(prop("mesh", "nothing-here", [1], false), 0)).toBeNull();
    });

    // [...offset, 2]: index 0 in the stamp is not index 0 in the vector.
    it("does not guess past a spread", () => {
      const spread: StampedProp = {
        element: "mesh",
        name: "position",
        array: true,
        values: [
          { raw: "...offset", editable: false },
          { raw: "2", value: 2, editable: true, line: 1, column: 1 },
        ],
      };

      expect(new PreviewSession(box()).previewOf(spread, 1)).toBeNull();
    });
  });
});

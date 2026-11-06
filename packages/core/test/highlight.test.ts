import { describe, expect, it, vi } from "vitest";
import * as THREE from "three";
import { attachHighlight, boxMatrixFor, HighlightLayer } from "../src/highlight.js";

/** Where the unit cube's corner (0.5, 0.5, 0.5) lands under a box matrix. */
function corner(matrix: THREE.Matrix4, x = 0.5, y = 0.5, z = 0.5) {
  return new THREE.Vector3(x, y, z).applyMatrix4(matrix);
}

describe("boxMatrixFor", () => {
  it("fits a mesh's own box and turns with it", () => {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(2, 4, 6));
    mesh.position.set(10, 0, 0);
    mesh.rotation.y = Math.PI / 2;
    const out = new THREE.Matrix4();

    expect(boxMatrixFor({ object: mesh }, out)).toBe(true);

    // Local corner (1, 2, 3), rotated a quarter turn about y, then moved.
    const expected = new THREE.Vector3(1, 2, 3)
      .applyAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI / 2)
      .add(new THREE.Vector3(10, 0, 0));
    expect(corner(out).distanceTo(expected)).toBeLessThan(1e-6);
  });

  it("fits one instance, not the whole mesh", () => {
    const mesh = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), undefined, 2);
    const dummy = new THREE.Object3D();
    dummy.position.set(5, 0, 0);
    dummy.updateMatrix();
    mesh.setMatrixAt(1, dummy.matrix);
    const out = new THREE.Matrix4();

    expect(boxMatrixFor({ object: mesh, instanceId: 1 }, out)).toBe(true);
    expect(corner(out).toArray()).toEqual([5.5, 0.5, 0.5]);
  });

  it("refuses an instance outside the count", () => {
    const mesh = new THREE.InstancedMesh(new THREE.BoxGeometry(), undefined, 2);

    expect(boxMatrixFor({ object: mesh, instanceId: 2 }, new THREE.Matrix4())).toBe(false);
  });

  it("fits every instance when no instance is named", () => {
    const mesh = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), undefined, 2);
    const dummy = new THREE.Object3D();
    dummy.position.set(-4, 0, 0);
    dummy.updateMatrix();
    mesh.setMatrixAt(0, dummy.matrix);
    dummy.position.set(4, 0, 0);
    dummy.updateMatrix();
    mesh.setMatrixAt(1, dummy.matrix);
    const out = new THREE.Matrix4();

    boxMatrixFor({ object: mesh }, out);

    expect(corner(out).toArray()).toEqual([4.5, 0.5, 0.5]);
    expect(corner(out, -0.5, -0.5, -0.5).toArray()).toEqual([-4.5, -0.5, -0.5]);
  });

  it("falls back to the world box of a group's contents", () => {
    const group = new THREE.Group();
    const child = new THREE.Mesh(new THREE.BoxGeometry(2, 2, 2));
    child.position.set(0, 3, 0);
    group.add(child);
    const out = new THREE.Matrix4();

    expect(boxMatrixFor({ object: group }, out)).toBe(true);
    expect(corner(out).toArray()).toEqual([1, 4, 1]);
  });

  it("reports an empty group as nothing to draw", () => {
    expect(boxMatrixFor({ object: new THREE.Group() }, new THREE.Matrix4())).toBe(false);
  });
});

/** Just enough of a WebGLRenderer to observe what is drawn and where. */
function fakeRenderer() {
  const calls: Array<{ scene: THREE.Object3D; autoClear: boolean }> = [];
  let target: unknown = null;
  const renderer = {
    autoClear: true,
    xr: { isPresenting: false },
    getRenderTarget: () => target,
    setRenderTarget: (next: unknown) => {
      target = next;
    },
    render(this: { autoClear: boolean }, scene: THREE.Object3D) {
      calls.push({ scene, autoClear: this.autoClear });
    },
  };
  return { renderer: renderer as unknown as THREE.WebGLRenderer, calls, raw: renderer };
}

describe("HighlightLayer", () => {
  const mesh = (x = 0) => {
    const object = new THREE.Mesh(new THREE.BoxGeometry());
    object.position.x = x;
    return object;
  };
  const shown = (layer: HighlightLayer) => layer.scene.children.filter((child) => child.visible).length;

  it("shows one box for each target", () => {
    const layer = new HighlightLayer();

    layer.setAll("pointed", [{ object: mesh() }, { object: mesh(5) }, { object: mesh(9) }]);
    layer.update();

    expect(shown(layer)).toBe(3);
    expect(layer.all("pointed")).toHaveLength(3);
  });

  it("hides the boxes it no longer needs, and reuses them", () => {
    const layer = new HighlightLayer();
    layer.setAll("pointed", [{ object: mesh() }, { object: mesh(5) }]);
    const built = layer.scene.children.length;

    layer.setAll("pointed", [{ object: mesh(1) }]);
    layer.update();
    expect(shown(layer)).toBe(1);

    layer.setAll("pointed", [{ object: mesh(1) }, { object: mesh(2) }]);
    layer.update();
    expect(shown(layer)).toBe(2);
    expect(layer.scene.children).toHaveLength(built);
  });

  it("keeps each kind's boxes apart", () => {
    const layer = new HighlightLayer();
    const selected = { object: mesh() };

    layer.set("selected", selected);
    layer.setAll("pointed", [{ object: mesh(5) }]);
    layer.setAll("agent", [{ object: mesh(7) }]);
    layer.setAll("pointed", []);

    expect(layer.get("selected")).toBe(selected);
    expect(layer.get("pointed")).toBeNull();
    expect(layer.all("agent")).toHaveLength(1);
  });

  it("is active while any kind has a target", () => {
    const layer = new HighlightLayer();
    expect(layer.active).toBe(false);

    layer.setAll("agent", [{ object: mesh() }]);
    expect(layer.active).toBe(true);

    layer.set("agent", null);
    expect(layer.active).toBe(false);
  });

  it("hides a box whose target has nothing to draw around", () => {
    const layer = new HighlightLayer();

    layer.setAll("pointed", [{ object: new THREE.Group() }, { object: mesh() }]);
    layer.update();

    expect(shown(layer)).toBe(1);
  });
});

describe("attachHighlight", () => {
  const appScene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera();

  it("draws nothing extra while nothing is highlighted", () => {
    const { renderer, calls } = fakeRenderer();
    attachHighlight(renderer, new HighlightLayer(), () => camera);

    renderer.render(appScene, camera);

    expect(calls.map((c) => c.scene)).toEqual([appScene]);
  });

  it("draws the layer after a frame on screen, without clearing it", () => {
    const { renderer, calls } = fakeRenderer();
    const layer = new HighlightLayer();
    layer.set("selected", { object: new THREE.Mesh(new THREE.BoxGeometry()) });
    attachHighlight(renderer, layer, () => camera);

    renderer.render(appScene, camera);

    expect(calls.map((c) => c.scene)).toEqual([appScene, layer.scene]);
    expect(calls[1].autoClear).toBe(false);
    // Restored for the application's next frame.
    expect(renderer.autoClear).toBe(true);
  });

  // A post-processing composer renders the scene into targets before its
  // final pass reaches the screen. Drawing on an intermediate target would
  // feed the highlight through the effects, or have it overwritten.
  it("leaves frames rendered into a target alone", () => {
    const { renderer, calls, raw } = fakeRenderer();
    const layer = new HighlightLayer();
    layer.set("hover", { object: new THREE.Mesh(new THREE.BoxGeometry()) });
    attachHighlight(renderer, layer, () => camera);

    raw.setRenderTarget({});
    renderer.render(appScene, camera);

    expect(calls.map((c) => c.scene)).toEqual([appScene]);
  });

  // A render resets the counters, so they would otherwise describe the
  // highlight's boxes for as long as anything is highlighted: wrong in an FPS
  // panel, in r3f-perf, and in the inspector's own numbers.
  it("leaves the renderer's frame counters describing the application's frame", () => {
    const { renderer, raw } = fakeRenderer();
    const info = { render: { calls: 0, triangles: 0, frame: 0 } };
    Object.assign(raw, { info });
    const draw = raw.render;
    raw.render = function (this: typeof raw, scene: THREE.Object3D) {
      draw.call(this, scene);
      const isApp = scene === appScene;
      info.render = Object.assign(info.render, { calls: isApp ? 40 : 2, triangles: isApp ? 9000 : 24, frame: info.render.frame + 1 });
    };
    const layer = new HighlightLayer();
    layer.set("selected", { object: new THREE.Mesh(new THREE.BoxGeometry()) });
    attachHighlight(renderer, layer, () => camera);

    renderer.render(appScene, camera);

    expect(info.render).toEqual({ calls: 40, triangles: 9000, frame: 1 });
  });

  it("removes its wrapper, and leaves a later one in place", () => {
    const { renderer, raw } = fakeRenderer();
    const original = raw.render;
    const detach = attachHighlight(renderer, new HighlightLayer(), () => camera);
    detach();
    expect(raw.render).toBe(original);

    const detachFirst = attachHighlight(renderer, new HighlightLayer(), () => camera);
    const later = vi.fn();
    raw.render = later;
    detachFirst();
    expect(raw.render).toBe(later);
  });
});

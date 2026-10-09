// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as THREE from "three";
import { Discovery } from "../../src/client/discovery.js";
import { Inspector } from "../../src/client/inspector.js";

/**
 * The inspector against real three objects and a stand-in renderer: what a
 * page does to it — a renderer announced on the devtools hook, a key, a
 * click — and what it does back.
 */

/** A WebGLRenderer as far as discovery and highlighting look at one. */
function fakeRenderer(canvas: HTMLCanvasElement) {
  const drawn: THREE.Object3D[] = [];
  const renderer = {
    isWebGLRenderer: true,
    domElement: canvas,
    autoClear: true,
    xr: { isPresenting: false },
    getRenderTarget: () => null,
    render: (scene: THREE.Object3D) => {
      drawn.push(scene);
    },
  };
  return { renderer: renderer as unknown as THREE.WebGLRenderer, drawn };
}

function canvasAt(width: number, height: number) {
  const canvas = document.createElement("canvas");
  canvas.getBoundingClientRect = () =>
    ({ left: 0, top: 0, right: width, bottom: height, width, height, x: 0, y: 0 }) as DOMRect;
  document.body.append(canvas);
  return canvas;
}

function sceneWithBox() {
  const scene = new THREE.Scene();
  const box = new THREE.Mesh(new THREE.BoxGeometry(2, 2, 2), new THREE.MeshBasicMaterial());
  box.userData.__ctsSource = {
    file: "src/Scene.tsx",
    function: "Scene",
    line: 12,
    column: 7,
    props: [
      {
        element: "mesh",
        name: "scale",
        array: false,
        values: [{ raw: "1.5", value: 1.5, editable: true, line: 12, column: 20 }],
      },
    ],
  };
  scene.add(box);
  scene.add(new THREE.AmbientLight());
  scene.updateMatrixWorld(true);
  const camera = new THREE.PerspectiveCamera(50, 1, 0.1, 100);
  camera.position.set(0, 0, 10);
  camera.updateMatrixWorld(true);
  return { scene, box, camera };
}

function announce(renderer: THREE.WebGLRenderer) {
  (globalThis as { __THREE_DEVTOOLS__?: EventTarget }).__THREE_DEVTOOLS__!.dispatchEvent(
    new CustomEvent("observe", { detail: renderer })
  );
}

const shadow = () => document.querySelector("cts-devtools")!.shadowRoot!;

describe("the injected inspector", () => {
  let canvas: HTMLCanvasElement;
  let renderer: ReturnType<typeof fakeRenderer>;
  let inspector: Inspector;
  let world: ReturnType<typeof sceneWithBox>;

  beforeEach(() => {
    sessionStorage.clear();
    delete (globalThis as { __THREE_DEVTOOLS__?: EventTarget }).__THREE_DEVTOOLS__;

    const discovery = new Discovery(null);
    discovery.install();
    canvas = canvasAt(400, 400);
    renderer = fakeRenderer(canvas);
    announce(renderer.renderer);

    world = sceneWithBox();
    renderer.renderer.render(world.scene, world.camera); // the app's first frame

    inspector = new Inspector(discovery, { hotkey: "alt+shift+c", button: true }, null);
    inspector.mount();
  });

  afterEach(() => {
    document.querySelector("cts-devtools")?.remove();
    canvas.remove();
  });

  const press = (init: KeyboardEventInit) =>
    window.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, ...init }));
  const clickCanvas = (x = 200, y = 200) => {
    canvas.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, clientX: x, clientY: y }));
    const event = new MouseEvent("click", { bubbles: true, cancelable: true, clientX: x, clientY: y });
    canvas.dispatchEvent(event);
    return event;
  };

  it("shows a toggle button on the canvas", () => {
    const toggle = shadow().querySelector<HTMLButtonElement>(".toggle")!;

    expect(toggle.hidden).toBe(false);
    expect(toggle.title).toBe("Inspect objects (Alt+Shift+C)");
  });

  it("toggles inspect mode with the hotkey and the button", () => {
    press({ altKey: true, shiftKey: true, code: "KeyC", key: "C" });
    expect(inspector.api().isInspecting()).toBe(true);
    expect(canvas.style.cursor).toBe("crosshair");

    shadow().querySelector<HTMLButtonElement>(".toggle")!.click();
    expect(inspector.api().isInspecting()).toBe(false);
    expect(canvas.style.cursor).toBe("");
  });

  it("ignores the hotkey while typing", () => {
    const input = document.createElement("input");
    document.body.append(input);
    input.dispatchEvent(
      new KeyboardEvent("keydown", { bubbles: true, composed: true, altKey: true, shiftKey: true, code: "KeyC" })
    );

    expect(inspector.api().isInspecting()).toBe(false);
    input.remove();
  });

  it("leaves clicks to the application until inspect mode is on", () => {
    const event = clickCanvas();

    expect(event.defaultPrevented).toBe(false);
    expect(inspector.api().selection()).toBeNull();
  });

  it("takes a click in inspect mode, selects what is under it, and opens the panel", () => {
    let appSawClick = false;
    canvas.addEventListener("click", () => (appSawClick = true));
    inspector.setInspecting(true);

    const event = clickCanvas();

    expect(event.defaultPrevented).toBe(true);
    expect(appSawClick).toBe(false);
    expect(inspector.api().selection()).toMatchObject({
      kind: "Mesh",
      file: "src/Scene.tsx",
      line: 12,
      function: "Scene",
    });

    const panel = shadow().querySelector(".panel")!;
    expect(panel.textContent).toContain("src/Scene.tsx:12");
    const input = panel.querySelector<HTMLInputElement>('[data-cts-edit="mesh.scale"]')!;
    expect(input.value).toBe("1.5");
  });

  it("draws the selection after the application's next frame", () => {
    inspector.setInspecting(true);
    clickCanvas();

    renderer.drawn.length = 0;
    renderer.renderer.render(world.scene, world.camera);

    expect(renderer.drawn[0]).toBe(world.scene);
    expect(renderer.drawn).toHaveLength(2);
  });

  // A drag orbits the camera; it must not also select whatever it ended on.
  it("does not select at the end of a drag", () => {
    inspector.setInspecting(true);
    canvas.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, clientX: 10, clientY: 10 }));
    canvas.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, clientX: 200, clientY: 200 }));

    expect(inspector.api().selection()).toBeNull();
  });

  it("clears the selection on a click at nothing", () => {
    inspector.setInspecting(true);
    clickCanvas();
    clickCanvas(5, 5);

    expect(inspector.api().selection()).toBeNull();
    expect(shadow().querySelector(".panel")).toBeNull();
  });

  it("leaves inspect mode on the first Esc and closes the panel on the second", () => {
    inspector.setInspecting(true);
    clickCanvas();

    press({ key: "Escape" });
    expect(inspector.api().isInspecting()).toBe(false);
    expect(inspector.api().selection()).not.toBeNull();

    press({ key: "Escape" });
    expect(inspector.api().selection()).toBeNull();
  });

  it("says plainly when an object has no source", () => {
    delete world.box.userData.__ctsSource;
    inspector.setInspecting(true);
    clickCanvas();

    expect(shadow().querySelector(".panel")!.textContent).toContain(
      "No source found for this object."
    );
  });

  it("remembers the mode and selection for after a reload", () => {
    inspector.setInspecting(true);
    clickCanvas();

    expect(JSON.parse(sessionStorage.getItem("__cts_inspector")!)).toEqual({
      inspecting: true,
      selection: { file: "src/Scene.tsx", line: 12, column: 7, ordinal: 0, instanceId: null },
    });
  });
});

describe("discovery", () => {
  beforeEach(() => {
    delete (globalThis as { __THREE_DEVTOOLS__?: EventTarget }).__THREE_DEVTOOLS__;
  });

  // The three.js devtools extension installs the hook too. Replacing it would
  // blind the extension.
  it("shares a devtools hook that is already there", () => {
    const existing = new EventTarget();
    (globalThis as { __THREE_DEVTOOLS__?: EventTarget }).__THREE_DEVTOOLS__ = existing;

    new Discovery(null).install();

    expect((globalThis as { __THREE_DEVTOOLS__?: EventTarget }).__THREE_DEVTOOLS__).toBe(existing);
  });

  // A post-processing pass renders a one-triangle scene of its own after the
  // application's, often with an orthographic camera.
  it("takes the application's scene, not a post-processing pass drawn after it", () => {
    const discovery = new Discovery(null);
    discovery.install();
    const { renderer } = fakeRenderer(canvasAt(100, 100));
    announce(renderer);

    const { scene, camera } = sceneWithBox();
    const pass = new THREE.Scene();
    pass.add(new THREE.Mesh());
    renderer.render(scene, camera);
    renderer.render(pass, new THREE.OrthographicCamera());

    const view = discovery.all()[0];
    expect(view.scene()).toBe(scene);
    expect(view.camera()).toBe(camera);
  });

  it("prefers what R3F's store names", () => {
    const canvas = canvasAt(100, 100);
    const { renderer } = fakeRenderer(canvas);
    const { scene, camera } = sceneWithBox();
    const roots = new Map([[canvas, { store: { getState: () => ({ gl: renderer, scene, camera, invalidate: () => {} }) } }]]);

    const discovery = new Discovery(roots as never);
    discovery.install(); // finds the renderer through R3F, with no hook event

    expect(discovery.all()[0].scene()).toBe(scene);
  });
});

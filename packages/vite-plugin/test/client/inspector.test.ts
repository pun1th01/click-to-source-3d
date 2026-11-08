// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as THREE from "three";
import { AGENT_ACTIVITY_EVENT, AGENT_SELECTION_EVENT, AGENT_STATE_EVENT } from "@click-to-source-3d/shared";
import { ctsEnter, ctsLeave, ctsNew, ctsSite } from "@click-to-source-3d/core/devtools";
import { AgentLink } from "../../src/client/agentLink.js";
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

describe("finding what is on the page", () => {
  afterEach(() => {
    delete (globalThis as { __THREE_DEVTOOLS__?: EventTarget }).__THREE_DEVTOOLS__;
    delete (globalThis as { __CTS_EARLY_RENDERERS__?: unknown }).__CTS_EARLY_RENDERERS__;
    document.body.replaceChildren();
    delete (document as { elementsFromPoint?: unknown }).elementsFromPoint;
  });

  it("finds a WebGPURenderer", () => {
    delete (globalThis as { __THREE_DEVTOOLS__?: EventTarget }).__THREE_DEVTOOLS__;
    const discovery = new Discovery(null);
    discovery.install();
    const renderer = {
      isRenderer: true,
      isWebGPURenderer: true,
      domElement: canvasAt(100, 100),
      autoClear: true,
      getRenderTarget: () => null,
      render: () => undefined,
    } as unknown as THREE.WebGLRenderer;

    announce(renderer);

    expect(discovery.all().map((view) => view.renderer)).toEqual([renderer]);
  });

  it("follows a frame drawn with renderAsync, and adds its highlight after", async () => {
    delete (globalThis as { __THREE_DEVTOOLS__?: EventTarget }).__THREE_DEVTOOLS__;
    const discovery = new Discovery(null);
    discovery.install();
    const drawn: unknown[] = [];
    const renderer = {
      isRenderer: true,
      isWebGPURenderer: true,
      domElement: canvasAt(100, 100),
      autoClear: true,
      getRenderTarget: () => null,
      render: () => undefined,
      renderAsync: async (scene: unknown) => {
        drawn.push(scene);
      },
    } as unknown as THREE.WebGLRenderer & { renderAsync(scene: unknown, camera: unknown): Promise<void> };
    announce(renderer);
    const [view] = discovery.all();
    const scene = new THREE.Scene();
    const mesh = new THREE.Mesh(new THREE.BoxGeometry());
    scene.add(mesh);
    const camera = new THREE.PerspectiveCamera();

    await renderer.renderAsync(scene, camera);
    expect(view.scene()).toBe(scene);
    expect(drawn).toEqual([scene]);

    view.layer.set("selected", { object: mesh });
    await renderer.renderAsync(scene, camera);

    expect(drawn).toEqual([scene, scene, view.layer.scene]);
    expect(renderer.autoClear).toBe(true);
  });

  it("takes a renderer made before it loaded", () => {
    delete (globalThis as { __THREE_DEVTOOLS__?: EventTarget }).__THREE_DEVTOOLS__;
    const { renderer } = fakeRenderer(canvasAt(100, 100));
    (globalThis as { __CTS_EARLY_RENDERERS__?: unknown }).__CTS_EARLY_RENDERERS__ = [renderer];

    const discovery = new Discovery(null);
    discovery.install();

    expect(discovery.all().map((view) => view.renderer)).toEqual([renderer]);
  });

  describe("a pointer over something other than the canvas", () => {
    const setUp = () => {
      delete (globalThis as { __THREE_DEVTOOLS__?: EventTarget }).__THREE_DEVTOOLS__;
      const discovery = new Discovery(null);
      discovery.install();
      const canvas = canvasAt(100, 100);
      announce(fakeRenderer(canvas).renderer);
      const overlay = document.createElement("div");
      document.body.append(overlay);
      (document as unknown as { elementsFromPoint: () => Element[] }).elementsFromPoint = () => [overlay, canvas];
      return { discovery, canvas, overlay };
    };

    it("finds the canvas it's over", () => {
      const { discovery, canvas } = setUp();

      expect(discovery.viewAt(canvas, 1, 1)?.canvas).toBe(canvas);
    });

    it("looks through a layer on top of the canvas", () => {
      const { discovery, canvas, overlay } = setUp();

      expect(discovery.viewAt(overlay, 1, 1)?.canvas).toBe(canvas);
    });

    it.each(["button", "a", "input", "select", "textarea", "label", "summary"])("leaves a <%s> its click", (tag) => {
      const { discovery } = setUp();
      const control = document.createElement(tag);
      document.body.append(control);

      expect(discovery.viewAt(control, 1, 1)).toBeNull();
    });

    it("leaves something inside a control its click", () => {
      const { discovery } = setUp();
      const button = document.createElement("button");
      const icon = document.createElement("span");
      button.append(icon);
      document.body.append(button);

      expect(discovery.viewAt(icon, 1, 1)).toBeNull();
    });

    it("leaves the inspector's own panel alone", () => {
      const { discovery } = setUp();

      expect(discovery.viewAt(document.createElement("cts-devtools"), 1, 1)).toBeNull();
    });

    it("finds nothing where no canvas is under the pointer", () => {
      const { discovery, overlay } = setUp();
      (document as unknown as { elementsFromPoint: () => Element[] }).elementsFromPoint = () => [overlay];

      expect(discovery.viewAt(overlay, 1, 1)).toBeNull();
    });
  });
});

describe("the injected inspector, for plain three.js", () => {
  const terrainStamp = (line: number, extra: object = {}) => ({
    file: "src/world.js",
    function: "createTerrain",
    line,
    column: 3,
    ...extra,
  });
  const literal = (raw: string, line: number, column: number) => ({
    raw,
    value: Number(raw),
    editable: true,
    line,
    column,
  });
  const generator = {
    id: "src/world.js#createTerrain",
    name: "createTerrain",
    file: "src/world.js",
    line: 30,
    column: 8,
    params: [{ name: "size", arg: 0 }],
    numbers: [{ line: 36, text: "const height = fbm(x * 0.08) * 6;", values: [literal("0.08", 36, 26)] }],
    uses: [
      {
        name: "fbm",
        depth: 0,
        file: "src/noise.js",
        line: 21,
        column: 8,
        params: ["x", "y"],
        numbers: [{ line: 22, text: "let amplitude = 0.5;", values: [literal("0.5", 22, 19)] }],
      },
      { name: "hash", depth: 1, file: "src/noise.js", line: 1, column: 8, params: ["x"], numbers: [] },
      { name: "createNoise2D", depth: 0, package: "simplex-noise" },
    ],
  };

  let inspector: Inspector;
  let terrain: THREE.Mesh;
  let canvas: HTMLCanvasElement;

  const selectTerrain = () => {
    inspector.setInspecting(true);
    canvas.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, clientX: 200, clientY: 200 }));
    canvas.dispatchEvent(new MouseEvent("click", { bubbles: true, clientX: 200, clientY: 200 }));
  };
  const text = () => shadow().querySelector(".panel")!.textContent ?? "";
  const postsOf = (fetcher: ReturnType<typeof vi.fn>) =>
    fetcher.mock.calls
      .filter(([url]) => url === "/__cts/write-file")
      .map(([, init]) => JSON.parse((init as { body: string }).body));

  beforeEach(() => {
    sessionStorage.clear();
    delete (globalThis as { __THREE_DEVTOOLS__?: EventTarget }).__THREE_DEVTOOLS__;
    delete (globalThis as { __CTS_TRACE__?: unknown }).__CTS_TRACE__;

    const discovery = new Discovery(null);
    discovery.install();
    canvas = canvasAt(400, 400);
    const { renderer } = fakeRenderer(canvas);
    announce(renderer);

    const scene = new THREE.Scene();
    terrain = ctsNew(
      new THREE.Mesh(
        ctsNew(
          new THREE.BoxGeometry(2, 2, 2),
          terrainStamp(31, {
            creates: "BoxGeometry",
            how: "new",
            generator,
            props: [{ element: "BoxGeometry", name: "args", array: true, values: [literal("2", 31, 40)] }],
          })
        ),
        ctsNew(
          new THREE.MeshStandardMaterial({ color: "#336699", roughness: 0.5 }),
          terrainStamp(43, {
            creates: "MeshStandardMaterial",
            how: "new",
            generator,
            props: [
              { element: "MeshStandardMaterial", name: "roughness", array: false, values: [literal("0.5", 43, 60)] },
              {
                element: "MeshStandardMaterial",
                name: "color",
                array: false,
                values: [{ raw: '"#336699"', value: "#336699", editable: true, line: 43, column: 40 }],
              },
            ],
          })
        )
      ),
      terrainStamp(41, { creates: "Mesh", how: "new", generator })
    );
    scene.add(terrain);
    scene.updateMatrixWorld(true);
    const camera = new THREE.PerspectiveCamera(50, 1, 0.1, 100);
    camera.position.set(0, 0, 10);
    camera.updateMatrixWorld(true);
    renderer.render(scene, camera);

    inspector = new Inspector(discovery, { hotkey: "alt+shift+c", button: true }, null);
    inspector.mount();
  });

  afterEach(() => {
    document.querySelector("cts-devtools")?.remove();
    canvas.remove();
    vi.unstubAllGlobals();
  });

  it("names where it came from, with nothing tagged", () => {
    selectTerrain();

    expect(text()).toContain("createTerrain");
    expect(text()).toContain("src/world.js:41");
    expect(terrain.userData).toEqual({});
  });

  it("gathers the properties of its geometry and material, wherever they were written", () => {
    selectTerrain();

    const elements = [...shadow().querySelectorAll(".element")].map((element) => element.textContent);
    expect(elements).toContain("BoxGeometrysrc/world.js:31");
    expect(elements).toContain("MeshStandardMaterialsrc/world.js:43");
  });

  it("lists the helpers, indented as they call each other, with packages named", () => {
    selectTerrain();

    const row = (name: string) => shadow().querySelector<HTMLElement>(`[data-cts-use="${name}"]`)!;
    expect(row("fbm").textContent).toContain("fbm(x, y)");
    expect(row("fbm").textContent).toContain("src/noise.js:21");
    expect(row("hash").style.marginLeft).toBe("12px");
    expect(row("createNoise2D").textContent).toContain("simplex-noise");
  });

  it("lists the other numbers with the line each is on", () => {
    selectTerrain();

    expect(text()).toContain("const height = fbm(x * 0.08) * 6;");
    const input = shadow().querySelector<HTMLInputElement>('[data-cts-edit="createTerrain.line 36[0]"]')!;
    expect(input.value).toBe("0.08");
    // Nothing in the scene can show it, so there is nothing to drag.
    expect(shadow().querySelector('[data-cts-slider="createTerrain.line 36[0]"]')).toBeNull();
  });

  it("previews a colour as it is typed, and only once it is one", () => {
    selectTerrain();
    const material = terrain.material as THREE.MeshStandardMaterial;
    const field = shadow().querySelector<HTMLInputElement>('[data-cts-edit="MeshStandardMaterial.color"]')!;
    expect(shadow().querySelector('[data-cts-slider="MeshStandardMaterial.color"]')).toBeNull();

    field.value = "#ff";
    field.dispatchEvent(new Event("input"));
    expect(material.color.getHexString()).toBe("336699");

    field.value = "#ff0000";
    field.dispatchEvent(new Event("input"));
    expect(material.color.getHexString()).toBe("ff0000");

    field.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(material.color.getHexString()).toBe("336699");
  });

  it("writes a helper's number to the helper's file", async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ success: true }), { status: 200 }));
    vi.stubGlobal("fetch", fetcher);
    selectTerrain();

    const field = shadow().querySelector<HTMLInputElement>('[data-cts-edit="fbm.line 22[0]"]')!;
    field.value = "0.25";
    field.dispatchEvent(new Event("input"));
    field.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));

    await vi.waitFor(() => expect(postsOf(fetcher)).toHaveLength(1));
    expect(postsOf(fetcher)[0].edits[0]).toMatchObject({
      file: "src/noise.js",
      line: 22,
      column: 19,
      expected: "0.5",
      newValue: 0.25,
    });
  });

  it("describes all of it for an assistant", () => {
    selectTerrain();
    const selected = inspector.api().selection()!;

    expect(selected.how).toBe("new");
    expect(selected.generators.map((fn) => fn.name)).toEqual(["createTerrain"]);
    expect(selected.props.map((prop) => prop.file)).toEqual(["src/world.js", "src/world.js", "src/world.js"]);
  });
});

describe("the injected inspector, with a call chain", () => {
  let inspector: Inspector;
  let canvas: HTMLCanvasElement;

  beforeEach(() => {
    sessionStorage.clear();
    delete (globalThis as { __THREE_DEVTOOLS__?: EventTarget }).__THREE_DEVTOOLS__;
    delete (globalThis as { __CTS_TRACE__?: unknown }).__CTS_TRACE__;

    const discovery = new Discovery(null);
    discovery.install();
    canvas = canvasAt(400, 400);
    const { renderer } = fakeRenderer(canvas);
    announce(renderer);

    const source = (name: string, params: string[]) => ({
      id: `src/world.js#${name}`,
      name,
      file: "src/world.js",
      line: 8,
      column: 8,
      params: params.map((param, arg) => ({ name: param, arg })),
      numbers: [],
      uses: [],
    });
    const scene = new THREE.Scene();

    ctsSite({
      target: "src/world.js#buildWorld",
      file: "src/main.js",
      line: 23,
      column: 1,
      args: [null, { raw: "7", value: 7, editable: true, line: 23, column: 18 }],
    });
    ctsEnter(source("buildWorld", ["scene", "seed"]), [scene, 7]);
    ctsSite({ target: "src/world.js#createTerrain", file: "src/world.js", line: 9, column: 3, args: [null] });
    ctsEnter(source("createTerrain", ["size"]), [40]);
    const mesh = ctsNew(
      new THREE.Mesh(new THREE.BoxGeometry(2, 2, 2), new THREE.MeshBasicMaterial()),
      { file: "src/world.js", function: "createTerrain", line: 41, column: 3, how: "new" }
    );
    ctsLeave();
    ctsLeave();

    scene.add(mesh);
    scene.updateMatrixWorld(true);
    const camera = new THREE.PerspectiveCamera(50, 1, 0.1, 100);
    camera.position.set(0, 0, 10);
    camera.updateMatrixWorld(true);
    renderer.render(scene, camera);

    inspector = new Inspector(discovery, { hotkey: "alt+shift+c", button: true }, null);
    inspector.mount();
    inspector.setInspecting(true);
    canvas.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, clientX: 200, clientY: 200 }));
    canvas.dispatchEvent(new MouseEvent("click", { bubbles: true, clientX: 200, clientY: 200 }));
  });

  afterEach(() => {
    document.querySelector("cts-devtools")?.remove();
    canvas.remove();
    vi.unstubAllGlobals();
  });

  const frames = () => [...shadow().querySelectorAll<HTMLElement>("[data-cts-frame]")];

  it("shows the nearest call first, with where each was made", () => {
    expect(frames().map((frame) => frame.dataset.ctsFrame)).toEqual(["createTerrain", "buildWorld"]);
    expect(frames()[1].textContent).toContain("src/main.js:23");
  });

  it("shows a value passed along as it was, read-only", () => {
    expect(frames()[0].querySelector("input")).toBeNull();
    expect(frames()[0].textContent).toContain("40");
    expect(frames()[1].textContent).toContain("<Scene>");
  });

  it("writes a literal argument where the call is", async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ success: true }), { status: 200 }));
    vi.stubGlobal("fetch", fetcher);

    const field = frames()[1].querySelector<HTMLInputElement>("input")!;
    expect(field.value).toBe("7");
    expect(field.getAttribute("data-cts-edit")).toBe("buildWorld.seed");
    expect(frames()[1].querySelector("input.slider")).toBeNull();

    field.value = "12";
    field.dispatchEvent(new Event("input"));
    field.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));

    await vi.waitFor(() => expect(fetcher).toHaveBeenCalled());
    const body = JSON.parse((fetcher.mock.calls[0] as unknown as [string, { body: string }])[1].body);
    expect(body.edits[0]).toMatchObject({ file: "src/main.js", line: 23, column: 18, expected: "7", newValue: 12 });
  });

  it("tells a report about the calls", () => {
    expect(inspector.api().selection()!.trace.map((frame) => frame.name)).toEqual(["buildWorld", "createTerrain"]);
  });
});

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
      pointerMode: false,
      panelOpen: true,
      tab: "inspect",
      selection: { file: "src/Scene.tsx", line: 12, column: 7, ordinal: 0, instanceId: null },
      pointing: [],
      pins: [],
    });
  });

  describe("the panel's tabs", () => {
    const openTab = (name: string) =>
      shadow().querySelector<HTMLButtonElement>(`[data-cts-open-tab="${name}"]`)!.click();
    const visibleBody = () => shadow().querySelector<HTMLElement>(".body:not([hidden])")!;

    it("opens on Inspect", () => {
      inspector.setInspecting(true);
      clickCanvas();

      expect(visibleBody().getAttribute("data-cts-tab")).toBe("inspect");
    });

    it("has no Agent tab without a bridge to reach an assistant through", () => {
      inspector.setInspecting(true);
      clickCanvas();

      expect(shadow().querySelector('[data-cts-open-tab="agent"]')).toBeNull();
      expect(shadow().querySelector('[data-cts-action="point"]')).toBeNull();
    });

    // A draft in the Inspect tab must survive looking at another tab.
    it("keeps a draft across a tab switch", () => {
      inspector.setInspecting(true);
      clickCanvas();
      const input = shadow().querySelector<HTMLInputElement>('[data-cts-edit="mesh.scale"]')!;
      input.value = "9";
      input.dispatchEvent(new Event("input"));

      openTab("compare");
      openTab("inspect");

      expect(shadow().querySelector<HTMLInputElement>('[data-cts-edit="mesh.scale"]')).toBe(input);
      expect(input.value).toBe("9");
    });
  });

  describe("the toolbar", () => {
    // jsdom has neither a clipboard nor a canvas to read, which is a fair test
    // of both failing: the panel says so, and nothing is left unhandled.
    it("says so when a copy fails, and leaves nothing unhandled", async () => {
      vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
      const unhandled = vi.fn();
      process.on("unhandledRejection", unhandled);
      inspector.setInspecting(true);
      clickCanvas();

      shadow().querySelector<HTMLButtonElement>('[data-cts-action="screenshot"]')!.click();
      await vi.waitFor(() =>
        expect(shadow().querySelector(".status")!.textContent).toContain("Could not copy")
      );
      renderer.renderer.render(world.scene, world.camera);
      await new Promise((resolve) => setTimeout(resolve, 20));

      expect(unhandled).not.toHaveBeenCalled();
      process.off("unhandledRejection", unhandled);
      vi.restoreAllMocks();
    });

    it("still copies the report's text when the picture cannot be taken", async () => {
      vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
      const writeText = vi.fn(async () => undefined);
      Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
      inspector.setInspecting(true);
      clickCanvas();

      shadow().querySelector<HTMLButtonElement>('[data-cts-action="report"]')!.click();
      await vi.waitFor(() => expect(writeText).toHaveBeenCalled());

      expect((writeText.mock.calls[0] as unknown as [string])[0]).toContain("### Mesh at `src/Scene.tsx:12`");
      await vi.waitFor(() =>
        expect(shadow().querySelector(".status")!.textContent).toContain("Copied the report as Markdown")
      );
      renderer.renderer.render(world.scene, world.camera);
      await new Promise((resolve) => setTimeout(resolve, 20));
      Object.defineProperty(navigator, "clipboard", { value: undefined, configurable: true });
      vi.restoreAllMocks();
    });
  });

  describe("performance", () => {
    it("shows what the object costs, in its summary", () => {
      inspector.setInspecting(true);
      clickCanvas();

      const summaries = [...shadow().querySelectorAll("summary")].map((summary) => summary.textContent);
      expect(summaries).toContain("Performance12 triangles · 1 draw call");

      const panel = shadow().querySelector(".panel")!.textContent;
      expect(panel).toContain("vertices24");
      expect(panel).toContain("materials1");
    });

    it("says what share of the frame it is, as three counted it", () => {
      (renderer.renderer as unknown as { info: unknown }).info = { render: { triangles: 48, calls: 3 } };
      inspector.setInspecting(true);
      clickCanvas();

      expect(shadow().querySelector(".panel")!.textContent).toContain("25% of 48 triangles");
    });

    // A composer's final pass draws one triangle, which says nothing about the frame.
    it("makes no claim from a count smaller than the object", () => {
      (renderer.renderer as unknown as { info: unknown }).info = { render: { triangles: 1, calls: 1 } };
      inspector.setInspecting(true);
      clickCanvas();

      expect(shadow().querySelector(".panel")!.textContent).not.toContain("of the frame");
    });

    it("stays open across a redraw once opened", () => {
      inspector.setInspecting(true);
      clickCanvas();
      const details = [...shadow().querySelectorAll("details")][0];
      details.open = true;
      details.dispatchEvent(new Event("toggle"));

      clickCanvas();

      expect([...shadow().querySelectorAll("details")][0].open).toBe(true);
    });

    it("has nothing to say about an object that draws nothing", () => {
      const view = (inspector as unknown as { discovery: Discovery }).discovery.all()[0];
      const group = new THREE.Group();
      world.scene.add(group);

      inspector.select({
        view,
        pick: { object: group, instanceId: null, point: new THREE.Vector3(), distance: 0, resolution: null },
      });

      const summaries = [...shadow().querySelectorAll("summary")].map((summary) => summary.textContent);
      expect(summaries).toEqual(["Details"]);
    });
  });

  describe("previewing a value", () => {
    const field = () => shadow().querySelector<HTMLInputElement>('[data-cts-edit="mesh.scale"]')!;
    const slider = () => shadow().querySelector<HTMLInputElement>('[data-cts-slider="mesh.scale"]')!;

    beforeEach(() => {
      inspector.setInspecting(true);
      clickCanvas();
    });

    it("offers a slider starting at the value", () => {
      expect(slider().value).toBe("1.5");
      expect(Number(slider().max)).toBeGreaterThan(1.5);
    });

    it("shows a dragged value in the scene without saving it", () => {
      slider().value = "3";
      slider().dispatchEvent(new Event("input"));

      expect(world.box.scale.toArray()).toEqual([3, 3, 3]);
      expect(field().value).toBe("3");
      expect(field().classList.contains("dirty")).toBe(true);
      expect(shadow().querySelector<HTMLElement>(".unsaved")!.hidden).toBe(false);
      expect(shadow().querySelector(".unsaved")!.textContent).toContain("1 unsaved value");
    });

    it("shows a typed value in the scene too, and moves the slider", () => {
      field().value = "2";
      field().dispatchEvent(new Event("input"));

      expect(world.box.scale.x).toBe(2);
      expect(slider().value).toBe("2");
    });

    it("stretches the slider for a value past where a drag would reach", () => {
      field().value = "500";
      field().dispatchEvent(new Event("input"));

      expect(Number(slider().max)).toBe(500);
      expect(world.box.scale.x).toBe(500);
    });

    it("ignores what cannot be a number, until it can", () => {
      field().value = "abc";
      field().dispatchEvent(new Event("input"));

      expect(world.box.scale.x).toBe(1);
    });

    it("puts the value back on Revert", () => {
      slider().value = "3";
      slider().dispatchEvent(new Event("input"));

      shadow().querySelector<HTMLButtonElement>('[data-cts-action="revert"]')!.click();

      expect(world.box.scale.x).toBe(1);
      expect(field().value).toBe("1.5");
      expect(field().classList.contains("dirty")).toBe(false);
      expect(shadow().querySelector<HTMLElement>(".unsaved")!.hidden).toBe(true);
    });

    it("puts the value back on Esc", () => {
      slider().value = "3";
      slider().dispatchEvent(new Event("input"));

      field().dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));

      expect(world.box.scale.x).toBe(1);
      expect(field().value).toBe("1.5");
    });

    it("clears the bar when a value is dragged back to where it started", () => {
      slider().value = "3";
      slider().dispatchEvent(new Event("input"));
      slider().value = "1.5";
      slider().dispatchEvent(new Event("input"));

      expect(shadow().querySelector<HTMLElement>(".unsaved")!.hidden).toBe(true);
    });

    it("puts the value back when another object is selected", () => {
      slider().value = "3";
      slider().dispatchEvent(new Event("input"));

      clickCanvas(5, 5);

      expect(world.box.scale.x).toBe(1);
    });

    it("writes only when told to", async () => {
      const posts: unknown[] = [];
      vi.stubGlobal("fetch", async (_url: string, init: { body: string }) => {
        posts.push(JSON.parse(init.body));
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      });

      slider().value = "3";
      slider().dispatchEvent(new Event("input"));
      expect(posts).toEqual([]);

      field().dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
      await vi.waitFor(() => expect(posts).toHaveLength(1));

      expect(posts[0]).toMatchObject({
        edits: [{ file: "src/Scene.tsx", line: 12, column: 20, expected: "1.5", newValue: 3 }],
      });
      await vi.waitFor(() => expect(shadow().querySelector(".status")!.textContent).toContain("Saved scale"));
      // The saved value stays on screen, for R3F to apply.
      expect(world.box.scale.x).toBe(3);
      vi.unstubAllGlobals();
    });

    it("refuses what is not a number, naming the problem, and writes nothing", async () => {
      const fetcher = vi.fn();
      vi.stubGlobal("fetch", fetcher);

      field().value = "abc";
      field().dispatchEvent(new Event("input"));
      shadow().querySelector<HTMLButtonElement>('[data-cts-action="save"]')!.click();
      await new Promise((resolve) => setTimeout(resolve));

      expect(fetcher).not.toHaveBeenCalled();
      expect(shadow().querySelector(".status")!.textContent).toContain("Enter a number");
      vi.unstubAllGlobals();
    });
  });

  // Rewriting a literal can change its length and move what follows it on the
  // line, so saving several in file order would make the later ones stale.
  describe("saving several values", () => {
    function worldWithValues() {
      const stamped = world.box.userData.__ctsSource;
      const value = (raw: string, column: number) => ({ raw, value: Number(raw), editable: true, line: 12, column });
      stamped.props = [
        { element: "mesh", name: "position", array: true, values: [value("1", 20), value("2", 23), value("3", 26)] },
      ];
    }

    // A save can reload the page, and a request not yet sent by then never would be.
    it("sends them all in one request", async () => {
      worldWithValues();
      inspector.setInspecting(true);
      clickCanvas();
      const posts: Array<{ edits: Array<{ column: number; newValue: number }> }> = [];
      vi.stubGlobal("fetch", async (_url: string, init: { body: string }) => {
        posts.push(JSON.parse(init.body));
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      });

      for (const [index, next] of [[0, "10"], [2, "30"]] as const) {
        const input = shadow().querySelector<HTMLInputElement>(`[data-cts-edit="mesh.position[${index}]"]`)!;
        input.value = next;
        input.dispatchEvent(new Event("input"));
      }

      expect(shadow().querySelector(".unsaved")!.textContent).toContain("2 unsaved values");
      shadow().querySelector<HTMLButtonElement>('[data-cts-action="save"]')!.click();
      await vi.waitFor(() => expect(posts).toHaveLength(1));

      expect(posts[0].edits.map((edit) => [edit.column, edit.newValue])).toEqual([[20, 10], [26, 30]]);
      await vi.waitFor(() => expect(shadow().querySelector(".status")!.textContent).toContain("Saved 2 values"));
      vi.unstubAllGlobals();
    });

    // One constant can be shown in several fields, and is still one literal.
    describe("a constant shown in several fields", () => {
      const field = (index: number) =>
        shadow().querySelector<HTMLInputElement>(`[data-cts-edit="mesh.position[${index}]"]`)!;
      const slider = (index: number) =>
        shadow().querySelector<HTMLInputElement>(`[data-cts-slider="mesh.position[${index}]"]`)!;

      beforeEach(() => {
        const constant = { raw: "4", value: 4, editable: true, line: 3, column: 15, via: "SIZE" };
        world.box.position.set(4, 4, 4);
        world.box.userData.__ctsSource.props = [
          { element: "mesh", name: "position", array: true, values: [constant, { ...constant }, { ...constant }] },
        ];
        world.scene.updateMatrixWorld(true);
        inspector.setInspecting(true);
        // The box moved, so click where it now is.
        inspector.select({
          view: (inspector as unknown as { discovery: Discovery }).discovery.all()[0],
          pick: {
            object: world.box,
            instanceId: null,
            point: new THREE.Vector3(),
            distance: 0,
            resolution: { object: world.box, sourceRef: { file: "src/Scene.tsx", function: "Scene", line: 12, args: {} } },
          },
        });
      });

      // Saving any of them changes all of them, so a preview of only one would
      // show something the save will not do.
      it("previews in all of them when one is dragged", () => {
        slider(1).value = "6";
        slider(1).dispatchEvent(new Event("input"));

        expect(world.box.position.toArray()).toEqual([6, 6, 6]);
        expect([field(0).value, field(1).value, field(2).value]).toEqual(["6", "6", "6"]);
        expect(slider(2).value).toBe("6");
      });

      it("previews in all of them when one is typed in", () => {
        field(0).value = "7";
        field(0).dispatchEvent(new Event("input"));

        expect(world.box.position.toArray()).toEqual([7, 7, 7]);
        expect(field(2).value).toBe("7");
      });

      it("puts them all back on Esc in any one", () => {
        field(0).value = "7";
        field(0).dispatchEvent(new Event("input"));

        field(1).dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));

        expect(world.box.position.toArray()).toEqual([4, 4, 4]);
        expect(field(2).value).toBe("4");
        expect(shadow().querySelector<HTMLElement>(".unsaved")!.hidden).toBe(true);
      });

      it("writes the one literal once", async () => {
        const posts: Array<{ edits: Array<{ newValue: number; line: number; column: number }> }> = [];
        vi.stubGlobal("fetch", async (_url: string, init: { body: string }) => {
          posts.push(JSON.parse(init.body));
          return new Response(JSON.stringify({ ok: true }), { status: 200 });
        });

        slider(0).value = "6";
        slider(0).dispatchEvent(new Event("input"));
        shadow().querySelector<HTMLButtonElement>('[data-cts-action="save"]')!.click();
        await vi.waitFor(() => expect(shadow().querySelector(".status")!.textContent).toContain("Saved SIZE"));

        expect(posts).toHaveLength(1);
        expect(posts[0].edits).toHaveLength(1);
        expect(posts[0].edits[0]).toMatchObject({ newValue: 6, line: 3, column: 15 });
        vi.unstubAllGlobals();
      });
    });

    it("keeps what was typed when the save is refused, and says why", async () => {
      worldWithValues();
      inspector.setInspecting(true);
      clickCanvas();
      vi.stubGlobal(
        "fetch",
        async () => new Response(JSON.stringify({ error: "The file changed", code: "STALE_LOCATION" }), { status: 409 })
      );

      for (const [index, next] of [[0, "10"], [2, "30"]] as const) {
        const input = shadow().querySelector<HTMLInputElement>(`[data-cts-edit="mesh.position[${index}]"]`)!;
        input.value = next;
        input.dispatchEvent(new Event("input"));
      }
      shadow().querySelector<HTMLButtonElement>('[data-cts-action="save"]')!.click();

      await vi.waitFor(() => expect(shadow().querySelector(".status")!.textContent).toContain("The file changed"));
      expect(shadow().querySelector(".unsaved")!.textContent).toContain("2 unsaved values");
      vi.unstubAllGlobals();
    });
  });

  describe("pinning and comparing", () => {
    function twoBoxes() {
      const other = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicMaterial());
      other.position.set(0, 0, -4);
      other.userData.__ctsSource = { file: "src/Other.tsx", function: "Other", line: 30, column: 3 };
      world.scene.add(other);
      world.scene.updateMatrixWorld(true);
      return other;
    }
    const pin = () => shadow().querySelector<HTMLButtonElement>('[data-cts-action="pin"]')!;
    const openCompare = () => shadow().querySelector<HTMLButtonElement>('[data-cts-open-tab="compare"]')!.click();

    beforeEach(() => {
      inspector.setInspecting(true);
      clickCanvas();
    });

    it("pins the selection, and says so", () => {
      pin().click();

      expect(inspector.api().pins()).toEqual([{ what: "Mesh", where: "src/Scene.tsx:12" }]);
      expect(pin().getAttribute("aria-pressed")).toBe("true");
      expect(pin().textContent).toBe("Pinned");
    });

    it("unpins on a second press", () => {
      pin().click();
      pin().click();

      expect(inspector.api().pins()).toEqual([]);
    });

    it("says what to do when nothing is pinned", () => {
      openCompare();

      expect(shadow().querySelector('[data-cts-tab="compare"]')!.textContent).toContain("Pin this object");
    });

    it("explains itself with nothing at all to compare", () => {
      openCompare();
      inspector.select(null);

      expect(shadow().querySelector('[data-cts-tab="compare"]')!.textContent).toContain("Pin an object");
    });

    it("asks for another object once one is pinned", () => {
      pin().click();
      openCompare();

      expect(shadow().querySelector('[data-cts-tab="compare"]')!.textContent).toContain("Select another object");
    });

    it("compares a pin with the selection, marking what differs", () => {
      pin().click();
      const other = twoBoxes();
      const target = { view: (inspector as unknown as { selection: { view: unknown } }).selection.view };
      inspector.select({
        view: target.view as never,
        pick: {
          object: other,
          instanceId: null,
          point: new THREE.Vector3(),
          distance: 0,
          resolution: { object: other, sourceRef: { file: "src/Other.tsx", function: "Other", line: 30, args: {} } },
        },
      });

      openCompare();

      const tab = shadow().querySelector('[data-cts-tab="compare"]')!;
      expect(tab.textContent).toContain("src/Scene.tsx:12");
      expect(tab.textContent).toContain("src/Other.tsx:30");
      const different = [...tab.querySelectorAll(".differs")].map((cell) => cell.textContent);
      expect(different).toContain("Scene");
      expect(different).toContain("Other");
    });

    it("can show only what differs", () => {
      pin().click();
      const other = twoBoxes();
      const view = (inspector as unknown as { selection: { view: unknown } }).selection.view;
      inspector.select({
        view: view as never,
        pick: {
          object: other,
          instanceId: null,
          point: new THREE.Vector3(),
          distance: 0,
          resolution: { object: other, sourceRef: { file: "src/Other.tsx", function: "Other", line: 30, args: {} } },
        },
      });
      openCompare();

      const check = shadow().querySelector<HTMLInputElement>('[data-cts-action="differences-only"]')!;
      check.checked = true;
      check.dispatchEvent(new Event("change"));

      const tab = shadow().querySelector('[data-cts-tab="compare"]')!;
      expect(tab.querySelectorAll(".cell:not(.differs)")).toHaveLength(0);
      expect(tab.querySelectorAll(".cell.differs").length).toBeGreaterThan(0);
    });

    it("holds two pins, and a third replaces the oldest", () => {
      pin().click();
      const other = twoBoxes();
      const third = twoBoxes();
      const view = (inspector as unknown as { selection: { view: unknown } }).selection.view;
      const choose = (object: THREE.Object3D, line: number) =>
        inspector.select({
          view: view as never,
          pick: {
            object,
            instanceId: null,
            point: new THREE.Vector3(),
            distance: 0,
            resolution: { object, sourceRef: { file: "src/Other.tsx", function: "Other", line, args: {} } },
          },
        });

      choose(other, 30);
      pin().click();
      choose(third, 31);
      pin().click();

      expect(inspector.api().pins().map((entry) => entry.where)).toEqual(["src/Other.tsx:30", "src/Other.tsx:31"]);
    });

    it("remembers what is pinned for after a reload", () => {
      pin().click();

      expect(JSON.parse(sessionStorage.getItem("__cts_inspector")!).pins).toEqual([
        { file: "src/Scene.tsx", line: 12, column: 7, ordinal: 0, instanceId: null },
      ]);
    });
  });
});

describe("pointing an assistant at objects", () => {
  let canvas: HTMLCanvasElement;
  let renderer: ReturnType<typeof fakeRenderer>;
  let inspector: Inspector;
  let world: ReturnType<typeof sceneWithBox>;
  let channel: ReturnType<typeof fakeHot>;

  function fakeHot() {
    const sent: Array<{ event: string; data: unknown }> = [];
    const listeners = new Map<string, Array<(data: never) => void>>();
    return {
      sent,
      hot: {
        send: (event: string, data?: unknown) => sent.push({ event, data }),
        on: (event: string, listener: (data: never) => void) =>
          listeners.set(event, [...(listeners.get(event) ?? []), listener]),
      },
      emit: (event: string, data?: unknown) =>
        (listeners.get(event) ?? []).forEach((listener) => listener(data as never)),
    };
  }

  const claude = { id: "1", name: "Claude Code", lastCallAt: null };
  const published = () =>
    channel.sent.filter((message) => message.event === AGENT_SELECTION_EVENT).at(-1)?.data as
      | { pointing: Array<{ kind: string; source: { line: number } | null; props: unknown[] }>; selected: unknown }
      | undefined;

  const clickCanvas = (init: MouseEventInit = {}) => {
    canvas.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, clientX: 200, clientY: 200 }));
    canvas.dispatchEvent(
      new MouseEvent("click", { bubbles: true, cancelable: true, clientX: 200, clientY: 200, ...init })
    );
  };
  const pointerButton = () => shadow().querySelector<HTMLButtonElement>(".toggle.pointer")!;
  const agentTab = () => shadow().querySelector<HTMLElement>('[data-cts-tab="agent"]')!;

  beforeEach(() => {
    sessionStorage.clear();
    delete (globalThis as { __THREE_DEVTOOLS__?: EventTarget }).__THREE_DEVTOOLS__;

    const discovery = new Discovery(null);
    discovery.install();
    canvas = canvasAt(400, 400);
    renderer = fakeRenderer(canvas);
    announce(renderer.renderer);
    world = sceneWithBox();
    renderer.renderer.render(world.scene, world.camera);

    channel = fakeHot();
    const agent = new AgentLink(discovery, channel.hot);
    inspector = new Inspector(discovery, { hotkey: "alt+shift+c", button: true }, channel.hot, agent);
    inspector.mount();
  });

  afterEach(() => {
    document.querySelector("cts-devtools")?.remove();
    canvas.remove();
  });

  describe("the pointer button", () => {
    it("stays out of the way until there is an assistant to point", () => {
      expect(pointerButton().hidden).toBe(true);

      channel.emit(AGENT_STATE_EVENT, { agents: [claude], log: [] });

      expect(pointerButton().hidden).toBe(false);
    });

    it("turns on pointer mode and opens the Agent tab", () => {
      channel.emit(AGENT_STATE_EVENT, { agents: [claude], log: [] });

      pointerButton().click();

      expect(inspector.api().isInspecting()).toBe(true);
      expect(pointerButton().getAttribute("aria-pressed")).toBe("true");
      expect(agentTab().hidden).toBe(false);
      expect(agentTab().textContent).toContain("Claude Code connected");
    });

    it("points at each object clicked, leaving the selection alone", () => {
      pointerButton().click();

      clickCanvas();

      expect(inspector.api().pointing()).toEqual([{ what: "Mesh", where: "src/Scene.tsx:12" }]);
      expect(inspector.api().selection()).toBeNull();
      expect(agentTab().hidden).toBe(false);
    });

    it("lets go of an object clicked again", () => {
      pointerButton().click();

      clickCanvas();
      clickCanvas();

      expect(inspector.api().pointing()).toEqual([]);
    });

    it("counts what is pointed at on the button", () => {
      pointerButton().click();
      clickCanvas();

      expect(pointerButton().querySelector<HTMLElement>(".count")!.textContent).toBe("1");
      expect(pointerButton().querySelector<HTMLElement>(".count")!.hidden).toBe(false);
    });

    it("ends pointer mode on Esc, keeping what is pointed at", () => {
      pointerButton().click();
      clickCanvas();

      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));

      expect(inspector.api().isInspecting()).toBe(false);
      expect(pointerButton().getAttribute("aria-pressed")).toBe("false");
      expect(inspector.api().pointing()).toHaveLength(1);
    });

    it("does nothing at a click on empty space", () => {
      pointerButton().click();

      canvas.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, clientX: 5, clientY: 5 }));
      canvas.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, clientX: 5, clientY: 5 }));

      expect(inspector.api().pointing()).toEqual([]);
    });

    it("stays up while something is pointed at, even with no assistant", () => {
      inspector.setInspecting(true);
      clickCanvas({ shiftKey: true });

      expect(pointerButton().hidden).toBe(false);
    });
  });

  describe("Shift+click", () => {
    it("adds to what is pointed at, in plain inspect mode", () => {
      inspector.setInspecting(true);

      clickCanvas({ shiftKey: true });

      expect(inspector.api().pointing()).toHaveLength(1);
      expect(inspector.api().selection()).toBeNull();
    });

    it("leaves a plain click selecting as ever", () => {
      inspector.setInspecting(true);

      clickCanvas();

      expect(inspector.api().pointing()).toEqual([]);
      expect(inspector.api().selection()).not.toBeNull();
    });

    it("is the application's outside inspect mode", () => {
      clickCanvas({ shiftKey: true });

      expect(inspector.api().pointing()).toEqual([]);
    });
  });

  describe("the Point button in the panel", () => {
    it("points at the selected object, and lets go again", () => {
      inspector.setInspecting(true);
      clickCanvas();
      const point = () => shadow().querySelector<HTMLButtonElement>('[data-cts-action="point"]')!;

      point().click();
      expect(inspector.api().pointing()).toHaveLength(1);
      expect(point().getAttribute("aria-pressed")).toBe("true");
      expect(point().textContent).toBe("Pointing");

      point().click();
      expect(inspector.api().pointing()).toEqual([]);
    });
  });

  describe("what the assistant is told", () => {
    it("publishes what is pointed at, with what it takes to edit it", () => {
      inspector.setInspecting(true);
      clickCanvas({ shiftKey: true });

      const [object] = published()!.pointing;
      expect(object).toMatchObject({
        kind: "Mesh",
        source: { file: "src/Scene.tsx", function: "Scene", line: 12, column: 7 },
        address: { file: "src/Scene.tsx", function: "Scene", line: 12, ordinal: 0 },
        props: [{ element: "mesh", name: "scale", values: [{ raw: "1.5", line: 12, column: 20 }] }],
      });
    });

    it("publishes the selection too, for when nothing is pointed at", () => {
      inspector.setInspecting(true);
      clickCanvas();

      expect(published()).toMatchObject({ pointing: [], selected: { kind: "Mesh" } });
    });

    it("publishes letting go", () => {
      inspector.setInspecting(true);
      clickCanvas({ shiftKey: true });
      clickCanvas({ shiftKey: true });

      expect(published()!.pointing).toEqual([]);
    });

    it("gives where it is and what it costs", () => {
      inspector.setInspecting(true);
      clickCanvas({ shiftKey: true });

      expect(published()!.pointing[0]).toMatchObject({
        transform: { position: [0, 0, 0], scale: [1, 1, 1], worldPosition: [0, 0, 0] },
        materials: ["MeshBasicMaterial #ffffff"],
        cost: { triangles: 12, drawCalls: 1 },
      });
    });

    it("names the parents of an object with no source", () => {
      delete world.box.userData.__ctsSource;
      inspector.setInspecting(true);
      clickCanvas({ shiftKey: true });

      expect(published()!.pointing[0]).toMatchObject({ source: null, address: null, parents: ["Scene"] });
    });
  });

  describe("the Agent tab", () => {
    beforeEach(() => {
      inspector.setInspecting(true);
      clickCanvas();
      shadow().querySelector<HTMLButtonElement>('[data-cts-open-tab="agent"]')!.click();
    });

    it("says no assistant is connected", () => {
      expect(agentTab().textContent).toContain("No assistant connected");
    });

    describe("turning on the MCP server", () => {
      const off = { folder: "my-scene", registered: [], written: [], problems: [], assistant: "Claude Code" };
      const on = { ...off, registered: [".mcp.json"], written: [".mcp.json"] };
      const button = () => agentTab().querySelector<HTMLButtonElement>('[data-cts-action="mcp-on"]');
      const reply = (status: number, body: unknown) =>
        new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

      /** Opens the tab again with the dev server answering as given. */
      async function open(answer: (init?: RequestInit) => Response) {
        const fetcher = vi.fn(async (_url: string, init?: RequestInit) => answer(init));
        vi.stubGlobal("fetch", fetcher);
        shadow().querySelector<HTMLButtonElement>('[data-cts-open-tab="inspect"]')!.click();
        (inspector as unknown as { setupAsked: boolean; agent: { setup: unknown } }).setupAsked = false;
        (inspector as unknown as { agent: { setup: unknown } }).agent.setup = null;
        shadow().querySelector<HTMLButtonElement>('[data-cts-open-tab="agent"]')!.click();
        await vi.waitFor(() => expect(fetcher).toHaveBeenCalled());
        return fetcher;
      }

      afterEach(() => {
        vi.unstubAllGlobals();
      });

      it("offers a button where it isn't on", async () => {
        await open(() => reply(200, off));

        await vi.waitFor(() => expect(button()).not.toBeNull());
        expect(button()!.textContent).toContain("Turn on MCP server");
        expect(agentTab().textContent).toContain('.mcp.json in "my-scene"');
      });

      it("turns it on, and says what to do next", async () => {
        const fetcher = await open((init) => reply(200, init?.method === "POST" ? on : off));
        await vi.waitFor(() => expect(button()).not.toBeNull());

        button()!.click();

        await vi.waitFor(() => expect(agentTab().querySelector('[data-cts-mcp="on"]')).not.toBeNull());
        expect(fetcher).toHaveBeenCalledWith("/__cts/mcp", { method: "POST" });
        expect(agentTab().textContent).toContain("Now start Claude Code in \"my-scene\"");
        expect(button()).toBeNull();
      });

      it("says it is already on, with no button", async () => {
        await open(() => reply(200, on));

        await vi.waitFor(() => expect(agentTab().querySelector('[data-cts-mcp="on"]')).not.toBeNull());
        expect(button()).toBeNull();
      });

      it("says why when it couldn't", async () => {
        await open((init) => (init?.method === "POST" ? reply(500, { error: "disk full" }) : reply(200, off)));
        await vi.waitFor(() => expect(button()).not.toBeNull());

        button()!.click();

        await vi.waitFor(() => expect(agentTab().querySelector('[role="alert"]')?.textContent).toContain("disk full"));
        expect(button()).not.toBeNull();
      });

      it("says which file it couldn't edit", async () => {
        const problem = { ...off, problems: [{ file: ".mcp.json", reason: "Unexpected token" }] };
        await open((init) => reply(200, init?.method === "POST" ? problem : off));
        await vi.waitFor(() => expect(button()).not.toBeNull());

        button()!.click();

        await vi.waitFor(() => expect(agentTab().querySelector('[role="alert"]')?.textContent).toContain(".mcp.json: Unexpected token"));
      });

      it("isn't offered once an assistant connects", async () => {
        await open(() => reply(200, off));
        await vi.waitFor(() => expect(button()).not.toBeNull());

        channel.emit(AGENT_STATE_EVENT, { agents: [claude], log: [] });

        expect(agentTab().textContent).toContain("Claude Code connected · no calls yet");
        expect(button()).toBeNull();
      });
    });

    it("adds the selected object on request", () => {
      shadow().querySelector<HTMLButtonElement>('[data-cts-action="point-selected"]')!.click();

      expect(inspector.api().pointing()).toHaveLength(1);
      expect(agentTab().textContent).toContain("Pointing at 1");
      expect(agentTab().textContent).toContain("src/Scene.tsx:12");
      expect(shadow().querySelector('[data-cts-action="point-selected"]')).toBeNull();
    });

    it("clears the list", () => {
      shadow().querySelector<HTMLButtonElement>('[data-cts-action="point-selected"]')!.click();
      shadow().querySelector<HTMLButtonElement>('[data-cts-action="clear-pointing"]')!.click();

      expect(inspector.api().pointing()).toEqual([]);
      expect(published()!.pointing).toEqual([]);
    });

    it("shows each call as it happens, newest first, with edits marked", () => {
      channel.emit(AGENT_ACTIVITY_EVENT, {
        id: 1, at: 1000, agent: "Claude Code", tool: "get_selection", detail: "", result: "1 object pointed at",
        status: "ok", effect: "read", durationMs: 1, targets: [],
      });
      channel.emit(AGENT_ACTIVITY_EVENT, {
        id: 2, at: 2000, agent: "Claude Code", tool: "edit_parameter", detail: "src/Scene.tsx:12", result: "1.5 → 3",
        status: "ok", effect: "edit", durationMs: 1, targets: [{ file: "src/Scene.tsx", line: 12 }],
      });

      const rows = [...agentTab().querySelectorAll(".log-row")];
      expect(rows[0].textContent).toContain("edit_parameter");
      expect(rows[0].textContent).toContain("1.5 → 3");
      expect(rows[0].querySelector(".pill.edit")).not.toBeNull();
      expect(rows[1].textContent).toContain("get_selection");
      expect(rows[1].querySelector(".pill")).toBeNull();
      expect(agentTab().textContent).toContain("2 tool calls");
    });

    it("shows a failed call in its own colour", () => {
      channel.emit(AGENT_ACTIVITY_EVENT, {
        id: 1, at: 1000, agent: "Claude Code", tool: "edit_parameter", detail: "", result: "No such argument",
        status: "error", effect: "edit", durationMs: 1, targets: [],
      });

      expect(agentTab().querySelector(".log-result.bad")!.textContent).toBe("No such argument");
    });

    it("never treats what comes from source as markup", () => {
      channel.emit(AGENT_ACTIVITY_EVENT, {
        id: 1, at: 1000, agent: "Claude Code", tool: "<img src=x>", detail: "<b>", result: "<script>",
        status: "ok", effect: "read", durationMs: 1, targets: [],
      });

      expect(agentTab().querySelector("img, b, script")).toBeNull();
      expect(agentTab().textContent).toContain("<img src=x>");
    });

    it("selects the object a line of the log leads to", () => {
      inspector.select(null);
      channel.emit(AGENT_ACTIVITY_EVENT, {
        id: 1, at: 1000, agent: "Claude Code", tool: "get_source", detail: "", result: "",
        status: "ok", effect: "read", durationMs: 1, targets: [{ file: "src/Scene.tsx", line: 12 }],
      });

      agentTab().querySelector<HTMLButtonElement>(".log-row.link")!.click();

      expect(inspector.api().selection()).toMatchObject({ file: "src/Scene.tsx", line: 12 });
    });

    it("opens the line when the scene has no such object", async () => {
      const opened: unknown[] = [];
      vi.stubGlobal("fetch", async (_url: string, init: { body: string }) => {
        opened.push(JSON.parse(init.body));
        return new Response("{}", { status: 200 });
      });
      channel.emit(AGENT_ACTIVITY_EVENT, {
        id: 1, at: 1000, agent: "Claude Code", tool: "get_source", detail: "", result: "",
        status: "ok", effect: "read", durationMs: 1, targets: [{ file: "src/Other.tsx", line: 7 }],
      });

      agentTab().querySelector<HTMLButtonElement>(".log-row.link")!.click();

      await vi.waitFor(() => expect(opened).toEqual([{ file: "src/Other.tsx", line: 7 }]));
      vi.unstubAllGlobals();
    });

    // Activity arrives whenever it likes, and must not take a half-typed value
    // with it.
    it("does not disturb a draft in the Inspect tab", () => {
      shadow().querySelector<HTMLButtonElement>('[data-cts-open-tab="inspect"]')!.click();
      const input = shadow().querySelector<HTMLInputElement>('[data-cts-edit="mesh.scale"]')!;
      input.value = "9";
      input.dispatchEvent(new Event("input"));

      channel.emit(AGENT_ACTIVITY_EVENT, {
        id: 1, at: 1000, agent: "Claude Code", tool: "get_source", detail: "", result: "",
        status: "ok", effect: "read", durationMs: 1, targets: [],
      });

      expect(shadow().querySelector<HTMLInputElement>('[data-cts-edit="mesh.scale"]')).toBe(input);
      expect(input.value).toBe("9");
    });
  });

  describe("when a module updates", () => {
    const update = () => channel.emit("vite:afterUpdate");

    function successor(line = 12) {
      const next = new THREE.Mesh(new THREE.BoxGeometry(2, 2, 2), new THREE.MeshBasicMaterial());
      next.userData.__ctsSource = { file: "src/Scene.tsx", function: "Scene", line, column: 7 };
      world.scene.add(next);
      return next;
    }

    beforeEach(() => {
      vi.useFakeTimers();
      inspector.setInspecting(true);
      clickCanvas({ shiftKey: true });
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    // An update that remounts unmounts everything first. A refresh landing in
    // that gap found nothing, dropped the objects and saved that, so the reload
    // Vite followed with restored a list with objects missing.
    it("does not lose what is pointed at in the gap of a remount", () => {
      world.scene.remove(world.box);

      update();
      vi.advanceTimersByTime(100);

      expect(inspector.api().pointing()).toHaveLength(1);
      expect(JSON.parse(sessionStorage.getItem("__cts_inspector")!).pointing).toHaveLength(1);
    });

    it("follows an object to whatever replaced it", () => {
      world.scene.remove(world.box);
      update();
      vi.advanceTimersByTime(100);

      const next = successor();
      vi.advanceTimersByTime(400);

      const held = (inspector as unknown as { pointing: Array<{ pick: { object: unknown } }> }).pointing;
      expect(held[0].pick.object).toBe(next);
    });

    it("lets go of an object that never comes back", () => {
      world.scene.remove(world.box);

      update();
      vi.advanceTimersByTime(2000);

      expect(inspector.api().pointing()).toEqual([]);
      expect(published()!.pointing).toEqual([]);
    });

    it("starts counting again at another update", () => {
      world.scene.remove(world.box);

      update();
      vi.advanceTimersByTime(1000);
      update();
      vi.advanceTimersByTime(1000);

      // The first update's last look has passed, and is not final any more.
      expect(inspector.api().pointing()).toHaveLength(1);

      vi.advanceTimersByTime(1000);
      expect(inspector.api().pointing()).toEqual([]);
    });

    it("tells the assistant the new values", () => {
      world.box.userData.__ctsSource = {
        ...world.box.userData.__ctsSource,
        props: [
          {
            element: "mesh",
            name: "scale",
            array: false,
            values: [{ raw: "9", value: 9, editable: true, line: 12, column: 20 }],
          },
        ],
      };

      update();
      vi.advanceTimersByTime(100);

      expect(published()!.pointing[0].props).toMatchObject([{ values: [{ raw: "9" }] }]);
    });

    it("puts back what was only previewed when the object's source changes, and says why", () => {
      clickCanvas();
      const input = shadow().querySelector<HTMLInputElement>('[data-cts-edit="mesh.scale"]')!;
      input.value = "9";
      input.dispatchEvent(new Event("input"));
      expect(world.box.scale.x).toBe(9);

      world.box.userData.__ctsSource = { ...world.box.userData.__ctsSource };
      update();
      vi.advanceTimersByTime(100);

      expect(world.box.scale.x).toBe(1);
      expect(shadow().querySelector(".status")!.textContent).toContain("unsaved values were put back");
    });

    // vite:afterUpdate fires for any module, a stylesheet's included.
    it("leaves a value being dragged alone when something unrelated updates", () => {
      clickCanvas();
      const input = shadow().querySelector<HTMLInputElement>('[data-cts-edit="mesh.scale"]')!;
      input.value = "9";
      input.dispatchEvent(new Event("input"));

      update();
      vi.advanceTimersByTime(2000);

      expect(world.box.scale.x).toBe(9);
      expect(shadow().querySelector<HTMLInputElement>('[data-cts-edit="mesh.scale"]')).toBe(input);
      expect(input.value).toBe("9");
    });

    it("redraws the panel when the object's values change", () => {
      clickCanvas();
      world.box.userData.__ctsSource = {
        ...world.box.userData.__ctsSource,
        props: [
          {
            element: "mesh",
            name: "scale",
            array: false,
            values: [{ raw: "7", value: 7, editable: true, line: 12, column: 20 }],
          },
        ],
      };

      update();
      vi.advanceTimersByTime(100);

      expect(shadow().querySelector<HTMLInputElement>('[data-cts-edit="mesh.scale"]')!.value).toBe("7");
    });
  });

  describe("after a reload", () => {
    function reload() {
      document.querySelector("cts-devtools")?.remove();
      const discovery = new Discovery(null);
      delete (globalThis as { __THREE_DEVTOOLS__?: EventTarget }).__THREE_DEVTOOLS__;
      discovery.install();
      announce(renderer.renderer);
      renderer.renderer.render(world.scene, world.camera);
      channel = fakeHot();
      const agent = new AgentLink(discovery, channel.hot);
      inspector = new Inspector(discovery, { hotkey: "alt+shift+c", button: true }, channel.hot, agent);
      inspector.mount();
    }

    // Vite reloads the page after an edit to an entry module, and the assistant
    // that made the edit may well ask again.
    it("still points at the same objects", async () => {
      inspector.setInspecting(true);
      clickCanvas({ shiftKey: true });

      reload();

      await vi.waitFor(() => expect(inspector.api().pointing()).toHaveLength(1));
      await vi.waitFor(() => expect(published()?.pointing).toHaveLength(1));
    });

    // "The second one" has to go on meaning the same object.
    it("keeps them in order, whichever turns up first", async () => {
      vi.useFakeTimers();
      const second = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicMaterial());
      second.position.set(0, 0, -5);
      second.userData.__ctsSource = { file: "src/Second.tsx", function: "Second", line: 3, column: 1 };
      world.scene.add(second);
      world.scene.updateMatrixWorld(true);

      inspector.setInspecting(true);
      clickCanvas({ shiftKey: true });
      const view = (inspector as unknown as { discovery: Discovery }).discovery.all()[0];
      (inspector as unknown as { togglePointing(target: unknown): void }).togglePointing({
        view,
        pick: {
          object: second,
          instanceId: null,
          point: new THREE.Vector3(),
          distance: 0,
          resolution: { object: second, sourceRef: { file: "src/Second.tsx", function: "Second", line: 3, args: {} } },
        },
      });
      expect(inspector.api().pointing().map((entry) => entry.where)).toEqual(["src/Scene.tsx:12", "src/Second.tsx:3"]);

      // The first object mounts late.
      world.scene.remove(world.box);
      reload();
      await vi.advanceTimersByTimeAsync(300);
      expect(inspector.api().pointing().map((entry) => entry.where)).toEqual(["src/Second.tsx:3"]);

      world.scene.add(world.box);
      await vi.advanceTimersByTimeAsync(300);

      expect(inspector.api().pointing().map((entry) => entry.where)).toEqual(["src/Scene.tsx:12", "src/Second.tsx:3"]);
      vi.useRealTimers();
    });

    it("says nothing to the server until it has found them", async () => {
      inspector.setInspecting(true);
      clickCanvas({ shiftKey: true });

      reload();

      // Published empty, this would tell an assistant asking during the reload
      // that the developer had stopped pointing.
      expect(published()).toBeUndefined();
      await vi.waitFor(() => expect(published()?.pointing).toHaveLength(1));
    });

    it("comes back in pointer mode, on the Agent tab", async () => {
      channel.emit(AGENT_STATE_EVENT, { agents: [claude], log: [] });
      pointerButton().click();
      clickCanvas();

      reload();

      await vi.waitFor(() => expect(inspector.api().isInspecting()).toBe(true));
      await vi.waitFor(() => expect(agentTab()?.hidden).toBe(false));
      expect(pointerButton().getAttribute("aria-pressed")).toBe("true");
    });

    // Found by stopping a server mid-load: with no canvas yet, the restore timed
    // out and saved an empty list over what it was looking for.
    it("keeps looking, and keeps what was saved, for as long as there is no canvas", async () => {
      vi.useFakeTimers();
      inspector.setInspecting(true);
      clickCanvas({ shiftKey: true });
      const saved = sessionStorage.getItem("__cts_inspector");

      document.querySelector("cts-devtools")?.remove();
      const discovery = new Discovery(null);
      delete (globalThis as { __THREE_DEVTOOLS__?: EventTarget }).__THREE_DEVTOOLS__;
      discovery.install();
      channel = fakeHot();
      inspector = new Inspector(
        discovery,
        { hotkey: "alt+shift+c", button: true },
        channel.hot,
        new AgentLink(discovery, channel.hot)
      );
      inspector.mount();

      await vi.advanceTimersByTimeAsync(30_000);
      expect(sessionStorage.getItem("__cts_inspector")).toBe(saved);

      announce(renderer.renderer);
      renderer.renderer.render(world.scene, world.camera);
      await vi.advanceTimersByTimeAsync(1000);

      expect(inspector.api().pointing()).toHaveLength(1);
      vi.useRealTimers();
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

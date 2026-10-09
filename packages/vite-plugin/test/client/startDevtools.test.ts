// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as THREE from "three";
import { setBridgeScene } from "@click-to-source-3d/core/devtools";
import { startDevtools } from "../../src/client/index.js";

/**
 * The bridge as an assistant meets it: a query arriving over Vite's HMR
 * channel, answered about the page's scene.
 */

/** Enough of import.meta.hot to drive the bridge as Vite would. */
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

function stampedScene() {
  const scene = new THREE.Scene();
  const box = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshBasicMaterial());
  box.userData.__ctsSource = { file: "src/Scene.tsx", function: "Scene", line: 12, column: 7 };
  scene.add(box);
  return scene;
}

describe("startDevtools", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    const global = globalThis as { __CTS_DEVTOOLS__?: unknown; __THREE_DEVTOOLS__?: unknown };
    delete global.__CTS_DEVTOOLS__;
    delete global.__THREE_DEVTOOLS__;
    setBridgeScene(null);
  });

  afterEach(() => {
    vi.useRealTimers();
    document.body.innerHTML = "";
  });

  // three announces a renderer from its constructor, before R3F has given the
  // root a camera, so the scene could not be handed to the bridge then. It
  // was handed over by a once-a-second check, and an assistant asking in
  // between — right after a reload — was told there was no scene. Found by
  // the end-to-end test on CI's faster machine.
  it("answers about the scene from the first frame, not the next check", () => {
    const { hot, sent, emit } = fakeHot();
    const roots = new Map<unknown, { store: { getState(): unknown } }>();

    startDevtools({
      hot,
      r3fRoots: roots,
      options: { inspector: false, bridge: true, hotkey: "alt+shift+c", button: false },
    });

    const canvas = document.createElement("canvas");
    document.body.append(canvas);
    const renderer = {
      isWebGLRenderer: true,
      domElement: canvas,
      autoClear: true,
      xr: { isPresenting: false },
      getRenderTarget: () => null,
      render: () => undefined,
    } as unknown as THREE.WebGLRenderer;
    const state: { gl: THREE.WebGLRenderer; scene: THREE.Scene; camera?: THREE.Camera } = {
      gl: renderer,
      scene: stampedScene(),
    };
    roots.set(canvas, { store: { getState: () => state } });

    // Constructed: announced with no camera yet.
    (globalThis as { __THREE_DEVTOOLS__?: EventTarget }).__THREE_DEVTOOLS__!.dispatchEvent(
      new CustomEvent("observe", { detail: renderer })
    );

    // R3F configures the root, then draws its first frame.
    state.camera = new THREE.PerspectiveCamera();
    renderer.render(state.scene, state.camera);

    emit("cts:bridge:query", { requestId: "q1", query: { kind: "list_scene_provenance" } });

    const reply = sent.find((message) => message.event === "cts:bridge:reply");
    expect(reply?.data).toMatchObject({ requestId: "q1", result: { status: "ready" } });
  });
});

import type * as THREE from "three";
import {
  connectBridgeOverHot,
  setBridgeScene,
  type HotChannel,
} from "@click-to-source-3d/core/devtools";
import { Discovery, type R3FRoots } from "./discovery.js";
import { Inspector } from "./inspector.js";

/**
 * The inspector the Vite plugin injects into every page it serves in dev.
 *
 * Bundled into one file with everything it needs except three itself, which
 * comes from the application so that both share one copy. It is started by a
 * small virtual module the plugin writes, which hands it Vite's HMR channel
 * and, when the project uses R3F, R3F's registry of canvases.
 */

export type DevtoolsOptions = {
  inspector: boolean;
  bridge: boolean;
  hotkey: string;
  button: boolean;
};

export function startDevtools(setup: {
  hot?: HotChannel | null;
  r3fRoots?: R3FRoots | undefined;
  options: DevtoolsOptions;
}): void {
  const global = globalThis as { __CTS_DEVTOOLS__?: unknown };

  // Once per page. The virtual module can be evaluated again by HMR; a second
  // inspector would draw a second toggle and answer every key twice.
  if (global.__CTS_DEVTOOLS__) {
    return;
  }

  const { options } = setup;
  const hot = setup.hot ?? null;
  const discovery = new Discovery(setup.r3fRoots ?? null);
  discovery.install();

  let inspector: Inspector | null = null;
  if (options.inspector) {
    inspector = new Inspector(discovery, { hotkey: options.hotkey, button: options.button }, hot);
    const mount = () => inspector!.mount();
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", mount, { once: true });
    } else {
      mount();
    }
  }

  if (options.bridge && hot) {
    connectBridgeOverHot(hot);

    // The bridge answers about the main canvas. Re-attached only when the
    // scene or camera actually changes: each attach advances the bridge's
    // generation counter, which an agent reads as "the scene was replaced".
    let attached: { scene: THREE.Object3D; camera: THREE.Camera } | null = null;
    const sync = () => {
      const view = discovery.primary();
      const scene = view?.scene() ?? null;
      const camera = view?.camera() ?? null;
      if (scene === attached?.scene && camera === attached?.camera) {
        return;
      }
      attached = scene && camera ? { scene, camera } : null;
      setBridgeScene(attached);
    };
    discovery.onView(sync);
    // three announces a renderer from its constructor, before R3F has given
    // the root a camera, so the first sync usually finds nothing. Until one
    // succeeds, try again after every frame: an assistant asking right after
    // a reload would otherwise be told there is no scene for up to a second.
    discovery.onFrame(() => {
      if (!attached) {
        sync();
      }
    });
    setInterval(sync, 1000);
  }

  global.__CTS_DEVTOOLS__ = {
    options,
    ...(inspector?.api() ?? {}),
  };
}

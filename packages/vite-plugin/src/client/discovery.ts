import type * as THREE from "three";
import { attachHighlight, HighlightLayer } from "@click-to-source-3d/core/devtools";

/** The part of R3F's root store the inspector reads. */
type R3FState = {
  gl: THREE.WebGLRenderer;
  scene: THREE.Scene;
  camera: THREE.Camera;
  invalidate: (frames?: number) => void;
};

/** R3F's `_roots`: canvas to root, each with its zustand store. */
export type R3FRoots = Map<unknown, { store: { getState(): R3FState } }> | null;

/** How long a scene counts as currently drawn after its last frame. */
const RECENT_MS = 1000;

/**
 * One renderer and the canvas it draws to: what the inspector picks against
 * and draws its highlight on.
 */
export class View {
  readonly layer = new HighlightLayer();
  lastFrameAt = 0;
  private readonly seen = new Map<THREE.Scene, { camera: THREE.Camera; at: number }>();

  constructor(
    readonly renderer: THREE.WebGLRenderer,
    readonly canvas: HTMLCanvasElement,
    private readonly r3f: () => R3FState | null
  ) {}

  /** Notes a frame. Called for every render() the application makes. */
  frame(scene: THREE.Object3D, camera: THREE.Camera): void {
    this.lastFrameAt = performance.now();
    if ((scene as THREE.Scene).isScene) {
      this.seen.set(scene as THREE.Scene, { camera, at: this.lastFrameAt });
    }

    // Forget scenes long gone — a level unloaded, an HMR generation replaced
    // — so they can be collected. Bounded work: only when the map grows.
    if (this.seen.size > 8) {
      for (const [old, entry] of this.seen) {
        if (this.lastFrameAt - entry.at > RECENT_MS * 10) {
          this.seen.delete(old);
        }
      }
    }
  }

  /**
   * The application's own scene.
   *
   * Under R3F the store names it. Otherwise it is inferred from what is
   * drawn: of the scenes rendered recently, the one with the most children.
   * A post-processing pass renders a scene of its own — one full-screen
   * triangle — after the application's, often with an orthographic camera,
   * so "the last scene drawn" would usually be the wrong answer.
   */
  private main(): { scene: THREE.Scene; camera: THREE.Camera } | null {
    const state = this.r3f();
    if (state) {
      return { scene: state.scene, camera: state.camera };
    }

    let best: { scene: THREE.Scene; camera: THREE.Camera; size: number; at: number } | null = null;
    const now = performance.now();
    const recent = [...this.seen].filter(([, entry]) => now - entry.at <= RECENT_MS);

    // An app that has stopped drawing still has a scene worth inspecting.
    for (const [scene, entry] of recent.length > 0 ? recent : this.seen) {
      const size = scene.children.length;
      if (!best || size > best.size || (size === best.size && entry.at > best.at)) {
        best = { scene, camera: entry.camera, size, at: entry.at };
      }
    }

    return best ? { scene: best.scene, camera: best.camera } : null;
  }

  scene(): THREE.Scene | null {
    return this.main()?.scene ?? null;
  }

  camera(): THREE.Camera | null {
    return this.main()?.camera ?? null;
  }

  /**
   * Asks for one more frame so a changed highlight shows.
   *
   * R3F is told through its own invalidate(), which matters under
   * frameloop="demand". A plain three.js app that is drawing continuously
   * needs nothing; one that only draws on demand gets its last scene drawn
   * once more, if no frame has arrived in the meantime.
   */
  redraw(): void {
    const state = this.r3f();
    if (state) {
      state.invalidate();
      return;
    }

    const requested = performance.now();
    setTimeout(() => {
      const main = this.main();
      if (this.lastFrameAt < requested && main) {
        this.renderer.render(main.scene, main.camera);
      }
    }, 100);
  }

  /** On screen and not removed from the page. */
  get live(): boolean {
    return this.canvas.isConnected;
  }

  area(): number {
    const rect = this.canvas.getBoundingClientRect();
    return rect.width * rect.height;
  }
}

/**
 * Finds every three.js renderer on the page, with no code from the
 * application.
 *
 * three announces each WebGLRenderer it constructs to a global devtools hook,
 * `__THREE_DEVTOOLS__`, which this listens on. The hook is created if absent
 * and shared if present: the official three.js devtools extension installs
 * one too, and replacing it would blind the extension. For R3F, its own
 * registry of canvases is consulted as well, which also covers a renderer
 * created before this script ran.
 */
export class Discovery {
  private readonly views = new Map<THREE.WebGLRenderer, View>();
  private readonly listeners = new Set<(view: View) => void>();
  private readonly frameListeners = new Set<(view: View) => void>();

  constructor(private readonly roots: R3FRoots) {}

  install(): void {
    const global = globalThis as { __THREE_DEVTOOLS__?: EventTarget };

    if (typeof global.__THREE_DEVTOOLS__?.addEventListener !== "function") {
      global.__THREE_DEVTOOLS__ = new EventTarget();
    }

    global.__THREE_DEVTOOLS__.addEventListener("observe", (event) => {
      const detail = (event as CustomEvent).detail as { isWebGLRenderer?: boolean } | null;
      if (detail?.isWebGLRenderer) {
        this.add(detail as THREE.WebGLRenderer);
      }
    });

    this.refresh();
  }

  /** Picks up any renderer R3F knows about that the hook did not report. */
  refresh(): void {
    for (const root of this.roots?.values() ?? []) {
      const gl = root.store.getState().gl;
      if ((gl as { isWebGLRenderer?: boolean } | undefined)?.isWebGLRenderer) {
        this.add(gl);
      }
    }
  }

  onView(listener: (view: View) => void): void {
    this.listeners.add(listener);
  }

  /** Called after every frame any view draws, so a listener has to be cheap. */
  onFrame(listener: (view: View) => void): void {
    this.frameListeners.add(listener);
  }

  private add(renderer: THREE.WebGLRenderer): void {
    const canvas = renderer.domElement;

    if (this.views.has(renderer) || !(canvas instanceof HTMLCanvasElement)) {
      return;
    }

    const view = new View(renderer, canvas, () => {
      const root = this.roots?.get(canvas);
      return root ? root.store.getState() : null;
    });

    // Highlight first, so the frame tracker wraps it and never mistakes the
    // highlight's own scene for one of the application's.
    attachHighlight(renderer, view.layer, () => view.camera());

    const render = renderer.render;
    const frameListeners = this.frameListeners;
    renderer.render = function (this: THREE.WebGLRenderer, scene, camera) {
      view.frame(scene, camera);
      const result = render.call(this, scene, camera);
      for (const listener of frameListeners) {
        listener(view);
      }
      return result;
    } as typeof renderer.render;

    this.views.set(renderer, view);
    for (const listener of this.listeners) {
      listener(view);
    }
  }

  all(): View[] {
    return [...this.views.values()].filter((view) => view.live);
  }

  forCanvas(element: EventTarget | null): View | null {
    return this.all().find((view) => view.canvas === element) ?? null;
  }

  /** The largest canvas on the page: where the toggle button goes. */
  primary(): View | null {
    let best: View | null = null;
    for (const view of this.all()) {
      if (!best || view.area() > best.area()) {
        best = view;
      }
    }
    return best;
  }
}

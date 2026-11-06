import * as THREE from "three";

/** What to draw a box around: an object, or one instance of an InstancedMesh. */
export type HighlightTarget = {
  object: THREE.Object3D;
  instanceId?: number | null;
};

/**
 * What a box means, which is what its colour tells the developer: under the
 * pointer, pinned for comparison, being looked at by their assistant, pointed
 * out to their assistant, or selected.
 */
export type HighlightKind = "hover" | "pinned" | "agent" | "pointed" | "selected";

const STYLES: Record<HighlightKind, { color: number; fill: number; order: number }> = {
  hover: { color: 0xffffff, fill: 0.06, order: 9995 },
  pinned: { color: 0x6aa9ff, fill: 0.06, order: 9996 },
  agent: { color: 0xb18cff, fill: 0.07, order: 9997 },
  pointed: { color: 0xf5b13d, fill: 0.12, order: 9998 },
  selected: { color: 0x3cc2b8, fill: 0.14, order: 9999 },
};

const KINDS = Object.keys(STYLES) as HighlightKind[];

// One unit cube, shared: a slot is that cube transformed onto its target.
const UNIT_BOX = new THREE.BoxGeometry(1, 1, 1);
const UNIT_EDGES = new THREE.EdgesGeometry(UNIT_BOX);

const _box = new THREE.Box3();
const _center = new THREE.Vector3();
const _size = new THREE.Vector3();
const _instance = new THREE.Matrix4();
const _fit = new THREE.Matrix4();
const _identity = new THREE.Quaternion();
// A flat object — a plane — has a zero-size axis, which would collapse the
// box matrix and leave nothing to draw.
const MIN_SIZE = new THREE.Vector3(1e-4, 1e-4, 1e-4);

/** Every box of one kind. A box is made the first time it is needed, and kept. */
type Slot = {
  targets: HighlightTarget[];
  boxes: THREE.Group[];
  edges: THREE.LineBasicMaterial;
  fill: THREE.MeshBasicMaterial;
};

/**
 * Writes into `out` the matrix that maps a unit cube onto the target's box.
 *
 * A mesh gets its own geometry's box carried by its world matrix, so the box
 * turns with a rotated object instead of growing to an axis-aligned envelope.
 * One instance gets the geometry's box carried by that instance's matrix too.
 * Anything without geometry — a group, say — falls back to the world-space
 * box around everything under it.
 *
 * Returns false when there is nothing to draw around.
 */
export function boxMatrixFor(target: HighlightTarget, out: THREE.Matrix4): boolean {
  const object = target.object;
  object.updateWorldMatrix(true, false);

  const geometry = (object as THREE.Mesh).geometry as THREE.BufferGeometry | undefined;
  const instanced = object as THREE.InstancedMesh;

  if (geometry?.isBufferGeometry) {
    if (geometry.boundingBox === null) {
      geometry.computeBoundingBox();
    }
    _box.copy(geometry.boundingBox!);

    if (_box.isEmpty()) {
      return false;
    }

    _box.getCenter(_center);
    _box.getSize(_size).max(MIN_SIZE);
    _fit.compose(_center, _identity, _size);

    if (instanced.isInstancedMesh && target.instanceId != null) {
      if (target.instanceId < 0 || target.instanceId >= instanced.count) {
        return false;
      }
      instanced.getMatrixAt(target.instanceId, _instance);
      out.multiplyMatrices(object.matrixWorld, _instance).multiply(_fit);
      return true;
    }

    if (instanced.isInstancedMesh) {
      // The whole mesh: every instance's placement, in the mesh's own space.
      // Computed into a local box rather than mesh.boundingBox, which belongs
      // to the application.
      _box.makeEmpty();
      const piece = new THREE.Box3();
      for (let i = 0; i < instanced.count; i++) {
        instanced.getMatrixAt(i, _instance);
        _box.union(piece.copy(geometry.boundingBox!).applyMatrix4(_instance));
      }
      if (_box.isEmpty()) {
        return false;
      }
      _box.getCenter(_center);
      _box.getSize(_size).max(MIN_SIZE);
      _fit.compose(_center, _identity, _size);
    }

    out.multiplyMatrices(object.matrixWorld, _fit);
    return true;
  }

  _box.setFromObject(object, true);

  if (_box.isEmpty()) {
    return false;
  }

  _box.getCenter(_center);
  _box.getSize(_size).max(MIN_SIZE);
  out.compose(_center, _identity, _size);
  return true;
}

/**
 * Boxes drawn over a rendered frame, as a pass of their own.
 *
 * They live in a scene that is never added to the application's, so they
 * cannot turn up in its traversals, raycasts or exports, and they are drawn
 * after the application's frame rather than instead of it. That is the
 * difference from the OutlinePass this replaces, which had to own the render
 * loop: it fought any other post-processing for it, and cost the application
 * its antialiasing while it held it.
 *
 * Depth testing is off, so a box shows through whatever is in front of it,
 * the way an inspector's highlight should.
 */
export class HighlightLayer {
  readonly scene = new THREE.Scene();
  private readonly slots: Record<HighlightKind, Slot>;

  constructor() {
    this.scene.name = "click-to-source highlight";
    this.slots = Object.fromEntries(KINDS.map((kind) => [kind, this.makeSlot(kind)])) as Record<
      HighlightKind,
      Slot
    >;
  }

  private makeSlot(kind: HighlightKind): Slot {
    const style = STYLES[kind];

    return {
      targets: [],
      boxes: [],
      edges: new THREE.LineBasicMaterial({
        color: style.color,
        depthTest: false,
        depthWrite: false,
        transparent: true,
        opacity: 0.95,
      }),
      fill: new THREE.MeshBasicMaterial({
        color: style.color,
        depthTest: false,
        depthWrite: false,
        transparent: true,
        opacity: style.fill,
      }),
    };
  }

  private makeBox(kind: HighlightKind, slot: Slot): THREE.Group {
    const group = new THREE.Group();
    group.matrixAutoUpdate = false;
    group.visible = false;

    const edges = new THREE.LineSegments(UNIT_EDGES, slot.edges);
    const fill = new THREE.Mesh(UNIT_BOX, slot.fill);
    edges.renderOrder = fill.renderOrder = STYLES[kind].order;
    group.add(fill, edges);
    this.scene.add(group);

    return group;
  }

  /** Points the first box of a kind at a target, or hides every box of it. */
  set(kind: HighlightKind, target: HighlightTarget | null): void {
    this.setAll(kind, target ? [target] : []);
  }

  /** Points as many boxes of a kind as there are targets. */
  setAll(kind: HighlightKind, targets: HighlightTarget[]): void {
    const slot = this.slots[kind];
    slot.targets = targets;

    while (slot.boxes.length < targets.length) {
      slot.boxes.push(this.makeBox(kind, slot));
    }
    slot.boxes.forEach((box, index) => {
      box.visible = index < targets.length;
    });
  }

  get(kind: HighlightKind): HighlightTarget | null {
    return this.slots[kind].targets[0] ?? null;
  }

  all(kind: HighlightKind): readonly HighlightTarget[] {
    return this.slots[kind].targets;
  }

  /** Whether anything is shown, so a caller can skip the pass entirely. */
  get active(): boolean {
    return KINDS.some((kind) => this.slots[kind].targets.length > 0);
  }

  /**
   * Re-fits every visible box to its target. Run before each draw, since a
   * target can move, animate or be re-placed between frames.
   */
  update(): void {
    for (const slot of Object.values(this.slots)) {
      slot.targets.forEach((target, index) => {
        const box = slot.boxes[index];
        box.visible = boxMatrixFor(target, box.matrix);
        box.matrixWorldNeedsUpdate = true;
      });
    }
  }

  dispose(): void {
    for (const slot of Object.values(this.slots)) {
      slot.edges.dispose();
      slot.fill.dispose();
    }
  }
}

/**
 * Draws a layer after every frame a renderer puts on screen.
 *
 * Wraps this one renderer's `render` rather than claiming a place in a render
 * loop, so it composes with whatever already renders: R3F's own call, a
 * post-processing composer's final pass, or a plain three.js loop. Frames
 * drawn into a render target are left alone — they are passes on their way to
 * the screen, not the screen.
 *
 * `camera` is asked for on every frame. The camera that drew the last frame
 * is not always the right one: a composer's final pass is drawn with an
 * orthographic camera of its own.
 *
 * Returns the function that removes the wrapper. Removing it is safe in any
 * order: a wrapper someone else installed after this one is left in place.
 */
export function attachHighlight(
  renderer: THREE.WebGLRenderer,
  layer: HighlightLayer,
  camera: () => THREE.Camera | null
): () => void {
  const original = renderer.render;
  let drawing = false;

  const wrapped = function (this: THREE.WebGLRenderer, scene: THREE.Object3D, frameCamera: THREE.Camera) {
    original.call(this, scene, frameCamera);

    if (drawing || !layer.active || this.getRenderTarget() !== null || this.xr?.isPresenting) {
      return;
    }

    const target = camera();
    if (!target) {
      return;
    }

    drawing = true;
    const autoClear = this.autoClear;
    this.autoClear = false;
    // A render resets the renderer's frame counters, so without this they
    // would describe the highlight's two boxes rather than the application's
    // frame, for as long as anything is highlighted, in anything that reads
    // them: an FPS panel, r3f-perf, the inspector's own numbers.
    const counters = this.info?.render;
    const frame = counters && { ...counters };
    try {
      layer.update();
      original.call(this, layer.scene, target);
    } finally {
      this.autoClear = autoClear;
      if (counters && frame) {
        Object.assign(counters, frame);
      }
      drawing = false;
    }
  };

  renderer.render = wrapped as typeof renderer.render;

  return () => {
    if (renderer.render === (wrapped as typeof renderer.render)) {
      renderer.render = original;
    }
  };
}

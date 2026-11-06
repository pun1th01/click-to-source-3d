import type * as THREE from "three";
import type { StampedProp } from "@click-to-source-3d/shared";

/** A value shown live in the scene while it is being changed, before any save. */
export type ValuePreview = {
  /** The constructor parameter this value is, for a geometry's `args`. */
  paramName?: string;
  set(value: number): void;
  /** Puts the value the scene had before the preview back. */
  reset(): void;
};

type Holder = Record<string, unknown>;

function axesOf(value: Holder): string[] | null {
  if (value.isColor) {
    return ["r", "g", "b"];
  }
  if (value.isQuaternion || value.isVector4) {
    return ["x", "y", "z", "w"];
  }
  if (value.isVector3 || value.isEuler) {
    return ["x", "y", "z"];
  }
  return value.isVector2 ? ["x", "y"] : null;
}

/**
 * One element of a prop like `position={[0, 1, 2]}`: R3F applied the array to a
 * Vector3 or an Euler, so the live value is that object's matching component.
 */
function componentPreview(current: Holder, index: number): ValuePreview | null {
  const key = Array.isArray(current) ? String(index) : axesOf(current)?.[index];

  if (key === undefined || typeof current[key] !== "number") {
    return null;
  }
  const original = current[key] as number;

  return {
    set: (value) => {
      current[key] = value;
    },
    reset: () => {
      current[key] = original;
    },
  };
}

/** A prop with one value: a number, or `scale={2}` on a vector. */
function scalarPreview(holder: Holder, key: string): ValuePreview | null {
  const current = holder[key];

  if (typeof current === "number") {
    return {
      set: (value) => {
        holder[key] = value;
      },
      reset: () => {
        holder[key] = current;
      },
    };
  }

  const vector = current as Partial<THREE.Vector3> | null | undefined;
  if (vector?.setScalar && vector.clone && vector.copy) {
    const original = vector.clone();
    return {
      set: (value) => void vector.setScalar!(value),
      reset: () => void vector.copy!(original),
    };
  }
  return null;
}

/**
 * The previews for one stamped object, sharing what they have to share.
 *
 * A geometry's `args` are not properties anything can write to: they went to its
 * constructor. So a change builds a new geometry from the old one's `parameters`,
 * which three's own geometries keep in constructor order, and swaps it in. Every
 * value in `args` previews through the same rebuild, or changing one would undo
 * another.
 */
export class PreviewSession {
  private geometry: {
    original: THREE.BufferGeometry;
    built: THREE.BufferGeometry | null;
    values: unknown[];
    keys: string[];
    make: new (...args: unknown[]) => THREE.BufferGeometry;
  } | null = null;
  private readonly touched = new Set<ValuePreview>();

  constructor(private readonly object: THREE.Object3D) {}

  /** The preview for one value, or null when nothing in the scene can show it. */
  previewOf(prop: StampedProp, index: number): ValuePreview | null {
    // A spread means the stamped list and the array R3F applied do not line up.
    if (prop.values.some((value) => value.raw.startsWith("..."))) {
      return null;
    }

    const preview = this.find(prop, index);
    if (!preview) {
      return null;
    }

    return {
      paramName: preview.paramName,
      set: (value) => {
        this.touched.add(preview);
        preview.set(value);
      },
      reset: () => {
        this.touched.delete(preview);
        preview.reset();
      },
    };
  }

  private find(prop: StampedProp, index: number): ValuePreview | null {
    const isGeometry = prop.element.endsWith("Geometry");
    const isMaterial = prop.element.endsWith("Material");

    if (prop.name === "args") {
      return isGeometry ? this.geometryArg(index) : null;
    }
    if (isGeometry) {
      return null;
    }

    let holder = (isMaterial ? this.materialFor(prop.element) : this.object) as unknown as Holder | null;

    // R3F's dash props reach into the object: `rotation-y`, `material-roughness`.
    const parts = prop.name.split("-");
    const leaf = parts.pop()!;
    for (const part of parts) {
      holder = (holder?.[part] ?? null) as Holder | null;
    }
    if (!holder) {
      return null;
    }

    if (prop.array) {
      const current = holder[leaf] as Holder | undefined;
      return current ? componentPreview(current, index) : null;
    }
    return scalarPreview(holder, leaf);
  }

  private materialFor(element: string): THREE.Material | null {
    const material = (this.object as THREE.Mesh).material as THREE.Material | THREE.Material[] | undefined;
    if (!Array.isArray(material)) {
      return material ?? null;
    }
    // Several materials: only the one the element names, by its type.
    return material.find((entry) => entry.type.toLowerCase() === element.toLowerCase()) ?? null;
  }

  private geometryArg(index: number): ValuePreview | null {
    const mesh = this.object as THREE.Mesh;
    const original = mesh.geometry as (THREE.BufferGeometry & { parameters?: Record<string, unknown> }) | undefined;

    if (!original?.parameters) {
      return null;
    }

    const state = (this.geometry ??= {
      original,
      built: null,
      keys: Object.keys(original.parameters),
      values: Object.values(original.parameters),
      make: original.constructor as new (...args: unknown[]) => THREE.BufferGeometry,
    });
    const startedAs = state.values[index];
    if (typeof startedAs !== "number") {
      return null;
    }

    const rebuild = () => {
      const next = new state.make(...state.values);
      mesh.geometry = next;
      state.built?.dispose();
      state.built = next;
    };

    return {
      paramName: state.keys[index],
      set: (value) => {
        state.values[index] = value;
        rebuild();
      },
      reset: () => {
        state.values[index] = startedAs;
        if (mesh.geometry === state.built) {
          rebuild();
        }
      },
    };
  }

  /** Puts everything back as it was. */
  restore(): void {
    for (const preview of this.touched) {
      preview.reset();
    }
    this.touched.clear();
    this.dropBuilt();
  }

  /**
   * Hands over to the update a save caused. The scene already shows the saved
   * values and R3F is about to apply them, so properties are left alone. A built
   * geometry is ours to clean up: once R3F has replaced it, by dropping it, and
   * if nothing did, by putting back the one R3F still owns.
   */
  settle(): void {
    this.touched.clear();
    this.dropBuilt();
  }

  private dropBuilt(): void {
    const state = this.geometry;
    if (!state?.built) {
      return;
    }
    const mesh = this.object as THREE.Mesh;
    if (mesh.geometry === state.built) {
      mesh.geometry = state.original;
    }
    state.built.dispose();
    state.built = null;
  }
}

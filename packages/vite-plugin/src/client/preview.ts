import type * as THREE from "three";
import type { StampedProp } from "@click-to-source-3d/shared";

/** A value shown live in the scene while it is being changed, before any save. */
export type ValuePreview = {
  /** The constructor parameter this value is, for a geometry's `args`. */
  paramName?: string;
  /** A colour, which isn't a quantity, so a slider has nothing to do. */
  isColor?: boolean;
  /** What some typed text means here, or null if it can't be shown yet. */
  parse(text: string): number | string | null;
  set(value: number | string): void;
  /** Puts the value the scene had before the preview back. */
  reset(): void;
};

function parseNumber(text: string): number | null {
  const number = Number(text);
  return text.trim() !== "" && Number.isFinite(number) ? number : null;
}

/** A colour as a person would type one: `#c2643c`, `0xc2643c`, `tomato`. */
function colorParser(color: THREE.Color) {
  const names = (color.constructor as { NAMES?: Record<string, number> }).NAMES ?? {};
  return (text: string): number | string | null => {
    const trimmed = text.trim();
    if (/^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(trimmed)) {
      return trimmed;
    }
    const number = parseNumber(trimmed);
    if (number !== null) {
      return Number.isInteger(number) && number >= 0 && number <= 0xffffff ? number : null;
    }
    return names[trimmed.toLowerCase()] !== undefined ? trimmed.toLowerCase() : null;
  };
}

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
    parse: parseNumber,
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
      parse: parseNumber,
      set: (value) => {
        holder[key] = value;
      },
      reset: () => {
        holder[key] = current;
      },
    };
  }

  // Before the vector check: a colour has setScalar too, which would turn
  // `color: 0xff0000` into a shade of grey.
  const color = current as THREE.Color | null | undefined;
  if (color?.isColor) {
    const original = color.clone();
    return {
      isColor: true,
      parse: colorParser(color),
      set: (value) => void color.set(value),
      reset: () => void color.copy(original),
    };
  }

  const vector = current as Partial<THREE.Vector3> | null | undefined;
  if (vector?.setScalar && vector.clone && vector.copy) {
    const original = vector.clone();
    return {
      parse: parseNumber,
      set: (value) => void vector.setScalar!(value as number),
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
  private untouched: boolean | null = null;

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
      isColor: preview.isColor,
      parse: preview.parse,
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

    if (!original?.parameters || !this.isUntouched(original)) {
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
      parse: parseNumber,
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

  /**
   * Whether a geometry is still just what its constructor made. Code that moves the
   * vertices afterwards, which is what terrain does, or that bakes in a rotation,
   * isn't captured by `parameters`, so a rebuild would show a flat plane and call
   * it a preview. Those values can still be typed and saved.
   */
  private isUntouched(geometry: THREE.BufferGeometry & { parameters?: Record<string, unknown> }): boolean {
    if (this.untouched !== null) {
      return this.untouched;
    }
    this.untouched = false;
    try {
      const make = geometry.constructor as new (...args: unknown[]) => THREE.BufferGeometry;
      const fresh = new make(...Object.values(geometry.parameters as object));
      const now = geometry.getAttribute("position")?.array;
      const then = fresh.getAttribute("position")?.array;
      this.untouched =
        !!now && !!then && now.length === then.length && now.every((value, index) => value === then[index]);
      fresh.dispose();
    } catch {
      // A subclass that can't be built again from its parameters.
    }
    return this.untouched;
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

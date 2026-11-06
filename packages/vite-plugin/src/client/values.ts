import type { StampedValue } from "@click-to-source-3d/shared";

/**
 * A value as an input shows it: a string without its quotes, anything else as
 * written in source, so `0x88aa55` stays hex and `-2.20` keeps its zero.
 */
export function draftOf(value: StampedValue): string {
  return typeof value.value === "string" ? value.value : value.raw;
}

export type Parsed = { ok: true; value: unknown } | { ok: false; error: string };

/** Reads what was typed as the same kind of value the literal was. */
export function parseDraft(original: StampedValue, draft: string): Parsed {
  const current = original.value;

  if (typeof current === "number") {
    const trimmed = draft.trim();
    const number = Number(trimmed);
    return trimmed !== "" && Number.isFinite(number)
      ? { ok: true, value: number }
      : { ok: false, error: "Enter a number" };
  }

  if (typeof current === "boolean") {
    return draft === "true" || draft === "false"
      ? { ok: true, value: draft === "true" }
      : { ok: false, error: 'Enter "true" or "false"' };
  }

  if (current === null && draft === "null") {
    return { ok: true, value: null };
  }

  return { ok: true, value: draft };
}

export type SliderRange = { min: number; max: number; step: number };

/** A step about a two-hundredth of the span, at a round number: 0.01, 0.1, 1. */
function stepFor(span: number): number {
  return 10 ** (Math.floor(Math.log10(span)) - 2);
}

/** Properties that only mean anything from nothing to one. */
const UNIT_RANGE =
  /^(material-)?(roughness|metalness|opacity|transmission|clearcoat|clearcoatRoughness|sheen|sheenRoughness|alphaTest|reflectivity|ior)$/;

/** Things that have a size, which cannot usefully go below zero. */
const NOT_NEGATIVE =
  /intensity|scale|radius|width|height|depth|size|distance|length|near|far|fov|decay|tube|bevel|power/i;

/**
 * How far a slider should reach from where a value starts.
 *
 * Nothing in source says what range a number is meant to move in, so this goes by
 * what the name suggests and otherwise by the value's own size. It only sets how
 * far a drag goes: typing is not limited to it. `name` is the prop's name or, for
 * a geometry's `args`, the constructor parameter the value is.
 */
export function sliderRange(name: string, value: number): SliderRange {
  if (/segments/i.test(name)) {
    return { min: 1, max: Math.max(64, value * 2), step: 1 };
  }

  if (UNIT_RANGE.test(name)) {
    return { min: 0, max: Math.max(1, value), step: 0.01 };
  }

  if (/rotation/i.test(name)) {
    return { min: Math.min(-Math.PI, value), max: Math.max(Math.PI, value), step: 0.01 };
  }

  if (NOT_NEGATIVE.test(name) && value >= 0) {
    const max = Math.max(1, value * 3);
    return { min: 0, max, step: stepFor(max) };
  }

  const reach = Math.max(2, Math.abs(value));
  return { min: value - reach, max: value + reach, step: stepFor(reach * 2) };
}

/** A slider's position as a number worth writing down, not 1.2000000000000002. */
export function sliderText(value: number, step: number): string {
  const decimals = Math.max(0, -Math.floor(Math.log10(step)));
  return String(Number(value.toFixed(decimals)));
}

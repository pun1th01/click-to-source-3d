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

import type { StampedValue } from "@click-to-source-3d/shared";

export function formatBytes(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function formatCount(count: number): string {
  return count.toLocaleString("en-US");
}

export function vectorText(values: number[]): string {
  return values.join(", ");
}

/** A value as written in source, and what it comes to when it names a constant. */
export function valueText(value: StampedValue): string {
  return value.via ? `${value.via} = ${value.raw}` : value.raw;
}

export function plural(count: number, one: string, many = `${one}s`): string {
  return `${formatCount(count)} ${count === 1 ? one : many}`;
}

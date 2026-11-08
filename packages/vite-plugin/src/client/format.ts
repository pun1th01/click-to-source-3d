import type { StampedValue, UsedFunction } from "@click-to-source-3d/shared";

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

/**
 * The helpers behind an object, once each. One shared by its own function and its
 * geometry's is listed by both.
 */
export function usesOf(object: { generators: Array<{ uses: UsedFunction[] }> }): UsedFunction[] {
  const seen = new Set<string>();
  return object.generators
    .flatMap((fn) => fn.uses)
    .filter((use) => {
      const key = use.file ? `${use.file}:${use.line}` : `${use.package}#${use.name}`;
      const fresh = !seen.has(key);
      seen.add(key);
      return fresh;
    });
}

/** What made some props: `<mesh>` in JSX, `BoxGeometry` in plain code. */
export function elementLabel(element: string): string {
  return /^[A-Z]/.test(element) || element.includes(".") ? element : `<${element}>`;
}

export function plural(count: number, one: string, many = `${one}s`): string {
  return `${formatCount(count)} ${count === 1 ? one : many}`;
}

/**
 * Static discovery of provenance in source, with no browser involved.
 *
 * This is the honest replacement for the originally-scoped
 * `search_by_generator`. That tool assumed a queryable index of live objects.
 * No such index exists out of process: the capture registry is a WeakMap keyed
 * by mesh object identity, which is not enumerable and cannot be, since that
 * is what lets a discarded HMR generation collect.
 *
 * What can be answered without a browser is the source-side question — which
 * call sites declare provenance, and what arguments they name. That is weaker
 * than "which objects exist right now", and the difference is worth keeping
 * in view: this reports what the code says, not what is on screen.
 */

export type ProvenanceSite = {
  file: string;
  /** Line of the `sourceRef` literal, 1-indexed. */
  line: number;
  /** The `line:` the ref points at, which is often not the line it sits on. */
  declaredLine: number | null;
  function: string | null;
  /** Argument names, in declaration order. */
  args: string[];
  /** Per-instance refs are read-only; there is no literal to rewrite. */
  perInstance: boolean;
};

const SOURCE_EXTENSIONS = [".js", ".jsx", ".ts", ".tsx", ".mjs", ".cjs"];

function isSourceFile(name: string): boolean {
  if (name.startsWith(".")) {
    return false;
  }

  return SOURCE_EXTENSIONS.some((ext) => name.endsWith(ext));
}

/**
 * Extracts the object literal that follows `sourceRef:` at `start`.
 *
 * Brace-matched rather than regex-matched, because an args object nests and a
 * regex would stop at the first closing brace. String literals are tracked so
 * a brace inside a string does not unbalance the count.
 */
function extractObject(text: string, start: number): string | null {
  const open = text.indexOf("{", start);

  if (open === -1) {
    return null;
  }

  let depth = 0;
  let quote: string | null = null;

  for (let i = open; i < text.length; i++) {
    const ch = text[i];

    if (quote) {
      if (ch === "\\") {
        i++;
      } else if (ch === quote) {
        quote = null;
      }
      continue;
    }

    if (ch === '"' || ch === "'" || ch === "`") {
      quote = ch;
      continue;
    }

    if (ch === "{") {
      depth++;
    } else if (ch === "}") {
      depth--;
      if (depth === 0) {
        return text.slice(open, i + 1);
      }
    }
  }

  return null;
}

function readStringField(block: string, field: string): string | null {
  const match = block.match(
    new RegExp(`\\b${field}\\s*:\\s*['"\`]([^'"\`]*)['"\`]`)
  );

  return match ? match[1] : null;
}

function readNumberField(block: string, field: string): number | null {
  const match = block.match(new RegExp(`\\b${field}\\s*:\\s*(-?\\d+)`));

  return match ? Number(match[1]) : null;
}

function readArgNames(block: string): string[] {
  const argsAt = block.indexOf("args");

  if (argsAt === -1) {
    return [];
  }

  const argsBlock = extractObject(block, argsAt);

  if (!argsBlock) {
    return [];
  }

  // Keys at depth 1 of the args object only: a nested object's keys are not
  // arguments.
  //
  // Both forms have to be handled. `args: { x: 1 }` names the key before a
  // colon; `args: { noiseFloor, lakeBedLevel }` is shorthand and has no colon
  // at all — and shorthand is what generation code actually writes, since the
  // values are already in scope as locals.
  const names: string[] = [];
  let depth = 0;
  let quote: string | null = null;
  let token = "";
  let sawColon = false;

  const flush = () => {
    if (sawColon) {
      return;
    }

    const name = token.trim();

    if (/^[A-Za-z_$][\w$]*$/.test(name)) {
      names.push(name);
    }
  };

  for (let i = 0; i < argsBlock.length; i++) {
    const ch = argsBlock[i];

    if (quote) {
      if (ch === "\\") i++;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      quote = ch;
      continue;
    }
    if (ch === "{") {
      depth++;
      if (depth === 1) {
        token = "";
        sawColon = false;
      }
      continue;
    }
    if (ch === "}") {
      if (depth === 1) {
        flush();
      }
      depth--;
      continue;
    }
    if (depth !== 1) {
      continue;
    }
    if (ch === ":" && !sawColon) {
      const name = token.trim();
      if (/^[A-Za-z_$][\w$]*$/.test(name)) {
        names.push(name);
      }
      sawColon = true;
      token = "";
      continue;
    }
    if (ch === ",") {
      flush();
      sawColon = false;
      token = "";
      continue;
    }
    if (!sawColon) {
      token += ch;
    }
  }

  return names;
}

function lineOf(text: string, index: number): number {
  let line = 1;

  for (let i = 0; i < index; i++) {
    if (text[i] === "\n") {
      line++;
    }
  }

  return line;
}

/** Finds every declared `sourceRef` in one file's text. */
export function scanFile(relativePath: string, text: string): ProvenanceSite[] {
  const sites: ProvenanceSite[] = [];
  const marker = /\bsourceRef\s*:/g;
  let match: RegExpExecArray | null;

  while ((match = marker.exec(text)) !== null) {
    const block = extractObject(text, match.index);

    if (!block) {
      continue;
    }

    const file = readStringField(block, "file");

    // A sourceRef with no file is a type annotation or a destructuring, not a
    // declaration.
    if (!file) {
      continue;
    }

    // Per-instance refs are pushed into an array; the surrounding text says so.
    const before = text.slice(Math.max(0, match.index - 400), match.index);
    const perInstance = /instanceSourceRefs|instanceRef\s*=/.test(before);

    sites.push({
      file: relativePath,
      line: lineOf(text, match.index),
      declaredLine: readNumberField(block, "line"),
      function: readStringField(block, "function"),
      args: readArgNames(block),
      perInstance,
    });
  }

  return sites;
}

export type ScanEntry = { path: string; text: string };

/** Scans a set of already-read source files. */
export function scanProvenance(entries: ScanEntry[]): ProvenanceSite[] {
  return entries
    .filter((entry) => isSourceFile(entry.path.split("/").pop() ?? ""))
    .flatMap((entry) => scanFile(entry.path, entry.text));
}

export { isSourceFile };

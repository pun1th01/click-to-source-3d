import { READ_FILE_PATH, WRITE_FILE_PATH } from "@click-to-source/shared";

/**
 * Everything here goes through the dev server's endpoints rather than
 * touching the filesystem directly.
 *
 * Not an accident of convenience. The write endpoint does not merely write —
 * it parses the file and applies the edit through the same `editSource` the
 * overlay panel uses, and it enforces the same extension allowlist and
 * traversal guard. Reimplementing any of that here would mean two
 * implementations of the rules that decide what an agent may touch, which is
 * exactly the kind of divergence that ends in one of them being wrong.
 *
 * The consequence is that every tool needs a running dev server. The
 * endpoints are registered under `apply: "serve"` and do not exist in a
 * build.
 */
export type DevServerOptions = {
  /** Origin of the running Vite dev server, e.g. http://localhost:5173 */
  origin: string;
  /** Milliseconds before a request is abandoned. */
  timeoutMs?: number;
};

// A cold Vite dev server can spend several seconds optimising dependencies
// before it answers the first request, and an agent's tool call can afford to
// wait. Measured: the first POST after startup exceeded 5s on a real project,
// while every subsequent one returned in milliseconds.
const DEFAULT_TIMEOUT_MS = 15000;

export class DevServerError extends Error {
  readonly status: number;
  /** Typed failure from editSource, when the server supplied one. */
  readonly code: string | null;

  constructor(message: string, status: number, code: string | null = null) {
    super(message);
    this.name = "DevServerError";
    this.status = status;
    this.code = code;
  }
}

/**
 * The request took too long rather than being refused.
 *
 * Separate from unreachable because the remedy differs: a timeout usually
 * means a cold dev server still optimising dependencies, where retrying
 * works, while unreachable means there is nothing to talk to and retrying
 * will not help.
 */
export class DevServerTimeoutError extends Error {
  readonly origin: string;
  readonly timeoutMs: number;

  constructor(origin: string, timeoutMs: number) {
    super(
      `No response from ${origin} within ${timeoutMs}ms. The dev server may ` +
        `still be starting or optimising dependencies; retrying usually succeeds.`
    );
    this.name = "DevServerTimeoutError";
    this.origin = origin;
    this.timeoutMs = timeoutMs;
  }
}

/**
 * Distinguishes "the dev server is not running" from "the dev server said no".
 *
 * An agent can act on the first by starting one; the second means its request
 * was wrong. Collapsing them into one error would make the tool advice
 * useless.
 */
export class DevServerUnreachableError extends Error {
  readonly origin: string;

  constructor(origin: string, cause: string) {
    super(
      `No Click-to-Source dev server reachable at ${origin}. ` +
        `Start the application's Vite dev server, and make sure clickToSource() ` +
        `is in its plugins. (${cause})`
    );
    this.name = "DevServerUnreachableError";
    this.origin = origin;
  }
}

async function post(
  options: DevServerOptions,
  path: string,
  body: unknown
): Promise<Record<string, unknown>> {
  const url = `${options.origin.replace(/\/+$/, "")}${path}`;
  const controller = new AbortController();
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let response: Response;

  try {
    response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
      // Deliberately no Origin header: the endpoints admit a non-browser
      // client precisely so tooling can drive them.
    });
  } catch (error) {
    if (controller.signal.aborted) {
      throw new DevServerTimeoutError(options.origin, timeoutMs);
    }

    throw new DevServerUnreachableError(
      options.origin,
      error instanceof Error ? error.message : "request failed"
    );
  } finally {
    clearTimeout(timer);
  }

  let payload: Record<string, unknown> = {};

  try {
    payload = (await response.json()) as Record<string, unknown>;
  } catch {
    // A non-JSON body from this path means something other than the plugin
    // answered — most often the dev server is running without it installed.
    throw new DevServerError(
      `Unexpected non-JSON response from ${path}. Is clickToSource() in the ` +
        `Vite plugins array?`,
      response.status
    );
  }

  if (!response.ok) {
    throw new DevServerError(
      typeof payload.error === "string" ? payload.error : "Request failed",
      response.status,
      typeof payload.code === "string" ? payload.code : null
    );
  }

  return payload;
}

/** Reads a source file through the dev server, subject to its allowlist. */
export async function readSourceFile(
  options: DevServerOptions,
  file: string
): Promise<string> {
  const payload = await post(options, READ_FILE_PATH, { file });

  if (typeof payload.content !== "string") {
    throw new DevServerError("Read response contained no source content", 500);
  }

  return payload.content;
}

/**
 * Rewrites one argument at a known source location.
 *
 * `content` is deliberately not sent. The endpoint reads the file itself when
 * it is absent, so the edit applies to what is on disk right now rather than
 * to whatever the caller last read — which for an agent may be many turns
 * stale.
 */
export async function editParameter(
  options: DevServerOptions,
  edit: { file: string; line: number; argName: string; newValue: unknown }
): Promise<void> {
  await post(options, WRITE_FILE_PATH, edit);
}

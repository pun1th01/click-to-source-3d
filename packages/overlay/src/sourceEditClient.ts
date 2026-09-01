import {
  READ_FILE_PATH,
  WRITE_FILE_PATH,
  type EditRequest,
  type SourceRef,
} from "@click-to-source-3d/shared";

type JsonResponse = {
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
};

export type SourceEditFetch = (
  input: string,
  init?: RequestInit
) => Promise<JsonResponse>;

export class SourceEditTransportError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "SourceEditTransportError";
    this.status = status;
  }
}

/**
 * A save that never settles is worse here than one that fails.
 *
 * Every Save button in the panel is disabled while one is in flight, so a
 * request that hangs — a dev server stopped mid-edit, a suspended laptop —
 * leaves the whole panel permanently unable to edit anything, with no error
 * to explain it. A deadline turns that into a message the developer can act
 * on. Ten seconds is far longer than a local file read and write needs.
 */
const REQUEST_TIMEOUT_MS = 10000;

async function postJson<T>(
  endpoint: string,
  body: unknown,
  fetchImpl: SourceEditFetch
): Promise<T> {
  let response: JsonResponse;

  try {
    response = await fetchImpl(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      // Injected test doubles ignore this, which is why the timeout is not
      // something they can assert on. It exists for the real fetch.
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === "TimeoutError") {
      throw new SourceEditTransportError(
        `No response from the dev server within ${REQUEST_TIMEOUT_MS}ms. Is it still running?`,
        504
      );
    }

    throw error;
  }

  const payload = (await response.json()) as {
    error?: unknown;
  } & T;

  if (!response.ok) {
    const detail = typeof payload.error === "string" ? payload.error : "Request failed";
    throw new SourceEditTransportError(detail, response.status);
  }

  return payload;
}

export async function readSourceFile(
  file: string,
  fetchImpl: SourceEditFetch = fetch
): Promise<string> {
  const payload = await postJson<{ content?: unknown }>(
    READ_FILE_PATH,
    { file },
    fetchImpl
  );

  if (typeof payload.content !== "string") {
    throw new SourceEditTransportError("Read response did not contain source content", 500);
  }

  return payload.content;
}

export async function editSourceFile(
  sourceRef: SourceRef,
  argName: string,
  newValue: unknown,
  fetchImpl: SourceEditFetch = fetch
): Promise<void> {
  const content = await readSourceFile(sourceRef.file, fetchImpl);
  const request: EditRequest = {
    file: sourceRef.file,
    line: sourceRef.line,
    // `argName` is the panel's display key; editSource matches against the
    // identifier as declared in source. Resolve through argSources when the
    // generator declares a mapping, otherwise pass the key through unchanged.
    argName: sourceRef.argSources?.[argName] ?? argName,
    newValue,
  };

  await postJson(
    WRITE_FILE_PATH,
    { ...request, content },
    fetchImpl
  );
}

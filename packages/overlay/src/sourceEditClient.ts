import {
  READ_FILE_PATH,
  WRITE_FILE_PATH,
  type EditRequest,
  type SourceRef,
} from "@click-to-source/shared";

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

async function postJson<T>(
  endpoint: string,
  body: unknown,
  fetchImpl: SourceEditFetch
): Promise<T> {
  const response = await fetchImpl(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

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

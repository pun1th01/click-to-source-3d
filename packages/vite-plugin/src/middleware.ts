import { promises as fs } from "node:fs";
import path from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { EditRequest } from "@click-to-source/shared";
import { editSource, SourceEditError } from "./sourceEditor.js";

type ReadFileRequest = {
  file: string;
};

type WriteFileRequest = {
  file: string;
  content: string;
};

type EditWriteFileRequest = {
  file: string;
  content?: string;
  edit: EditRequest;
};

type FileRequest = ReadFileRequest | WriteFileRequest | EditWriteFileRequest;

type FileSystemError = NodeJS.ErrnoException;

function sendJson(
  response: ServerResponse,
  statusCode: number,
  payload: Record<string, unknown>
) {
  const body = JSON.stringify(payload);

  response.statusCode = statusCode;
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.setHeader("Content-Length", Buffer.byteLength(body));
  response.end(body);
}

async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];

  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  const body = Buffer.concat(chunks).toString("utf8");

  if (!body) {
    throw new Error("empty request body");
  }

  try {
    return JSON.parse(body);
  } catch {
    throw new Error("invalid JSON body");
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOwn(value: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function parseRequestBody(
  body: unknown,
  operation: "read" | "write"
): FileRequest {
  if (!isRecord(body) || typeof body.file !== "string" || body.file.length === 0) {
    throw new Error("invalid request body");
  }

  if (operation === "write") {
    const hasEditFields =
      hasOwn(body, "line") || hasOwn(body, "argName") || hasOwn(body, "newValue");

    if (hasEditFields) {
      if (
        !Number.isInteger(body.line) ||
        (body.line as number) < 1 ||
        typeof body.argName !== "string" ||
        body.argName.length === 0 ||
        !hasOwn(body, "newValue") ||
        (hasOwn(body, "content") && typeof body.content !== "string")
      ) {
        throw new Error("invalid request body");
      }

      return {
        file: body.file,
        content: typeof body.content === "string" ? body.content : undefined,
        edit: {
          file: body.file,
          line: body.line as number,
          argName: body.argName,
          newValue: body.newValue,
        },
      };
    }

    if (typeof body.content !== "string") {
      throw new Error("invalid request body");
    }

    return { file: body.file, content: body.content };
  }

  return { file: body.file };
}

function isWindowsAbsolutePath(file: string): boolean {
  return /^[a-zA-Z]:/.test(file) || file.startsWith("\\\\");
}

function isInsideRoot(root: string, candidate: string): boolean {
  const relativePath = path.relative(root, candidate);

  return (
    relativePath !== "" &&
    relativePath !== ".." &&
    !relativePath.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relativePath)
  );
}

function resolveLexicalPath(root: string, requestedFile: string): string | null {
  if (
    requestedFile.includes("\0") ||
    path.isAbsolute(requestedFile) ||
    isWindowsAbsolutePath(requestedFile)
  ) {
    return null;
  }

  // Treat both slash styles as separators so Windows traversal attempts are
  // rejected consistently even if the server is later run on another OS.
  const normalizedFile = requestedFile.replace(/[\\/]+/g, path.sep);
  const resolvedRoot = path.resolve(root);
  const resolvedFile = path.resolve(resolvedRoot, normalizedFile);

  return isInsideRoot(resolvedRoot, resolvedFile) ? resolvedFile : null;
}

async function resolveSafePath(
  root: string,
  requestedFile: string
): Promise<string | null> {
  const lexicalPath = resolveLexicalPath(root, requestedFile);

  if (!lexicalPath) {
    return null;
  }

  const resolvedRoot = await fs.realpath(root);
  let existingPath = lexicalPath;
  const missingPathParts: string[] = [];

  while (true) {
    try {
      const realExistingPath = await fs.realpath(existingPath);
      const realCandidate = path.resolve(
        realExistingPath,
        ...missingPathParts.reverse()
      );

      return isInsideRoot(resolvedRoot, realCandidate) ? lexicalPath : null;
    } catch (error) {
      const fileSystemError = error as FileSystemError;

      if (fileSystemError.code !== "ENOENT") {
        throw error;
      }

      const parentPath = path.dirname(existingPath);

      if (parentPath === existingPath) {
        return null;
      }

      missingPathParts.push(path.basename(existingPath));
      existingPath = parentPath;
    }
  }
}

/**
 * Handles one read or write request against `root`.
 *
 * Deliberately free of any Vite import: it takes only node:http types, so a
 * binding for another dev server can reuse it without change.
 */
export async function handleFileRequest(
  request: IncomingMessage,
  response: ServerResponse,
  root: string,
  operation: "read" | "write"
) {
  if (request.method !== "POST") {
    response.setHeader("Allow", "POST");
    sendJson(response, 405, { error: "Method not allowed" });
    return;
  }

  let parsedRequest: FileRequest;

  try {
    parsedRequest = parseRequestBody(await readJsonBody(request), operation);
  } catch {
    sendJson(response, 400, { error: "Invalid request body" });
    return;
  }

  let filePath: string | null;

  try {
    filePath = await resolveSafePath(root, parsedRequest.file);
  } catch {
    sendJson(response, 500, { error: "Filesystem failure" });
    return;
  }

  if (!filePath) {
    sendJson(response, 400, { error: "Invalid file path" });
    return;
  }

  try {
    if (operation === "read") {
      const content = await fs.readFile(filePath, "utf8");
      sendJson(response, 200, { content });
      return;
    }

    const writeRequest = parsedRequest as WriteFileRequest | EditWriteFileRequest;
    let content = writeRequest.content;

    if ("edit" in writeRequest) {
      const source = content ?? (await fs.readFile(filePath, "utf8"));

      try {
        content = editSource(source, writeRequest.edit);
      } catch (error) {
        if (error instanceof SourceEditError) {
          sendJson(response, 400, {
            error: "Source edit failed",
            code: error.code,
          });
          return;
        }

        sendJson(response, 500, { error: "Source edit failure" });
        return;
      }
    }

    await fs.writeFile(
      filePath,
      content as string,
      "utf8"
    );
    sendJson(response, 200, { success: true });
  } catch (error) {
    const fileSystemError = error as FileSystemError;

    if (fileSystemError.code === "ENOENT") {
      sendJson(response, 404, { error: "File not found" });
      return;
    }

    sendJson(response, 500, { error: "Filesystem failure" });
  }
}

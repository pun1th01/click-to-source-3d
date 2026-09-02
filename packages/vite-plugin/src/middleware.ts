import { promises as fs } from "node:fs";
import path from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { EditRequest } from "@click-to-source-3d/shared";
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

/**
 * Extensions the editor can actually operate on.
 *
 * editSource parses with @babel/parser, so this list tracks what the parser
 * handles rather than being an arbitrary policy. Anything outside it could
 * only ever be read or clobbered wholesale, never meaningfully edited.
 */
export const DEFAULT_ALLOWED_EXTENSIONS = [
  ".js",
  ".jsx",
  ".ts",
  ".tsx",
  ".mjs",
  ".cjs",
  ".mts",
  ".cts",
] as const;

export type FileRequestOptions = {
  allowedExtensions: readonly string[];
  allowedOrigins: readonly string[];
  /**
   * Callers reachable from outside this machine are refused unless this is
   * set. See isLoopbackRemote for why the default is closed.
   */
  allowRemote?: boolean;
};

/**
 * Whether a requested path is one the editor is permitted to touch.
 *
 * Two rules, and the second is not redundant. path.extname(".env") returns
 * "" rather than ".env", because Node treats a leading dot as the start of a
 * basename — so dotfiles fail the extension test by accident of that return
 * value, not by intent. The accident does not cover dotfiles that do carry a
 * recognised extension: ".babelrc.js" yields ".js" and ".hidden.ts" yields
 * ".ts", both of which would otherwise pass. Rejecting dot-prefixed
 * basenames outright closes that gap and makes the dotfile rule explicit
 * rather than incidental.
 */
function isEditableFile(
  requestedFile: string,
  allowedExtensions: readonly string[]
): boolean {
  const basename = path.basename(requestedFile.replace(/[\\/]+/g, path.sep));

  if (basename.startsWith(".")) {
    return false;
  }

  return allowedExtensions.includes(path.extname(basename));
}

/**
 * Whether the caller is on this machine.
 *
 * The endpoints read and write files anywhere under the project root, and the
 * origin check deliberately allows requests with no Origin header on the
 * grounds that anything with local shell access could edit those files
 * directly. That reasoning holds only while "local" is true. Started with
 * `vite --host`, the dev server is reachable from the network, and a plain
 * curl from another machine carries no Origin and inherits that allowance.
 *
 * Loopback is therefore checked separately from origin, and remote callers
 * are refused unless the consumer opts in.
 */
function isLoopbackRemote(request: IncomingMessage): boolean {
  const address = request.socket?.remoteAddress;

  if (typeof address !== "string" || address.length === 0) {
    // A socket with no address is a stand-in rather than a real connection;
    // in-process tests reach the handler this way.
    return true;
  }

  // IPv4, IPv4-mapped IPv6, and IPv6 loopback respectively.
  return (
    address === "127.0.0.1" ||
    address.startsWith("127.") ||
    address === "::1" ||
    address === "::ffff:127.0.0.1" ||
    address.startsWith("::ffff:127.")
  );
}

/**
 * Rejects cross-origin browser requests.
 *
 * Without this, any page open in the developer's browser can POST to the dev
 * server and read or rewrite files in their project. A request with no Origin
 * header is allowed: that is a non-browser client such as curl or the test
 * suite, and anything with local shell access can edit the files directly
 * anyway, so refusing it buys nothing. isLoopbackRemote is what keeps
 * "non-browser client" and "on this machine" from drifting apart.
 *
 * An Origin is matched against the server's own origins, which the plugin
 * supplies from Vite's resolved config. It is deliberately not compared
 * against this request's Host header: a non-browser client sets both, so
 * `Origin: http://evil.test` with `Host: evil.test` satisfied that comparison
 * and was accepted. Measured against the shipped 0.1.0 handler, that returned
 * 200 and completed the write.
 */
function isAllowedOrigin(
  request: IncomingMessage,
  allowedOrigins: readonly string[]
): boolean {
  // Browsers set Sec-Fetch-Site on every request, so a cross-site value is a
  // rejection signal that does not depend on parsing Origin at all.
  if (request.headers["sec-fetch-site"] === "cross-site") {
    return false;
  }

  const origin = request.headers.origin;

  if (typeof origin !== "string" || origin.length === 0) {
    return true;
  }

  return allowedOrigins.includes(origin);
}

/**
 * The one caller policy, shared by every endpoint this package serves.
 *
 * Exported because the bridge endpoints live in the plugin rather than here,
 * and when they were wired up they inherited neither check — a page on any
 * origin could query the running scene, and under `vite --host` so could the
 * network. Two copies of a policy is how that happened; this is one copy.
 *
 * Returns null when the caller is acceptable, or the response to send.
 */
export function checkCaller(
  request: IncomingMessage,
  options: { allowedOrigins: readonly string[]; allowRemote?: boolean }
): { status: number; error: string } | null {
  if (!options.allowRemote && !isLoopbackRemote(request)) {
    return { status: 403, error: "Remote request rejected" };
  }

  if (!isAllowedOrigin(request, options.allowedOrigins)) {
    return { status: 403, error: "Cross-origin request rejected" };
  }

  return null;
}

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
  operation: "read" | "write",
  options: FileRequestOptions
) {
  const refusal = checkCaller(request, options);

  if (refusal) {
    sendJson(response, refusal.status, { error: refusal.error });
    return;
  }

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

  // Deliberately after the traversal check: an escape attempt is the more
  // specific finding and should be what the caller is told about.
  if (!isEditableFile(parsedRequest.file, options.allowedExtensions)) {
    sendJson(response, 400, { error: "File type not editable" });
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
          // The editor's message, not a generic stand-in for it. Both clients
          // read `error` as the human-readable half, so replacing the constant
          // here is what carries "declared at line 2" to the panel and to an
          // agent; sending it under a new key would have reached neither
          // without changing them too. `code` is unchanged and still the field
          // to branch on.
          sendJson(response, 400, {
            error: error.message,
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

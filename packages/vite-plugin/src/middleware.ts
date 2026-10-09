import { promises as fs } from "node:fs";
import path from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { EditRequest } from "@click-to-source-3d/shared";
import { editSource, SourceEditError } from "./sourceEditor.js";

type ReadFileRequest = {
  file: string;
};

type EditWriteFileRequest = {
  file: string;
  edit: EditRequest;
};

type FileRequest = ReadFileRequest | EditWriteFileRequest;

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
  /**
   * Directories a requested file may resolve into besides the root, which is
   * always allowed. Paths are still interpreted relative to the root.
   *
   * The plugin passes Vite's resolved `server.fs.allow` — by default the
   * workspace root — which is the boundary Vite already serves source from.
   * In a monorepo, a component in `packages/ui` is stamped with a path like
   * `../../packages/ui/src/Rock.tsx`, and with the root as the only boundary
   * every such file was refused: the panel named it and could not edit it.
   */
  allowedRoots?: readonly string[];
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
  return isLoopbackAddress(request.socket?.remoteAddress);
}

/**
 * The same test for an address on its own, for connections that are not an
 * HTTP request by the time they reach the plugin — the bridge's websocket.
 */
export function isLoopbackAddress(address: string | undefined): boolean {
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
    // A write is an edit of one literal, and nothing else.
    //
    // This endpoint used to also accept `{ file, content }` and write the
    // content verbatim — a whole-file overwrite of any allowed source file
    // under the root. Neither client ever sent that, and an edit could carry
    // `content` too, which was edited in place of the file on disk: the same
    // overwrite, one step removed, and a lost update whenever the file
    // changed between the caller's read and its write. `content` is now
    // ignored rather than refused, so a 0.1.3 overlay that still sends it
    // keeps working, and every edit applies to the file as it is on disk.
    // By position (line, column, expected) or by name (line, argName); see
    // EditRequest. The editor validates each field again, so this only has
    // to keep malformed shapes from reaching it.
    const byPosition = hasOwn(body, "column");

    if (
      !Number.isInteger(body.line) ||
      (body.line as number) < 1 ||
      !hasOwn(body, "newValue") ||
      (byPosition
        ? !Number.isInteger(body.column) ||
          (body.column as number) < 1 ||
          typeof body.expected !== "string" ||
          (hasOwn(body, "argName") && typeof body.argName !== "string")
        : typeof body.argName !== "string" || body.argName.length === 0)
    ) {
      throw new Error("invalid request body");
    }

    return {
      file: body.file,
      edit: {
        file: body.file,
        line: body.line as number,
        argName: typeof body.argName === "string" ? body.argName : undefined,
        column: byPosition ? (body.column as number) : undefined,
        expected: byPosition ? (body.expected as string) : undefined,
        newValue: body.newValue,
      },
    };
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

function resolveLexicalPath(
  root: string,
  requestedFile: string,
  allowedRoots: readonly string[]
): string | null {
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
  const resolvedFile = path.resolve(path.resolve(root), normalizedFile);

  return allowedRoots.some((allowed) =>
    isInsideRoot(path.resolve(allowed), resolvedFile)
  )
    ? resolvedFile
    : null;
}

async function realpathOrNull(target: string): Promise<string | null> {
  try {
    return await fs.realpath(target);
  } catch {
    return null;
  }
}

async function resolveSafePath(
  root: string,
  requestedFile: string,
  allowedRoots: readonly string[]
): Promise<string | null> {
  const lexicalPath = resolveLexicalPath(root, requestedFile, allowedRoots);

  if (!lexicalPath) {
    return null;
  }

  // An allowed root that does not exist admits nothing, rather than failing
  // every request.
  const realRoots = (await Promise.all(allowedRoots.map(realpathOrNull))).filter(
    (entry): entry is string => entry !== null
  );
  let existingPath = lexicalPath;
  const missingPathParts: string[] = [];

  while (true) {
    try {
      const realExistingPath = await fs.realpath(existingPath);
      const realCandidate = path.resolve(
        realExistingPath,
        ...missingPathParts.reverse()
      );

      return realRoots.some((realRoot) => isInsideRoot(realRoot, realCandidate))
        ? lexicalPath
        : null;
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
 * Replaces a file's contents in one step.
 *
 * A plain write truncates the file first, and Vite's watcher can read it in
 * between: measured during this project's own end-to-end test, the stamping
 * transform received an empty main.tsx moments after a Save and warned that
 * another plugin had compiled away its JSX. Writing beside the file and
 * renaming over it means a watcher sees the old contents or the new, never
 * neither.
 *
 * Falls back to a direct write when the rename is refused — on Windows, by a
 * file another process holds open, such as a sync client.
 */
async function writeAtomically(file: string, content: string): Promise<void> {
  const temporary = path.join(
    path.dirname(file),
    `.${path.basename(file)}.cts-${process.pid}-${Date.now()}.tmp`
  );

  try {
    await fs.writeFile(temporary, content, "utf8");
    await fs.rename(temporary, file);
  } catch {
    await fs.rm(temporary, { force: true }).catch(() => undefined);
    await fs.writeFile(file, content, "utf8");
  }
}

/** Opens a file at a position in the developer's editor. */
export type OpenInEditor = (file: string, line: number, column: number) => void;

function isPosition(value: unknown): boolean {
  return value === undefined || (Number.isInteger(value) && (value as number) >= 1);
}

/**
 * Handles one request to open a source file in the editor.
 *
 * Bound by the same rules as reading the file: the caller policy, the
 * traversal guard, the extension allowlist. Opening is not reading, but a
 * page that could open any path could probe which files exist, and an editor
 * launched on an arbitrary file is a strange thing for a dev tool to let a
 * web page do. `open` is passed in so tests need not launch an editor.
 */
export async function handleOpenRequest(
  request: IncomingMessage,
  response: ServerResponse,
  root: string,
  options: FileRequestOptions,
  open: OpenInEditor
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

  let body: Record<string, unknown>;

  try {
    const parsed = await readJsonBody(request);
    if (
      !isRecord(parsed) ||
      typeof parsed.file !== "string" ||
      parsed.file.length === 0 ||
      !isPosition(parsed.line) ||
      !isPosition(parsed.column)
    ) {
      throw new Error("invalid request body");
    }
    body = parsed;
  } catch {
    sendJson(response, 400, { error: "Invalid request body" });
    return;
  }

  const file = body.file as string;
  let filePath: string | null;

  try {
    filePath = await resolveSafePath(root, file, [root, ...(options.allowedRoots ?? [])]);
  } catch {
    sendJson(response, 500, { error: "Filesystem failure" });
    return;
  }

  if (!filePath) {
    sendJson(response, 400, { error: "Invalid file path" });
    return;
  }

  if (!isEditableFile(file, options.allowedExtensions)) {
    sendJson(response, 400, { error: "File type not editable" });
    return;
  }

  try {
    await fs.access(filePath);
  } catch {
    sendJson(response, 404, { error: "File not found" });
    return;
  }

  open(filePath, (body.line as number | undefined) ?? 1, (body.column as number | undefined) ?? 1);
  sendJson(response, 200, { opened: true });
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
    filePath = await resolveSafePath(root, parsedRequest.file, [
      root,
      ...(options.allowedRoots ?? []),
    ]);
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

    const { edit } = parsedRequest as EditWriteFileRequest;
    const source = await fs.readFile(filePath, "utf8");
    let content: string;

    try {
      content = editSource(source, edit);
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

    await writeAtomically(filePath, content);
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

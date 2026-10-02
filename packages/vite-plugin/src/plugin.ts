import {
  BRIDGE_EVENTS_PATH,
  BRIDGE_QUERY_PATH,
  BRIDGE_REPLY_PATH,
  READ_FILE_PATH,
  WRITE_FILE_PATH,
} from "@click-to-source-3d/shared";
import type { BridgeQuery } from "@click-to-source-3d/shared";
import { BridgeHub } from "./bridgeHub.js";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Plugin, ResolvedConfig } from "vite";
import {
  checkCaller,
  DEFAULT_ALLOWED_EXTENSIONS,
  handleFileRequest,
  type FileRequestOptions,
} from "./middleware.js";
import { stampSource } from "./stampSource.js";

const TRAILING_SLASHES = new RegExp("/+$");

/** Reads a JSON body, runs a handler, and writes the JSON result. */
async function handleBridgePost(
  request: IncomingMessage,
  response: ServerResponse,
  handler: (body: unknown) => unknown | Promise<unknown>
): Promise<void> {
  const chunks: Buffer[] = [];

  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  let body: unknown = {};

  try {
    body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
  } catch {
    response.statusCode = 400;
    response.setHeader("Content-Type", "application/json");
    response.end(JSON.stringify({ error: "Invalid JSON body" }));
    return;
  }

  const result = await handler(body);
  const payload = JSON.stringify(result);

  response.statusCode = 200;
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.setHeader("Content-Length", Buffer.byteLength(payload));
  response.end(payload);
}

export type ClickToSourceOptions = {
  /**
   * File extensions the editor may read and write. Replaces the default set
   * rather than extending it. Defaults to DEFAULT_ALLOWED_EXTENSIONS.
   */
  allowedExtensions?: string[];
  /**
   * Extra browser origins permitted to call the endpoints, beyond the dev
   * server's own. Defaults to none.
   */
  allowedOrigins?: string[];
  /**
   * Stamp every host element with its source location into
   * `userData.__ctsSource`, so file, function and line no longer have to be
   * hand-written into `userData.sourceRef`.
   *
   * Emitted paths are always relative to the Vite root, in dev as well as in
   * a build. The panel displays whatever it resolves, so an absolute path
   * would put the developer's home directory on screen in every screenshot
   * and shared session.
   *
   * `true` stamps in dev only. `"always"` also stamps production builds —
   * off by default, and not merely to save bytes: a stamp names a source file
   * and the component that produced it, so shipping one publishes your
   * project's file layout and internal component names to every visitor, with
   * no user-facing benefit, since the overlay that reads these is not in a
   * production bundle.
   *
   * Stamping needs JSX still to be present when this plugin's transform runs.
   * @vitejs/plugin-react performs no JSX transform of its own — it configures
   * Vite's, which runs later — so either plugin order stamps identically. A
   * React plugin that does compile JSX in a "pre" transform of its own would
   * consume it first if listed first; the transform below warns when it finds
   * a .jsx/.tsx file with no JSX left in it.
   */
  stampSource?: boolean | "always";
  /**
   * Formerly installed a probe that captured per-instance transforms as they
   * were written.
   *
   * Instance transforms are now read live from the mesh when an instance is
   * resolved, which needs no probe, patches nothing, and also covers the
   * `setMatrixAt(i, dummy.matrix)` loop the probe could not see. Every
   * InstancedMesh gets per-instance provenance with no option set.
   *
   * @deprecated Has no effect. Remove it; the option is removed in 0.2.0.
   */
  captureInstances?: boolean;
  /**
   * Serve the read, write and bridge endpoints to callers beyond this
   * machine.
   *
   * Off by default. The endpoints read and write files under the project
   * root, and a request with no Origin header is allowed because a local
   * non-browser client could edit those files directly anyway. Started with
   * `vite --host`, the same request can arrive from the network, where that
   * reasoning does not apply. Turn this on only on a network you control.
   */
  allowRemote?: boolean;
  /**
   * Open the scene bridge, letting an out-of-process client ask the running
   * page about its own contents.
   *
   * Off by default and dev only. Always-on would mean every dev server holds
   * an event stream and serialises scene state for a tool nobody is running.
   *
   * Requires <ClickToSourceBridge /> inside the Canvas: the bridge needs a
   * scene and a camera, which only a component inside the R3F tree can supply.
   */
  bridge?: boolean;
};

/**
 * Serves the source read/write endpoints the Click-to-Source overlay calls.
 *
 * Dev-server only — `apply: "serve"` keeps it out of production builds.
 * Source paths in requests are resolved relative to Vite's own `root`, which
 * is also what `SourceRef.file` values are expected to be relative to.
 */
export function clickToSource(options: ClickToSourceOptions = {}): Plugin {
  let resolvedConfig: ResolvedConfig;

  const requestOptions: FileRequestOptions = {
    allowedExtensions:
      options.allowedExtensions ?? [...DEFAULT_ALLOWED_EXTENSIONS],
    allowedOrigins: options.allowedOrigins ?? [],
    allowRemote: options.allowRemote ?? false,
  };

  const stamping = options.stampSource ?? false;
  const bridging = options.bridge ?? false;
  const hub = new BridgeHub();
  let warnedAboutOrder = false;

  return {
    name: "click-to-source",
    // "pre" so the transform runs before Vite's own JSX compilation, which is
    // where @vitejs/plugin-react's JSX is compiled — so with that plugin,
    // either array order works. A plugin that compiles JSX in a "pre"
    // transform of its own would need this one listed ahead of it, since Vite
    // keeps array order within a bucket; the transform warns if it finds a
    // .jsx/.tsx file with no JSX left in it.
    enforce: "pre",
    apply(_config, env) {
      // The endpoints are dev-only. The build is entered only to stamp, and
      // only when the caller opted into production stamping.
      return env.command === "serve" || stamping === "always";
    },
    configResolved(config) {
      resolvedConfig = config;

      if (options.captureInstances !== undefined) {
        config.logger.warn(
          "click-to-source: captureInstances is deprecated and has no effect. " +
            "Instance transforms are now read live, for every InstancedMesh, " +
            "with no option. Remove it from clickToSource()."
        );
      }
    },
    transform(code, id) {
      if (!stamping) {
        return null;
      }
      if (resolvedConfig.command === "build" && stamping !== "always") {
        return null;
      }
      if (!/\.[jt]sx$/.test(id.split("?")[0])) {
        return null;
      }

      if (!warnedAboutOrder && !code.includes("<")) {
        // A .jsx file with no JSX left in it means something compiled it
        // first. @vitejs/plugin-react does not — Vite's own compilation runs
        // after this transform — but a plugin that compiles JSX itself in a
        // "pre" transform does. Silently stamping nothing is the worst
        // outcome, so say so once.
        warnedAboutOrder = true;
        this.warn(
          "click-to-source: no JSX found in " +
            id +
            ". Another plugin compiled it before click-to-source ran; list " +
            "clickToSource() first in your Vite plugins, or source stamping " +
            "will do nothing."
        );
        return null;
      }

      return stampSource(code, id.split("?")[0], { root: resolvedConfig.root });
    },

    configureServer(server) {
      if (bridging) {
        server.httpServer?.on("close", () => hub.dispose());
      }

      /**
       * The server's own origins, read at request time.
       *
       * Not captured when the server starts: resolvedUrls is still null at
       * the httpServer "listening" event and is assigned only after
       * server.listen() resolves. Reading it eagerly silently yielded an
       * empty list, which rejected the page's own same-origin requests —
       * caught by driving the real overlay rather than by a test.
       */
      const serverOrigins = (): readonly string[] => {
        const urls = server.resolvedUrls;

        if (!urls) {
          return requestOptions.allowedOrigins;
        }

        return [
          ...new Set([
            ...requestOptions.allowedOrigins,
            // resolvedUrls carry a trailing slash; an Origin header never does.
            ...[...urls.local, ...urls.network].map((url) =>
              url.replace(TRAILING_SLASHES, "")
            ),
          ]),
        ];
      };

      server.middlewares.use((request, response, next) => {
        let pathname: string;

        try {
          pathname = new URL(request.url ?? "/", "http://localhost").pathname;
        } catch {
          next();
          return;
        }

        // Every bridge path is subject to the same caller policy as the file
        // endpoints. The query surface is read-only, but it discloses source
        // paths, function names and argument values, which is not something to
        // hand to any page that happens to be open — or, under `vite --host`,
        // to the network. Checked before `bridging` is consulted, so a
        // disallowed caller cannot even learn whether the bridge is enabled.
        if (
          pathname === BRIDGE_EVENTS_PATH ||
          pathname === BRIDGE_REPLY_PATH ||
          pathname === BRIDGE_QUERY_PATH
        ) {
          const refusal = checkCaller(request, {
            allowedOrigins: serverOrigins(),
            allowRemote: requestOptions.allowRemote,
          });

          if (refusal) {
            response.statusCode = refusal.status;
            response.setHeader("Content-Type", "application/json; charset=utf-8");
            response.end(JSON.stringify({ error: refusal.error }));
            return;
          }
        }

        if (bridging && pathname === BRIDGE_EVENTS_PATH) {
          hub.handleEvents(request, response);
          return;
        }

        if (bridging && pathname === BRIDGE_REPLY_PATH) {
          void handleBridgePost(request, response, (body) => {
            hub.handleReply(body as { requestId?: string; result?: unknown });
            return { ok: true };
          });
          return;
        }

        if (pathname === BRIDGE_QUERY_PATH) {
          void handleBridgePost(request, response, async (body) => {
            if (!bridging) {
              return {
                status: "disabled",
                reason:
                  "The scene bridge is off. Pass bridge: true to clickToSource() " +
                  "and add <ClickToSourceBridge /> inside your Canvas.",
              };
            }

            const { query, pageId, timeoutMs } = body as {
              query: BridgeQuery;
              pageId?: number;
              timeoutMs?: number;
            };

            return hub.query(query, { pageId, timeoutMs });
          });
          return;
        }

        // Vite's own serving boundary, so a component from a sibling
        // workspace package is as editable as it is loadable.
        const fileOptions = (): FileRequestOptions => ({
          ...requestOptions,
          allowedOrigins: serverOrigins(),
          allowedRoots: resolvedConfig.server.fs.allow,
        });

        if (pathname === READ_FILE_PATH) {
          void handleFileRequest(
            request,
            response,
            resolvedConfig.root,
            "read",
            fileOptions()
          );
          return;
        }

        if (pathname === WRITE_FILE_PATH) {
          void handleFileRequest(
            request,
            response,
            resolvedConfig.root,
            "write",
            fileOptions()
          );
          return;
        }

        next();
      });
    },
  };
}

import {
  BRIDGE_EVENTS_PATH,
  BRIDGE_HELLO_EVENT,
  BRIDGE_QUERY_EVENT,
  BRIDGE_QUERY_PATH,
  BRIDGE_REPLY_EVENT,
  BRIDGE_REPLY_PATH,
  OPEN_IN_EDITOR_PATH,
  READ_FILE_PATH,
  WRITE_FILE_PATH,
} from "@click-to-source-3d/shared";
import type { BridgeQuery } from "@click-to-source-3d/shared";
import launchEditor from "launch-editor";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { BridgeHub } from "./bridgeHub.js";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Plugin, ResolvedConfig } from "vite";
import {
  checkCaller,
  isLoopbackAddress,
  DEFAULT_ALLOWED_EXTENSIONS,
  handleFileRequest,
  handleOpenRequest,
  type FileRequestOptions,
} from "./middleware.js";
import { announceDevServer } from "./registry.js";
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
   * On by default. `true` stamps in dev only. `"always"` also stamps
   * production builds — not the default, and not merely to save bytes: a stamp
   * names a source file
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
   * Open the scene bridge, letting an out-of-process client — the MCP server
   * an AI assistant runs — ask the running page about its own contents.
   *
   * On by default, dev only. The injected inspector answers over Vite's own
   * HMR websocket, which is already open, so an idle bridge costs nothing.
   * `<ClickToSourceBridge />` still works and is no longer needed.
   */
  bridge?: boolean;
  /**
   * Inject the inspector into every page the dev server serves: a toggle
   * button on the canvas and a keyboard shortcut that turn on inspect mode,
   * in which clicking an object shows where it came from and lets its values
   * be edited in place.
   *
   * On by default, dev only — nothing is added to a build. `false` turns it
   * off; an object configures it.
   */
  inspector?:
    | boolean
    | {
        /** Default "alt+shift+c". */
        hotkey?: string;
        /** Show the toggle button on the canvas. Default true. */
        button?: boolean;
      };
};

/**
 * Whether a package is installed where the project can import it: in a
 * node_modules beside the project or above it, as a monorepo hoists.
 */
function isInstalled(root: string, name: string): boolean {
  for (let dir = root; ; dir = path.dirname(dir)) {
    if (existsSync(path.join(dir, "node_modules", name, "package.json"))) {
      return true;
    }
    if (path.dirname(dir) === dir) {
      return false;
    }
  }
}

/** Reported to the MCP server, which shows it if the two disagree. */
const PLUGIN_VERSION = (createRequire(import.meta.url)("../package.json") as { version: string }).version;

const CLIENT_MODULE_ID = "virtual:click-to-source/client";
const RESOLVED_CLIENT_ID = `\0${CLIENT_MODULE_ID}`;

/**
 * The bundled inspector. Built beside this file in dist/; when this file runs
 * from src/ — under the test runner — the bundle is in the sibling dist/.
 */
const CLIENT_FILE = (() => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [path.join(here, "client.js"), path.join(here, "..", "dist", "client.js")];
  return candidates.find((candidate) => existsSync(candidate)) ?? candidates[0];
})();

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

  const stamping = options.stampSource ?? true;
  const bridging = options.bridge ?? true;
  const inspector =
    options.inspector === false
      ? null
      : {
          hotkey: (typeof options.inspector === "object" && options.inspector.hotkey) || "alt+shift+c",
          button: typeof options.inspector === "object" ? options.inspector.button !== false : true,
        };
  const injecting = inspector !== null || bridging;
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
    config(config, env) {
      if (env.command !== "serve" || !injecting) {
        return;
      }

      // The inspector imports three, and R3F's registry when the project has
      // R3F. Vite's start-up scan reads the application's own code, and an
      // application whose code imports only R3F never names three itself —
      // so the inspector's import was discovered late, after the first page
      // had loaded, and Vite re-optimised and reloaded the page. Measured in
      // a freshly created app. Naming both up front puts them in the first
      // optimisation. Only what is installed is named, so a project without
      // R3F gets no "failed to resolve" warning.
      const root = path.resolve(config.root ?? process.cwd());
      const include = ["three", "@react-three/fiber"].filter((name) => isInstalled(root, name));
      return include.length > 0 ? { optimizeDeps: { include } } : undefined;
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
      // A dependency's JSX is the dependency's: its paths would be outside
      // the project and its values nothing a developer edits.
      if (id.includes("/node_modules/")) {
        return null;
      }

      // An empty module is a file caught mid-write by the watcher, not a
      // compiled one; there is nothing to warn about, and the next change
      // event brings the real contents.
      if (code.trim() === "") {
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

    transformIndexHtml: {
      order: "pre",
      handler(_html, context) {
        // Dev only. In a build there is no dev server to answer the inspector
        // or the bridge, and nothing should reach a visitor.
        if (!context.server || !injecting) {
          return;
        }

        // A module script at the very top of <head>. Module scripts run in
        // document order, so the inspector is listening on three's devtools
        // hook before the application constructs its first renderer.
        return [
          {
            tag: "script",
            attrs: { type: "module", src: `/@id/__x00__${CLIENT_MODULE_ID}` },
            injectTo: "head-prepend" as const,
          },
        ];
      },
    },

    resolveId(id) {
      return id === CLIENT_MODULE_ID ? RESOLVED_CLIENT_ID : null;
    },

    async load(id) {
      if (id !== RESOLVED_CLIENT_ID) {
        return null;
      }

      // R3F's registry of canvases, when the project has R3F. Imported here,
      // in the application's module graph, so it is the application's own
      // copy — the one holding its canvases.
      const r3f = await this.resolve(
        "@react-three/fiber",
        path.join(resolvedConfig.root, "index.html")
      ).catch(() => null);

      const clientOptions = {
        inspector: inspector !== null,
        bridge: bridging,
        hotkey: inspector?.hotkey ?? "alt+shift+c",
        button: inspector?.button ?? false,
      };

      // The bundled inspector's own source, served as this virtual module
      // rather than imported from inside node_modules.
      //
      // The difference is which three it gets. Imported from its file in
      // node_modules, the bundle is a dependency Vite has not pre-bundled,
      // and its `import "three"` resolved to three's raw module while the
      // application had the pre-bundled one: two copies of three in one page,
      // and three's own "Multiple instances" warning in every project that
      // installed the plugin. This repository's example never showed it,
      // because there the plugin is a workspace symlink, which Vite treats as
      // source. As a virtual module the code is source in every project, so
      // its imports resolve exactly as the application's do.
      // The bundle's own sourcemap comment would point the browser at a .map
      // beside the virtual module, which does not exist; the map is returned
      // with the code instead.
      const client = readFileSync(CLIENT_FILE, "utf8").replace(
        /\/\/# sourceMappingURL=\S+\s*$/,
        ""
      );
      const mapFile = `${CLIENT_FILE}.map`;
      const map = existsSync(mapFile) ? readFileSync(mapFile, "utf8") : null;

      return {
        // Appended after the bundle, so the bundle's sourcemap still lines up.
        code: [
          client,
          r3f ? `import * as __ctsR3F from "@react-three/fiber";` : "const __ctsR3F = null;",
          `startDevtools({ hot: import.meta.hot, r3fRoots: __ctsR3F ? __ctsR3F._roots : null, options: ${JSON.stringify(clientOptions)} });`,
        ].join("\n"),
        map,
      };
    },

    configureServer(server) {
      // Announce the server once it is listening, so the MCP server can find
      // it without being configured. Its address is known only then:
      // resolvedUrls is null at the httpServer "listening" event and is
      // assigned only after listen() resolves, so listen() itself is wrapped.
      const listen = server.listen.bind(server);
      server.listen = async (...args: Parameters<typeof server.listen>) => {
        const listening = await listen(...args);
        const origin = server.resolvedUrls?.local[0];
        if (origin) {
          const withdraw = announceDevServer({
            origin: new URL(origin).origin,
            root: resolvedConfig.root,
            version: PLUGIN_VERSION,
          });
          server.httpServer?.once("close", withdraw);
        }
        return listening;
      };

      if (bridging) {
        server.httpServer?.on("close", () => hub.dispose());

        // The injected inspector's transport: Vite's own HMR websocket, which
        // is already open to every page and refuses a browser on a foreign
        // origin. It does admit a client that sends no Origin at all, which
        // under `vite --host` includes the network, so the same loopback rule
        // as the HTTP endpoints applies to who may register as a page.
        // A page is keyed by its socket, so a repeat hello after a reconnect
        // replaces it, and the socket closing removes it.
        const remoteAddresses = new WeakMap<object, string | undefined>();

        server.ws.on("connection", (socket: object, request?: IncomingMessage) => {
          remoteAddresses.set(socket, request?.socket?.remoteAddress);
        });

        server.ws.on(BRIDGE_HELLO_EVENT, (data, client) => {
          const hello = (data ?? {}) as { session?: unknown; url?: unknown };
          const socket = (client as { socket?: { once?: (e: string, f: () => void) => void } })
            .socket;
          const key = socket ?? client;

          if (
            !requestOptions.allowRemote &&
            !isLoopbackAddress(remoteAddresses.get(key as object))
          ) {
            return;
          }

          hub.attach(
            { send: (envelope) => client.send(BRIDGE_QUERY_EVENT, envelope) },
            {
              key,
              session: typeof hello.session === "string" ? hello.session : null,
              url: typeof hello.url === "string" ? hello.url : "unknown",
            }
          );
          socket?.once?.("close", () => hub.detach(key));
        });

        server.ws.on(BRIDGE_REPLY_EVENT, (data) => {
          hub.handleReply((data ?? {}) as { requestId?: string; result?: unknown });
        });
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
                  "The scene bridge is off. Remove bridge: false from " +
                  "clickToSource() in the Vite config.",
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

        if (pathname === OPEN_IN_EDITOR_PATH) {
          void handleOpenRequest(
            request,
            response,
            resolvedConfig.root,
            fileOptions(),
            (file, line, column) => {
              // launch-editor picks the editor from LAUNCH_EDITOR, EDITOR or the
              // running processes, and reports a failure to the terminal.
              launchEditor(`${file}:${line}:${column}`);
            }
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

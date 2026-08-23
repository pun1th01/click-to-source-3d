import { READ_FILE_PATH, WRITE_FILE_PATH } from "@click-to-source/shared";
import type { Plugin, ResolvedConfig } from "vite";
import { handleFileRequest } from "./middleware.js";

/**
 * Serves the source read/write endpoints the Click-to-Source overlay calls.
 *
 * Dev-server only — `apply: "serve"` keeps it out of production builds.
 * Source paths in requests are resolved relative to Vite's own `root`, which
 * is also what `SourceRef.file` values are expected to be relative to.
 */
export function clickToSource(): Plugin {
  let resolvedConfig: ResolvedConfig;

  return {
    name: "click-to-source",
    apply: "serve",
    configResolved(config) {
      resolvedConfig = config;
    },
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        let pathname: string;

        try {
          pathname = new URL(request.url ?? "/", "http://localhost").pathname;
        } catch {
          next();
          return;
        }

        if (pathname === READ_FILE_PATH) {
          void handleFileRequest(
            request,
            response,
            resolvedConfig.root,
            "read"
          );
          return;
        }

        if (pathname === WRITE_FILE_PATH) {
          void handleFileRequest(
            request,
            response,
            resolvedConfig.root,
            "write"
          );
          return;
        }

        next();
      });
    },
  };
}

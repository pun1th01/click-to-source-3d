import { READ_FILE_PATH, WRITE_FILE_PATH } from "@click-to-source/shared";
import type { Plugin, ResolvedConfig } from "vite";
import {
  DEFAULT_ALLOWED_EXTENSIONS,
  handleFileRequest,
  type FileRequestOptions,
} from "./middleware.js";

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
  };

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
            "read",
            requestOptions
          );
          return;
        }

        if (pathname === WRITE_FILE_PATH) {
          void handleFileRequest(
            request,
            response,
            resolvedConfig.root,
            "write",
            requestOptions
          );
          return;
        }

        next();
      });
    },
  };
}

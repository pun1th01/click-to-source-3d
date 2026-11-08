/**
 * The bridge entry point, for supplying your own transport.
 *
 * `@click-to-source-3d/vite-plugin` answers over Vite's own websocket, which
 * is the supported path and needs nothing from here. This subpath exists for
 * the case that does not fit: a different dev server, an existing socket, an
 * embedded viewer. Attach a scene with `setBridgeScene()` from the package
 * root, then hand each incoming query to `answerBridgeQuery` and return what
 * it gives you.
 *
 * The query and result shapes are the `BridgeQuery` type in
 * `@click-to-source-3d/shared`. This is the same function the built-in channel
 * calls, so a custom transport answers exactly as it does.
 */
export { answerBridgeQuery } from "./bridgeClient.js";

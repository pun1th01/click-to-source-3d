/**
 * Reachable internals, carrying no stability guarantee.
 *
 * Everything here is exported so that something outside this module can call
 * it — a test driving the shipped path, or a consumer supplying its own
 * transport instead of the SSE channel the plugin provides. None of it is
 * covered by the package's version contract, and it may change or disappear
 * in a patch release.
 *
 * The public API is the package root. If you find yourself importing this
 * subpath to do something ordinary, that is a gap in the root export worth
 * reporting rather than a pattern to build on.
 */
export { answerBridgeQuery } from "./bridgeClient.js";
export { hasInstanceRecords } from "./instanceCapture.js";

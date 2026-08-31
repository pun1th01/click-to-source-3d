/**
 * The public API of @click-to-source-3d/core.
 *
 * Named explicitly rather than re-exported wholesale. Publishing turns
 * whatever appears here into a contract, and `export *` would promise every
 * symbol these modules happen to expose — including ones that exist only so
 * a sibling module or a test can reach them.
 *
 * Supplying your own bridge transport instead of the one the Vite plugin
 * serves is the `@click-to-source-3d/core/bridge` subpath.
 */
export { resolveSourceRef, resolveObjectAtPoint } from "./resolver.js";
export type { ResolutionResult } from "./resolver.js";

export {
  installInstanceProbe,
  getProbeStats,
  getInstanceRecord,
  instanceSourceRefFrom,
} from "./instanceCapture.js";
export type { InstanceRecord, ProbeStats } from "./instanceCapture.js";

export {
  setBridgeScene,
  getBridgeGeneration,
  connectBridge,
} from "./bridgeClient.js";

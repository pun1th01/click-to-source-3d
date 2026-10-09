/**
 * Framework-free building blocks for an inspector UI.
 *
 * Shared by the inspector the Vite plugin injects and by the React components
 * in `@click-to-source-3d/overlay`, so the two describe, highlight, pick and
 * edit an object the same way. Nothing here touches the DOM beyond a canvas's
 * bounding rect, and nothing depends on React.
 */
export { describeMesh } from "./meshDetails.js";
export type { GeometryDetails, MaterialDetails, MeshDetails } from "./meshDetails.js";

export {
  editSourceFile,
  editSourceAt,
  readSourceFile,
  SourceEditTransportError,
} from "./sourceEditClient.js";
export type { SourceEditFetch } from "./sourceEditClient.js";

export { HighlightLayer, attachHighlight, boxMatrixFor } from "./highlight.js";
export type { HighlightKind, HighlightTarget } from "./highlight.js";

export { pickAt, ndcFromClient } from "./picking.js";
export type { Pick } from "./picking.js";

export { connectBridgeOverHot, setBridgeScene } from "./bridgeClient.js";
export type { HotChannel } from "./bridgeClient.js";

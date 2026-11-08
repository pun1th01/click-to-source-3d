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

export { measureObject } from "./meshStats.js";

export {
  editSourceFile,
  editSourceAt,
  editSourceMany,
  readSourceFile,
  SourceEditTransportError,
} from "./sourceEditClient.js";
export type { SourceEditFetch } from "./sourceEditClient.js";

export { HighlightLayer, attachHighlight, boxMatrixFor } from "./highlight.js";
export type { HighlightKind, HighlightTarget } from "./highlight.js";

export { pickAt, ndcFromClient } from "./picking.js";
export type { Pick } from "./picking.js";

export { connectBridgeOverHot, setBridgeScene } from "./bridgeClient.js";
export type { BridgeExtension, HotChannel } from "./bridgeClient.js";

export {
  allPropsOf,
  ctsCall,
  ctsEnter,
  ctsLeave,
  ctsLoadAsync,
  ctsNew,
  ctsOnLoad,
  ctsSite,
  ctsVia,
  describeValue,
  generatorsOf,
  partsOf,
  recordOf,
  stampOf,
} from "./trace.js";
export type { CallSite, ObjectPart } from "./trace.js";

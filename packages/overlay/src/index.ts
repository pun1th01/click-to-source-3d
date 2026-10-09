export * from "./hooks/useClickToSource.js";
export * from "./store/overlayStore.js";
export * from "./components/SelectionHighlight.js";
export * from "./components/GenerationTrace.js";
export * from "./components/ClickToSourceBridge.js";
// Moved to core so the injected inspector can share it; re-exported so
// existing imports from this package keep working.
export {
  editSourceFile,
  readSourceFile,
  SourceEditTransportError,
  type SourceEditFetch,
} from "@click-to-source-3d/core/devtools";

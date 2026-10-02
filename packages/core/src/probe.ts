import { installInstanceProbe } from "./instanceCapture.js";

/**
 * Former side-effect entry that installed the instance capture probe.
 *
 * Instance transforms are now read live from `instanceMatrix` when an
 * instance is resolved, so nothing needs installing and importing this does
 * nothing. Kept so existing `import "@click-to-source-3d/core/probe"` lines
 * keep resolving.
 *
 * @deprecated Remove the import. This entry is removed in 0.2.0.
 */
installInstanceProbe();

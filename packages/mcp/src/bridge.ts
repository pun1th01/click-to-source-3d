import {
  BRIDGE_QUERY_PATH,
  type BridgeQuery,
  type ProvenanceAddress,
} from "@click-to-source-3d/shared";
import { postJson, type DevServerOptions } from "./devServer.js";

/**
 * Client half of the scene bridge.
 *
 * Every state the page can be in is reported rather than collapsed into a
 * timeout, because the remedy differs for each and an agent can only act on
 * a stated one:
 *
 *   disabled      bridge: true was never passed. Configuration, not runtime.
 *   disconnected  no page attached. Open the app. A full reload passes
 *                 through this state for ~23ms, measured, because the socket
 *                 close is observed before the replacement connects.
 *   ambiguous     more than one page. Naming which is the caller's choice,
 *                 not the server's — picking the first would make answers
 *                 depend on tab order.
 *   no_scene      page attached, nothing mounted. Wait, do not reopen.
 *   timeout       page attached but did not answer. Something is wrong in
 *                 the page, unlike disconnected.
 *   ready         answered.
 */

export type BridgeOutcome =
  | { status: "disabled"; reason: string }
  | { status: "disconnected" }
  | { status: "ambiguous"; pages: Array<{ pageId: number; url: string }> }
  | { status: "timeout"; pageId: number }
  | { status: "answered"; pageId: number; result: unknown };

async function ask(
  options: DevServerOptions,
  query: BridgeQuery,
  extra: { pageId?: number } = {}
): Promise<BridgeOutcome> {
  const payload = (await postJson(options, BRIDGE_QUERY_PATH, {
    query,
    ...extra,
  })) as BridgeOutcome;

  return payload;
}

/**
 * Resolves whatever is under a point in the running scene.
 *
 * Coordinates are normalised device coordinates, -1 to 1, because the bridge
 * has no idea what size the caller thinks the canvas is.
 */
export function resolveAtPoint(
  options: DevServerOptions,
  input: { x: number; y: number; pageId?: number }
): Promise<BridgeOutcome> {
  return ask(
    options,
    { kind: "resolve_at_point", x: input.x, y: input.y },
    { pageId: input.pageId }
  );
}

/**
 * Provenance for one addressed object, or one instance within it.
 *
 * Two failures are worth distinguishing, and both are reported rather than
 * returned as an empty result:
 *
 * A well-formed address can name the wrong thing — the shape is right but no
 * object matches. That comes back as `address_not_found` with the addresses
 * that do exist in the same file, so the caller can correct rather than
 * guess. A bare empty answer would be indistinguishable from "that object
 * carries no provenance".
 *
 * An instance slot can also have gone stale. If a mesh's instance count
 * shrank, the slots past the new count still render but their records belong
 * to a generation that is gone, and are indistinguishable from live ones by
 * (mesh, index) alone. The count-aware sweep in the capture registry drops
 * them, and this reports `instance_not_recorded` with the reason rather than
 * handing back the previous generation's transform.
 */
export function getInstanceProvenance(
  options: DevServerOptions,
  input: { address: ProvenanceAddress; pageId?: number }
): Promise<BridgeOutcome> {
  return ask(
    options,
    { kind: "get_instance_provenance", address: input.address },
    { pageId: input.pageId }
  );
}

/** Every stamped object currently in the scene, with its address. */
export function listSceneProvenance(
  options: DevServerOptions,
  input: { pageId?: number } = {}
): Promise<BridgeOutcome> {
  return ask(options, { kind: "list_scene_provenance" }, input);
}

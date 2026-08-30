/**
 * Placeholder for the browser bridge, which is not built.
 *
 * `resolve_at_point` is registered rather than omitted so an agent
 * discovers that object-level provenance exists as a capability and learns
 * why it cannot have it, instead of inferring from an absent tool that the
 * project has no such notion. The error is deliberately terminal: retrying
 * will not help until the bridge ships, and saying so is more useful than a
 * timeout that looks transient.
 *
 * When the bridge does exist it will answer with one of three states, and
 * they must stay distinguishable because the remedy differs for each:
 *
 *   disconnected        no page attached. A full reload tears the old socket
 *                       down before the new page connects, and close fires
 *                       synchronously, so this is known immediately rather
 *                       than waited for.
 *   connected_no_scene  page attached, nothing mounted yet. Wait.
 *   ready               resolvable.
 *
 * Collapsing those into a timeout would make "nobody is looking at the page"
 * indistinguishable from "the browser is busy". An agent can act on the
 * first and not the second.
 */
export type BridgeState = "unavailable" | "disconnected" | "connected_no_scene" | "ready";

export class BridgeUnavailableError extends Error {
  readonly state: BridgeState = "unavailable";

  constructor() {
    super(
      "Object-level provenance needs the browser bridge, which is not built. " +
        "Nothing outside the page can hold a THREE.Object3D, and the capture " +
        "registry is keyed by mesh identity rather than by any id an agent " +
        "could pass. Retrying will not help. Use list_provenance and " +
        "search_by_generator for the source-side view, which reports what the " +
        "code declares rather than what is currently rendered."
    );
    this.name = "BridgeUnavailableError";
  }
}

/** Always throws. Reserved so the capability is discoverable, not usable. */
export function resolveAtPoint(): never {
  throw new BridgeUnavailableError();
}

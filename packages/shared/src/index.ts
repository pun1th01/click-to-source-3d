/**
 * Represents the provenance metadata of a generated object.
 * This is the finalized v0.1 shape from Stage 2.
 */
export type SourceRef = {
  file: string;
  function: string;
  line: number;
  args: Record<string, unknown>;
  /**
   * Optional map from an `args` display key to the identifier as actually
   * declared in source. Required only when the two differ — e.g. a display
   * key of `waterLevel` for a constant declared `WATER_LEVEL`. Keys absent
   * from this map resolve to themselves, so omitting the field entirely
   * preserves the pre-existing behaviour.
   */
  argSources?: Record<string, string>;
  schemaVersion?: number;
};

/**
 * Per-instance provenance entry for InstancedMesh-based generators.
 *
 * Stored as `userData.instanceSourceRefs: InstanceSourceRef[]` on the
 * InstancedMesh, keyed 1:1 by Three.js instanceId.
 *
 * @see Stage 5 architecture addendum — docs/architecture/stage5-instanced-mesh-support.md
 */
export type InstanceSourceRef = {
  /** The provenance metadata for this specific instance. */
  sourceRef: SourceRef;
};

/**
 * The dev-server endpoints backing the source-edit round trip.
 *
 * Both halves of the contract import these: the browser client in
 * `@click-to-source-3d/overlay` and the dev-server plugin in
 * `@click-to-source-3d/vite-plugin`. A single definition is what keeps the two
 * sides from drifting apart silently — a mismatch leaves the panel able to
 * resolve provenance but unable to write anything back, with no error to
 * point at.
 *
 * These are the first runtime values in this package. Consumers that
 * previously erased their import of it entirely will now carry a real one.
 */
export const READ_FILE_PATH = "/__cts/read-file";
export const WRITE_FILE_PATH = "/__cts/write-file";

/**
 * A request to rewrite a single argument at a known source location.
 *
 * Produced by the overlay client from a {@link SourceRef}, consumed by the
 * editor in the dev-server plugin. `argName` is the identifier as declared
 * in source, which is not always the panel's display key — see
 * `SourceRef.argSources`.
 */
export type EditRequest = {
  file: string;
  line: number;
  argName: string;
  newValue: unknown;
};

/**
 * Why a source edit failed. Returned to the client as the `code` field
 * alongside the human-readable `error` message.
 */
export type SourceEditErrorCode =
  | "INVALID_REQUEST"
  | "PARSE_ERROR"
  | "ARGUMENT_NOT_FOUND"
  | "LOCATION_NOT_FOUND"
  | "AMBIGUOUS_LOCATION"
  | "UNSUPPORTED_VALUE";

/**
 * Location stamped onto `userData.__ctsSource` by the build-time transform in
 * `@click-to-source-3d/vite-plugin`.
 *
 * Carries only what a JSX element's own position can tell you. `args` is
 * absent by design: the transform knows where a call site is, not which of
 * its values are worth editing. A hand-written `sourceRef` supplies that,
 * and the resolver merges the two.
 */
export type SourceStamp = {
  file: string;
  function: string;
  line: number;
};

/**
 * A hand-written `userData.sourceRef` when a stamp is also present.
 *
 * Authors need only write the fields they are overriding — most often `args`
 * alone, letting file, function and line come from the stamp.
 */
export type PartialSourceRef = Partial<SourceRef>;

/**
 * Bridge transport paths.
 *
 * Three channels rather than a WebSocket. A socket would be the obvious
 * choice for request/response, but the only usable server implementation
 * would be a new dependency in `@click-to-source-3d/vite-plugin`, which
 * otherwise carries three. The lifecycle that matters here — close observed
 * before reconnect on a full reload — was measured on this transport and is
 * the same either way.
 */
export const BRIDGE_EVENTS_PATH = "/__cts/bridge/events";
export const BRIDGE_REPLY_PATH = "/__cts/bridge/reply";
export const BRIDGE_QUERY_PATH = "/__cts/bridge/query";

/**
 * Where a thing came from, as an address in source rather than an object
 * identity.
 *
 * `Object3D.uuid` is regenerated on construction, so a remount invalidates
 * every uuid an agent holds — measured at 8 distinct uuids becoming 11 after
 * one edit. An address derived from the stamped call site survives that,
 * because it changes only when the code changes.
 *
 * `ordinal` disambiguates the several meshes one JSX element can produce: a
 * map over colour groups yields three meshes all stamped at the same line,
 * in deterministic order.
 */
export type ProvenanceAddress = {
  file: string;
  function: string;
  line: number;
  ordinal: number;
  /** Present when addressing one instance within an InstancedMesh. */
  instanceId?: number;
};

/** Lifecycle of the page the bridge talks to. */
export type BridgeStatus =
  | "disconnected"
  | "no_scene"
  | "ambiguous"
  | "ready";

export type BridgeQuery =
  | { kind: "resolve_at_point"; x: number; y: number }
  | { kind: "get_instance_provenance"; address: ProvenanceAddress }
  | { kind: "list_scene_provenance" };

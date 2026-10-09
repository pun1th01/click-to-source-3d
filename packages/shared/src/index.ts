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
 * A request to rewrite a single value in a source file.
 *
 * Two modes, chosen by whether `column` is present.
 *
 * **By position** — `line`, `column` and `expected`. Names the literal itself:
 * the one starting at that line and column, whose source text must still be
 * `expected`. This is what the inspector sends for values the build step
 * found, since it knows exactly where each one is. If the file has changed so
 * that the position no longer holds that text, the edit is refused with
 * `STALE_LOCATION` rather than landing on something else.
 *
 * **By name** — `line` and `argName`. Finds a literal named `argName` whose
 * own line, or the line of an enclosing call, element or object, is `line`.
 * This is what a hand-written `sourceRef` and the MCP `edit_parameter` tool
 * send. `argName` is the identifier as declared in source, which is not
 * always the panel's display key — see `SourceRef.argSources`.
 */
export type EditRequest = {
  file: string;
  line: number;
  /** Required by name; descriptive only by position. */
  argName?: string;
  /** 1-based. Present for an edit by position. */
  column?: number;
  /** The literal's current source text. Required with `column`. */
  expected?: string;
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
  | "STALE_LOCATION"
  | "UNSUPPORTED_VALUE";

/** The dev-server endpoint that opens a file at a line in the editor. */
export const OPEN_IN_EDITOR_PATH = "/__cts/open";

/**
 * Where running dev servers announce themselves, under the OS temp directory.
 *
 * Each listening server writes one JSON file, a {@link DevServerEntry}, and
 * removes it on close. The MCP server reads them to find the dev server
 * without being told its address — which also covers a port Vite moved to
 * because the default was taken.
 */
export const DEV_SERVER_REGISTRY = "click-to-source/servers";

export type DevServerEntry = {
  /** e.g. http://localhost:5173 */
  origin: string;
  /** The Vite root: what stamped paths are relative to. */
  root: string;
  pid: number;
  /** The plugin's version. */
  version: string;
  startedAt: number;
};

/**
 * One value in a stamped prop: a literal the inspector can edit in place, or
 * an expression it can only show.
 */
export type StampedValue = {
  /** Source text: the literal as written, or the whole expression. */
  raw: string;
  /** The literal's value when the stamp was made. Absent for an expression. */
  value?: string | number | boolean | null;
  /** Whether `line` and `column` name a literal that can be rewritten. */
  editable: boolean;
  /** 1-based position of the literal. Present when editable. */
  line?: number;
  column?: number;
  /**
   * The constant the value was read through, when the prop names one —
   * `BOX_HEIGHT` in `args={[1.2, BOX_HEIGHT]}`. `line` and `column` then point
   * at the constant's declaration, which is where an edit has to land.
   */
  via?: string;
};

/**
 * One prop of a stamped element, or of a geometry or material inside it.
 *
 * Found by the build step, so values become editable without any
 * hand-written metadata. `values` has one entry for a scalar prop and one per
 * element for an array literal such as `position={[0, 1, 2]}`.
 */
export type StampedProp = {
  /** The element the prop is written on: `mesh`, `boxGeometry`, … */
  element: string;
  name: string;
  array: boolean;
  values: StampedValue[];
};

/**
 * Location stamped onto `userData.__ctsSource` by the build-time transform in
 * `@click-to-source-3d/vite-plugin`.
 *
 * `props` lists what the element's own position can tell about its values:
 * every literal prop, with where it is. It names nothing about meaning — which
 * values matter to a generator is still what a hand-written `sourceRef` says,
 * and the resolver merges the two.
 */
export type SourceStamp = {
  file: string;
  function: string;
  line: number;
  /** 1-based column of the element's opening `<`. */
  column?: number;
  props?: StampedProp[];
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
 * Bridge events on Vite's own HMR websocket, the transport the injected
 * inspector uses.
 *
 * That socket is already open to every page Vite serves, so riding on it
 * costs nothing per tab — unlike the EventSource above, which holds an extra
 * HTTP connection open and, over HTTP/1.1, counts against the browser's limit
 * of six per host. The three paths above remain for `<ClickToSourceBridge />`
 * until 0.2.0.
 *
 * A page announces itself with HELLO, receives questions as QUERY, and
 * answers each with REPLY carrying the same `requestId`.
 */
export const BRIDGE_HELLO_EVENT = "cts:bridge:hello";
export const BRIDGE_QUERY_EVENT = "cts:bridge:query";
export const BRIDGE_REPLY_EVENT = "cts:bridge:reply";

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

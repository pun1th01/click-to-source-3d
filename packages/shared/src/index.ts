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
 * `@click-to-source/overlay` and the dev-server plugin in
 * `@click-to-source/vite-plugin`. A single definition is what keeps the two
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
 * `@click-to-source/vite-plugin`.
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

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

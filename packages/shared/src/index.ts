/**
 * Represents the provenance metadata of a generated object.
 * This is the finalized v0.1 shape from Stage 2.
 */
export type SourceRef = {
  file: string;
  function: string;
  line: number;
  args: Record<string, unknown>;
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

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

# @click-to-source-3d/shared

Type definitions and protocol constants shared across
[Click-to-Source 3D](https://github.com/pun1th01/click-to-source-3d).

No runtime behaviour — types, plus the string constants naming the dev-server
endpoints. You will not normally install this directly; it arrives as a
dependency of the other packages.

## What is in it

`SourceRef` — the provenance record: `file`, `function`, `line`, and the `args`
that produced an object.

`SourceStamp` — the location half alone, written by automatic stamping.

`ProvenanceAddress` — how an object is named across a process boundary:
`{ file, function, line, ordinal }`, plus `instanceId` for one instance inside
an `InstancedMesh`. Derived from source rather than `Object3D.uuid`, which is
regenerated on every remount.

`EditRequest` and `SourceEditErrorCode` — the source-edit contract.

Endpoint constants for the read, write and bridge channels.

## License

MIT

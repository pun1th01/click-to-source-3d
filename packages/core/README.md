# @click-to-source-3d/core

Provenance resolution for Three.js objects: given a rendered object, find the
source location and arguments that produced it.

Browser-pure, no framework dependency. Part of
[Click-to-Source 3D](https://github.com/pun1th01/click-to-source-3d).

Most users do not install this directly — it arrives with
[`@click-to-source-3d/overlay`](https://www.npmjs.com/package/@click-to-source-3d/overlay).
Install it alone if you are on plain Three.js, or building your own UI.

## Install

    npm install @click-to-source-3d/core

`three` is a peer dependency (`>=0.170.0`).

## Use

    import { resolveSourceRef } from "@click-to-source-3d/core";

    const resolved = resolveSourceRef(object, instanceId);
    // -> { object, sourceRef: { file, function, line, args }, readonly }

Provenance comes from either source: `userData.sourceRef`, written by hand, or
`userData.__ctsSource`, stamped automatically by
[`@click-to-source-3d/vite-plugin`](https://www.npmjs.com/package/@click-to-source-3d/vite-plugin).
A manual ref wins over a stamp, field by field, so you can correct one value
without giving up automatic location.

### Instances

`InstancedMesh` instances have no objects of their own. When one is resolved,
its transform is read from the mesh's instance buffer and reported as `x`,
`y`, `z`, `scale` and `yaw`, under the location of the mesh itself. Nothing
needs installing, and it works however the matrices were written.

`@click-to-source-3d/core/probe`, which used to install a capture probe, is now
a no-op kept so existing imports resolve. Remove the import.

## Limits

**Instanced provenance is read-only.** A transform placed by a seeded RNG has
no corresponding literal in source.

**Variant-class values cannot be recovered.** A transform holds `x`, `y`, `z`,
`scale` and `yaw`. Anything not in it — colour group, species, material
variant — is not recoverable from the mesh. Write
`userData.instanceSourceRefs` by hand if you need it.

## Subpaths

    @click-to-source-3d/core         the public API
    @click-to-source-3d/core/probe   deprecated no-op, removed in 0.2.0
    @click-to-source-3d/core/bridge  answer bridge queries over your own transport

The `bridge` subpath is only needed if the SSE channel the Vite plugin serves
does not fit your setup. Attach a scene with `setBridgeScene()`, then pass each
incoming query to `answerBridgeQuery` — the same function the built-in channel
calls, so a custom transport answers identically.

## License

MIT

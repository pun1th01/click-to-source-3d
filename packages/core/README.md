# @click-to-source/core

Provenance resolution for Three.js objects: given a rendered object, find the
source location and arguments that produced it.

Browser-pure, no framework dependency. Part of
[Click-to-Source 3D](https://github.com/pun1th01/click-to-source-3d).

Most users do not install this directly — it arrives with
[`@click-to-source/overlay`](https://www.npmjs.com/package/@click-to-source/overlay).
Install it alone if you are on plain Three.js, or building your own UI.

## Install

    npm install @click-to-source/core

`three` is a peer dependency (`>=0.170.0 <0.180.0`).

## Use

    import { resolveSourceRef } from "@click-to-source/core";

    const resolved = resolveSourceRef(object, instanceId);
    // -> { object, sourceRef: { file, function, line, args }, readonly }

Provenance comes from either source: `userData.sourceRef`, written by hand, or
`userData.__ctsSource`, stamped automatically by
[`@click-to-source/vite-plugin`](https://www.npmjs.com/package/@click-to-source/vite-plugin).
A manual ref wins over a stamp, field by field, so you can correct one value
without giving up automatic location.

### Per-instance capture

`InstancedMesh` instances have no objects of their own. Install the probe
before any scene mounts and it records each write:

    import "@click-to-source/core/probe";

The Vite plugin injects this for you under `captureInstances: true`, ahead of
your entry module, because a probe that arrives after the first scene commits
captures nothing — and does so silently.

## Limits

**Instanced provenance is read-only.** A transform placed by a seeded RNG has
no corresponding literal in source.

**Variant-class values cannot be recovered.** The probe reads a `Matrix4`, so
it recovers `x`, `y`, `z`, `scale` and `yaw`. Anything not in the transform —
colour group, species, material variant — is not recoverable by capture. Write
`userData.instanceSourceRefs` by hand if you need it.

**Stale instance slots are dropped, not guessed.** If a mesh's instance count
shrinks, the abandoned slots still render and their records are
indistinguishable from live ones by index alone. They are discarded, because
confident wrong provenance is worse than none.

## Subpaths

    @click-to-source/core           the public API
    @click-to-source/core/probe     installs the instance capture probe
    @click-to-source/core/internal  reachable internals, no stability guarantee

## License

MIT

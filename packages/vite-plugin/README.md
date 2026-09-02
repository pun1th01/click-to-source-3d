# @click-to-source-3d/vite-plugin

The dev-server half of [Click-to-Source 3D](https://github.com/pun1th01/click-to-source-3d):
source read/write endpoints, build-time JSX source stamping, and the scene
bridge an agent talks to.

Dev only. Every feature is off by default.

## Scope

**Vite, and React Three Fiber.** Source stamping is a JSX transform, so it
applies to `.jsx`/`.tsx`. The endpoints it serves are consumed by
[`@click-to-source-3d/overlay`](https://www.npmjs.com/package/@click-to-source-3d/overlay)
and [`@click-to-source-3d/mcp`](https://www.npmjs.com/package/@click-to-source-3d/mcp).

## Install

    npm install -D @click-to-source-3d/vite-plugin

## Use

    import { clickToSource } from "@click-to-source-3d/vite-plugin";
    import react from "@vitejs/plugin-react";

    export default defineConfig({
      plugins: [
        clickToSource({
          stampSource: true,      // write source locations into userData
          captureInstances: true, // per-instance transforms for InstancedMesh
          bridge: true,           // let an agent query the running scene
        }),
        react(),
      ],
    });

### Options

| option | default | what it does |
|---|---|---|
| `stampSource` | `false` | Stamps `file`/`function`/`line` into `userData.__ctsSource` for each JSX element that becomes an object. Skips DOM and SVG tags, and `*Geometry`/`*Material`. |
| `captureInstances` | `false` | Injects a probe that records per-instance transforms from `InstancedMesh` writes. Must run before any scene mounts, which is why the plugin injects it rather than asking you to import it. |
| `bridge` | `false` | Opens the scene-bridge endpoints. Also needs `<ClickToSourceBridge />` inside your `Canvas`. |
| `allowedExtensions` | source types | Which file extensions the editor may read and write. |
| `allowedOrigins` | dev origins | Origin allowlist for the write endpoint. |

## Endpoints

All are dev-server only and absent unless the matching option is set.

    /__cts/read-file      /__cts/write-file
    /__cts/bridge/events  /__cts/bridge/reply  /__cts/bridge/query

## Limits

**Stamping is per JSX element.** An object created in a loop inside a component
gets that component's call site, not a distinct one per object. Several meshes
from one element are told apart by an `ordinal`, assigned in scene-traversal
order.

**The bridge answers only while the page renders.** R3F does not render
`Canvas` children in a hidden tab, so a backgrounded page reports
`disconnected` — indistinguishable from no page being open.

**Editing is per-argument and literal-only.** The AST editor rewrites a named
argument's literal. It fails with `ARGUMENT_NOT_FOUND`, `LOCATION_NOT_FOUND` or
`AMBIGUOUS_LOCATION` rather than editing the wrong thing.

## License

MIT

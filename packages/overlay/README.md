# @click-to-source-3d/overlay

React Three Fiber components for inspecting a running scene: click a mesh, see
the source location and the arguments that produced it, edit those arguments in
place.

Part of [Click-to-Source 3D](https://github.com/pun1th01/click-to-source-3d).

## Scope

**React Three Fiber only.** The overlay is React, `<SelectionHighlight />` and
`<ClickToSourceBridge />` need the R3F tree, and automatic source stamping is a
JSX transform. Plain Three.js can use `@click-to-source-3d/core` directly with
hand-written `userData.sourceRef`, but the experience described here is R3F.

Vite is required for the dev-server half — see
[`@click-to-source-3d/vite-plugin`](https://www.npmjs.com/package/@click-to-source-3d/vite-plugin).

## Install

Two installs bring four packages; `core` and `shared` arrive as dependencies.

    npm install @click-to-source-3d/overlay
    npm install -D @click-to-source-3d/vite-plugin

## Wiring

Five things go into your app.

**1. The plugin, before `react()`** — both declare `enforce: "pre"`, and
`react()` leaves no JSX to stamp:

    // vite.config.js
    plugins: [clickToSource({ stampSource: true, captureInstances: true }), react()]

**2. Resolve a click** and put the result in the store:

    const resolveClick = useClickToSource();

    const handlePointerUp = (e) => {
      e.stopPropagation();
      const resolved = resolveClick(e);
      resolved
        ? useOverlayStore.getState().select(resolved)
        : useOverlayStore.getState().clearSelection();
    };

**3. `<SelectionHighlight />`** — inside the `Canvas`. It outlines the selection.

**4. `<GenerationTrace />`** — outside the `Canvas`. It renders DOM, not scene
objects, and shows the file, function, line and editable arguments.

**5. `<ClickToSourceBridge />`** — inside the `Canvas`, only if you want the
agent tools in [`@click-to-source-3d/mcp`](https://www.npmjs.com/package/@click-to-source-3d/mcp)
to query the live scene.

## Limits worth knowing before you adopt it

**Instanced provenance is read-only.** An instance's transform comes from
whatever placed it — usually a seeded RNG — so there is no literal in your
source to rewrite. The panel shows the values and refuses to edit them.

**Variant-class values cannot be recovered.** Automatic capture reads a
`Matrix4`, so it recovers `x`, `y`, `z`, `scale` and `yaw` and nothing else.
Which colour group, species or material variant an instance belongs to is not
in the transform and is gone. Capture recovers *placement*, not
*classification*. If you need the classification, keep writing
`userData.instanceSourceRefs` by hand.

**Selection highlighting is mesh-wide for instanced meshes.** Clicking one
instance outlines every instance in that `InstancedMesh`. Resolution is
per-instance and correct; only the outline is coarse.

**`<SelectionHighlight />` takes over the render loop.** It draws through
`useFrame` at priority 1, which makes R3F hand rendering to it. It will not
compose with other post-processing that also claims a priority. Under
`frameloop="demand"` it works — it requests a frame when the selection
changes. Under `frameloop="never"` it cannot, and warns once in development.

**`<ClickToSourceBridge />` answers only while the page renders.** R3F does not
render `Canvas` children in a hidden or background tab, so a backgrounded page
reports `disconnected`, indistinguishable from no page at all.

## License

MIT

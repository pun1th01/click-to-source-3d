# @click-to-source-3d/vite-plugin

The one package [Click-to-Source 3D](https://github.com/pun1th01/click-to-source-3d)
needs. In development it stamps every three.js element in your JSX with where
it came from, injects an inspector into the page, and serves the endpoints the
inspector and AI coding assistants use. In a build it does nothing.

## Install

Needs Node 20.19+, Vite 6–8, React Three Fiber 9 and three.js 0.170+.

The quickest way is the setup command. Run it in your app's folder; it does
all of the below:

    npx click-to-source-3d init

Or by hand. Install the plugin as a dev dependency (`pnpm add -D`,
`yarn add -D` and `bun add -d` work too):

    npm install -D @click-to-source-3d/vite-plugin

Then add it to `plugins`, before or after `react()`:

```js
// vite.config.js (or .ts)
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { clickToSource } from "@click-to-source-3d/vite-plugin";

export default defineConfig({
  plugins: [clickToSource(), react()],
});
```

Start the dev server (`npm run dev`), open the app, press **Alt+Shift+C** or
the round button in the bottom-right corner of the canvas, and click
anything.

## Options

Every option is optional; `clickToSource()` on its own is the intended setup.

| option | default | what it does |
|---|---|---|
| `inspector` | `true` | The injected inspector. `false` turns it off. An object configures it: `{ hotkey: "alt+shift+c", button: true }`. |
| `stampSource` | `true` | Stamps each JSX element that becomes a three.js object with its file, component, line, column and literal props, into `userData.__ctsSource`. Skips DOM and SVG tags. `"always"` also stamps production builds, which publishes your file layout to visitors; you almost certainly do not want it. |
| `bridge` | `true` | Lets an out-of-process client — the MCP server an AI assistant runs — ask the open page about its scene, over Vite's own HMR websocket. |
| `allowRemote` | `false` | Serves the endpoints to callers beyond this machine. Turn on only on a network you control. |
| `allowedOrigins` | the dev server's | Extra browser origins allowed to call the endpoints. |
| `allowedExtensions` | source types | File extensions the endpoints may read and edit. |
| `captureInstances` | — | **Deprecated, no effect.** Instance transforms are read from the mesh. Removed in 0.2.0. |

## The inspector

Injected at the top of every page the dev server serves, before your app's
own scripts, through a virtual module; nothing is added to your code. It finds
your renderers through three.js's devtools hook (shared, not replaced, if the
three.js devtools extension installed it first), and R3F's registry when R3F is
present.

- **Inspect mode** — the hotkey or the button. Hover shows what is under the
  pointer; click selects. Clicks go to the inspector, drags still reach your
  camera controls. Esc leaves inspect mode, then closes the panel.
- **Highlight** — drawn after your frame by wrapping the renderer's own
  `render()`, so it composes with post-processing and never takes over the
  render loop. One instance of an `InstancedMesh` is highlighted on its own.
- **Panel** — the component, file and line with an Open button; every prop
  stamped on the element and its geometry and material, literals as editable
  fields; an instance's transform; mesh details. Enter saves a value.
- **Reloads** — inspect mode and the selection survive a full page reload,
  such as the one Vite does after an edit to your entry module.

`window.__CTS_DEVTOOLS__` exposes the inspector's state for tests:
`setInspecting`, `isInspecting`, `selection`, `describeAt`, `screenPointOf`,
`clear`.

## Endpoints

Dev server only. Each answers only to the page's own origin (or ones you
allow) and to programs on this machine, and only for allowed source files
inside Vite's `server.fs.allow` — in a monorepo, the workspace.

    /__cts/read-file     read a source file
    /__cts/write-file    rewrite one literal, by exact position or by name
    /__cts/open          open a file at a line in your editor
    /__cts/bridge/query  ask the open page about its scene

An edit by position names the literal's line, column and current text; if the
text there has changed, it is refused with `STALE_LOCATION`. Files are written
atomically, so Vite's watcher never reads one half-written.

`/__cts/open` uses [launch-editor](https://github.com/yyx990803/launch-editor),
as Vite's own error overlay does: set `LAUNCH_EDITOR` to choose the editor.

When the server starts listening it announces itself — origin, root, process —
in a file under the OS temp directory, which the MCP server reads to find it.
The file is removed when the server stops.

## Limits

**An element is a lowercase JSX tag.** A library component such as drei's
`<Box>` renders its elements inside the library, so its objects resolve to the
nearest element of yours around them.

**Editable means a literal**, or a constant declared once in the same file.
Anything computed is shown as code.

**Several objects from one element** — a `.map` over data — share its stamp
and are told apart by an `ordinal`, in scene-traversal order.

## License

MIT

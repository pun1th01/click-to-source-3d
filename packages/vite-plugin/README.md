# @click-to-source-3d/vite-plugin

The one package [Click-to-Source 3D](https://github.com/pun1th01/click-to-source-3d)
needs. In development it records where every three.js object comes from, in plain
code and in JSX, injects an inspector into the page, and serves the endpoints the
inspector and AI coding assistants use. In a build it does nothing.

## Install

Needs Node 20.19+, Vite 5–8 and three.js 0.150+. React Three Fiber 8 and 9 work too.

The quickest way is the setup command. Run it in your project; it does all of the
below, and more if you don't have Vite yet:

    npx click-to-source-3d init

Or by hand. Install the plugin as a dev dependency (`pnpm add -D`,
`yarn add -D` and `bun add -d` work too):

    npm install -D @click-to-source-3d/vite-plugin

Then add it to `plugins`, before or after `react()` if you have that:

```js
// vite.config.js (or .ts)
import { defineConfig } from "vite";
import { clickToSource } from "@click-to-source-3d/vite-plugin";

export default defineConfig({
  plugins: [clickToSource()],
});
```

A config that isn't one object can be wrapped, which works with anything Vite accepts:
an object, a function, an async function, or a promise.

```js
import { withClickToSource } from "@click-to-source-3d/vite-plugin";

export default withClickToSource(myConfig, { /* options */ });
```

Start the dev server (`npm run dev`), open the app, press **Alt+Shift+C** or
the round button in the bottom-right corner of the canvas, and click
anything.

## Options

Every option is optional; `clickToSource()` on its own is the intended setup.

| option | default | what it does |
|---|---|---|
| `inspector` | `true` | The injected inspector. `false` turns it off. An object configures it: `{ hotkey: "alt+shift+c", button: true }`. |
| `stampSource` | `true` | Records where objects come from. In JSX, it stamps each element that becomes a three.js object with its file, component, line, column and literal props, into `userData.__ctsSource`, skipping DOM and SVG tags. In plain code, see [Plain three.js](#plain-threejs). `false` turns off everything that touches your code. `"always"` also stamps JSX in production builds, which publishes your file layout to visitors; you almost certainly do not want it. |
| `bridge` | `true` | Lets an out-of-process client — the MCP server an AI assistant runs — ask the open page about its scene, over Vite's own HMR websocket. |
| `allowRemote` | `false` | Serves the endpoints to callers beyond this machine. Turn on only on a network you control. |
| `allowedOrigins` | the dev server's | Extra browser origins allowed to call the endpoints. |
| `allowedExtensions` | source types | File extensions the endpoints may read and edit. |

## Plain three.js

A `new THREE.Mesh()` has nowhere to put a stamp, and `userData` is your application's: it
ends up in `toJSON()` and in GLTFExporter's output. So when Vite serves a module for the
browser, the plugin adds calls around what makes objects, on the same line, and the records
go in a WeakMap beside the objects, which are left exactly as your code made them:

```js
const mesh = new THREE.Mesh(a, b);
// is served as
const mesh = __ctsNew(new THREE.Mesh(a, b), stamp);

mesh.clone();                  // __ctsNew(mesh.clone(), stamp)
loader.load(url, done);        // loader.load(url, __ctsOnLoad(done, stamp))
await loader.loadAsync(url);   // await __ctsLoadAsync(loader.loadAsync(url), stamp)
```

To know what to do with a module, it reads what it imports, once, across the project, and works
out which functions end up making objects, however many files away. Those record their calls
inside a `try`, so the record is right however they return, and a call to one notes where it was
made, which is what makes an argument written as a literal editable from the panel. It also lists
the helpers each function uses, and the numbers in them.

- **Left alone:** math types (`Vector3`, `Color` and the like, which code allocates in tight loops),
  the language's own classes, dependencies, type declarations, workers, a copy of three.js kept in the
  project, files over 1 MB, and anything Vite isn't serving for a browser: builds, server renders and
  test runners.
- **Class fields, subclasses, re-exports, aliases and namespaces** are followed.
- **`async` functions and generators** aren't recorded as calls, since they leave the stack at
  their first pause. What they make still has a source.
- **A script in a page** (`<script type="module">`) is recorded at its line in the page, and its
  values are edited there. A classic `<script src>` can't import anything, so it's left alone.

## The inspector

Injected at the top of every page the dev server serves, before your app's
own scripts, through a virtual module; nothing is added to your code. A module with
something to record imports it too, so it's there in a framework with no `index.html`. It
finds your renderers through three.js's devtools hook (shared, not replaced, if the
three.js devtools extension installed it first), and R3F's registry when R3F is
present. A `WebGPURenderer` is found too.

- **Inspect mode** — the hotkey or the button. Hover shows what is under the
  pointer; click selects. Clicks go to the inspector, drags still reach your
  camera controls. Esc leaves inspect mode, then closes the panel.
- **Highlight** — drawn after your frame by wrapping the renderer's own
  `render()`, so it composes with post-processing and never takes over the
  render loop. One instance of an `InstancedMesh` is highlighted on its own.
- **Picking** — what a click means is what can be seen. It skips materials that draw
  nothing, sees the layers the camera sees, and only counts a line or a point within a few
  pixels of it, so a `GridHelper` doesn't take every click near it. A click on a layer above
  the canvas, such as `CSS2DRenderer`'s, reaches the scene, and a control on the page keeps its click.
- **Panel** — the function, file and line with an Open button; **Called from**, the calls
  that led to the object with their values; every prop written for the object and its
  geometry and material, in any file, literals as editable fields; **Uses**, the helpers behind it,
  and the numbers in them; **Numbers**, the rest of the function's; an instance's transform;
  what the object costs to draw; mesh details.
- **Live preview** — a slider or a typed number or colour changes the live object at once,
  rebuilding a geometry from its `parameters` when the value is one of its `args`, unless your
  code has changed the geometry since, which a rebuild would lose. Nothing is written until
  Enter or Save, and Revert, Esc or selecting something else puts it back. Every field showing
  one constant moves together.
- **Pointer** — the pointer button, or Shift+click in inspect mode, marks objects
  for an AI assistant, which reads them through the MCP server's `get_selection`.
  The button shows only while an assistant is connected or something is marked.
- **Agent tab** — who is connected, what is pointed at, and every tool call. With no
  assistant connected, a **Turn on MCP server** button registers the server in
  `.mcp.json` at the repository's root, and in `.cursor/mcp.json` and `.vscode/mcp.json`
  where those folders exist, as `npx click-to-source-3d init --mcp` does. Calls
  are reported by the MCP server, and the dev server keeps the last 200 for a page
  that opens later.
- **Compare tab** — two pinned objects, or a pin and the selection, row by row.
- **Report and Image** — copy the object as Markdown, with a screenshot for targets
  that take rich text, or copy just the screenshot. Over plain http on another
  machine, where browsers offer no clipboard API, Report copies text only and
  Image is not available.
- **Reloads** — inspect mode, the selection, pins and what is pointed at survive a
  full page reload, such as the one Vite does after an edit to your entry module.

`window.__CTS_DEVTOOLS__` exposes the inspector's state for tests:
`setInspecting`, `isInspecting`, `selection`, `describeAt`, `screenPointOf`,
`clear`, `pointing`, `pins`, `looking`.

## Endpoints

Dev server only. Each answers only to the page's own origin (or ones you
allow) and to programs on this machine, and only for allowed source files
inside Vite's `server.fs.allow` — in a monorepo, the workspace.

    /__cts/read-file     read a source file
    /__cts/write-file    rewrite one literal, by exact position or by name,
                         or several at once, across files, all of them or none
    /__cts/open          open a file at a line in your editor
    /__cts/bridge/query  ask the open page about its scene
    /__cts/agent/report  an assistant saying it is here, and what it just did
    /__cts/mcp           whether the MCP server is registered for an assistant (GET),
                         and registering it (POST), for the Agent tab's button

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

**Editable means a literal**, or a constant declared once in the same file, or an
argument written as a literal at the call. Anything computed is shown as code.

**What reading the code can't follow is missing, not wrong.** A helper called through a
variable or a callback may not be listed.

**Several objects from one element** — a `.map` over data — share its stamp
and are told apart by an `ordinal`, in scene-traversal order.

## License

MIT

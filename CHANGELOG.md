# Changelog

All packages are versioned in lockstep.

## 0.2.0

The plugin now works with plain three.js, with nothing tagged by hand, and setting it up is one
command with nothing to do afterwards. This is the first version to support both three.js and
React Three Fiber.

### Plain three.js

- **Click any mesh and see the line that made it.** `new` anywhere in your project, in functions,
  classes, class fields and top-level code, in JavaScript and TypeScript, across files. Your objects
  have nothing added to them: not `userData`, and nothing in `toJSON()` or GLTFExporter's output.
- **Called from.** The calls that led to the object, with the values they were really given. An
  argument written as a literal can be edited from there, in whichever file the call is.
- **Uses.** The helpers behind the object, nested as they call each other: your noise function, what
  that calls, and functions from packages such as `simplex-noise` and three's own `ImprovedNoise`.
  Their numbers can be edited in their own files. What a function makes itself isn't listed: a ground
  plane doesn't "use" the rocks made on the next line.
- **Numbers.** Every other number in the function, by line. In top-level code, which has no function,
  the statements that use what the object was made from, so a loop that moves a geometry's vertices counts.
- **Properties, wherever they're written.** The arguments and options of its geometry and material,
  and what is set on the object afterwards: `position.set(...)`, `rotation.y = ...`, `scale.setScalar(...)`,
  even `cube.rotation.x += 0.01` in a loop at the other end of the file.
- **Clones and loaded models.** `mesh.clone()` is found where it was cloned. A click on part of a model is
  found at the `load`, `loadAsync` or `parse` that loaded it, and says which part. Selecting one survives a reload.
- **Scripts in a page.** `<script type="module">` is found at its line in the HTML file, and edited there.
- **Costs nothing it doesn't have to.** Math types aren't touched, so a tight loop is as fast as it was, and
  none of this reaches a build, a server render or a test runner.

### One command

`npx click-to-source-3d init` used to refuse or hand work back in several common cases. It no longer does:

- **No Vite config**, as `create-vite`'s vanilla template leaves you: it creates one.
- **No build tool, or no `package.json`:** it installs Vite and whatever else is missing, including the version
  of three.js your CDN link or import map names, and adds a `dev` script and, if needed, a page.
- **A monorepo's root, or a folder inside the app:** it finds the apps that use three.js and sets up each one.
- **Any config with an `export default`:** functions with several returns, `mergeConfig`, spreads and configs
  from other files are wrapped in the new `withClickToSource()`. `module.exports` works too.
- **An AI assistant in use:** its tools are set up without asking, including `.cursor/mcp.json` and
  `.vscode/mcp.json` where those folders exist.
- **A package manager that isn't installed:** it runs through `npx`.
- **Vite 5, three.js 0.150 and React Three Fiber 8** are now supported.

It also says clearly when it can't help: webpack, Next.js and others change nothing, and neither does a Vite older than 5
or a three.js older than 0.150, for which it gives the command that updates them.

### The inspector, for everyone

- **A click means what you can see.** It no longer finds meshes whose material draws nothing, sees the layers your
  camera sees, and a line or a point has to be within a few pixels. A `GridHelper` used to take every click within
  a world unit of it.
- **Clicks reach the scene through a layer on top of the canvas**, such as `CSS2DRenderer`'s, while a control on
  the page keeps its click.
- **Colours preview as you type them.** Before, a colour written as a number previewed as a shade of grey, because
  a colour has `setScalar` too.
- **Saving is all or nothing.** Several values go in one request, across any number of files, and if one is refused
  none is written. A save could otherwise be cut short by the page reload its first file caused.
- **Hex stays hex.** `0x88aa55` changed to red is written as `0xff0000`, not `16711680`.
- **`.ts` files parse as TypeScript**, not as JSX, where `<number>x` and `<T>(a) => a` are syntax errors.
- **The highlight's colours aren't changed by the application's tone mapping.**
- **A directive with no semicolon** (`"use client"` on its own line) no longer breaks the module.
- **Parts of an object stay selected through a reload.**
- **No errors in the console from clicking after the dev server has stopped.** Each click used to log one.
- **`WebGPURenderer` is found**, including through `renderAsync`, and through versions of three that don't announce it.
  So far this has only been tried through its WebGL backend.

### Turning on the MCP server from the panel

The Agent tab has a **Turn on MCP server** button. It registers the server where your
assistant reads its config, as `npx click-to-source-3d init --mcp` does, and then says how
to start the assistant. It doesn't need a terminal. Your assistant still starts the server
itself, so a running one has to be restarted to see it.

### Found by a checkup

The new code was run over all of three.js's own add-ons and source, over a thousand
files, and a sample of add-ons was run before and after with identical results. These
were found by that, by review, and by repeating the browser tests:

- **A name now means what it means where it is written.** A parameter called `onLoad` was
  taken for a function called `onLoad` elsewhere in the file, which could list a helper
  that isn't used, or offer the literal of another call to edit.
- **A call that never arrives leaves nothing behind.** If an argument threw, its note was
  left for a later call to the same function to take.
- **Arguments after a spread aren't matched to parameters**, a `...rest` parameter isn't
  offered as its first value, and an object's keys before a spread in it aren't trusted.
- **Nothing recorded can make the application's own call fail**, whatever it is passed: a
  value is described without running its getters, and a proxy whose traps throw is fine.
- **A save never loses track of the project.** Saving writes a temporary file, and its
  coming and going could make the next reload serve a module without its records.
- **Scripts in a page saved with Windows line endings** are read, as they weren't before.
- **A colour typed either way round is saved the way the code wrote it.** `#ff0000` for
  `0x88aa55` used to be refused, and `0xff0000` for `"#88aa55"` saved a colour three can't read.
- **`<primitive object={...}>`** shows where plain code made the object, and what it set on it.
- **A helper is listed once** in a report and in a comparison.
- **The Agent tab is current when shown**, rather than when something else changed.
- **`init` won't replace a `package.json` it can't read**, keeps its indent and line endings
  when it adds a script, and escapes a folder's name in a page it writes.

### Upgrading

Nothing changes in your config or your app, unless you still have one of these, which were already deprecated or
unused and are now gone:

- The `captureInstances` option.
- `<ClickToSourceBridge />` in `@click-to-source-3d/overlay`, and `connectBridge`. The plugin has done this since 0.1.5.
- `@click-to-source-3d/core/probe`, `installInstanceProbe` and `getProbeStats`. Instances have been read live since 0.1.5.
- The endpoints `/__cts/bridge/events` and `/__cts/bridge/reply`, which only those used.

## 0.1.6

Point at what you mean, and watch your assistant work. Mark one or more meshes in
the browser, go to your assistant and type "make these bigger". It sees exactly
which objects you mean, with the file, line and every editable value of each, and
everything it does shows up in the inspector as it happens.

### Upgrading

Update `@click-to-source-3d/vite-plugin`, and `@click-to-source-3d/mcp` if you use
it. They need to be on the same version. Nothing else changes.

### Added

**Pointing an assistant at objects.** The pointer button beside the inspect button,
which appears while an assistant is connected, turns on a mode where each click
marks an object. Shift+click does the same in inspect mode, and **Point** in the
panel marks the selection. Marked objects are outlined in amber, listed in order in
the Agent tab, and kept through a reload. One instance of an `InstancedMesh` can be
marked on its own. An assistant reads them with `get_selection`, and the server's
instructions tell it to do that when someone says "this" or "these".

**The Agent tab**, next to Inspect: which assistant is connected and when it last
made a call, and every tool call in plain words with its result, edits marked and
failures in red. Objects it asks about are outlined in violet for a moment. A line
of the log leads to its object, or to its source if the scene doesn't have it. The
log outlives a reload and is there for a page opened later.

**New MCP tools.**
- `get_selection`: what the developer is pointing at and has selected, each object
  with its source, every editable value with its exact position, its transform,
  materials and cost. Answered by the dev server from what the page last told it,
  so it works with the tab in the background and during a reload, and needs no
  `pageId`: the developer's latest gesture says which page they mean.
- `highlight_object`: outlines objects on the developer's screen, by file and line,
  for as long as the assistant asks.
- `get_canvas_screenshot`: a picture of the canvas, returned as an image, with any
  outlines. A WebGL canvas can only be read right after it is drawn, so this waits
  for the app's next frame. In a background tab, where none comes, it draws the
  scene once itself, and `via` says so.

`edit_parameter` also takes `column` and `expected`, the exact position
`get_selection` reports, so a value in an array like `position={[0, 1, 2]}` can now
be edited through it, and the edit appears in the log. It is refused with
`STALE_LOCATION` if the text there has changed.

**Live previews.** Every numeric value the scene can show gets a slider. Dragging it
or typing a number changes the live object straight away, with nothing written, and
a bar counts what is unsaved. Enter or **Save** writes it all, last in the file
first, so that a literal changing length cannot make the next position stale.
**Revert**, Esc or selecting something else puts the scene back. A geometry's `args`
preview by rebuilding it from its `parameters`, and R3F's own takes over after a
save. Every field showing one constant moves together, since saving any of them
changes them all.

**Performance section.** Triangles, draw calls, vertices, geometry memory, each
texture's size and estimated memory, whether it casts shadows, and its share of the
frame. `measureObject` in `@click-to-source-3d/core/devtools`.

**Pin and compare.** **Pin** an object, select another or pin two, and the Compare
tab shows them row by row with differences marked and an option to show only those.
Pins survive a reload.

**Copy as a bug report.** **Report** copies source, transform, values, cost and
environment as Markdown. Markdown text cannot hold a picture, so the screenshot
travels as the rich version of the same copy: a doc or chat gets it, and an issue
form gets the Markdown. **Image** copies just the screenshot.

### Changed

- The MCP server warns when it and the plugin are on different versions. They are
  installed separately, and the symptoms are otherwise strange.

### Fixed

- **The renderer's frame counters were wrong while anything was highlighted.** The
  highlight is drawn with a render call of its own, which reset `renderer.info`, so
  an FPS panel or r3f-perf reported the highlight's two boxes instead of your scene.
  They now keep describing your frame.

### Found by testing it

- An edit to an entry module could lose objects from the pointer list. The update
  unmounts everything before it remounts, and a refresh landing in that gap dropped
  whatever it couldn't find, then saved that. Objects now count as gone only after
  the last of three looks.
- Restoring after a reload gave up after 8 seconds even with no canvas yet, then
  saved an empty list over what it was looking for. Stopping a dev server mid-load
  did it. The clock now starts when there is a canvas.
- A reloaded list could come back in another order if objects mounted out of order.
- Any hot update, a stylesheet's included, redrew the panel and threw away a value
  being dragged. It now redraws only if that object's own source changed.
- An assistant's last report could arrive after its goodbye and bring it back as
  connected for 15 seconds.
- A tab that had just closed kept what it pointed at for a different page to inherit.
- A passing question from the assistant cut short an outline it had asked to keep.

### Repository

- `e2e/agent.spec.ts` drives the whole loop with a real MCP server: pointing, reading
  it back, editing through what came back, surviving the reload, the log, outlines,
  screenshots read back and checked for content, sliders, compare and the clipboard.
- New README screenshots, taken by the same script as the others.

## 0.1.5

One command, and nothing in your app. Until now, using Click-to-Source meant
about ten steps by hand: two installs, three plugin options, a click handler,
three components, a `Canvas` prop, and hand-written `sourceRef` metadata with
line numbers that had to be kept in sync. Now:

    npx click-to-source-3d init

Start the app, press **Alt+Shift+C**, click anything.

### Upgrading

Nothing breaks: 0.1.4 setups keep working. To simplify one:

- Update `@click-to-source-3d/vite-plugin`, and `@click-to-source-3d/mcp` if
  you use it.
- `clickToSource({ stampSource: true, bridge: true })` can become
  `clickToSource()`.
- Remove `<SelectionHighlight />`, `<GenerationTrace />`,
  `<ClickToSourceBridge />`, the click handler and `onPointerMissed`, then
  uninstall `@click-to-source-3d/overlay`.
- Drop `CTS_DEV_SERVER` and `CTS_PROJECT_ROOT` from your MCP config.

The README's "Upgrading from 0.1.4 or earlier" has the commands.

### Added

**`npx click-to-source-3d init`** — a new package, `click-to-source-3d`, run
with `npx` and never installed. It installs the plugin with the project's
package manager (npm, pnpm, yarn or bun, read from the lockfile, found above
the app in a monorepo), and adds `clickToSource()` to `vite.config`, editing
only those two places so the file's formatting survives. It recognises the
shapes Vite's templates and docs use, including a config written as a
function, and prints the two lines to paste for anything else rather than
guessing. It asks once whether to set up the MCP server; `--mcp` and
`--no-mcp` skip the question. Running it twice changes nothing.

The config editing is written against Babel rather than a config-editing
library: the library tried first reported success on a function-form config
while adding only the import, which would have left a project silently not
set up.

**The inspector, injected by the plugin.** No components, no handler.
- *Inspect mode*: Alt+Shift+C, or a button in the corner of the canvas.
  Hovering shows what is under the pointer and its file and line; clicking
  opens the panel. Clicks go to the inspector, not the app, and drags still
  orbit the camera. Esc leaves inspect mode, then closes the panel. The
  shortcut is ignored while typing and is configurable.
- *The highlight* is drawn after the app's own frame by wrapping the
  renderer's `render()`, so it never takes over the render loop, composes
  with post-processing, and keeps antialiasing. One instance of an
  `InstancedMesh` is highlighted on its own, not the whole mesh.
- *The panel* lives in a shadow root on `<html>`, outside React and out of
  reach of the app's CSS. It shows the component, file and line with an
  **Open** button, the element's props as editable fields, an instance's
  transform, and mesh details. Objects with no source say so, and name their
  parents.
- *Surviving a reload*: inspect mode and the selection come back after the
  full reload Vite does when an entry module changes.
- *Discovery* uses three.js's own `__THREE_DEVTOOLS__` hook — shared, not
  replaced, when the three.js devtools extension installed it first — plus
  R3F's registry of canvases.

**Editable values with nothing tagged by hand.** The stamp now records every
literal prop on an element, and on the geometry and material inside it, with
its exact line and column: `position={[0, 1, 2]}`, `args={[1, 2, 1]}`,
`color="#fff"`. A prop naming a constant declared once in the same file —
`args={[1.2, BOX_HEIGHT]}` — is followed to the declaration. Anything computed
is shown as code. Stamps are hoisted into one table per module and placed on
its first line, so no line of the module moves.

**Edits by exact position.** The write endpoint takes `line`, `column` and the
literal's current text, and refuses with the new `STALE_LOCATION` code if the
text there has changed. Edits by name, for hand-written refs and the MCP tool,
work as before. Files are written atomically: a plain write let Vite's
watcher read a half-written file, seen during this release's own end-to-end
test as a spurious "no JSX found" warning.

**Open in editor**: `POST /__cts/open`, guarded like the other endpoints, uses
launch-editor as Vite's error overlay does. Set `LAUNCH_EDITOR` to choose.

**The MCP server finds the dev server by itself.** The plugin announces its
address and root under the OS temp directory while it listens, and the MCP
server reads that on every call — so it works when the dev server starts
after the assistant, or on a port other than 5173. In a monorepo it picks the
dev server closest to where the assistant was started. A dead server's file
is cleared. `CTS_DEV_SERVER` and `CTS_PROJECT_ROOT` still override it.

**`@click-to-source-3d/core/devtools`**, the framework-free pieces the
inspector is built from: `pickAt`, `HighlightLayer`, `attachHighlight`,
`describeMesh`, `editSourceAt`, `connectBridgeOverHot`.

### Changed

- `clickToSource()` turns on stamping, the inspector and the bridge by
  default. `stampSource: true` and `bridge: true` are no longer needed.
- The bridge also runs over Vite's own HMR websocket, so it holds no extra
  connection per tab and can stay on. A hello from a non-loopback address is
  ignored unless `allowRemote` is set, matching the HTTP endpoints. The SSE
  transport remains for `<ClickToSourceBridge />` until 0.2.0.
- `resolve_at_point` returns the object's stamped props, with positions, so an
  assistant can edit what it finds.
- `<SelectionHighlight />` uses the same highlight as the inspector: no more
  `useFrame` priority, no more lost antialiasing, one instance at a time.
- `@click-to-source-3d/overlay` is legacy. Its components still work; the
  inspector notes once in the console that they can be removed.
- The example app has no click-to-source code in it at all.

### Fixed, found by setting up fresh apps

Both were invisible inside this repository, where the plugin is a workspace
symlink that Vite treats as source code.

- **Two copies of three.** Imported from its file in `node_modules`, the
  inspector's `import "three"` got three's raw module while the app had the
  pre-bundled one, and three logged "Multiple instances of Three.js being
  imported". The inspector is now served as the virtual module itself, so its
  imports resolve as the app's do.
- **A reload on first start.** An app whose code imports only R3F never names
  three, so Vite found the inspector's import late, re-optimised, and reloaded
  the page. The plugin now names `three` and `@react-three/fiber` for the
  first optimisation, when they are installed.

Verified by running `init` from packed tarballs in a new `create-vite` app with
the current three.js, R3F and Vite, under npm and under pnpm 12.

### Repository

- End-to-end tests with Playwright drive the example as a developer would:
  the hotkey, a click, an edit surviving the reload, the Open request, and an
  MCP server answering with no configuration. They run in CI on Chromium.
  Their first CI run caught a bug: an assistant asking in the first second
  after a page load was told there was no scene. The scene now reaches the
  bridge on the first frame.
- The README's screenshots are taken from the example by a Playwright script.
- The root package is renamed `click-to-source-3d-monorepo`, freeing the name
  for the CLI.
- The README gives the supported versions, complete step-by-step setup (by
  `init` and by hand, with a whole `vite.config`), where Cursor and VS Code
  keep their MCP config, upgrade steps, troubleshooting, and how to remove
  it. `init` no longer implies that Cursor reads `.mcp.json`; it points other
  assistants to those steps.
- Every published package links back to the repository from npm, and the
  plugin's npm description says what it does now.

## 0.1.4

Bug fixes in four of the five packages; `shared` moves with them by
convention. Upgrade if you use `InstancedMesh`, edit values from the panel,
load models with `<primitive>`, or work in a monorepo.

### Upgrading

Nothing breaks, but four things are worth doing:

- Remove `captureInstances` from `clickToSource()`. It now does nothing and
  warns once.
- Remove any `import "@click-to-source-3d/core/probe"`. It now does nothing.
- If your click handler is on `onPointerUp`, move it to `onClick` and return
  early when `e.delta > 2`. The README shows the new handler.
- If anything of yours posted `{ file, content }` to `/__cts/write-file`, it
  is now refused. Neither the panel nor the MCP server ever sent it.

### Fixed — `@click-to-source-3d/core`

**Instances placed the way the three.js docs teach now resolve.** The capture
probe paired each `setMatrixAt` write with an earlier `Matrix4.clone()`, so
`mesh.setMatrixAt(i, dummy.matrix)` — one shared matrix, every iteration —
captured 0 of 500 instances, with no warning. The transform is now read from
the mesh's `instanceMatrix` when an instance is resolved. On the same 500
instances that read agreed with the probe's records on every field. It also
covers matrices written straight into the buffer, needs nothing installed
before the scene mounts, and patches no prototypes.

`captureInstances` is now a deprecated no-op that warns once, and
`@click-to-source-3d/core/probe`, `installInstanceProbe` and `getProbeStats`
are kept only so existing code keeps compiling. All are removed in 0.2.0.
`instance_not_recorded` now has one cause, `instance_out_of_range`; the
probe-specific causes can no longer occur.

### Fixed — `@click-to-source-3d/vite-plugin`

**Save no longer rewrites the wrong literal.** Literals inside a hand-written
`sourceRef` were edit candidates. Write `args: { radius: 0.6 }` next to
`<sphereGeometry args={[0.6, 32, 32]} />` and Save rewrote the copy in the
metadata, reported success, and the sphere did not change. Anything under
`sourceRef` or `instanceSourceRefs` is now ignored, so that edit fails with
`ARGUMENT_NOT_FOUND` instead of changing the wrong value.

**A `<primitive>`'s own userData survives stamping.** The stamp was
`userData={{ __ctsSource }}`, which R3F applies by replacing userData. On
`<primitive object={gltf.scene} />` that discarded the model's glTF extras in
dev only, so an app reading them behaved differently in dev and production.
Elements without an explicit `userData` are now stamped with the pierced
prop `userData-__ctsSource`, which adds one key. An explicit `userData`
attribute still gets the merge, because piercing after it throws inside R3F
when the value is `null`, a string or frozen.

**A spread's userData no longer loses to the stamp.** The stamp was appended
after every attribute, so in `<mesh {...props} />` where `props` carries
userData, that userData was replaced outright, hand-written `sourceRef` and
all. Whether a spread carries userData is a runtime value, so the stamp is
now emitted before the first spread: a spread with userData wins, as manual
outranks stamped everywhere else, and one without it leaves the stamp alone.

**Components wrapped in `memo` or `forwardRef` are named.** They, and
anonymous default exports, were stamped `function: "unknown"`. Default
exports are named after their file (`Trees (default export)`, or the folder
for an `index` file).

**`<animated.mesh>` and `<motion.group>` are stamped.** Member-expression
elements whose last part is an R3F intrinsic were skipped entirely.

**Files in sibling workspace packages can be read and edited.** Paths were
contained to the Vite root, so in a monorepo a component stamped as
`../../packages/ui/src/Rock.tsx` was named by the panel and refused by the
endpoint. Containment now uses Vite's resolved `server.fs.allow`, which is
where Vite already serves source from.

### Security — `@click-to-source-3d/vite-plugin`

**The write endpoint accepts edits only.** It also accepted
`{ file, content }` and wrote the content verbatim, a whole-file overwrite of
any allowed source file that no client used. An edit could also carry
`content`, which was edited instead of the file on disk. That was the same
overwrite one step removed, and a lost update whenever the file changed
between the panel's read and its write. Whole-file writes are now refused. A
`content` field on an edit is ignored rather than refused, so a 0.1.3
overlay keeps working. Every edit applies to the file as it is on disk.

### Fixed — `@click-to-source-3d/overlay`

**The components do nothing in a production build.** Mounted
unconditionally, they shipped a live panel and a render-loop takeover. The
bridge also opened an `EventSource` to a dev-only endpoint, which the browser
retries indefinitely. Each now renders nothing when
`NODE_ENV === "production"`.

**`<SelectionHighlight />` no longer costs the app its antialiasing while
nothing is selected.** It rendered every frame through an `EffectComposer`
whose render target has no multisampling, so mounting it turned antialiasing
off for the whole application. With nothing selected it now makes the same
`gl.render(scene, camera)` call R3F would, so an unselected frame is the same
as one without the component. While something is selected, antialiasing is
still off; a multisampled target costs several hundred megabytes at retina
resolution.

**The panel no longer reads the file before each save.** It sends the edit
alone; see the write endpoint above.

**The documented click handler no longer selects on an orbit drag.** It used
`onPointerUp`, where R3F reports no pointer travel, so releasing a drag over
a mesh selected it. The README and example now use `onClick` and ignore
`e.delta > 2`.

### Fixed — `@click-to-source-3d/mcp`

The server reports its version from its own `package.json`, rather than a
literal that release bumps have to remember.

### Changed

- `vite-plugin` skips the Babel parse for modules with no lowercase JSX,
  measured at ~8 ms per 400-line module. Its sourcemaps use word-boundary
  resolution.
- `engines` is now `node >=20.19.0`, which Vite 7 and 8 require. CI runs
  Node 22 and 24.

### Repository

- `CONTRIBUTING.md` exists; the README linked to it, and to a code of
  conduct, that did not. The README now points at the Contributor Covenant.
- The example sets `"type": "module"`, which silences Vite's warning on every
  build. It also places its trees with the shared `dummy.matrix` loop, so the
  demo exercises the fixed path.

## 0.1.3

Only `mcp` and `vite-plugin` change behaviour; the other three move with
them by convention.

### Added — `@click-to-source-3d/mcp`

**`get_source` takes a line instead of a range.** A caller arriving from
`list_provenance` or a bridge resolve holds one line, and turning that into
a range was arithmetic it had no basis for. `around` centres a window on a
line, with `contextLines` either side, defaulting to 20. Explicit bounds
still win per edge, so a caller that did compute a range gets exactly that
range and one that computed a single edge gets the other centred.

Passing no bounds at all has always read the whole file. Nothing said so,
and the schema advertised `startLine` and `endLine`, so the description now
names it as the right default.

**`list_files`** answers the question an agent has before it can call
anything else: what is here. It reports names only, reads no contents, and
is deliberately not a file browser — it returns exactly the set the
provenance scan would read, so a file it does not list is a file no other
tool in this package can reach. The walk is now shared with the scanner
rather than duplicated, so the two cannot drift.

The 2000-file scan limit was previously silent, making a partial scan
indistinguishable from a complete one. `list_files` reports `truncated`.

### Fixed

**A failed source edit now says why it failed.** `editSource` has always
produced a specific reason — which argument, at which line, and since 0.1.2
the lines it is actually declared on — and the dev-server middleware
replaced all of it with the constant "Source edit failed" before sending.
Both halves of the product read `error` as the human-readable message, so
neither the panel nor an agent ever saw any of it. The 0.1.2 change that
added "declared at line N" improved a string that could not reach a caller.
`code` is unchanged and remains the field to branch on.

**`list_provenance` no longer implies a project has no provenance.** It
described itself as listing "every declared provenance site", which is
false in the configuration the README recommends: stamped locations live in
transformed output and the scanner cannot see them, so a `stampSource`-only
project got an empty array against a description promising completeness.
It now says an empty result means no hand-written `sourceRef`, names the
bridge tools that do see stamped objects, and points at `list_files`.

Teaching the scanner to read stamps is the real fix and is not a patch.

### Repository

These do not ship in any package.

**`npm run build` works on a clean clone.** There were no root scripts, so
the obvious command was `npm run build --workspaces`, which runs workspaces
alphabetically and builds `examples` before `vite-plugin` — and the
example's Vite config imports the plugin from its `dist`. Exit 1 before,
exit 0 after.

**CI runs the tests.** It previously ran `npm ci` and `npm ls --workspaces`
and nothing else: 166 tests existed and none executed anywhere. It now
builds and tests on ubuntu-latest and windows-latest across Node 20 and 22,
with skips reported by name on every platform rather than reduced to a
count.

Its first run found two tests that only agreed with the platform that wrote
them. One asserted Windows path separators through the ambient `path`
module, which is posix on Linux. The other is worse: the scanner's symlink
containment tests had never executed anywhere. `it.runIf` evaluates its
condition during collection and `beforeAll` runs after collection, so the
flag was always false when it was read — and a guard added to catch exactly
that read the flag at run time instead, and so reported on Linux that tests
which had been skipped had run. Until this release, deleting the symlink
check from the scanner would have left the suite green. Both tests now run
on the platforms that can run them.

## 0.1.2

### Fixed — install

**`three`'s upper version bound is gone.** `core` and `overlay` declared
`three: ">=0.170.0 <0.180.0"`. `three` is at `0.185.1`, so
`npm install @click-to-source-3d/overlay` failed outright with `ERESOLVE` for
anyone on a current version — on step one of the README, before any of this
tool ran at all. The ceiling was this project's own: `@react-three/fiber`
asks only for `>=0.156`.

The range is now `>=0.170.0`. Verified both ways rather than assumed: the
install that failed on `0.1.1` succeeds against `three@0.185.1`, and capture,
resolution and the raycast path were each exercised against `three` r185 in a
consumer outside this repository.

### Changed

**The provenance scanner no longer follows symlinks.** `collectSites` in
`@click-to-source-3d/mcp` is the only code in that package that reads the
filesystem directly; everything else goes through the dev server, which
resolves symlinks and re-checks containment before answering. Symlinked
directories were already skipped, but by accident rather than intent —
`readdir`'s `Dirent` reflects `lstat`, so `isDirectory()` is false for a link
and the recursion never saw one. Files had no such accident: a link named
`foo.ts` passed the extension test and `readFile` followed it, so a target
outside the project root would be scanned and reported under an in-root
relative path.

Scope, stated plainly: a site carries a path, a line, a function name and
argument names — never file contents — and the link has to be one the
developer put in their own project. This closes a difference between the two
paths' idea of what is in scope, not a demonstrated escape. It is a change of
intent into mechanism.

The two containment tests skip on platforms where creating a symlink needs
elevation, rather than passing vacuously.

### Fixed

**`LOCATION_NOT_FOUND` now names the lines the argument is declared on.**
It previously said only that the argument was not at the requested line,
which is the same message whether the line is stale or the name is not
editable at all. The panel hits this constantly and cannot get past it: it
sends `sourceRef.line`, naming the generator's call site, while a hoisted
constant's only location is its own declaration — so the `waterLevel` ->
`WATER_LEVEL` mapping that `argSources` exists to support fails every time,
and used to fail looking as though the argument did not exist.

This is a message change only. Which edits are accepted and which are
refused is byte-for-byte what it was: the same candidate set, the same line
matching, the same codes. In particular two arguments of one name on one
line still raise `AMBIGUOUS_LOCATION` and still write nothing — that was
already the behaviour in `0.1.1`, in all of the const-plus-JSX, two-attribute
and two-object-key shapes, and it is unchanged here. Nothing that writes
today stops writing.

The underlying limitation is not fixed: that edit still fails. Making it
succeed means teaching the panel which line to ask for, which is an API
question rather than a patch.

- The overlay's source-edit requests now carry a 10s deadline. Every Save
  button is disabled while one is in flight, so a request that never settled
  left the panel permanently unable to edit anything with no error shown.
- The bridge's reply POST no longer produces an unhandled rejection when the
  dev server stops while a tab is still open.
- `packages/examples` pinned `vite-plugin` to `0.1.0`, which no longer matched
  the workspace. `npm ls --workspaces` — the only command CI runs — failed on
  it, and a fresh install could resolve the published copy instead of the
  local one. Now `*`, matching its siblings.
- The MCP server reported version `0.1.0` to clients regardless of its
  actual version.

### Tests

The capture registry's lifetime is now pinned by the behaviour that depends
on it rather than by garbage collection. A reported concern that the registry
grows without bound across HMR reloads does not hold — it is a `WeakMap` keyed
on the mesh — but the obvious test for that is not writable: `WeakMap` is not
enumerable by design, and `WeakRef` and `FinalizationRegistry` report only
after a collection the runtime is free never to schedule, so such a test
passes or fails on GC timing rather than on this code.

What is asserted instead is the consequence an HMR reload actually depends
on: records belong to one mesh identity and never leak into its replacement,
and installation stays one-way so a re-evaluated module does not double-count
writes. Reclamation itself was measured out of band — 200 generations of 255
instances, every mesh released after collection, heap 43.9MB to 9.1MB — and
is deliberately not re-asserted in the suite.

The two symlink-containment tests skip where creating a symlink needs
elevation, rather than passing without having run.

### Documentation

The "what it costs to adopt" summary said five things go into your app and
counted `<ClickToSourceBridge />` among them; the bridge is needed only for
the agent tools. Four are required, and the summary now says which one is not
a component and names `onPointerMissed`, which it had omitted entirely.

Status lines that read `0.1.0` were left behind by the 0.1.1 release. The
ones naming the current version now track it; the ones describing why the
first release was `0.1.0` say so in the past tense.

## 0.1.1

### Security

**The origin check no longer trusts the request's own `Host` header.**
`isAllowedOrigin` compared `Origin` against `request.headers.host`. A
non-browser client sets both, so `Origin: http://evil.test` with
`Host: evil.test` satisfied the comparison. Measured against the 0.1.0
handler, that returned `200` and completed a write into the project root.
An `Origin` is now matched against the dev server's own origins, which the
plugin reads from Vite's resolved URLs.

On reach, corrected after publishing 0.1.1: this one was not reachable.
A browser cannot forge `Host`, so it was never a browser CSRF vector — a
real cross-origin page was rejected in 0.1.0 and still is. Vite's own
`allowedHosts` check answers a forged `Host` before plugin middleware
runs, so a stock Vite server was already covered. The first version of
this entry said the exposed surface was `handleFileRequest`, on the
grounds that its documentation offers it to other dev servers; but the
package does not export it, so no consumer can reach it. That reuse is a
design intention, not a shipped capability.

So this change fixes a check that was wrong in principle, with no
demonstrated path to exploitation. The two below are different: a page
open in the browser could query the bridge cross-origin and receive
`200`, observed directly; and the file endpoints accepted a caller whose
socket was not on loopback.

**Requests from outside this machine are refused by default.**
The endpoints allow a request with no `Origin` header, on the stated
grounds that a local non-browser client could edit those files directly
anyway. That reasoning holds only while the caller is local. Started with
`vite --host`, the dev server is reachable from the network and a plain
`curl` from another machine inherited the allowance, giving read and write
access to anything under the project root.

Loopback is now checked separately from origin. IPv4, IPv6 and
IPv4-mapped loopback are accepted; anything else is refused with
`Remote request rejected` unless the new `allowRemote` option is set.

**The bridge endpoints answer to the same caller policy as the file
endpoints.** The three `/__cts/bridge/*` paths were wired straight to their
handlers and inherited neither the origin check nor the loopback guard.
Measured before the fix: a page on any origin could POST a bridge query and
get `200`. The query surface is read-only, so this was disclosure rather
than write access — but it discloses source file paths, function names and
the argument values a generator was called with, and under `vite --host` it
disclosed them to the network.

The guard now lives in one exported function that every endpoint calls.
Two copies of a policy is how the bridge came to have none. The check runs
before `bridge` is consulted, so a disallowed caller cannot distinguish
"the bridge is off" from "you may not ask".

### Added

- `allowRemote` option on `clickToSource()`, default `false`. Turn it on
  only on a network you control.

### Notes

Neither fix changes the documented behaviour for local use: a same-origin
request from the page, and a no-Origin request from a local client, both
still succeed. That was verified by driving the real overlay in a browser,
not only by tests — an earlier version of the origin fix read Vite's
`resolvedUrls` at the `httpServer` "listening" event, where it is still
`null`, which silently rejected the page's own requests.

## 0.1.0

First release. Five packages: `shared`, `core`, `overlay`, `vite-plugin`
and `mcp`. See the
[v0.1.0 release notes](https://github.com/pun1th01/click-to-source-3d/releases/tag/v0.1.0).

# Stage 5 Addendum: Build-Time Source Stamping

Records the build-time transform that stamps JSX source locations into
`userData.__ctsSource`, and the resolution rule that consumes them. It is an
addendum to `metadata-convention.pdf` and the `Stage 3 Implementation
Validation Report`.

Off by default. Enabled per project with `stampSource`.

## Why build time

`@babel/plugin-transform-react-jsx-source` already runs in any Vite React
project, but its output cannot be used. Under the automatic runtime it emits
the source as the **fifth positional argument** to `jsxDEV`, outside `props`:

    jsxDEV("mesh", { geometry, position, userData }, void 0, false,
           { fileName, lineNumber, columnNumber }, this)

R3F's reconciler only ever sees the props object, so the location never
reaches `applyProps`, the `Object3D`, or `userData`. React then discards it —
in React 19, `ReactElement(type, key, props, owner, debugStack, debugTask)`
keeps only the debug Error objects, and `_debugSource` appears nowhere in the
runtime. Reading it back at runtime is not available, which is why this is a
transform rather than a fiber inspection.

## Plugin ordering — silent when violated

`clickToSource()` must be listed **before** the React plugin:

    plugins: [clickToSource({ stampSource: true }), react()]

`@vitejs/plugin-react` registers `vite:react-babel` with `enforce: "pre"`, and
this plugin declares the same. Vite preserves user array order within a bucket,
so `react()` first converts the JSX to `jsxDEV` calls and leaves nothing to
stamp.

Nothing errors when the order is wrong. The transform runs, finds no JSX, and
emits nothing — provenance simply never appears, which is indistinguishable
from the feature being off. Because a silent no-op is the worst failure mode,
the transform warns once when it sees a `.jsx` or `.tsx` file containing no
JSX. That warning is the only signal; treat it as an error.

## Precedence — manual beats auto, anywhere in the chain

`resolveSourceRef` walks the parent chain twice. A hand-written
`userData.sourceRef` anywhere in the chain outranks a stamp anywhere in the
chain, **even when the stamp sits on a nearer object**. Only when no manual ref
exists does the nearest stamp win. Within a single object the two merge field
by field, manual winning per field.

This inverts the innermost-wins rule used everywhere else in resolution, and
the reason is worth stating because the code looks wrong without it.

A stamp records where a JSX element sits. That is frequently not where the
values came from. Terrain builds its geometry inside a `useMemo` from
parameters declared far above:

    line  20:  const noiseFloor = -30, lakeBedLevel = -20;
    ...
    line  31:  let geo = new THREE.PlaneGeometry(size, size, segments, segments);
    ...
    line 255:  <mesh geometry={geometry} material={material} userData={{
                 sourceRef: { file: '...', function: 'Terrain', line: 20,
                              args: { noiseFloor, lakeBedLevel } } }} />

The stamp for that element says line 255. The hand-written ref says line 20,
because line 20 is where `noiseFloor` is declared and therefore what
`editSource` can actually rewrite. If the nearer stamp won, the panel would
point at the JSX, and editing `noiseFloor` would fail with
`ARGUMENT_NOT_FOUND` — the argument is not on line 255.

More generally: stamps are applied to every host element indiscriminately,
while a hand-written ref is a deliberate statement about which call site
matters. If a nearer stamp could shadow it, enabling the transform would
silently break every existing hand-written ref that happens to have stamped
descendants. Manual is the override path, so it wins outright.

A stamp carries no `args`, since the transform knows where a call site is but
not which of its values are worth editing. An object resolved through a stamp
alone shows file, function and line, and no argument rows.

Per-instance provenance is unaffected and still takes precedence over both.
See `stage5-instanced-mesh-support.md`.

## Production

`stampSource: true` stamps in dev only. `stampSource: "always"` also stamps
production builds, and is off by default for disclosure rather than bundle
size: a stamp names a source file and the component that produced it, so
shipping one publishes the project's file layout and internal component names
to every visitor — for a panel that is not in the production bundle.

**Emitted paths are relative to the Vite root in both modes.** This is not only
a production concern. The panel displays whatever it resolves, so an absolute
path would put the developer's home directory on screen in every screenshot and
shared session. Verified for POSIX and Windows roots; the Windows case also
normalises separators, so `src/Scene.jsx` is emitted rather than
`src\Scene.jsx`.

## What is stamped

Lowercase host elements only. A React component's JSX is stamped where the
component is declared, not where it is used.

Elements whose names end in `Geometry` or `Material` are skipped. They do carry
`userData`, so stamping them would work, but they are never the answer to
"where did this come from".

An existing `userData` is preserved: the author's expression is spread first
and the stamp added after. A `userData` that is not an object expression is
left untouched rather than guessed at.

## Verification limitation

Automatic resolution could not be demonstrated using the dogfooding app as it
stands, because **every object in it that anyone would click is already tagged
by hand**. Terrain and Water carry manual refs; Trees and GroundCover carry
per-instance arrays. In all four the manual path wins by design, so none of
them exercises the stamp.

Demonstrating it required temporarily adding an untagged `<mesh>` to
`Scene.jsx` with no `sourceRef` anywhere on it. A raycast through
`resolveObjectAtPoint` against the live scene hit that mesh and resolved it to
`src/components/Scene.jsx:77` with empty `args`, purely through its stamp, and
the panel rendered the file, function and line. The probe was removed
afterwards.

The consequence for future work: the dogfooding app cannot regression-test the
stamp path on its own. Coverage for it lives in `stampSource.test.ts` and in
the resolver precedence tests, not in the app.

A second observation from the same session, recorded because it argues against
depending on React's own injection: for `Water.jsx`, `jsx-source` reported
`lineNumber: 93` for a `<mesh>` at source line 74 and `119` for a
`<waterMaterial>` at line 100 — a constant offset of 19. The stamps written by
this transform matched source exactly for Water, Terrain and Scene, because the
transform parses the original file before anything else has touched it.

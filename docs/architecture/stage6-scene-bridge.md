# Stage 6 Phase 2: The Scene Bridge

Records the read-only channel that lets an out-of-process client ask the
running page about its own scene. Addendum to Phase 1, which shipped four
file-based MCP tools and reserved `resolve_at_point` for exactly this.

Off by default. Enabled with `bridge`, and a component the consumer mounts.

## What Phase 1 could not answer

Phase 1's `list_provenance` is a static scan. Against the dogfooding app it
reports **2** declared sites in `Trees.jsx` and `GroundCover.jsx`. The running
scene contains **8** instanced meshes at those two call sites:

    GroundCover.jsx:362 #0  count=262     Trees.jsx:240 #0  count=200
    GroundCover.jsx:362 #1  count=263     Trees.jsx:240 #1  count=198
    GroundCover.jsx:362 #2  count=225     Trees.jsx:240 #2  count=2
    GroundCover.jsx:362 #3  count=31
    GroundCover.jsx:362 #4  count=24

One `<InstancedGroundCoverMesh>` in source becomes five meshes at runtime,
partitioned by material, with counts decided by a seeded RNG. No scan can know
that, because it is not in the source. This is the gap the bridge closes, and
the reason the reserved tool was reserved rather than dropped.

## Transport

SSE downstream, POST upstream, correlated by request id — a request/response
pair built from two one-way channels. WebSocket was the obvious alternative and
was rejected for its dependency: `ws` in the plugin, for a channel that carries
a few small JSON messages per session. Vite already proxies nothing here, so
`X-Accel-Buffering: no` is set defensively rather than because a buffering layer
is known to sit in front.

Three paths, all served by the plugin and all absent unless `bridge` is set:

    /__cts/bridge/events   page attaches, server pushes questions
    /__cts/bridge/reply    page posts one answer
    /__cts/bridge/query    Node client asks

## Opt-in, in two parts

    plugins: [clickToSource({ bridge: true }), react()]

and, inside the `Canvas`:

    <ClickToSourceBridge />

The component is unavoidable, and the asymmetry with the capture probe is worth
stating. The probe is injected by the plugin because it patches a prototype and
needs no application context. The bridge needs a scene and a camera, and only a
component inside the R3F tree can supply them — `useThree` is the only route to
the objects the queries operate on.

## Addressing: derived from source, never from `uuid`

An address is `{file, function, line, ordinal}`, optionally `instanceId`.

`Object3D.uuid` is the obvious key and is unusable: it is regenerated on every
remount, so an address minted before an HMR update names nothing afterwards. A
source location survives, because it is what the source says.

`ordinal` disambiguates objects sharing one call site — the five ground-cover
meshes above — and is assigned by scene traversal order, which is deterministic
for a given graph.

## Every state is named

The page can be in more states than "answered", and each has a different
remedy, so none are collapsed into a timeout:

    disabled       bridge: true was never passed. Configuration, not runtime.
    disconnected   no page attached. Open the app.
    ambiguous      more than one page. Naming which is the caller's choice.
    no_scene       page attached, nothing mounted. Wait, do not reopen.
    timeout        page attached but silent. Something is wrong *in* the page.
    ready          answered.

`ambiguous` is a refusal, not a fallback. Picking the first page would make an
answer depend on tab order, which is invisible to the caller and changes
without warning.

A full reload passes through `disconnected` rather than hanging: measured
against a real browser, the old socket's close is observed **23ms before** the
replacement connects, so the hub genuinely knows it has no page during that
window and never infers it from silence.

## One document is one page

Keyed by socket, a single tab reported as **two** pages, and every query came
back `ambiguous`. React StrictMode mounts effects twice in development, and the
first `EventSource`'s close is not always visible to the server before the
second opens.

The client now sends a `sessionStorage`-backed session id, and the hub drops
any earlier entry with the same session.

The superseded entry is dropped from the map but **its socket is left open**.
Ending it is tidier and is wrong: to `EventSource`, a stream that ends looks
like a dropped connection, so the browser reconnects — and the reconnect
supersedes its own replacement. With that `end()` in place, page ids climbed
without pause and every query landed in the gap as `disconnected`. Both
behaviours are covered by tests that fail when the fix is reverted.

## The two failure cases

Both apply to the read tools, and both are reported rather than returned as an
empty result.

**A well-formed address can name the wrong thing.** Asking for
`Trees.jsx:240` under the function name `TreeInstances` — the real one is
`InstancedTreeMesh` — returns:

    {"status":"address_not_found","nearest":[
      {"file":"src/components/Trees.jsx","function":"Trees","line":197,"ordinal":0},
      {"file":"src/components/Trees.jsx","function":"InstancedTreeMesh","line":240,"ordinal":0},
      {"file":"src/components/Trees.jsx","function":"InstancedTreeMesh","line":240,"ordinal":1},
      {"file":"src/components/Trees.jsx","function":"InstancedTreeMesh","line":240,"ordinal":2}]}

The alternatives make the failure recoverable. A bare empty answer would be
indistinguishable from "that object carries no provenance". This case is not
hypothetical — it was hit twice while verifying this document, both times by
guessing a plausible-but-wrong function name.

**An instance slot can go stale when a count shrinks.** Regenerating the world
with a new seed took `GroundCover.jsx:362 #0` from 262 instances to 247. The
slots between still exist in the buffer, and are indistinguishable from live
ones by `(mesh, index)` alone. Measured after the shrink:

    slot 255  {"status":"instance_not_recorded","count":247,
               "reason":"instanceId is past the mesh's current count"}
    slot 100  ready, record.countAtWrite = 247

The count-aware sweep drops the abandoned slot rather than handing back the
previous generation's transform, and the surviving slot's record carries the
*new* count, confirming it was rewritten rather than merely retained.

## `generation` tracks attachment, not content

`generation` increments when a scene is attached, and a caller passing back the
value it last saw is told when the world rebuilt underneath it.

It does not detect a regeneration. Across the seed change above — which changed
six of eight instance counts — `generation` stayed at **1**, because R3F reuses
the same scene object. An agent cannot use `generation` to notice that
placements changed; it must re-read the counts. Recorded here because the
name invites the opposite assumption.

## Read-only, and the write tool that is not here

`apply_instance_edit` was proposed and is deliberately absent. An instance's
transform comes from a seeded RNG, so **no literal in source corresponds to
it** — there is nothing for an AST editor to rewrite. A write tool would have
had to either invent a literal or write to a location it resolved at runtime,
and a runtime-resolved stamp is not a safe edit target. Instance provenance
stays read-only, consistent with the resolver and the panel.

### Follow-up: `edit_generator_parameter`

The editable thing is not the instance, it is the parameter that produced it —
`count`, `spacing`, a density threshold. That tool is `edit_parameter` with an
address-to-line lookup in front of it: resolve `{file, function, line, ordinal}`
to the generator's declaration site, then edit a named argument there through
the AST editor that already exists.

It is not built yet because its input is the address scheme this phase
establishes, and that scheme should be exercised by the read tools first.

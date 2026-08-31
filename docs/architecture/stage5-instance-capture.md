# Stage 5 Addendum: Per-Instance Capture

Records the runtime probe that recovers per-instance provenance for a
hand-rolled `THREE.InstancedMesh`, replacing hand-maintained
`userData.instanceSourceRefs` arrays. Addendum to
`stage5-instanced-mesh-support.md`, which described the hand-maintained model
this supersedes, and to `stage5-source-stamping.md`, which supplies the
call-site half.

Off by default. Enabled with `captureInstances`.

## The option, and why installation timing is the whole difficulty

    plugins: [clickToSource({ captureInstances: true }), react()]

**Instance writes are once-only and there is no replay.** A placement loop
runs at mount, fills the instance matrix, and never runs again. A probe that
arrives after the first scene commits captures nothing — and captures nothing
*silently*, which is the worst failure available here.

That constraint drives the delivery. The plugin injects a module script into
`head-prepend`, ahead of the application entry; module scripts execute in
document order, so the probe is live before any scene mounts as a matter of
document structure rather than of the consumer remembering something.

The script points at a virtual module the plugin serves, whose body is a plain
`import "@click-to-source-3d/core/probe"`. Two simpler routes were tried and do
not work. A bare specifier is not resolvable from an HTML `src`. Prepending the
import to the entry module depends on the HTML being requested before the entry
is transformed, which module caching makes unreliable. The virtual module lets
Vite resolve the specifier from the application's own context — necessary
because a probe resolved into a different module graph would patch a different
copy of three than the application uses, and would then observe nothing.

The probe can also be installed by hand as the first statement of an entry:

    import "@click-to-source-3d/core/probe";

## Per-instance precedence

Resolution for an instanced hit tries, in order:

1. `userData.instanceSourceRefs[instanceId]` — hand-written
2. the capture registry, keyed by `(mesh, index)`
3. the ordinary parent walk

**The decision is per instance, not per mesh.** A partially populated array —
fewer entries than the mesh has instances — leaves the uncovered slots
resolving through capture rather than costing them their provenance. Mesh-level
precedence would step past captured data that is present and correct in favour
of something less specific, and would also contradict the existing
out-of-bounds path, which already degrades per instance.

Hand-written entries win where they exist for the same reason manual beats
stamped elsewhere, plus one specific to instancing: the probe cannot always
distinguish a stale slot from a live one (below), whereas an authored array has
no such failure mode.

## Process-global patching and its cost

Two prototypes are patched, both process-wide:

- `Matrix4.prototype.clone` — records the transform its receiver held
- `InstancedMesh.prototype.setMatrixAt` — supplies the destination

Every `InstancedMesh` in the process pays the call-through, including ones the
application does not own: drei's `Cloud`, `Sampler`, `Instances` and
`Outlines` all route through the same prototype.

Measured on this implementation, Node, 200,000 calls per trial:

| | unpatched | patched | factor |
| --- | ---: | ---: | ---: |
| `setMatrixAt` | ~55 ns | 560–676 ns | 10–12x |
| `Matrix4.clone` | 171–220 ns | 3,277–3,587 ns | 15–21x |

That is roughly 3.7–3.9 microseconds added per instance, or about **4.4–4.7 ms
for a 1,205-instance scene**, one-off at mount.

The clone multiplier is the larger of the two and is a consequence of a design
choice: `clone()` decomposes eagerly into position, quaternion, scale and Euler
angles, on every `Matrix4.clone()` in the process, even though most clones
never reach a `setMatrixAt` and are discarded. Storing the sixteen elements and
decomposing lazily on read would move that work off the hot path onto the rare
one. It has not been done, and is the obvious first optimisation if the cost
ever matters.

It has not mattered so far because `clone()` turns out to be quiet in practice:
the recorded experiment measured 2,410 clone calls on a real page load, every
one originating from the application and none from three.js, drei, R3F or
OrbitControls. That is a property of the codebases measured, not a guarantee.

The probe is dev-only and not offered for production, where there is no overlay
to read the records.

## Stale slots on a shrinking count

If an instance count shrinks on a reused mesh — 200 instances becoming 150 —
slots 150 to 199 still hold the previous generation's matrices and still
render. Their captured records remain, and are **indistinguishable from live
ones by `(mesh, index)` alone**.

Each record therefore stores the `mesh.count` in force at the moment of its
write, and a read discards any record whose recorded count differs from the
mesh's current count, or whose index is now past it. Confidently showing stale
provenance for an object that is visible on screen is worse than showing none.

The sweep is deliberately strict: it drops every record on a mesh whose count
changed, not only those past the new boundary, because a count change means the
generation that produced them is gone.

## The structural limit, worked through `variant`

Capture reconstructs a transform. It cannot reconstruct anything that never
entered one.

`GroundCover` chooses a mesh per instance by an RNG draw:

    const variantRoll = rng();
    const grassVariant = variantRoll < 0.36 ? 0 : variantRoll < 0.72 ? 1 : 2;
    ...
    grassMatrices[grassVariant].push(dummy.matrix.clone());

`grassVariant` selects which array, and therefore which `InstancedMesh`, the
matrix is pushed into. It is never written into `dummy`, never reaches the
matrix, and so never reaches the probe. **No transform-based capture mechanism
can route it** — this is a property of the information flow, not a gap in the
implementation.

The consequence in the panel is partial, and the distinction is worth being
precise about:

- **Grass versus bush survives.** They are separate call sites and carry
  different stamped lines, so a click still tells you which.
- **Variant within a kind does not.** All three grass meshes resolve to the
  same stamped line with the same argument keys, distinguishable only by
  position.

The hand-written arrays that were removed did carry `variant`, so this is a
real loss, taken deliberately. The trade runs both ways: capture supplies `y`
and `scale`, which those arrays never carried.

Where a categorical value like this matters, the fix is not a better probe. It
is to put the value where it belongs — on the mesh's own
`userData.sourceRef.args`, since every instance in that mesh shares it — or to
keep a hand-written array, which the precedence rule exists to honour.

## Verified

Against the Procedural Low-Poly World Generator, with the probe reproducing the
recorded experiment: 2,410 intercepted calls per scene build, 1,205 application
writes, 1,205 constructor fill, none unjoined, per-mesh 200/198/2 and
262/263/225/31/24.

Parity was measured before the hand-maintained arrays were removed, comparing
every authored entry against its captured record: **400 of 400 slots** across
all three tree meshes, all five fields, worst delta 0, no slot missing a
record.

Both values are rounded to three decimals for display, which is why the delta
is 0. The registry is the more precise of the two underneath — it keeps the
Float32 readback, for instance `-185.94479633385782` where the authored array
held `-185.945` — but that precision is latent and never shown.

## Known gap

The dogfooding app cannot regression-test this path on its own, for the same
reason source stamping could not: demonstrating capture required temporarily
stripping an authored array, because while one is present the manual branch
always wins. Coverage lives in `packages/core/test/instanceCapture.test.ts`.

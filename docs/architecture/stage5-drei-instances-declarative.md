# Stage 5 Addendum: drei `<Instances>` Is a Declarative Case

This document records a source-reading finding about `@react-three/drei`. No
code was changed and nothing here is implemented. It is an addendum to
`Implementation_Plan_AutoTagging.pdf` and
`docs/research/AutoInstrumentation_Experimental_Results.pdf`.

Read from `@react-three/drei@10.7.7` as installed in the Procedural Low-Poly
World Generator. drei is not a dependency of any Click-to-Source package.
The shipped `README.md` carries no inline prose for `Instances` — every
section links out to `pmndrs.github.io/drei` — so all findings below come
from the installed implementation.

## Finding

**`<Instances>` has no programmatic API. JSX children are the only input.**
The instance list is `React.useState([])` (`core/Instances.js:113`),
populated exclusively through `subscribe`, which each `<Instance>` calls on
itself in `React.useLayoutEffect(() => subscribe(group), [])`
(`core/Instances.js:82`, appending at `:161`). There is no matrices prop, no
`setMatrixAt` passthrough, and no ref method for adding instances.
Rendering `<Instance>` children is the entire mechanism.

All three usage forms are JSX: plain children, a render-prop child
(`isFunctionChild(children)`, `:183`, which is what `Merged` uses), and the
explicit-context pair returned by `createInstances()`.

**The per-instance transform comes from JSX props.** Each `<Instance>`
renders a real `positionMesh` into the scene graph, and `<Instances>` reads
it back each frame:

    instance.matrixWorld.decompose(translation, rotation, scale);   // :148
    instanceMatrix.toArray(matrices, i * 16);                       // :150

So `position` / `rotation` / `scale` on the JSX element are the source of
truth, round-tripped through the object's own `matrixWorld`.

**A click resolves to the individual instance object.**
`PositionMesh.raycast` sets both fields on the intersection:

    intersect.instanceId = instanceId;   // :53
    intersect.object = this;             // :54

`intersect.object` is the `PositionMesh` itself, not the parent
`InstancedMesh`. A `userData` prop on each `<Instance>` therefore resolves
through the existing parent walk unchanged. No `instanceSourceRefs` array
and no interception are required — which is materially simpler than the
hand-maintained per-instance arrays the Low-Poly World Generator uses for
its raw `THREE.InstancedMesh` (see `stage5-instanced-mesh-support.md`).

## What this supersedes

Implementation Plan §2.4 "Scope boundary" concludes:

> hand-rolled instancing is solved; library-owned instancing is not.

Experimental Results §9.4 "The gap nothing closes" concludes:

> H4 has nothing to attach to; every other hypothesis needs H4. This is not
> a scoping choice — it is an absence.

**The mechanical observation in both is correct and is confirmed here.**
`<Instances>` writes the buffer directly via `instanceMatrix.toArray(...)`
and calls no `setMatrixAt` anywhere in its path. (Other drei components do
— `Cloud.js:82` and `Sampler.js:40` — but `Instances` does not.)

**The conclusion drawn from it does not hold.** Both sections reason only
about H4, interception of a write call. drei needs no interception: the
location is available free from the `__source` transform on the JSX
element, the args are its props, and provenance attaches as ordinary
`userData`. The claim that "every other hypothesis needs H4" is what fails
— the declarative route is call-site shaped, not interception shaped.

The separation the plan asks for still stands, but the line falls
elsewhere: **hand-rolled instancing needs interception; library-owned
instancing needs none.**

## Known gap

`PositionMesh extends THREE.Group` (`core/Instances.js:14`), not `Mesh`.
Verified against three 0.173: `type` is `"Group"`, `isMesh` is `false`,
and it carries no own `material` — `geometry` is a getter delegating to the
parent `InstancedMesh`.

A clicked drei instance run through `describeMesh` therefore reports kind
`Group`, `triangleCount: null` (the `isMesh` guard), and `materials: []`,
with geometry borrowed from the parent. Not incorrect, but not what the
panel should show. Unhandled; noted for whenever drei support becomes real
work.

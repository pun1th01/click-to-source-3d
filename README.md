# Click-to-Source 3D

**Source-level debugging for React Three Fiber.**

---

## Introduction

Developers working on Three.js and React Three Fiber scenes often spend significant time locating the exact application code responsible for rendered output. Complex scenes with hundreds of generated objects make this a tedious, manual process — there is no built-in way to click a rendered mesh and jump straight to the source that created it.

**Click-to-Source 3D** aims to bridge runtime rendering and source code by allowing developers to interact directly with rendered objects and trace them back to the source responsible for generating them. Think of it as the 3D equivalent of browser DevTools' "Inspect Element" — but for Three.js scenes.

Unlike DOM-focused click-to-source tools or general Three.js scene inspectors, this tool traces rendered objects back to the exact generator function and arguments that created them, not just their current runtime state.

## Goals

- **Runtime Provenance** — Track which source code and parameters produced each rendered object.
- **Interactive Source Tracing** — Click any object in a 3D scene and jump to its origin in your editor.
- **Fast Debugging Workflow** — Eliminate guesswork when debugging procedural or generated geometry.
- **Better AI Context** — Provide structured provenance data that AI tools can consume for smarter assistance.
- **Developer Tooling** — Integrate seamlessly into existing Three.js and React Three Fiber workflows.

## Current Status

**Stage 7 — publishing.** Five packages at `0.1.0`, verified from tarballs
into a consumer outside the repo. Not yet on npm.

Earlier stages are recorded in `docs/architecture/`, and the tags
`stage5-complete` and `stage6-complete` mark verified checkpoints, each paired
with the commit of the dogfooding consumer it was verified against.

## Packages

| package | what it is |
|---|---|
| `@click-to-source-3d/shared` | The `SourceRef` contract and protocol constants. Types, no runtime. |
| `@click-to-source-3d/core` | Provenance resolution and per-instance capture. Browser-pure. |
| `@click-to-source-3d/overlay` | React Three Fiber components: selection, the trace panel, the bridge. |
| `@click-to-source-3d/vite-plugin` | Dev-server endpoints, JSX source stamping, the scene bridge. |
| `@click-to-source-3d/mcp` | An MCP server exposing the same provenance to coding agents. |

## Scope — React Three Fiber only

Source stamping is a JSX transform, the overlay is React, the bridge component
needs the R3F tree, and the dev-server half needs Vite. Plain Three.js can use
`@click-to-source-3d/core` with hand-written `userData.sourceRef`, but the
experience this project is about is R3F.

## What it costs to adopt

Two installs bring four packages — `core` and `shared` arrive as dependencies:

```bash
npm install @click-to-source-3d/overlay
npm install -D @click-to-source-3d/vite-plugin
```

Then roughly five things go into your app:

1. `clickToSource()` in `vite.config.js`, **before** `react()`
2. `useClickToSource()` in a pointer handler, feeding the selection store
3. `<SelectionHighlight />` inside the `Canvas`
4. `<GenerationTrace />` outside the `Canvas` — it renders DOM
5. `<ClickToSourceBridge />` inside the `Canvas`, if you want the agent tools

Every feature is opt-in and dev-only. Add `@click-to-source-3d/mcp` for the
MCP server.

## Limits worth knowing before you adopt it

**Instanced provenance is read-only.** An instance's transform comes from
whatever placed it, usually a seeded RNG, so there is no literal in your source
to rewrite. The panel shows the values and refuses to edit them.

**Variant-class values cannot be recovered.** Automatic capture reads a
`Matrix4`, so it recovers `x`, `y`, `z`, `scale` and `yaw` — and nothing else.
Which colour group, species or material variant an instance belongs to is not
in the transform. Capture recovers *placement*, not *classification*. Those
values used to exist, in the hand-maintained `instanceSourceRefs` arrays that
automatic capture replaced; that is a real trade, not an oversight. Keep
writing them by hand if you need the classification.

**Selection highlighting is mesh-wide for instanced meshes.** Clicking one
instance outlines every instance in that `InstancedMesh`. Resolution is
per-instance and correct; only the outline is coarse.

**Scene addresses do not detect regeneration.** They are derived from source
location, so they survive a remount — but if your world rebuilds with different
placements, the same address resolves to a different object and nothing reports
that it changed.

## Roadmap

| Stage | Milestone | Status |
|-------|-----------|--------|
| 0 | Scope freeze | done |
| 1 | Prove the mechanism | done |
| 2 | Provenance convention | done |
| 3 | Core engine + overlay | done |
| 4 | Dogfooding | done |
| 5 | Package polish | done — `stage5-complete` |
| 6 | MCP / agent mode | done — `stage6-complete` |
| 6.5 | Auto-instrumentation | done — shipped as `stampSource`, no longer optional or research |
| 7 | Ship | in progress — first release is `0.1.0`, not 1.0 |

The 1.0 in the original plan was optimistic. This releases at `0.1.0`: the API
surface has only just been curated deliberately, instanced provenance is
read-only, and there is no staleness detection for scene addresses. `0.x` says
that honestly.

For the original plan, see [`docs/roadmap/`](docs/roadmap/).

## Overlay components and the render loop

Two components have requirements that are invisible from their call sites,
because when either is unmet the result is a component that renders nothing
and says nothing. Both were found by consumers rather than by tests.

### `<SelectionHighlight />`

Draws the selection outline through an `EffectComposer`, on a `useFrame`
subscription at **priority 1**. Any priority above zero makes R3F stop
rendering the scene itself and hand the job to the subscriber, so this
component becomes the renderer.

- It does **not** compose with other post-processing that also claims a
  priority. Whichever renders last wins and the other's output is discarded.
- Under `frameloop="demand"` it works: it calls `invalidate()` whenever the
  selection changes. Before that it silently did not, because the selection
  arrives from a store R3F does not observe, so no frame was ever scheduled.
- Under `frameloop="never"` it cannot work — your application drives frames,
  so call `advance()` after changing the selection. It warns once in
  development rather than failing silently.

There is no requirement on the `gl` prop. A bare `<Canvas>` is fine.

### `<ClickToSourceBridge />`

Answers queries about the running scene, and must be inside the `Canvas`,
since only a component in the R3F tree can supply a scene and a camera.

It answers only while the page is actually rendering. R3F does not render
`Canvas` children in a hidden or background tab, so the component never
mounts and every bridge query reports `disconnected` — indistinguishable
from no page being open. This matters when driving the app headlessly: keep
the page visible, or expect `disconnected`.

## Repository Structure

```
click-to-source/
│
├── docs/                        # Project documentation
│   ├── architecture/            # Architecture decisions and design docs
│   ├── research/                # Research and competitor analysis
│   ├── tech-stack/              # Technology stack documentation
│   ├── roadmap/                 # Project roadmap and milestones
│   └── assets/                  # Documentation assets (diagrams, images)
│
├── packages/                    # Monorepo packages (npm workspaces)
│   ├── shared/                  # SourceRef contract and protocol constants
│   ├── core/                    # Provenance resolution, instance capture
│   ├── overlay/                 # React Three Fiber inspection components
│   ├── vite-plugin/             # Dev-server endpoints, stamping, bridge
│   ├── mcp/                     # MCP server for coding agents
│   └── examples/                # Example projects and demos
│
├── scripts/                     # Build, release, and development scripts
│
├── .github/                     # GitHub configuration
│   ├── ISSUE_TEMPLATE/          # Issue templates
│   ├── workflows/               # CI/CD workflows
│   └── pull_request_template.md # PR template
│
└── .vscode/                     # Editor configuration
```

## Documentation

Detailed project documentation is available in the [`docs/`](docs/) directory:

- **[Architecture](docs/architecture/)** — System design and architectural decisions.
  - [`metadata-convention.pdf`](docs/architecture/metadata-convention.pdf) — Permanent architectural contract and canonical SourceRef tagging convention.
  - [`future-auto-instrumentation-design.md`](docs/architecture/future-auto-instrumentation-design.md) — Future design document for automatic instrumentation.
  - [`Stage2_Architectural_Validation_Report.pdf`](docs/architecture/Stage2_Architectural_Validation_Report.pdf) — Stage 2 architectural validation report.
- **[Research](docs/research/)** — Technical approaches, competitor analysis, and experimental validation.
  - [`Click-to-Source_Technical_Approaches.pdf`](docs/research/Click-to-Source_Technical_Approaches.pdf) — Technical approach analysis.
  - [`Stage1_Experimental_Report.pdf`](docs/research/Stage1_Experimental_Report.pdf) — Stage 1 experimental validation report.
- **[Tech Stack](docs/tech-stack/)** — Technology choices and rationale.
- **[Roadmap](docs/roadmap/)** — Detailed project roadmap and milestones.

## Contributing

Contributions are welcome! Please read our [Contributing Guidelines](CONTRIBUTING.md) and our [Code of Conduct](CODE_OF_CONDUCT.md).
If you are opening an issue, please use the provided [Issue Templates](.github/ISSUE_TEMPLATE/).

## License

This project is licensed under the [MIT License](LICENSE).

---

<sub>Click-to-Source 3D is an open-source developer tool. Built for the Three.js and React Three Fiber community.</sub>

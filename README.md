# Click-to-Source 3D

**Source-level debugging for Three.js & React Three Fiber.**

---

## Introduction

Developers working on procedural Three.js and React Three Fiber scenes often spend significant time locating the exact application code responsible for rendered output. Complex scenes with hundreds of generated objects make this a tedious, manual process — there is no built-in way to click a rendered mesh and jump straight to the source that created it.

**Click-to-Source 3D** aims to bridge runtime rendering and source code by allowing developers to interact directly with rendered objects and trace them back to the source responsible for generating them. Think of it as the 3D equivalent of browser DevTools' "Inspect Element" — but for Three.js scenes.

## Goals

- **Runtime Provenance** — Track which source code and parameters produced each rendered object.
- **Interactive Source Tracing** — Click any object in a 3D scene and jump to its origin in your editor.
- **Fast Debugging Workflow** — Eliminate guesswork when debugging procedural or generated geometry.
- **Better AI Context** — Provide structured provenance data that AI tools can consume for smarter assistance.
- **Developer Tooling** — Integrate seamlessly into existing Three.js and React Three Fiber workflows.

## Current Status

> 🚧 **Early Development**

Current milestone:

**Stage 1** — Manual provenance prototype.

The project is in its initial setup phase. Architecture documents, research, and technical approach documents are available in the `docs/` folder.

## Roadmap

| Stage | Milestone | Description |
|-------|-----------|-------------|
| 1 | Manual Metadata | Manually attach provenance metadata to Three.js objects |
| 2 | Source Mapping | Map runtime objects back to source code locations |
| 3 | Interactive Overlay | Visual overlay for clicking and inspecting objects in-scene |
| 4 | Dogfooding | Internal testing with real-world Three.js projects |
| 5 | Automatic Instrumentation | AST-based automatic provenance injection |
| 6 | MCP Integration | Model Context Protocol integration for AI workflows |

For the full roadmap, see [`docs/roadmap/`](docs/roadmap/).

## Repository Structure

```
Click-to-Source-3D/
│
├── docs/                        # Project documentation
│   ├── architecture/            # Architecture decisions and design docs
│   ├── research/                # Research and competitor analysis
│   ├── tech-stack/              # Technology stack documentation
│   ├── roadmap/                 # Project roadmap and milestones
│   └── assets/                  # Documentation assets (diagrams, images)
│
├── packages/                    # Monorepo packages (npm workspaces)
│   ├── core/                    # Core provenance engine
│   ├── overlay/                 # Interactive inspection overlay
│   ├── examples/                # Example projects and demos
│   └── shared/                  # Shared utilities and types
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
- **[Research](docs/research/)** — Technical approaches and competitor analysis.
- **[Tech Stack](docs/tech-stack/)** — Technology choices and rationale.
- **[Roadmap](docs/roadmap/)** — Detailed project roadmap and milestones.

## Contributing

Contributions will be welcomed once the MVP architecture stabilizes. In the meantime, feel free to open issues for discussion and feedback.

For more details, see [CONTRIBUTING.md](CONTRIBUTING.md).

## License

This project is licensed under the [MIT License](LICENSE).

---

<sub>Click-to-Source 3D is an open-source developer tool. Built for the Three.js and React Three Fiber community.</sub>

# Click-to-Source 3D

**Source-level debugging for Three.js & React Three Fiber.**

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

> 🚧 **Early Development**

Current milestone:

**Stage 3** — Interactive Overlay.

**Stage 2 — Complete.** Source Mapping architecture and metadata conventions finalized. See the full report: [`Stage2_Architectural_Validation_Report.pdf`](docs/architecture/Stage2_Architectural_Validation_Report.pdf).

**Stage 1 — Complete.** All 7 experiments were executed, validating provenance tracking across mount, re-render, recreation, HMR, and memoized generation scenarios. See the full report: [`Stage1_Experimental_Report.pdf`](docs/research/Stage1_Experimental_Report.pdf).

Architecture documents, research, and technical approach documents are available in the `docs/` folder.

## Roadmap

| Stage | Milestone | Description |
|-------|-----------|-------------|
| 0 | Scope Freeze | Finalize core goals, non-goals, and project constraints |
| 1 | Prove the Mechanism | Validate DOM-to-Source patterns and identify metadata injection techniques |
| 2 | Provenance/Source Mapping Convention | Define canonical data structures and architectural boundaries |
| 3 | Core Engine + Overlay MVP | Build the metadata pipeline and a basic UI for on-screen selection |
| 4 | Dogfooding | Integrate into a complex test project to validate developer experience |
| 5 | Package Polish | Finalize APIs, add tests, write docs, and prepare for external use |
| 6 | MCP/AI Mode | Build standard MCP context interfaces for AI agents |
| 6.5 | Optional Auto-Instrumentation | Research AST/Babel transformations to remove manual tagging |
| 7 | Ship | Version 1.0 release |

For the full roadmap, see [`docs/roadmap/`](docs/roadmap/).

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

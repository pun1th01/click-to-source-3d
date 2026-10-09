# Contributing

Thanks for helping. Bug reports, fixes and documentation corrections are all
welcome.

## Setup

Node 22 or 24, which is what CI runs.

```bash
npm ci
npm run build
npm test
```

`npm run build` builds the packages in dependency order. Don't use
`npm run build --workspaces`, which builds alphabetically and fails on a
clean clone because the example imports the Vite plugin from its `dist`.

To try a change in the browser, run the example and press Alt+Shift+C:

```bash
npm run dev -w @click-to-source-3d/examples
```

The end-to-end tests drive the example in a real browser. Locally, use an
installed one rather than downloading Chromium:

```bash
CTS_E2E_CHANNEL=msedge npm run test:e2e
```

## Where things live

| package | what it is |
|---|---|
| `packages/vite-plugin` | Stamping, the injected inspector (`src/client`), the endpoints, the bridge hub |
| `packages/cli` | `npx click-to-source-3d init` |
| `packages/mcp` | The MCP server for coding agents |
| `packages/core` | Resolution, picking, the highlight, the bridge's browser half |
| `packages/shared` | Types and protocol constants shared by both halves |
| `packages/overlay` | Legacy React components |
| `packages/examples` | A plain R3F scene with only the plugin added |
| `e2e` | Playwright tests against the example |

Design notes for earlier stages are in `docs/architecture/`.

## Two things this repository cannot show you

Inside this repository the plugin is a workspace symlink, which Vite treats
as source code. In a real project it sits in `node_modules`, and two bugs in
0.1.5 appeared only there. Before a release that touches the plugin or the
inspector, pack the packages, install them into a fresh `create-vite` app
under npm and pnpm, run `init`, and check the console.

## Pull requests

- **A fix comes with a test that fails without it.** Several past fixes are
  recorded in the changelog as bugs a passing suite didn't catch, so a test
  has to exercise the real path.
- **Changes that affect users get a `CHANGELOG.md` entry** under the next
  version: what was wrong, what it does now, and anything a user has to do.
- **The published packages are versioned in lockstep.** Don't bump versions
  in a pull request; that happens at release.
- **Keep the endpoints' caller policy in one place.** Anything that reads or
  writes files, or answers questions about the scene, goes through
  `checkCaller` in `packages/vite-plugin/src/middleware.ts`.

If you're opening an issue, the templates in `.github/ISSUE_TEMPLATE/` ask
for what we need to reproduce it.

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

To try a change in the browser:

```bash
npm run dev -w @click-to-source-3d/examples
```

## Where things live

| package | what it is |
|---|---|
| `packages/shared` | Types and protocol constants shared by both halves |
| `packages/core` | Provenance resolution and the bridge's browser half |
| `packages/overlay` | React Three Fiber components |
| `packages/vite-plugin` | Source stamping, the dev-server endpoints, the bridge hub |
| `packages/mcp` | The MCP server for coding agents |
| `packages/examples` | The demo app, used to check changes by hand |

Design notes for earlier stages are in `docs/architecture/`.

## Pull requests

- **A fix comes with a test that fails without it.** Several past fixes are
  recorded in the changelog as bugs a passing suite didn't catch, so a test
  has to exercise the real path.
- **Changes that affect users get a `CHANGELOG.md` entry** under the next
  version: what was wrong, what it does now, and anything a user has to do.
- **The five published packages are versioned in lockstep.** Don't bump
  versions in a pull request; that happens at release.
- **Keep the endpoints' caller policy in one place.** Anything that reads or
  writes files, or answers questions about the scene, goes through
  `checkCaller` in `packages/vite-plugin/src/middleware.ts`.

If you're opening an issue, the templates in `.github/ISSUE_TEMPLATE/` ask
for what we need to reproduce it.

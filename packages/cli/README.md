# click-to-source-3d

Sets up [Click-to-Source 3D](https://github.com/pun1th01/click-to-source-3d)
in a Vite + React Three Fiber project with one command.

    npx click-to-source-3d init

Run it in your app's folder, the one with `package.json` and `vite.config`.
It needs Node 20.19+, Vite 6–8, React Three Fiber 9 and three.js 0.170+.
`pnpm dlx click-to-source-3d init` and `bunx click-to-source-3d init` work
too.

Then start your app as usual, press **Alt+Shift+C** (or the button in the
corner of the canvas), and click any object to see the line that created it
and edit its values.

## What it does

1. Installs `@click-to-source-3d/vite-plugin` as a dev dependency, with the
   package manager your project uses (npm, pnpm, yarn or bun, from its
   lockfile).
2. Adds `clickToSource()` to the front of `plugins` in your `vite.config`,
   changing nothing else in the file. If the config is written in a way it
   cannot edit safely, it prints the two lines to add instead.
3. Asks whether to set up the tools for AI coding assistants. On yes, it also
   installs `@click-to-source-3d/mcp` and registers it in `.mcp.json` at your
   repository root, which is Claude Code's config file. For Cursor, VS Code
   and others, see the
   [MCP package](https://www.npmjs.com/package/@click-to-source-3d/mcp).

It stops before changing anything if the project does not use Vite, or does
not use React Three Fiber. Running it again changes nothing.

## Options

    --mcp        set up the AI-assistant tools without asking
    --no-mcp     do not ask about them
    -y, --yes    accept the defaults without asking
    --force      set up a project that does not use React Three Fiber
    -h, --help   show help

It is never added to your project: `npx` downloads it, runs it, and that is
all.

## License

MIT

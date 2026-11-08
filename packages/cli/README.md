# click-to-source-3d

Sets up [Click-to-Source 3D](https://github.com/pun1th01/click-to-source-3d)
in a three.js or React Three Fiber project with one command, and nothing to do
afterwards.

    npx click-to-source-3d init

Run it in your project, or at the root of your monorepo. It needs Node 20.19+.
`pnpm dlx click-to-source-3d init` and `bunx click-to-source-3d init` work too.

Then start your app with the command it gives you, press **Alt+Shift+C** (or the
button in the corner of the canvas), and click any object to see the line that
made it and edit its values.

## What it does

It finds what you have, and does whatever is missing, with the package manager
your project uses (npm, pnpm, yarn or bun, from its lockfile), running that
through `npx` if it isn't installed:

1. **Finds your app.** The folder it's run in, the app above it, or every app using
   three.js in a monorepo, read from its workspaces and from folders such as
   `apps/*` and `frontend`. A library that only depends on three is left alone.
2. **Installs `@click-to-source-3d/vite-plugin`** as a dev dependency, and whatever
   else is missing: Vite if there's no build tool, and three.js if it's only used from
   a CDN link or a copy in the project, at the version those name.
3. **Adds `clickToSource()` to your Vite config**, changing nothing else in the file.
   If there's no config it creates one. If the config isn't one object, because a
   function returns different ones or it comes from `mergeConfig`, it wraps what
   you export in `withClickToSource(...)`. CommonJS works too. Only a file that
   exports nothing can't be edited, and it says what to add.
4. **Makes sure the app can start.** A `package.json` for a folder of scripts, a `dev`
   script if nothing runs Vite, and an `index.html` if there's no page.
5. **Sets up the tools for AI coding assistants** if it finds signs of one (`.claude`,
   `CLAUDE.md`, `.mcp.json`, `.cursor`, `.cursorrules`, `.windsurf`, `.vscode/mcp.json`).
   Otherwise it asks. That installs `@click-to-source-3d/mcp` and registers it in
   `.mcp.json` at your repository root, and in `.cursor/mcp.json` and `.vscode/mcp.json`
   where those folders exist.

It stops before changing anything if the project uses webpack, Next.js, Create
React App, Parcel, Gatsby, Angular, Astro or Nuxt, if its Vite is older than 5 or
its three.js older than 0.150, or if nothing here uses three.js. Running it again
changes nothing.

## Options

    --mcp        set up the AI-assistant tools without asking
    --no-mcp     do not set them up, or ask
    -y, --yes    accept the defaults without asking
    --force      set up a project that does not seem to use three.js
    -h, --help   show help

It is never added to your project: `npx` downloads it, runs it, and that is
all.

## License

MIT

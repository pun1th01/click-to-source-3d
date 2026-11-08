# @click-to-source-3d/mcp

An MCP server that gives a coding agent your scene's provenance — both what the
source declares and what the running app actually built.

Part of [Click-to-Source 3D](https://github.com/pun1th01/click-to-source-3d).

## What MCP is

MCP, the Model Context Protocol, is how AI coding assistants — Claude Code,
Cursor, VS Code with Copilot, Windsurf and others — use tools that other
programs provide. This package is one such program: the assistant starts it in
the background and calls its tools, which talk to your Vite dev server and,
through it, to your app open in the browser.

## Scope

**Plain three.js or React Three Fiber, behind a Vite dev server** running
[`@click-to-source-3d/vite-plugin`](https://www.npmjs.com/package/@click-to-source-3d/vite-plugin)
of the same version. The scene tools also need the app open in a browser tab.

## Install

    npx click-to-source-3d init --mcp

That installs this package and registers it in `.mcp.json` at the root of
your repository, and in `.cursor/mcp.json` and `.vscode/mcp.json` where those
folders exist. If the project already has signs of an assistant (`.claude`,
`CLAUDE.md`, `.mcp.json`, `.cursor`, `.windsurf`), a plain
`npx click-to-source-3d init` does this without being asked. Claude Code asks you
to approve the server the first time it starts in the project.

For another assistant, add the same entry to its own config file:

| assistant | file | key |
|---|---|---|
| Claude Code | `.mcp.json` | `mcpServers` |
| Cursor | `.cursor/mcp.json` | `mcpServers` |
| VS Code | `.vscode/mcp.json` | `servers` |

    {
      "mcpServers": {
        "click-to-source": { "command": "npx", "args": ["-y", "@click-to-source-3d/mcp"] }
      }
    }

On Windows, wrap the command: `"command": "cmd", "args": ["/c", "npx", "-y", "@click-to-source-3d/mcp"]`.

There is nothing to configure. When the dev server starts, the plugin
announces its address and project root, and this server reads that on every
call — so it works even if the dev server starts after the assistant does, or
on another port than usual. In a monorepo it picks the dev server whose
project is closest to where the assistant was started. `CTS_DEV_SERVER` and
`CTS_PROJECT_ROOT` still override it.

## Pointing

The developer points at one or more meshes in the browser, with the inspector's
pointer button or Shift+click, then tells their assistant what to do: "make these
bigger". The server's instructions tell the assistant to call `get_selection` when
someone says "this" or "these". It returns each object in order:

    {
      "kind": "Mesh",
      "source": { "file": "src/World.tsx", "function": "World", "line": 41, "column": 7 },
      "props": [
        {
          "element": "boxGeometry",
          "name": "args",
          "array": true,
          "values": [
            { "raw": "1.5", "value": 1.5, "editable": true, "line": 4, "column": 20, "via": "ROCK_SIZE" }
          ]
        }
      ],
      "transform": { "position": [-2, 0.75, 0], "rotation": [0, 0, 0], "scale": [1, 1, 1], "worldPosition": [-2, 0.75, 0] },
      "materials": ["MeshStandardMaterial #c2643c"],
      "cost": { "triangles": 12, "drawCalls": 1, "geometryBytes": 840, "textures": [] }
    }

A value's `line`, `column` and `raw` are what `edit_parameter` takes to rewrite it.
A `via` means the value is a constant and the position is its declaration, so the
edit changes every use.

The answer comes from the dev server, which the page tells as things change, so it
works with the tab in the background and during the reload an edit can cause.

## What the developer sees

The inspector's Agent tab shows which assistant is connected and every call it
makes, in plain words, with edits marked. Objects it asks about are outlined for a
moment, in a colour of their own. Clicking a line selects that object, or opens
that line in their editor.

The server reports each call to the dev server to make that happen, along with a
heartbeat. Nothing leaves the machine, and a report that fails never affects the
call.

## Tools

The developer and their screen — these need the app open:

    get_selection            what they are pointing at, and have selected
    highlight_object         outline objects to show them what you mean
    get_canvas_screenshot    see the scene as they do

Reading source — these work without a browser:

    get_source            read a file, or a line range
    list_provenance       every declared provenance site, by static scan
    search_by_generator   find sites by function or argument name
    edit_parameter        rewrite one literal, by exact position or by name

Reading the running scene — these need the app open:

    list_scene_provenance    every stamped object actually in the scene
    resolve_at_point         what is under a point, in normalised device coords
    get_instance_provenance  one object, or one instance within it

## Why the scene tools exist

A static scan reports what the source says. In a dogfooded app, two declared
sites in two files became **eight** instanced meshes at runtime, partitioned by
material, with counts chosen by a seeded RNG. None of that is in the source, and
no scan can find it.

## What it will not do

**Only edits through `edit_parameter` are in the log.** An assistant can also edit
files with its own tools, as with any file. Those still hot-reload, but this server
never sees them.

**A screenshot is of the canvas.** Not the page around it, and not the inspector's
panel. From a background tab it is drawn just for the call, without any
post-processing the app does, and `via` says `direct`.

**Instanced provenance is read-only.** An instance's transform comes from a
seeded RNG, so no literal in source corresponds to it and there is nothing for
an editor to rewrite.

**Variant-class values are unrecoverable.** An instance's transform holds
`x`, `y`, `z`, `scale` and `yaw`. Colour group, species or material variant
are not in it.

**Every failure is named rather than timed out.** `disabled`, `disconnected`,
`ambiguous` (more than one page open — naming which is your choice, not the
server's), `no_scene`, `timeout`. An instance slot outside the mesh's current
count reports `instance_out_of_range`.

**Addresses are not stable across a world regeneration.** They are derived from
source location, so they survive a remount — but if your scene regenerates with
different placements, the same address resolves to a different object and
nothing reports that it changed.

## License

MIT

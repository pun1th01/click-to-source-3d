# @click-to-source/mcp

An MCP server that gives a coding agent your scene's provenance — both what the
source declares and what the running app actually built.

Part of [Click-to-Source 3D](https://github.com/pun1th01/click-to-source-3d).

## Scope

**React Three Fiber, behind a Vite dev server.** The file tools read your
project through
[`@click-to-source/vite-plugin`](https://www.npmjs.com/package/@click-to-source/vite-plugin);
the scene tools need the app open in a browser with `bridge: true` and
`<ClickToSourceBridge />` mounted.

## Install

    npm install -D @click-to-source/mcp

Register the binary with your MCP client:

    {
      "command": "click-to-source-mcp",
      "env": {
        "CTS_DEV_SERVER": "http://localhost:5173",
        "CTS_PROJECT_ROOT": "/path/to/your/app"
      }
    }

## Tools

Reading source — these work without a browser:

    get_source            read a file, or a line range
    list_provenance       every declared provenance site, by static scan
    search_by_generator   find sites by function or argument name
    edit_parameter        rewrite one argument's literal, via the AST editor

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

**Instanced provenance is read-only.** An instance's transform comes from a
seeded RNG, so no literal in source corresponds to it and there is nothing for
an editor to rewrite.

**Variant-class values are unrecoverable.** Capture reads a `Matrix4`, so it
returns `x`, `y`, `z`, `scale` and `yaw`. Colour group, species or material
variant are not in the transform.

**Every failure is named rather than timed out.** `disabled`, `disconnected`,
`ambiguous` (more than one page open — naming which is your choice, not the
server's), `no_scene`, `timeout`. An instance with no record reports why:
`probe_not_installed`, `instance_out_of_range`, `no_records_for_mesh` or
`record_swept`.

**Addresses are not stable across a world regeneration.** They are derived from
source location, so they survive a remount — but if your scene regenerates with
different placements, the same address resolves to a different object and
nothing reports that it changed.

## License

MIT

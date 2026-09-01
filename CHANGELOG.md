# Changelog

All five packages are versioned in lockstep.

## 0.1.2

### Fixed — install

**`three`'s upper version bound is gone.** `core` and `overlay` declared
`three: ">=0.170.0 <0.180.0"`. `three` is at `0.185.1`, so
`npm install @click-to-source-3d/overlay` failed outright with `ERESOLVE` for
anyone on a current version — on step one of the README, before any of this
tool ran at all. The ceiling was this project's own: `@react-three/fiber`
asks only for `>=0.156`.

The range is now `>=0.170.0`. Verified both ways rather than assumed: the
install that failed on `0.1.1` succeeds against `three@0.185.1`, and capture,
resolution and the raycast path were each exercised against `three` r185 in a
consumer outside this repository.

### Changed

**The provenance scanner no longer follows symlinks.** `collectSites` in
`@click-to-source-3d/mcp` is the only code in that package that reads the
filesystem directly; everything else goes through the dev server, which
resolves symlinks and re-checks containment before answering. Symlinked
directories were already skipped, but by accident rather than intent —
`readdir`'s `Dirent` reflects `lstat`, so `isDirectory()` is false for a link
and the recursion never saw one. Files had no such accident: a link named
`foo.ts` passed the extension test and `readFile` followed it, so a target
outside the project root would be scanned and reported under an in-root
relative path.

Scope, stated plainly: a site carries a path, a line, a function name and
argument names — never file contents — and the link has to be one the
developer put in their own project. This closes a difference between the two
paths' idea of what is in scope, not a demonstrated escape. It is a change of
intent into mechanism.

The two containment tests skip on platforms where creating a symlink needs
elevation, rather than passing vacuously.

### Fixed

**`LOCATION_NOT_FOUND` now names the lines the argument is declared on.**
It previously said only that the argument was not at the requested line,
which is the same message whether the line is stale or the name is not
editable at all. The panel hits this constantly and cannot get past it: it
sends `sourceRef.line`, naming the generator's call site, while a hoisted
constant's only location is its own declaration — so the `waterLevel` ->
`WATER_LEVEL` mapping that `argSources` exists to support fails every time,
and used to fail looking as though the argument did not exist.

This is a message change only. Which edits are accepted and which are
refused is byte-for-byte what it was: the same candidate set, the same line
matching, the same codes. In particular two arguments of one name on one
line still raise `AMBIGUOUS_LOCATION` and still write nothing — that was
already the behaviour in `0.1.1`, in all of the const-plus-JSX, two-attribute
and two-object-key shapes, and it is unchanged here. Nothing that writes
today stops writing.

The underlying limitation is not fixed: that edit still fails. Making it
succeed means teaching the panel which line to ask for, which is an API
question rather than a patch.

- The overlay's source-edit requests now carry a 10s deadline. Every Save
  button is disabled while one is in flight, so a request that never settled
  left the panel permanently unable to edit anything with no error shown.
- The bridge's reply POST no longer produces an unhandled rejection when the
  dev server stops while a tab is still open.
- `packages/examples` pinned `vite-plugin` to `0.1.0`, which no longer matched
  the workspace. `npm ls --workspaces` — the only command CI runs — failed on
  it, and a fresh install could resolve the published copy instead of the
  local one. Now `*`, matching its siblings.
- The MCP server reported version `0.1.0` to clients regardless of its
  actual version.

### Tests

The capture registry's lifetime is now pinned by the behaviour that depends
on it rather than by garbage collection. A reported concern that the registry
grows without bound across HMR reloads does not hold — it is a `WeakMap` keyed
on the mesh — but the obvious test for that is not writable: `WeakMap` is not
enumerable by design, and `WeakRef` and `FinalizationRegistry` report only
after a collection the runtime is free never to schedule, so such a test
passes or fails on GC timing rather than on this code.

What is asserted instead is the consequence an HMR reload actually depends
on: records belong to one mesh identity and never leak into its replacement,
and installation stays one-way so a re-evaluated module does not double-count
writes. Reclamation itself was measured out of band — 200 generations of 255
instances, every mesh released after collection, heap 43.9MB to 9.1MB — and
is deliberately not re-asserted in the suite.

The two symlink-containment tests skip where creating a symlink needs
elevation, rather than passing without having run.

### Documentation

The "what it costs to adopt" summary said five things go into your app and
counted `<ClickToSourceBridge />` among them; the bridge is needed only for
the agent tools. Four are required, and the summary now says which one is not
a component and names `onPointerMissed`, which it had omitted entirely.

Status lines that read `0.1.0` were left behind by the 0.1.1 release. The
ones naming the current version now track it; the ones describing why the
first release was `0.1.0` say so in the past tense.

## 0.1.1

### Security

**The origin check no longer trusts the request's own `Host` header.**
`isAllowedOrigin` compared `Origin` against `request.headers.host`. A
non-browser client sets both, so `Origin: http://evil.test` with
`Host: evil.test` satisfied the comparison. Measured against the 0.1.0
handler, that returned `200` and completed a write into the project root.
An `Origin` is now matched against the dev server's own origins, which the
plugin reads from Vite's resolved URLs.

On reach, corrected after publishing 0.1.1: this one was not reachable.
A browser cannot forge `Host`, so it was never a browser CSRF vector — a
real cross-origin page was rejected in 0.1.0 and still is. Vite's own
`allowedHosts` check answers a forged `Host` before plugin middleware
runs, so a stock Vite server was already covered. The first version of
this entry said the exposed surface was `handleFileRequest`, on the
grounds that its documentation offers it to other dev servers; but the
package does not export it, so no consumer can reach it. That reuse is a
design intention, not a shipped capability.

So this change fixes a check that was wrong in principle, with no
demonstrated path to exploitation. The two below are different: a page
open in the browser could query the bridge cross-origin and receive
`200`, observed directly; and the file endpoints accepted a caller whose
socket was not on loopback.

**Requests from outside this machine are refused by default.**
The endpoints allow a request with no `Origin` header, on the stated
grounds that a local non-browser client could edit those files directly
anyway. That reasoning holds only while the caller is local. Started with
`vite --host`, the dev server is reachable from the network and a plain
`curl` from another machine inherited the allowance, giving read and write
access to anything under the project root.

Loopback is now checked separately from origin. IPv4, IPv6 and
IPv4-mapped loopback are accepted; anything else is refused with
`Remote request rejected` unless the new `allowRemote` option is set.

**The bridge endpoints answer to the same caller policy as the file
endpoints.** The three `/__cts/bridge/*` paths were wired straight to their
handlers and inherited neither the origin check nor the loopback guard.
Measured before the fix: a page on any origin could POST a bridge query and
get `200`. The query surface is read-only, so this was disclosure rather
than write access — but it discloses source file paths, function names and
the argument values a generator was called with, and under `vite --host` it
disclosed them to the network.

The guard now lives in one exported function that every endpoint calls.
Two copies of a policy is how the bridge came to have none. The check runs
before `bridge` is consulted, so a disallowed caller cannot distinguish
"the bridge is off" from "you may not ask".

### Added

- `allowRemote` option on `clickToSource()`, default `false`. Turn it on
  only on a network you control.

### Notes

Neither fix changes the documented behaviour for local use: a same-origin
request from the page, and a no-Origin request from a local client, both
still succeed. That was verified by driving the real overlay in a browser,
not only by tests — an earlier version of the origin fix read Vite's
`resolvedUrls` at the `httpServer` "listening" event, where it is still
`null`, which silently rejected the page's own requests.

## 0.1.0

First release. Five packages: `shared`, `core`, `overlay`, `vite-plugin`
and `mcp`. See the
[v0.1.0 release notes](https://github.com/pun1th01/click-to-source-3d/releases/tag/v0.1.0).

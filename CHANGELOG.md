# Changelog

All five packages are versioned in lockstep.

## 0.1.1

### Security

**The origin check no longer trusts the request's own `Host` header.**
`isAllowedOrigin` compared `Origin` against `request.headers.host`. A
non-browser client sets both, so `Origin: http://evil.test` with
`Host: evil.test` satisfied the comparison. Measured against the 0.1.0
handler, that returned `200` and completed a write into the project root.
An `Origin` is now matched against the dev server's own origins, which the
plugin reads from Vite's resolved URLs.

Two notes on reach. A browser cannot forge `Host`, so this was never a
browser CSRF vector — a real cross-origin page was rejected in 0.1.0 and
still is. And Vite's own `allowedHosts` check answers a forged `Host`
before plugin middleware runs, so a stock Vite server was already covered.
What was exposed is `handleFileRequest` itself, which is documented as
reusable by other dev servers and takes only `node:http` types.

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

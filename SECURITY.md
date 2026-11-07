# Security Policy

## Reporting a vulnerability

**Please don't open a public issue for a security problem.** Report it privately
through GitHub instead:

**[Report a vulnerability](https://github.com/pun1th01/click-to-source-3d/security/advisories/new)**

Say what you found, how to reproduce it, and what an attacker could do with it.
A small project that shows the problem helps most.

This project has one maintainer, so a reply may take a few days. Once a fix is
out, the report is published with credit to you, unless you'd rather stay
anonymous.

## Supported versions

Fixes go into the latest release. Please check that the problem still happens
there before reporting it.

## What counts

Click-to-Source runs on your development machine, and its dev server can read and
rewrite your source files. These are the kinds of problem worth reporting:

- A website you visit, or another machine on your network, reaching the
  `/__cts/` endpoints or the scene bridge. They should answer only to the page
  itself and to programs on your machine, unless you turn on `allowRemote`.
- Reading or changing a file outside what the endpoints allow: source files inside
  Vite's `server.fs.allow`, with an allowed extension.
- Any inspector code, stamped source information or endpoint reaching a production
  build, unless you opted in with `stampSource: "always"`.
- A problem in `npx click-to-source-3d init`, such as it changing files beyond
  those it says it changes.

## What doesn't

- **Anything possible only with `allowRemote: true`** on a network you don't control.
  The option's documentation warns against that.
- **A program already running on your machine** using the endpoints. They admit
  local programs on purpose, because that's how the MCP server works, and such a
  program could edit your files directly anyway.
- **What an AI assistant does with the access you give it.** Tools you connect can
  read your source and edit values, and the assistant may send what it reads to its
  own model. Review its changes as you would anyone's.
- **Vulnerabilities in a dependency** with no way to reach them through this project.
  Those belong with the dependency.

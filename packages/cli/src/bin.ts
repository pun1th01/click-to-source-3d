#!/usr/bin/env node
// The executable. Kept apart from cli.ts so tests can import that without
// running anything, and so nothing depends on comparing a module URL with
// argv[1] — which an npm bin symlink makes differ on macOS and Linux.
import { main } from "./cli.js";

main(process.argv.slice(2)).then((code) => {
  process.exitCode = code;
});

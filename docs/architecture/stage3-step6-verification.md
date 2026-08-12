# Stage 3 Step 6 - Minimal Vite File I/O Verification

## Purpose

Step 6 adds the development-server file transport foundation needed by later
editing work. It exposes local read and write endpoints through the existing
Vite server used by `packages/examples`.

No source parsing, AST work, provenance resolution, editable UI, Babel,
magic-string, custom HMR, or source discovery was added.

## Implementation

The plugin is implemented in
`packages/examples/vite-file-io.ts` and registered by
`packages/examples/vite.config.ts`.

The plugin uses Vite's `apply: "serve"` setting and
`configureServer()` middleware. It does not create a separate server and is
not included in the production client bundle.

## Endpoint Contracts

### Read

```text
POST /__cts/read-file
```

Request:

```json
{
  "file": "src/main.tsx"
}
```

Success response:

```json
{
  "content": "..."
}
```

### Write

```text
POST /__cts/write-file
```

Request:

```json
{
  "file": "relative/path/to/file.tsx",
  "content": "..."
}
```

Success response:

```json
{
  "success": true
}
```

The write operation sends the supplied string directly to `fs.writeFile` with
UTF-8 encoding. It does not format, parse, normalize, or otherwise transform
the content. Existing files are overwritten; a missing file may be created if
its parent directory already exists.

## Path Safety

Requested paths are resolved relative to the Vite-resolved project root for
the examples application (`packages/examples`). Absolute paths, null bytes,
`..` traversal, and both `/` and `\\` separator traversal attempts are
rejected. Existing symlink components are resolved before the containment
check so a path cannot use a symlink to escape the root.

Invalid paths return a generic `400` response. The implementation does not
include filesystem paths or other unnecessary details in error responses.

## Error Handling

| Condition | Response |
|---|---|
| Missing or invalid JSON/body fields | `400 { "error": "Invalid request body" }` |
| Absolute or escaping path | `400 { "error": "Invalid file path" }` |
| Missing file during read | `404 { "error": "File not found" }` |
| Non-POST request | `405 { "error": "Method not allowed" }` |
| Other filesystem failure | `500 { "error": "Filesystem failure" }` |

## Verification Methodology

`packages/examples/test/vite-file-io.test.ts` starts an isolated Vite dev
server with the plugin, then removes its temporary fixture directory during
cleanup. The tests verify:

1. Reading the existing `src/main.tsx` file.
2. Writing a temporary fixture containing CRLF, LF, and Unicode content.
3. Reading the fixture back through the endpoint.
4. Exact equality between written and read-back content.
5. Invalid request handling.
6. Missing-file handling.
7. Windows-style traversal rejection.
8. Absolute-path rejection.

## Verification Results

```text
npx vitest run packages/examples/test/vite-file-io.test.ts --reporter=verbose
3 tests passed

npx tsc --ignoreConfig --noEmit ... vite-file-io.ts vite.config.ts
passed

npx tsc -b packages/shared packages/core packages/overlay
passed

npm run test --workspace=@click-to-source/core
6 tests passed

npm run test --workspace=@click-to-source/overlay
4 tests passed

npm run build --workspace=@click-to-source/examples
passed - Vite 8.2.1
```

The production Vite build succeeds. The file-I/O plugin is development-only
and no endpoint route is added to the browser application code.

## Files Changed

| File | Change |
|---|---|
| `packages/examples/vite-file-io.ts` | Added the development-only Vite middleware plugin. |
| `packages/examples/vite.config.ts` | Registered the plugin with the existing React plugin. |
| `packages/examples/test/vite-file-io.test.ts` | Added independent endpoint and path-safety tests. |
| `docs/architecture/stage3-step6-verification.md` | Added this verification record. |

## Limitations

This is intentionally a local development MVP. It has no authentication,
authorization, source editing UI, AST awareness, automatic instrumentation,
custom HMR, or production API behavior. Later steps must produce the edited
content before calling the write endpoint.

## Step 6 Result

Stage 3 Step 6 is **COMPLETE**.

Stage 3 Step 7 has **NOT** started.

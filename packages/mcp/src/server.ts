#!/usr/bin/env node
import { createRequire } from "node:module";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { ActivityReporter, agentName } from "./activity.js";
import {
  getCanvasScreenshot,
  getInstanceProvenance,
  getSelection,
  highlightObject,
  listSceneProvenance,
  resolveAtPoint,
} from "./bridge.js";
import {
  DevServerError,
  DevServerTimeoutError,
  DevServerUnreachableError,
} from "./devServer.js";
import { findDevServer, versionMismatch } from "./discovery.js";
import {
  editParameterTool,
  getSource,
  listFiles,
  listProvenance,
  searchByGenerator,
  type ToolContext,
} from "./tools.js";

/**
 * Where the dev server is and which project it serves, worked out on every
 * call rather than once at startup: an assistant usually starts this server
 * before the developer runs `npm run dev`, and Vite may land on another port
 * than the one it landed on last time.
 *
 * The environment variables, when set, win. Otherwise the dev server's own
 * announcement is used, and failing that the Vite default, which produces
 * the "no dev server reachable" error with its remedy.
 */
function currentContext(): ToolContext {
  const announced = process.env.CTS_DEV_SERVER ? null : findDevServer(process.cwd());

  return {
    origin: process.env.CTS_DEV_SERVER ?? announced?.origin ?? "http://localhost:5173",
    root: process.env.CTS_PROJECT_ROOT ?? announced?.root ?? process.cwd(),
  };
}

const INSTRUCTIONS =
  "Click-to-Source connects you to the developer's running 3D scene. When they " +
  'say "this", "these", "that mesh" or "the one I clicked", call get_selection ' +
  "first: it returns the objects they are pointing at in the browser, each with " +
  "its source location and editable values. To change a value, pass its file, " +
  "line, column and raw text to edit_parameter, which Vite then hot-reloads. To " +
  "see the scene, call get_canvas_screenshot. To show them which object you mean, " +
  "call highlight_object.";

const TOOLS = [
  {
    name: "get_selection",
    description:
      "What the developer is pointing at in the running scene. Call this whenever " +
      'they refer to objects without naming them: "make this bigger", "why are ' +
      'these so slow", "the one I clicked". `pointing` lists the objects they ' +
      "deliberately pointed you at, in order; act on these first. `selected` is " +
      "the object open in their inspector panel, and is what they mean if " +
      "`pointing` is empty. Each object has its source file, component and line, " +
      "its `props` with the exact line, column and raw text of every editable " +
      "value, its transform and its rendering cost. A value with `via` is a " +
      "constant, and its line and column are the constant's declaration, so " +
      "changing it changes every use. Empty means they have not pointed at " +
      "anything, so ask them to.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "highlight_object",
    description:
      "Outline objects on the developer's screen, in a colour of their own, to " +
      'show them what you mean: "this is the tree I am changing". Names objects ' +
      "by file and line, as get_selection and list_scene_provenance report them. " +
      "Add `ordinal` for one of several objects from one line, and `instanceId` " +
      "for one instance of an InstancedMesh. The outline lasts `seconds`, 15 by " +
      "default. An empty list clears it. Reports what it found and what it did not.",
    inputSchema: {
      type: "object",
      properties: {
        targets: {
          type: "array",
          items: {
            type: "object",
            properties: {
              file: { type: "string" },
              line: { type: "number" },
              ordinal: { type: "number" },
              instanceId: { type: "number" },
            },
            required: ["file", "line"],
          },
        },
        seconds: { type: "number", description: "How long the outline lasts, up to 120" },
        pageId: { type: "number", description: "Required when several pages are open" },
      },
      required: ["targets"],
    },
  },
  {
    name: "get_canvas_screenshot",
    description:
      "A picture of the running scene, as the developer sees it, with any outlines " +
      "but without the page around the canvas or the inspector panel. Use it to see " +
      "what an object looks like, to find something to ask about with " +
      "resolve_at_point, or to check a change after an edit. `via` is `frame` for a " +
      "frame the app drew itself. It is `direct` when the tab is in the background " +
      "and the scene was drawn just for this, without any post-processing.",
    inputSchema: {
      type: "object",
      properties: {
        maxSize: { type: "number", description: "Longest edge in pixels. Default 1024, up to 2048." },
        pageId: { type: "number", description: "Required when several pages are open" },
      },
    },
  },
  {
    name: "get_source",
    description:
      "Read a source file from the running Click-to-Source project. Pass no " +
      "line bounds at all to read the whole file, or `around` to read a window " +
      "centred on one line — which is the usual next step after list_provenance " +
      "or resolve_at_point hands you a line. Subject to the same extension " +
      "allowlist as the overlay panel, so only editable source files are " +
      "reachable.",
    inputSchema: {
      type: "object",
      properties: {
        file: {
          type: "string",
          description: "Path relative to the Vite project root, e.g. src/components/Trees.jsx",
        },
        around: {
          type: "number",
          description:
            "1-indexed line to centre a window on. Reads contextLines either " +
            "side. Ignored for whichever bound startLine or endLine supplies.",
        },
        contextLines: {
          type: "number",
          description: "Lines either side of `around`. Defaults to 20.",
        },
        startLine: {
          type: "number",
          description: "1-indexed, inclusive. Overrides the start of `around`.",
        },
        endLine: {
          type: "number",
          description: "1-indexed, inclusive. Overrides the end of `around`.",
        },
      },
      required: ["file"],
    },
  },
  {
    name: "edit_parameter",
    description:
      "Rewrite one literal in source, through the same AST editor the panel uses. " +
      "Only that literal changes; formatting is preserved, and the developer sees " +
      "the edit in their activity log. Name it exactly, with the line, column and " +
      "raw text from a value in get_selection or resolve_at_point's props. Or, for " +
      "a hand-written sourceRef, by argName. Fails with STALE_LOCATION, " +
      "ARGUMENT_NOT_FOUND, LOCATION_NOT_FOUND or AMBIGUOUS_LOCATION rather than " +
      "editing the wrong thing. Vite hot-reloads the result.",
    inputSchema: {
      type: "object",
      properties: {
        file: { type: "string" },
        line: {
          type: "number",
          description:
            "Line of the literal. By argName, use the declaredLine reported by " +
            "list_provenance, which is often not the line the sourceRef sits on.",
        },
        column: {
          type: "number",
          description: "1-based column of the literal, from a value's `column`. Needs `expected`.",
        },
        expected: {
          type: "string",
          description: "The literal's current source text, from a value's `raw`.",
        },
        argName: { type: "string", description: "The argument's name, instead of column and expected." },
        newValue: { description: "String, number, boolean or null" },
      },
      required: ["file", "line", "newValue"],
    },
  },
  {
    name: "list_files",
    description:
      "List the source files the scanning tools can see, for when you do not " +
      "know what the project contains. This is not a file browser: it reports " +
      "exactly the set the provenance scan would read — recognised source " +
      "extensions under the project root, excluding dotfiles, node_modules, " +
      "dist, build, .git, .vite and coverage, and not following symlinks. " +
      "Files outside that set are invisible here whether or not they exist. " +
      "Reads no contents. Reports the root it walked, and whether it stopped " +
      "at the scan limit before finishing.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "list_provenance",
    description:
      "List every hand-written sourceRef in the project, by static scan. " +
      "Reports what the source says, not what is currently rendered — an object " +
      "only exists after a mount, and this cannot see the running scene. " +
      "An empty result means no hand-written sourceRef, NOT that the project " +
      "has no provenance: locations stamped by the Vite plugin live in " +
      "transformed output, are invisible to this scan, and still resolve " +
      "through the panel and through list_scene_provenance, resolve_at_point " +
      "and get_instance_provenance. Use list_files to see what source exists.",
    inputSchema: {
      type: "object",
      properties: {
        file: { type: "string", description: "Restrict to one file" },
      },
    },
  },
  {
    name: "resolve_at_point",
    description:
      "Resolve whatever is under a point in the RUNNING scene. Coordinates are " +
      "normalised device coordinates, -1 to 1. Needs the dev server running and " +
      "the app open in a browser tab; nothing else to set up. The answer " +
      "includes the object's editable props, each with its exact line and " +
      "column. Reports disconnected, no_scene, ambiguous or timeout rather than " +
      "failing silently — each has a different remedy.",
    inputSchema: {
      type: "object",
      properties: {
        x: { type: "number", description: "-1 (left) to 1 (right)" },
        y: { type: "number", description: "-1 (bottom) to 1 (top)" },
        pageId: { type: "number", description: "Required when several pages are open" },
      },
      required: ["x", "y"],
    },
  },
  {
    name: "list_scene_provenance",
    description:
      "Every stamped object currently in the running scene, with its address " +
      "and instance count. Unlike list_provenance this reports what is " +
      "rendered, not what the source declares — which is the only way to see " +
      "instanced objects, since their provenance exists at runtime only.",
    inputSchema: {
      type: "object",
      properties: {
        pageId: { type: "number" },
      },
    },
  },
  {
    name: "get_instance_provenance",
    description:
      "Provenance for one addressed object, or one instance within an " +
      "InstancedMesh. Addresses come from list_scene_provenance and are " +
      "{file, function, line, ordinal} — derived from the source location " +
      "rather than from Object3D.uuid, which is regenerated on every remount. " +
      "Read-only: an instance's transform comes from a seeded RNG, so no " +
      "literal in source corresponds to it.",
    inputSchema: {
      type: "object",
      properties: {
        file: { type: "string" },
        function: { type: "string" },
        line: { type: "number" },
        ordinal: { type: "number", description: "Which object at that call site, from 0" },
        instanceId: { type: "number", description: "Slot within an InstancedMesh" },
        pageId: { type: "number" },
      },
      required: ["file", "function", "line", "ordinal"],
    },
  },
  {
    name: "search_by_generator",
    description:
      "Find provenance sites by generating function or by argument name. " +
      "Answers where a generator declares provenance, not which live objects " +
      "it produced — that requires the running scene.",
    inputSchema: {
      type: "object",
      properties: {
        function: { type: "string", description: "Substring, case-insensitive" },
        argName: { type: "string", description: "Exact argument name" },
      },
    },
  },
];

// Read from the manifest that ships beside dist/. A literal here reported
// 0.1.0 to clients through 0.1.1, because a release bump never touched it.
const { version } = createRequire(import.meta.url)("../package.json") as {
  version: string;
};

const server = new Server(
  { name: "click-to-source", version },
  { capabilities: { tools: {} }, instructions: INSTRUCTIONS }
);

const reporter = new ActivityReporter(currentContext, () => ({
  id: String(process.pid),
  name: agentName(server.getClientVersion()?.name),
}));

server.oninitialized = () => reporter.start();

// The assistant closing its end of the pipe is how an MCP server learns it has
// gone. Without this the page would say it was connected for 15 seconds more.
process.stdin.once("end", () => void reporter.leave());

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const tool = request.params.name;
  const args = (request.params.arguments ?? {}) as Record<string, never>;
  const context = currentContext();
  const started = Date.now();

  try {
    let result: unknown;

    switch (tool) {
      case "get_selection":
        result = await getSelection(context);
        break;
      case "highlight_object":
        result = await highlightObject(context, args as never);
        break;
      case "get_canvas_screenshot":
        result = await getCanvasScreenshot(context, args as never);
        break;
      case "get_source":
        result = await getSource(context, args as never);
        break;
      case "edit_parameter":
        result = await editParameterTool(context, args as never);
        break;
      case "list_files":
        result = await listFiles(context);
        break;
      case "list_provenance":
        result = await listProvenance(context, args as never);
        break;
      case "search_by_generator":
        result = await searchByGenerator(context, args as never);
        break;
      case "resolve_at_point":
        result = await resolveAtPoint(context, args as never);
        break;
      case "list_scene_provenance":
        result = await listSceneProvenance(context, args as never);
        break;
      case "get_instance_provenance": {
        const a = args as unknown as {
          file: string;
          function: string;
          line: number;
          ordinal: number;
          instanceId?: number;
          pageId?: number;
        };
        result = await getInstanceProvenance(context, {
          address: {
            file: a.file,
            function: a.function,
            line: a.line,
            ordinal: a.ordinal,
            instanceId: a.instanceId,
          },
          pageId: a.pageId,
        });
        break;
      }
      default:
        throw new Error(`Unknown tool: ${tool}`);
    }

    reporter.call(tool, args, { result }, Date.now() - started);

    const warning = process.env.CTS_DEV_SERVER
      ? null
      : versionMismatch(findDevServer(process.cwd())?.version, version);
    if (warning) {
      result = { ...(result as object), warning };
    }

    // A picture goes to the assistant as a picture, not as text it has to decode.
    const image = (result as { result?: { status?: string; data?: string; mimeType?: string } }).result;
    if (tool === "get_canvas_screenshot" && image?.status === "ready" && image.data && image.mimeType) {
      const { data, ...about } = image;
      return {
        content: [
          { type: "image", data, mimeType: image.mimeType },
          { type: "text", text: JSON.stringify(about, null, 2) },
        ],
      };
    }

    return {
      content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
    };
  } catch (error) {
    // Failures are returned as tool errors rather than thrown, so the agent
    // sees the reason and can correct. The typed edit codes in particular are
    // actionable: a wrong line is recoverable, a missing dev server is not
    // recoverable by retrying.
    const detail =
      error instanceof DevServerError
        ? `${error.message}${error.code ? ` (${error.code})` : ""}`
        : error instanceof DevServerTimeoutError ||
            error instanceof DevServerUnreachableError
          ? error.message
          : error instanceof Error
            ? error.message
            : "Unknown failure";

    reporter.call(tool, args, { error: detail }, Date.now() - started);

    return {
      isError: true,
      content: [{ type: "text", text: detail }],
    };
  }
});

await server.connect(new StdioServerTransport());

#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import {
  getInstanceProvenance,
  listSceneProvenance,
  resolveAtPoint,
} from "./bridge.js";
import {
  DevServerError,
  DevServerTimeoutError,
  DevServerUnreachableError,
} from "./devServer.js";
import {
  editParameterTool,
  getSource,
  listFiles,
  listProvenance,
  searchByGenerator,
  type ToolContext,
} from "./tools.js";

const context: ToolContext = {
  origin: process.env.CTS_DEV_SERVER ?? "http://localhost:5173",
  root: process.env.CTS_PROJECT_ROOT ?? process.cwd(),
};

const TOOLS = [
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
      "Rewrite one argument at a source location, through the same AST editor " +
      "the panel uses. Only the named literal changes; formatting is preserved. " +
      "Fails with ARGUMENT_NOT_FOUND, LOCATION_NOT_FOUND or AMBIGUOUS_LOCATION " +
      "rather than editing the wrong thing. Vite hot-reloads the result.",
    inputSchema: {
      type: "object",
      properties: {
        file: { type: "string" },
        line: {
          type: "number",
          description:
            "Line the argument is declared on. Use the declaredLine reported " +
            "by list_provenance, which is often not the line the sourceRef sits on.",
        },
        argName: { type: "string" },
        newValue: { description: "String, number, boolean or null" },
      },
      required: ["file", "line", "argName", "newValue"],
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
      "normalised device coordinates, -1 to 1. Needs the app open in a browser " +
      "with bridge: true and <ClickToSourceBridge /> in the Canvas. Reports " +
      "disconnected, no_scene, ambiguous or timeout rather than failing " +
      "silently — each has a different remedy.",
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

const server = new Server(
  { name: "click-to-source", version: "0.1.3" },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const args = (request.params.arguments ?? {}) as Record<string, never>;

  try {
    let result: unknown;

    switch (request.params.name) {
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
        throw new Error(`Unknown tool: ${request.params.name}`);
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

    return {
      isError: true,
      content: [{ type: "text", text: detail }],
    };
  }
});

await server.connect(new StdioServerTransport());

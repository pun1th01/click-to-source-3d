#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { BridgeUnavailableError, resolveAtPoint } from "./bridge.js";
import {
  DevServerError,
  DevServerTimeoutError,
  DevServerUnreachableError,
} from "./devServer.js";
import {
  editParameterTool,
  getSource,
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
      "Read a source file from the running Click-to-Source project, optionally " +
      "a line range. Subject to the same extension allowlist as the overlay " +
      "panel, so only editable source files are reachable.",
    inputSchema: {
      type: "object",
      properties: {
        file: {
          type: "string",
          description: "Path relative to the Vite project root, e.g. src/components/Trees.jsx",
        },
        startLine: { type: "number", description: "1-indexed, inclusive" },
        endLine: { type: "number", description: "1-indexed, inclusive" },
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
    name: "list_provenance",
    description:
      "List every declared provenance site in the project, by static scan. " +
      "Reports what the source says, not what is currently rendered — an object " +
      "only exists after a mount, and this cannot see the running scene.",
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
      "RESERVED, not yet available. Would resolve the object under a screen " +
      "point in the running scene. Requires a browser bridge that is not " +
      "built: nothing outside the page can hold a THREE.Object3D. Returns a " +
      "terminal error — retrying will not help. Use list_provenance for the " +
      "source-side view.",
    inputSchema: {
      type: "object",
      properties: {
        x: { type: "number", description: "Normalised device coordinate, -1 to 1" },
        y: { type: "number", description: "Normalised device coordinate, -1 to 1" },
      },
      required: ["x", "y"],
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
  { name: "click-to-source", version: "0.1.0" },
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
      case "list_provenance":
        result = await listProvenance(context, args as never);
        break;
      case "search_by_generator":
        result = await searchByGenerator(context, args as never);
        break;
      case "resolve_at_point":
        resolveAtPoint();
        break;
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
      error instanceof BridgeUnavailableError
        ? error.message
        : error instanceof DevServerError
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

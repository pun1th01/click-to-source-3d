/**
 * Represents the provenance metadata of a generated object.
 * This is the finalized v0.1 shape from Stage 2.
 */
export type SourceRef = {
  file: string;
  function: string;
  line: number;
  args: Record<string, unknown>;
  /**
   * Optional map from an `args` display key to the identifier as actually
   * declared in source. Required only when the two differ — e.g. a display
   * key of `waterLevel` for a constant declared `WATER_LEVEL`. Keys absent
   * from this map resolve to themselves, so omitting the field entirely
   * preserves the pre-existing behaviour.
   */
  argSources?: Record<string, string>;
  schemaVersion?: number;
};

/**
 * Per-instance provenance entry for InstancedMesh-based generators.
 *
 * Stored as `userData.instanceSourceRefs: InstanceSourceRef[]` on the
 * InstancedMesh, keyed 1:1 by Three.js instanceId.
 *
 * @see Stage 5 architecture addendum — docs/architecture/stage5-instanced-mesh-support.md
 */
export type InstanceSourceRef = {
  /** The provenance metadata for this specific instance. */
  sourceRef: SourceRef;
};

/**
 * The dev-server endpoints backing the source-edit round trip.
 *
 * Both halves of the contract import these: the browser client in
 * `@click-to-source-3d/overlay` and the dev-server plugin in
 * `@click-to-source-3d/vite-plugin`. A single definition is what keeps the two
 * sides from drifting apart silently — a mismatch leaves the panel able to
 * resolve provenance but unable to write anything back, with no error to
 * point at.
 *
 * These are the first runtime values in this package. Consumers that
 * previously erased their import of it entirely will now carry a real one.
 */
export const READ_FILE_PATH = "/__cts/read-file";
export const WRITE_FILE_PATH = "/__cts/write-file";

/**
 * A request to rewrite a single value in a source file.
 *
 * Two modes, chosen by whether `column` is present.
 *
 * **By position** — `line`, `column` and `expected`. Names the literal itself:
 * the one starting at that line and column, whose source text must still be
 * `expected`. This is what the inspector sends for values the build step
 * found, since it knows exactly where each one is. If the file has changed so
 * that the position no longer holds that text, the edit is refused with
 * `STALE_LOCATION` rather than landing on something else.
 *
 * **By name** — `line` and `argName`. Finds a literal named `argName` whose
 * own line, or the line of an enclosing call, element or object, is `line`.
 * This is what a hand-written `sourceRef` and the MCP `edit_parameter` tool
 * send. `argName` is the identifier as declared in source, which is not
 * always the panel's display key — see `SourceRef.argSources`.
 */
export type EditRequest = {
  file: string;
  line: number;
  /** Required by name; descriptive only by position. */
  argName?: string;
  /** 1-based. Present for an edit by position. */
  column?: number;
  /** The literal's current source text. Required with `column`. */
  expected?: string;
  newValue: unknown;
};

/**
 * Why a source edit failed. Returned to the client as the `code` field
 * alongside the human-readable `error` message.
 */
export type SourceEditErrorCode =
  | "INVALID_REQUEST"
  | "PARSE_ERROR"
  | "ARGUMENT_NOT_FOUND"
  | "LOCATION_NOT_FOUND"
  | "AMBIGUOUS_LOCATION"
  | "STALE_LOCATION"
  | "UNSUPPORTED_VALUE";

/** The dev-server endpoint that opens a file at a line in the editor. */
export const OPEN_IN_EDITOR_PATH = "/__cts/open";

/**
 * Where running dev servers announce themselves, under the OS temp directory.
 *
 * Each listening server writes one JSON file, a {@link DevServerEntry}, and
 * removes it on close. The MCP server reads them to find the dev server
 * without being told its address — which also covers a port Vite moved to
 * because the default was taken.
 */
export const DEV_SERVER_REGISTRY = "click-to-source/servers";

export type DevServerEntry = {
  /** e.g. http://localhost:5173 */
  origin: string;
  /** The Vite root: what stamped paths are relative to. */
  root: string;
  pid: number;
  /** The plugin's version. */
  version: string;
  startedAt: number;
};

/**
 * One value in a stamped prop: a literal the inspector can edit in place, or
 * an expression it can only show.
 */
export type StampedValue = {
  /** Source text: the literal as written, or the whole expression. */
  raw: string;
  /** The literal's value when the stamp was made. Absent for an expression. */
  value?: string | number | boolean | null;
  /** Whether `line` and `column` name a literal that can be rewritten. */
  editable: boolean;
  /** 1-based position of the literal. Present when editable. */
  line?: number;
  column?: number;
  /**
   * The constant the value was read through, when the prop names one —
   * `BOX_HEIGHT` in `args={[1.2, BOX_HEIGHT]}`. `line` and `column` then point
   * at the constant's declaration, which is where an edit has to land.
   */
  via?: string;
};

/**
 * One prop of a stamped element, or of a geometry or material inside it.
 *
 * Found by the build step, so values become editable without any
 * hand-written metadata. `values` has one entry for a scalar prop and one per
 * element for an array literal such as `position={[0, 1, 2]}`.
 */
export type StampedProp = {
  /** The element the prop is written on: `mesh`, `BoxGeometry`, … */
  element: string;
  name: string;
  array: boolean;
  values: StampedValue[];
  /**
   * The file the values are in, when an object is described along with parts
   * that came from elsewhere, such as a geometry built in another module.
   */
  file?: string;
};

/** The numbers on one line of a function, with the line for context. */
export type SourceNumbers = {
  line: number;
  /** The line as written, trimmed and shortened. */
  text: string;
  values: StampedValue[];
};

/** Which argument a function parameter takes its value from. */
export type SourceParam = {
  /** `...rest`: one argument at the call is only the first of what it holds. */
  rest?: boolean;
  name: string;
  /** Position in the call. */
  arg: number;
  /** The property of that argument, for a destructured parameter. */
  key?: string;
};

/** A function a generator calls: its helpers, such as a noise function. */
export type UsedFunction = {
  name: string;
  /** How deep in the chain of helpers: 0 is called by the generator itself. */
  depth: number;
  /** Absent for a function from a package, which has `package` instead. */
  file?: string;
  line?: number;
  column?: number;
  /** The package it comes from, when it isn't project code. */
  package?: string;
  params?: string[];
  numbers?: SourceNumbers[];
};

/**
 * The function that made an object, as the build step read it: what it takes,
 * the numbers in it, and the helpers it calls.
 */
export type SourceFunction = {
  /** `file:line:column`, which a call site names to say what it is calling. */
  id: string;
  name: string;
  file: string;
  line: number;
  column?: number;
  params: SourceParam[];
  numbers: SourceNumbers[];
  uses: UsedFunction[];
};

/**
 * One call in the chain that led to an object being made.
 *
 * Unlike everything else here this is recorded as the code runs, so `args`
 * holds what was really passed. An argument written as a literal at the call
 * site also has its position, which is what makes it editable.
 */
export type TraceFrame = {
  name: string;
  file: string;
  line: number;
  column?: number;
  args: Array<{ name: string; value: string; literal?: StampedValue }>;
  /** Where the call was made, when the caller is project code. */
  calledAt?: { file: string; line: number; column?: number };
};

/**
 * Location stamped onto `userData.__ctsSource` by the build-time transform in
 * `@click-to-source-3d/vite-plugin`.
 *
 * `props` lists what the element's own position can tell about its values:
 * every literal prop, with where it is. It names nothing about meaning — which
 * values matter to a generator is still what a hand-written `sourceRef` says,
 * and the resolver merges the two.
 */
export type SourceStamp = {
  file: string;
  function: string;
  line: number;
  /** 1-based column of the element's opening `<`, or of the `new`. */
  column?: number;
  props?: StampedProp[];
  /** The class as written at the site: `Mesh`, `Tree`, `GLTFLoader`. */
  creates?: string;
  /** How the site makes it. Absent for a JSX element. */
  how?: "new" | "clone" | "load";
  /** What the build step read about the enclosing function. */
  generator?: SourceFunction;
};

/** What is known about one object that isn't written on the object itself. */
export type ObjectRecord = {
  stamp: SourceStamp;
  /** The calls that led to it, outermost first. */
  trace: TraceFrame[];
};

/**
 * A hand-written `userData.sourceRef` when a stamp is also present.
 *
 * Authors need only write the fields they are overriding — most often `args`
 * alone, letting file, function and line come from the stamp.
 */
export type PartialSourceRef = Partial<SourceRef>;

/** Where a program on this machine asks the open page a question. */
export const BRIDGE_QUERY_PATH = "/__cts/bridge/query";

/**
 * Bridge events on Vite's own HMR websocket.
 *
 * That socket is already open to every page Vite serves, so riding on it
 * costs nothing per tab.
 *
 * A page announces itself with HELLO, receives questions as QUERY, and
 * answers each with REPLY carrying the same `requestId`.
 */
export const BRIDGE_HELLO_EVENT = "cts:bridge:hello";
export const BRIDGE_QUERY_EVENT = "cts:bridge:query";
export const BRIDGE_REPLY_EVENT = "cts:bridge:reply";

/**
 * Where a thing came from, as an address in source rather than an object
 * identity.
 *
 * `Object3D.uuid` is regenerated on construction, so a remount invalidates
 * every uuid an agent holds — measured at 8 distinct uuids becoming 11 after
 * one edit. An address derived from the stamped call site survives that,
 * because it changes only when the code changes.
 *
 * `ordinal` disambiguates the several meshes one JSX element can produce: a
 * map over colour groups yields three meshes all stamped at the same line,
 * in deterministic order.
 */
export type ProvenanceAddress = {
  file: string;
  function: string;
  line: number;
  ordinal: number;
  /** Present when addressing one instance within an InstancedMesh. */
  instanceId?: number;
};

/** Lifecycle of the page the bridge talks to. */
export type BridgeStatus =
  | "disconnected"
  | "no_scene"
  | "ambiguous"
  | "ready";

/**
 * Names objects in the running scene from outside it: every object stamped at
 * a line, or with `ordinal`, one of them, or with `instanceId`, one instance.
 */
export type ObjectRef = {
  file: string;
  line: number;
  ordinal?: number;
  instanceId?: number;
};

export type BridgeQuery =
  | { kind: "resolve_at_point"; x: number; y: number }
  | { kind: "get_instance_provenance"; address: ProvenanceAddress }
  | { kind: "list_scene_provenance" }
  /** Answered by the dev server, from what the page last published. */
  | { kind: "get_selection" }
  /** Outlines objects on the developer's screen; an empty list clears them. */
  | { kind: "highlight_objects"; targets: ObjectRef[]; seconds?: number }
  /** A picture of the main canvas, as the developer sees it. */
  | { kind: "capture_canvas"; maxSize?: number };

/** Where an assistant reports itself and each tool call it makes. */
export const AGENT_REPORT_PATH = "/__cts/agent/report";

/**
 * Agent events on Vite's HMR websocket.
 *
 * SELECTION goes from the page to the dev server whenever what the developer
 * has selected or pointed at changes. STATE and ACTIVITY go the other way:
 * STATE is the whole picture, sent when a page says hello and when an
 * assistant comes or goes; ACTIVITY is one more tool call.
 */
export const AGENT_SELECTION_EVENT = "cts:agent:selection";
export const AGENT_STATE_EVENT = "cts:agent:state";
export const AGENT_ACTIVITY_EVENT = "cts:agent:activity";

/** An assistant connected through the MCP server. */
export type AgentInfo = {
  /** Identifies one MCP server process. */
  id: string;
  /** As a person would write it: "Claude Code". */
  name: string;
  /** When its last tool call finished, if it has made one. */
  lastCallAt: number | null;
};

/** What a line in the activity log can lead to. */
export type ActivityTarget = ObjectRef & { column?: number };

/**
 * One tool call, in plain words.
 *
 * `effect` says what the call did to the developer's world: `read` left it
 * alone, `edit` changed a source file, `point` drew on their screen.
 */
export type AgentActivity = {
  /** Assigned by the dev server, increasing. */
  id: number;
  /** Assigned by the dev server, when it heard about the call. */
  at: number;
  agent: string;
  tool: string;
  /** What was asked: `src/World.tsx lines 21-61`. May be empty. */
  detail: string;
  /** What came back: `9 objects`, `1.5 -> 2.5`. */
  result: string;
  status: "ok" | "error";
  effect: "read" | "edit" | "point";
  durationMs: number;
  targets: ActivityTarget[];
};

/** What the MCP server sends: itself, and the call it just finished, if any. */
export type AgentReport = {
  agent: { id: string; name: string };
  activity?: Omit<AgentActivity, "id" | "at" | "agent">;
  /** The assistant has gone away. */
  leaving?: boolean;
};

export type AgentState = { agents: AgentInfo[]; log: AgentActivity[] };

/**
 * What drawing one object costs, across itself and everything under it.
 *
 * `drawCalls` and `triangles` are what one frame asks of the GPU if all of it
 * is on screen, before shadow passes. They are worked out from the object, not
 * measured, so a culled object still reports what it would cost.
 */
export type ObjectCost = {
  meshes: number;
  drawCalls: number;
  triangles: number;
  vertices: number;
  /** One InstancedMesh's instances. Null when the object is not instanced. */
  instances: number | null;
  /** Vertex and index buffers. */
  geometryBytes: number;
  materials: number;
  textures: Array<{
    /** The material property holding it: `map`, `normalMap`. */
    slot: string;
    width: number | null;
    height: number | null;
    /** An estimate of GPU memory, mipmaps included. Null when unknown. */
    bytes: number | null;
  }>;
  /** Estimated GPU memory across `textures`. */
  textureBytes: number;
  /** Drawn again for every shadow-casting light that reaches it. */
  castsShadow: boolean;
};

/**
 * One object the developer selected or pointed at, as an assistant reads it.
 *
 * `props` carry the exact position of each value, which is what
 * `edit_parameter` takes to rewrite one.
 */
export type PointedObject = {
  kind: string;
  name: string | null;
  /** Set when one instance of an InstancedMesh is meant. */
  instanceId: number | null;
  /** Null when nothing in the object's parent chain names a source. */
  source: { file: string; function: string; line: number; column?: number } | null;
  address: ProvenanceAddress | null;
  /** The chain of parents, nearest first, for an object with no source. */
  parents: string[];
  props: StampedProp[];
  /** Where it is. For an instance, that instance's placement. */
  transform: {
    position: number[];
    rotation: number[];
    scale: number[];
    worldPosition: number[];
  };
  /** Each material's type and colour: `MeshStandardMaterial #c2643c`. */
  materials: string[];
  cost: ObjectCost | null;
  /** The calls that led to this object, with the values they were given. */
  trace: TraceFrame[];
  /**
   * The functions that made it: its own first, then its geometry's and material's
   * where those were made elsewhere. Their parameters, numbers and helpers.
   */
  generators: SourceFunction[];
  /** How the object was made: `new`, `clone` or `load`. Null for JSX. */
  how: "new" | "clone" | "load" | null;
  /** Where it sits inside what its source made, such as a loaded model: `Sword › Blade`. */
  modelPath: string | null;
};

/** What a page publishes as AGENT_SELECTION_EVENT. */
export type PageSelection = {
  /** What the developer deliberately pointed the assistant at, in order. */
  pointing: PointedObject[];
  /** The object open in the inspector's panel, if any. */
  selected: PointedObject | null;
};

/** Where the inspector asks whether the assistant tools are set up, and sets them up. */
export const MCP_SETUP_PATH = "/__cts/mcp";

/** What a project's MCP configuration says about this server. */
export type McpSetupStatus = {
  /** The folder the files are in, by name: where to start the assistant. */
  folder: string;
  /** Files that register the server, relative to that folder. */
  registered: string[];
  /** What a request to set it up wrote just now. */
  written: string[];
  /** Files that couldn't be edited, and why. Left for a person to fix. */
  problems: Array<{ file: string; reason: string }>;
  /** The assistant this project shows signs of, if any. */
  assistant: string | null;
};

export const MCP_SERVER_NAME = "click-to-source";
export const MCP_PACKAGE = "@click-to-source-3d/mcp";

/**
 * The entry that starts the MCP server, for an assistant's config file.
 *
 * `npx -y <package>` runs the copy installed in the project when there is one,
 * and fetches it otherwise, so the entry works from the repository root of a
 * monorepo whose app is further down. On Windows, MCP clients spawn commands
 * without a shell, and npx is a .cmd script there, so it goes through `cmd /c`.
 */
export function mcpServerEntry(platform: string): { command: string; args: string[] } {
  const run = ["npx", "-y", MCP_PACKAGE];
  return platform === "win32"
    ? { command: "cmd", args: ["/c", ...run] }
    : { command: run[0], args: run.slice(1) };
}

export type McpMergeResult =
  | { status: "added"; text: string }
  | { status: "already" }
  | { status: "invalid"; reason: string };

/**
 * Adds the server to an MCP config file's text, or starts one.
 *
 * An existing entry of the same name is left as it is: the developer may have
 * changed it. A file that isn't valid JSON is never rewritten; the caller says
 * what to add by hand instead. `vscode` is VS Code's own format, which calls the
 * list `servers` and wants each entry to say how it is reached.
 */
export function mergeMcpConfig(
  existing: string | null,
  platform: string,
  format: "standard" | "vscode" = "standard"
): McpMergeResult {
  const key = format === "vscode" ? "servers" : "mcpServers";
  let config: Record<string, unknown> = {};

  if (existing !== null && existing.replace(/^\uFEFF/, "").trim() !== "") {
    try {
      config = JSON.parse(existing.replace(/^\uFEFF/, "")) as typeof config;
    } catch (error) {
      return { status: "invalid", reason: (error as Error).message };
    }
    if (typeof config !== "object" || config === null || Array.isArray(config)) {
      return { status: "invalid", reason: "it is not a JSON object" };
    }
  }

  const servers = config[key] ?? {};
  if (typeof servers !== "object" || servers === null || Array.isArray(servers)) {
    return { status: "invalid", reason: `its "${key}" is not an object` };
  }
  if (MCP_SERVER_NAME in servers) {
    return { status: "already" };
  }

  const entry = mcpServerEntry(platform);
  config[key] = {
    ...servers,
    [MCP_SERVER_NAME]: format === "vscode" ? { type: "stdio", ...entry } : entry,
  };
  return { status: "added", text: `${JSON.stringify(config, null, 2)}\n` };
}

/** Whether an MCP config file's text registers the server. */
export function registersMcpServer(text: string, format: "standard" | "vscode" = "standard"): boolean {
  try {
    const config = JSON.parse(text.replace(/^\uFEFF/, "")) as Record<string, unknown>;
    const servers = config?.[format === "vscode" ? "servers" : "mcpServers"];
    return typeof servers === "object" && servers !== null && MCP_SERVER_NAME in servers;
  } catch {
    return false;
  }
}

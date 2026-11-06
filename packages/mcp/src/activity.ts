import {
  AGENT_REPORT_PATH,
  type ActivityTarget,
  type AgentReport,
} from "@click-to-source-3d/shared";
import { postJson, type DevServerOptions } from "./devServer.js";

type Activity = NonNullable<AgentReport["activity"]>;

/** How often the MCP server says it is still here. The dev server allows for 15s. */
const HEARTBEAT_MS = 5000;
/** A report is never worth holding anything up for. */
const REPORT_TIMEOUT_MS = 1500;

const KNOWN_CLIENTS: Record<string, string> = {
  "claude-code": "Claude Code",
  "cursor-vscode": "Cursor",
};

/** The client's name for itself as a person would write it. */
export function agentName(client: string | undefined): string {
  if (!client) {
    return "Assistant";
  }
  return (
    KNOWN_CLIENTS[client] ??
    client.replace(/[-_]+/g, " ").replace(/\b[a-z]/g, (letter) => letter.toUpperCase())
  );
}

type Answer = { status?: string; result?: Record<string, unknown>; reason?: string; pages?: unknown[] };

/** Why a bridge call came back with nothing, in words. Null when it has an answer. */
function bridgeFailure(answer: Answer): string | null {
  switch (answer.status) {
    case "answered":
      break;
    case "disabled":
      return "the scene bridge is off";
    case "disconnected":
      return "no page is open";
    case "ambiguous":
      return `${answer.pages?.length ?? "several"} pages are open`;
    case "timeout":
      return "the page did not answer";
    default:
      return "no answer";
  }

  const inner = answer.result?.status;
  switch (inner) {
    case undefined:
    case "ready":
      return null;
    case "no_scene":
      return "no scene yet";
    case "address_not_found":
      return "no such object";
    case "instance_not_recorded":
      return "no such instance";
    default:
      return String(answer.result?.reason ?? answer.result?.message ?? inner);
  }
}

const many = (count: number, one: string) => `${count} ${count === 1 ? one : `${one}s`}`;

/**
 * One tool call as the developer reads it in the inspector's Agent tab. Works
 * from what the call was given and what it returned, and never fails: a report
 * that could not be worded must not become a tool that failed.
 */
export function describeCall(
  tool: string,
  args: Record<string, unknown>,
  outcome: { result?: unknown; error?: string },
  durationMs: number
): Activity {
  const base = { tool, durationMs, status: "ok" as const, effect: "read" as const, detail: "", result: "", targets: [] as ActivityTarget[] };
  const file = typeof args.file === "string" ? args.file : "";
  const line = typeof args.line === "number" ? args.line : undefined;
  const result = (
    typeof outcome.result === "object" && outcome.result !== null ? outcome.result : {}
  ) as Record<string, unknown> & Answer;
  const inner = (result.result ?? {}) as Record<string, unknown>;

  const activity = ((): Activity => {
    switch (tool) {
      case "get_source": {
        const around = (args.around ?? args.startLine) as number | undefined;
        return {
          ...base,
          detail: file,
          result: result.startLine ? `lines ${result.startLine}-${result.endLine}` : "",
          targets: file ? [{ file, line: around ?? 1 }] : [],
        };
      }
      case "edit_parameter": {
        const column = typeof args.column === "number" ? args.column : undefined;
        const name = typeof args.argName === "string" ? args.argName : "";
        const from = typeof args.expected === "string" ? `${args.expected} → ` : "→ ";
        return {
          ...base,
          effect: "edit",
          detail: `${file}:${line ?? "?"}${name ? ` ${name}` : ""}`,
          result: `${from}${JSON.stringify(args.newValue)}`,
          targets: file && line !== undefined ? [{ file, line, ...(column ? { column } : {}) }] : [],
        };
      }
      case "list_files":
        return { ...base, result: many((result.files as unknown[] | undefined)?.length ?? 0, "file") };
      case "list_provenance":
        return { ...base, detail: file, result: many((result.sites as unknown[] | undefined)?.length ?? 0, "site") };
      case "search_by_generator":
        return {
          ...base,
          detail: String(args.function ?? args.argName ?? ""),
          result: many(Number(result.matched ?? 0), "site"),
        };
      case "resolve_at_point": {
        const ref = inner.sourceRef as { file?: string; line?: number; function?: string } | null | undefined;
        const address = inner.address as ActivityTarget | null | undefined;
        return {
          ...base,
          detail: `(${args.x}, ${args.y})`,
          result: ref ? `${ref.function} · ${ref.file}:${ref.line}` : "nothing with a source there",
          targets: address ? [address] : [],
        };
      }
      case "list_scene_provenance":
        return { ...base, result: many((inner.objects as unknown[] | undefined)?.length ?? 0, "object") };
      case "get_instance_provenance": {
        const instance = typeof args.instanceId === "number" ? ` #${args.instanceId}` : "";
        return {
          ...base,
          detail: `${file}:${line ?? "?"}${instance}`,
          result: (inner.sourceRef as { function?: string } | null | undefined)?.function ?? "",
          targets:
            file && line !== undefined
              ? [
                  {
                    file,
                    line,
                    ...(typeof args.ordinal === "number" ? { ordinal: args.ordinal } : {}),
                    ...(typeof args.instanceId === "number" ? { instanceId: args.instanceId } : {}),
                  },
                ]
              : [],
        };
      }
      case "get_selection": {
        const pointing = (inner.pointing as unknown[] | undefined)?.length ?? 0;
        return {
          ...base,
          result: pointing > 0
            ? `${many(pointing, "object")} pointed at`
            : inner.selected
              ? "the selected object"
              : "nothing pointed at",
        };
      }
      case "highlight_object": {
        const targets = Array.isArray(args.targets) ? (args.targets as ActivityTarget[]) : [];
        const shown = (inner.highlighted as unknown[] | undefined)?.length ?? 0;
        return {
          ...base,
          effect: "point",
          detail: targets.map((target) => `${target.file}:${target.line}`).join(", "),
          result: targets.length === 0 ? "cleared" : `${many(shown, "object")} outlined`,
          targets,
        };
      }
      case "get_canvas_screenshot":
        return { ...base, result: `${inner.width}×${inner.height} image` };
      default:
        return base;
    }
  })();

  if (outcome.error) {
    return { ...activity, status: "error", result: outcome.error };
  }

  const failure = "status" in result ? bridgeFailure(result) : null;
  return failure ? { ...activity, status: "error", result: failure } : activity;
}

/**
 * Tells the dev server this assistant is here and what it does, so the page can
 * show the developer.
 *
 * Purely a courtesy to them. Nothing here can fail a tool call, delay one, or
 * keep the process alive after the assistant has gone. The server to tell is
 * worked out each time, since the developer may start it after the assistant, or
 * restart it on another port.
 */
export class ActivityReporter {
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly context: () => DevServerOptions,
    private readonly agent: () => { id: string; name: string }
  ) {}

  private send(report: Omit<AgentReport, "agent">): Promise<void> {
    return postJson(
      { origin: this.context().origin, timeoutMs: REPORT_TIMEOUT_MS },
      AGENT_REPORT_PATH,
      { agent: this.agent(), ...report }
    ).then(
      () => undefined,
      () => undefined
    );
  }

  start(): void {
    if (this.timer) {
      return;
    }
    void this.send({});
    this.timer = setInterval(() => void this.send({}), HEARTBEAT_MS);
    this.timer.unref?.();
  }

  /**
   * Reports a finished call. Runs after the real work and its answer has to get
   * through, so even a call whose arguments were too strange to word (an
   * assistant can send anything) must not turn into a failure here.
   */
  call(tool: string, args: Record<string, unknown>, outcome: { result?: unknown; error?: string }, durationMs: number): void {
    try {
      void this.send({ activity: describeCall(tool, args, outcome, durationMs) });
    } catch {
      // Unreported, and otherwise unharmed.
    }
  }

  leave(): Promise<void> {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    return this.send({ leaving: true });
  }
}

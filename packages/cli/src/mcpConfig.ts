export const MCP_SERVER_NAME = "click-to-source";
export const MCP_PACKAGE = "@click-to-source-3d/mcp";

/**
 * The `.mcp.json` entry that starts the MCP server.
 *
 * `npx -y <package>` runs the copy installed in the project when there is
 * one, and fetches it otherwise, so the entry works from the repository root
 * of a monorepo whose app is further down. On Windows, MCP clients spawn
 * commands without a shell, and npx is a .cmd script there, so it has to go
 * through `cmd /c`.
 */
export function mcpServerEntry(platform: NodeJS.Platform = process.platform) {
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
 * Adds the server to an existing `.mcp.json`, or starts one.
 *
 * An existing entry of the same name is left as it is: the developer may
 * have changed it. A file that is not valid JSON is never rewritten; the
 * caller says what to add by hand instead.
 */
export function mergeMcpConfig(existing: string | null, platform: NodeJS.Platform = process.platform): McpMergeResult {
  let config: { mcpServers?: Record<string, unknown>; [key: string]: unknown } = {};

  if (existing !== null && existing.trim() !== "") {
    try {
      config = JSON.parse(existing) as typeof config;
    } catch (error) {
      return { status: "invalid", reason: (error as Error).message };
    }
    if (typeof config !== "object" || config === null || Array.isArray(config)) {
      return { status: "invalid", reason: "it is not a JSON object" };
    }
  }

  if (config.mcpServers && MCP_SERVER_NAME in config.mcpServers) {
    return { status: "already" };
  }

  config.mcpServers = { ...(config.mcpServers ?? {}), [MCP_SERVER_NAME]: mcpServerEntry(platform) };
  return { status: "added", text: `${JSON.stringify(config, null, 2)}\n` };
}

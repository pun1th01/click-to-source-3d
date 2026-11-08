import { existsSync } from "node:fs";
import path from "node:path";
import { mcpServerEntry as entryFor } from "@click-to-source-3d/shared";

// The entry and how it is merged are shared with the inspector's button, which writes
// the same files, so that both always write the same thing.
export { MCP_PACKAGE, MCP_SERVER_NAME, mergeMcpConfig, type McpMergeResult } from "@click-to-source-3d/shared";

export function mcpServerEntry(platform: NodeJS.Platform = process.platform) {
  return entryFor(platform);
}

/** Signs that an assistant is used here, and what to call it. */
const ASSISTANT_SIGNS: Array<[string, string]> = [
  [".claude", "Claude Code"],
  ["CLAUDE.md", "Claude Code"],
  [".mcp.json", "an MCP client"],
  [".cursor", "Cursor"],
  [".cursorrules", "Cursor"],
  [".windsurf", "Windsurf"],
  [".windsurfrules", "Windsurf"],
  [".vscode/mcp.json", "VS Code"],
];

/** The assistant this folder is set up for, if any. */
export function detectAssistant(...folders: string[]): string | null {
  for (const folder of folders) {
    for (const [sign, name] of ASSISTANT_SIGNS) {
      if (existsSync(path.join(folder, sign))) {
        return name;
      }
    }
  }
  return null;
}

/** Every file to register the server in: Claude Code's, and those of editors in use. */
export function mcpConfigFiles(root: string): Array<{ file: string; format: "standard" | "vscode" }> {
  const files: Array<{ file: string; format: "standard" | "vscode" }> = [
    { file: path.join(root, ".mcp.json"), format: "standard" },
  ];
  if (existsSync(path.join(root, ".cursor"))) {
    files.push({ file: path.join(root, ".cursor", "mcp.json"), format: "standard" });
  }
  if (existsSync(path.join(root, ".vscode"))) {
    files.push({ file: path.join(root, ".vscode", "mcp.json"), format: "vscode" });
  }
  return files;
}

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { mergeMcpConfig, registersMcpServer, type McpSetupStatus } from "@click-to-source-3d/shared";

/**
 * What the Agent tab's button does: what `npx click-to-source-3d init --mcp` does to
 * a project's MCP configuration, and no more. The rules are the CLI's, which has the
 * same three below, kept apart because one runs in a project and the other in Vite.
 *
 * The assistant is what starts the MCP server, so this can't start it: it registers
 * it where the assistant will look the next time it starts in the project.
 */

/** Where an assistant is started, and so where its config belongs: the repository's root. */
export function workspaceRootOf(dir: string): string {
  for (let current = path.resolve(dir); ; current = path.dirname(current)) {
    if (existsSync(path.join(current, ".git"))) {
      return current;
    }
    if (path.dirname(current) === current) {
      return path.resolve(dir);
    }
  }
}

const ASSISTANT_SIGNS: Array<[string, string]> = [
  [".claude", "Claude Code"],
  ["CLAUDE.md", "Claude Code"],
  [".cursor", "Cursor"],
  [".cursorrules", "Cursor"],
  [".windsurf", "Windsurf"],
  [".windsurfrules", "Windsurf"],
  [".vscode/mcp.json", "VS Code"],
  [".mcp.json", "an MCP client"],
];

function detectAssistant(...folders: string[]): string | null {
  for (const folder of folders) {
    for (const [sign, name] of ASSISTANT_SIGNS) {
      if (existsSync(path.join(folder, sign))) {
        return name;
      }
    }
  }
  return null;
}

/** Claude Code's file, and those of the editors in use. */
function configFiles(root: string): Array<{ file: string; format: "standard" | "vscode" }> {
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

function readText(file: string): string | null {
  try {
    return readFileSync(file, "utf8");
  } catch {
    return null;
  }
}

const shown = (root: string, file: string) => path.relative(root, file).split(path.sep).join("/");

export function mcpSetupStatus(viteRoot: string): McpSetupStatus {
  const root = workspaceRootOf(viteRoot);
  return {
    // By name: a path would put the developer's home directory on screen.
    folder: path.basename(root),
    registered: configFiles(root)
      .filter(({ file, format }) => {
        const text = readText(file);
        return text !== null && registersMcpServer(text, format);
      })
      .map(({ file }) => shown(root, file)),
    written: [],
    problems: [],
    assistant: detectAssistant(root, viteRoot),
  };
}

/** Registers the server in every file an assistant here reads. Changes nothing already there. */
export function turnOnMcp(viteRoot: string, platform: string = process.platform): McpSetupStatus {
  const root = workspaceRootOf(viteRoot);
  const written: string[] = [];
  const problems: McpSetupStatus["problems"] = [];

  for (const { file, format } of configFiles(root)) {
    const merged = mergeMcpConfig(readText(file), platform, format);
    if (merged.status === "added") {
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(file, merged.text);
      written.push(shown(root, file));
    } else if (merged.status === "invalid") {
      problems.push({ file: shown(root, file), reason: merged.reason });
    }
  }

  return { ...mcpSetupStatus(viteRoot), written, problems };
}

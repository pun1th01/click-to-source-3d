import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createInterface } from "node:readline/promises";
import { MCP_PACKAGE, mcpServerEntry, mergeMcpConfig } from "./mcpConfig.js";
import { installCommand, readProject, type PackageManager } from "./project.js";
import { MANUAL_SNIPPET, PLUGIN_PACKAGE, patchViteConfig } from "./viteConfig.js";

export const VERSION = (createRequire(import.meta.url)("../package.json") as { version: string }).version;

const MCP_SETUP_URL = "https://github.com/pun1th01/click-to-source-3d/tree/main/packages/mcp#install";

/** Everything init does to the outside world, so a test can stand in for it. */
export type Io = {
  cwd: string;
  log: (line: string) => void;
  error: (line: string) => void;
  /** Runs a command to completion and returns its exit code. */
  run: (command: string, args: string[], cwd: string) => number;
  ask: (question: string) => Promise<string>;
  interactive: boolean;
  platform: NodeJS.Platform;
};

export type Flags = {
  /** null: ask, when there is someone to ask. */
  mcp: boolean | null;
  yes: boolean;
  force: boolean;
  help: boolean;
  version: boolean;
  /** Package specs to install instead of the published ones — for testing unreleased builds. */
  pluginSpec?: string;
  mcpSpec?: string;
};

export function parseArgs(argv: string[]): { command: string | null; flags: Flags; unknown: string[] } {
  const flags: Flags = { mcp: null, yes: false, force: false, help: false, version: false };
  const unknown: string[] = [];
  let command: string | null = null;

  for (const arg of argv) {
    if (arg === "--mcp") flags.mcp = true;
    else if (arg === "--no-mcp") flags.mcp = false;
    else if (arg === "--yes" || arg === "-y") flags.yes = true;
    else if (arg === "--force") flags.force = true;
    else if (arg === "--help" || arg === "-h") flags.help = true;
    else if (arg === "--version" || arg === "-v") flags.version = true;
    else if (arg.startsWith("--plugin-spec=")) flags.pluginSpec = arg.slice("--plugin-spec=".length);
    else if (arg.startsWith("--mcp-spec=")) flags.mcpSpec = arg.slice("--mcp-spec=".length);
    else if (!arg.startsWith("-") && command === null) command = arg;
    else unknown.push(arg);
  }

  return { command, flags, unknown };
}

const HELP = `click-to-source-3d ${VERSION}

Sets up Click-to-Source 3D in a Vite + React Three Fiber project.

Usage
  npx click-to-source-3d init [options]

Options
  --mcp       Also set up the MCP server for AI coding assistants
  --no-mcp    Do not ask about the MCP server
  -y, --yes   Accept the defaults without asking
  --force     Set up a project that does not use React Three Fiber
  -h, --help  Show this help
`;

function devCommand(manager: PackageManager): string {
  return manager === "npm" ? "npm run dev" : `${manager} dev`;
}

/**
 * Installs the plugin, adds it to vite.config, and — if asked — registers the
 * MCP server. Returns the process exit code.
 */
export async function init(flags: Flags, io: Io): Promise<number> {
  const project = readProject(io.cwd);

  if (!project) {
    io.error(`No package.json in ${io.cwd}. Run this in your app's folder.`);
    return 1;
  }
  if (!project.hasVite || !project.viteConfig) {
    io.error(
      `${project.name} does not use Vite (no vite.config found). Click-to-Source 3D ` +
        "works with Vite for now; webpack and Next.js are on the roadmap."
    );
    return 1;
  }
  if (!project.hasR3F && !flags.force) {
    io.error(
      `${project.name} does not use React Three Fiber. Plain three.js support arrives ` +
        "in 0.2.0. Run with --force to set it up anyway."
    );
    return 1;
  }

  const configName = path.basename(project.viteConfig);
  io.log(`Setting up Click-to-Source 3D in ${project.name}\n`);

  let mcp = flags.mcp;
  if (mcp === null) {
    mcp =
      io.interactive && !flags.yes
        ? /^y/i.test(
            (await io.ask("Set up AI-agent tools (MCP)? (y/N) ")).trim()
          )
        : false;
  }

  const specs = [flags.pluginSpec ?? `${PLUGIN_PACKAGE}@^${VERSION}`];
  if (mcp) {
    specs.push(flags.mcpSpec ?? `${MCP_PACKAGE}@^${VERSION}`);
  }
  const { command, args } = installCommand(project.packageManager, specs);
  io.log(`Installing with ${project.packageManager}: ${specs.join(" ")}`);

  if (io.run(command, args, project.dir) !== 0) {
    io.error(`\nThe install failed. Nothing else was changed. You can run it yourself:\n  ${command} ${args.join(" ")}`);
    return 1;
  }
  io.log(`✔ Installed ${PLUGIN_PACKAGE}${mcp ? ` and ${MCP_PACKAGE}` : ""}`);

  let manual = false;
  const patch = patchViteConfig(readFileSync(project.viteConfig, "utf8"));
  if (patch.status === "patched") {
    writeFileSync(project.viteConfig, patch.code);
    io.log(`✔ Added clickToSource() to ${configName}`);
  } else if (patch.status === "already") {
    io.log(`✔ ${configName} already uses clickToSource()`);
  } else {
    manual = true;
    io.log(
      `! Could not edit ${configName} automatically: ${patch.reason}.\n` +
        `  Add these lines to it:\n\n${MANUAL_SNIPPET.replace(/^/gm, "    ")}\n`
    );
  }

  if (mcp) {
    const file = path.join(project.workspaceRoot, ".mcp.json");
    const merged = mergeMcpConfig(existsSync(file) ? readFileSync(file, "utf8") : null, io.platform);
    const where = path.relative(io.cwd, file) || ".mcp.json";
    if (merged.status === "added") {
      writeFileSync(file, merged.text);
      io.log(`✔ Registered the MCP server in ${where}`);
      io.log(`  Claude Code reads it. For Cursor, VS Code and others, see ${MCP_SETUP_URL}`);
    } else if (merged.status === "already") {
      io.log(`✔ ${where} already registers the MCP server`);
    } else {
      manual = true;
      io.log(
        `! Could not edit ${where} (${merged.reason}). Add this under "mcpServers":\n\n` +
          `    "click-to-source": ${JSON.stringify(mcpServerEntry(io.platform))}\n`
      );
    }
  }

  io.log(
    `\n${manual ? "Almost done" : "Done"}. Start your app with \`${devCommand(project.packageManager)}\`, ` +
      "then press Alt+Shift+C (or the button in the corner of the canvas) and click any object."
  );
  return 0;
}

/**
 * Quoting for cmd.exe. Package managers are .cmd scripts on Windows and have
 * to run through the shell, where `^` is the escape character: unquoted,
 * `pkg@^0.1.5` installs exactly 0.1.5.
 */
function quoteForCmd(arg: string): string {
  return /[\s^&|<>()%!"]/.test(arg) ? `"${arg.replace(/"/g, '\\"')}"` : arg;
}

function realIo(): Io {
  const windows = process.platform === "win32";
  return {
    cwd: process.cwd(),
    log: (line) => console.log(line),
    error: (line) => console.error(line),
    // On Windows the command line is built here, quoted, and handed to the
    // shell whole: passing an args array alongside shell: true is deprecated
    // in Node 24, because Node would only concatenate it, unescaped.
    run: (command, args, cwd) =>
      (windows
        ? spawnSync([command, ...args.map(quoteForCmd)].join(" "), { cwd, stdio: "inherit", shell: true })
        : spawnSync(command, args, { cwd, stdio: "inherit" })
      ).status ?? 1,
    ask: async (question) => {
      const readline = createInterface({ input: process.stdin, output: process.stdout });
      try {
        return await readline.question(question);
      } finally {
        readline.close();
      }
    },
    interactive: Boolean(process.stdin.isTTY && process.stdout.isTTY),
    platform: process.platform,
  };
}

export async function main(argv: string[], io: Io = realIo()): Promise<number> {
  const { command, flags, unknown } = parseArgs(argv);

  if (flags.version) {
    io.log(VERSION);
    return 0;
  }
  if (flags.help) {
    io.log(HELP);
    return 0;
  }
  if (unknown.length > 0) {
    io.error(`Unknown option ${unknown[0]}.\n\n${HELP}`);
    return 1;
  }
  // `npx click-to-source-3d` on its own does the one thing it is for.
  if (command !== null && command !== "init") {
    io.error(`Unknown command "${command}".\n\n${HELP}`);
    return 1;
  }

  return init(flags, io);
}

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createInterface } from "node:readline/promises";
import { detectAssistant, MCP_PACKAGE, mcpConfigFiles, mcpServerEntry, mergeMcpConfig } from "./mcpConfig.js";
import { findApps, installCommand, readProject, type PackageManager, type Project } from "./project.js";
import { MANUAL_SNIPPET, NEW_CONFIG, PLUGIN_PACKAGE, patchViteConfig } from "./viteConfig.js";

export const VERSION = (createRequire(import.meta.url)("../package.json") as { version: string }).version;

const MCP_SETUP_URL = "https://github.com/pun1th01/click-to-source-3d/tree/main/packages/mcp#install";

/** The oldest Vite the plugin works with. */
const OLDEST_VITE = 5;
/** The oldest three.js it works with, by revision. */
const OLDEST_THREE = 150;
/** What a project with no bundler gets. */
const VITE_SPEC = "vite@^8";

/** Everything init does to the outside world, so a test can stand in for it. */
export type Io = {
  cwd: string;
  log: (line: string) => void;
  error: (line: string) => void;
  /** Runs a command to completion and returns its exit code. */
  run: (command: string, args: string[], cwd: string) => number;
  /** Whether a command can be run at all. */
  has: (command: string) => boolean;
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

Adds Click-to-Source 3D to a three.js or React Three Fiber project. Run it in
your project, and there is nothing else to do.

It finds your app (from a monorepo's root too), installs what is missing, and
adds the plugin to your Vite config, creating one if you have none. A folder of
plain scripts gets a package.json and Vite.

Usage
  npx click-to-source-3d init [options]

Options
  --mcp       Also set up the MCP server for AI coding assistants. Automatic
              when this project is already set up for one.
  --no-mcp    Do not set up the MCP server, or ask about it
  -y, --yes   Accept the defaults without asking
  --force     Set up a project that does not seem to use three.js
  -h, --help  Show this help
`;

function devCommand(manager: PackageManager, script: string): string {
  return manager === "npm" ? `npm run ${script}` : `${manager} ${script}`;
}

/** Runs a package manager, through npx if it isn't installed here. */
function resolveManager(install: { command: string; args: string[] }, io: Io) {
  return install.command === "npm" || io.has(install.command)
    ? install
    : { command: "npx", args: ["-y", `${install.command}@latest`, ...install.args] };
}

function packageNameFor(dir: string): string {
  const name = path
    .basename(dir)
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^[._-]+|[._-]+$/g, "");
  return name || "three-app";
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** A JSON file written back the way it was: its indent, its line endings, its last newline. */
function writeJsonLike(file: string, raw: string, value: unknown): void {
  const indent = /^\{\r?\n([ \t]+)"/.exec(raw)?.[1] ?? 2;
  const eol = raw.includes("\r\n") ? "\r\n" : "\n";
  const text = JSON.stringify(value, null, indent).replace(/\n/g, eol);
  writeFileSync(file, raw.endsWith("\n") || raw === "" ? `${text}${eol}` : text);
}

/** A page for a project that has scripts and none to load them from. */
function newPage(title: string, entry: string): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>${escapeHtml(title)}</title>
    <style>
      html,
      body {
        margin: 0;
        height: 100%;
      }
    </style>
  </head>
  <body>
    <script type="module" src="/${escapeHtml(entry)}"></script>
  </body>
</html>
`;
}

function refusal(app: Project): string | null {
  if (app.manifestError) {
    return `${app.name}'s package.json can't be read (${app.manifestError}). Fix it, and run this again.`;
  }
  if (app.otherBundler) {
    return (
      `${app.name} is built with ${app.otherBundler}. Click-to-Source 3D works with Vite for now; ` +
      "other build tools are on the roadmap."
    );
  }
  if (app.viteMajor !== null && app.viteMajor < OLDEST_VITE) {
    const { command, args } = installCommand(app.packageManager, ["vite@latest"]);
    return (
      `${app.name} uses Vite ${app.viteMajor}, and Click-to-Source 3D needs Vite ${OLDEST_VITE} or newer. ` +
      `To update it:\n  ${command} ${args.join(" ")}`
    );
  }
  // Saying so here beats the wall of text a package manager prints about peers.
  if (app.threeRevision !== null && app.threeRevision < OLDEST_THREE) {
    const { command, args } = installCommand(app.packageManager, ["three@latest"], { dev: false });
    return (
      `${app.name} uses three.js 0.${app.threeRevision}, and Click-to-Source 3D needs 0.${OLDEST_THREE} or newer. ` +
      (app.threeDeclared
        ? `To update it:\n  ${command} ${args.join(" ")}`
        : "Update the version in your page's link to three.js, and run this again.")
    );
  }
  return null;
}

/** How one app came out: the command that starts it, unless it couldn't be set up. */
type Outcome = { app: Project; start: string | null; manual: boolean };

/** Sets up one app. */
function setUpApp(app: Project, flags: Flags, mcp: boolean, io: Io): Outcome {
  const failed: Outcome = { app, start: null, manual: false };

  const reason = refusal(app);
  if (reason) {
    io.error(reason);
    return failed;
  }

  io.log(`Setting up Click-to-Source 3D in ${app.name}\n`);

  // A folder of scripts becomes a project: nothing can be installed into it otherwise.
  const manifestFile = path.join(app.dir, "package.json");
  if (!app.hasManifest) {
    writeFileSync(
      manifestFile,
      `${JSON.stringify({ name: packageNameFor(app.dir), private: true, version: "0.0.0", type: "module" }, null, 2)}\n`
    );
    io.log("✔ Created package.json");
  }

  const undo = () => {
    if (!app.hasManifest) {
      rmSync(manifestFile, { force: true });
    }
  };

  const install = (specs: string[], dev: boolean): boolean => {
    const { command, args } = resolveManager(installCommand(app.packageManager, specs, { dev }), io);
    io.log(`Installing with ${app.packageManager}: ${specs.join(" ")}`);
    if (io.run(command, args, app.dir) === 0) {
      return true;
    }
    io.error(`\nThe install failed. Nothing else was changed. You can run it yourself:\n  ${command} ${args.join(" ")}`);
    undo();
    return false;
  };

  // three has to be there for the page to run, so it isn't a dev dependency.
  if (!app.threeDeclared && !install([app.threeVersion ? `three@${app.threeVersion}` : "three"], false)) {
    return failed;
  }

  const devSpecs = [flags.pluginSpec ?? `${PLUGIN_PACKAGE}@^${VERSION}`];
  if (!app.hasVite) {
    devSpecs.push(VITE_SPEC);
  }
  if (mcp) {
    devSpecs.push(flags.mcpSpec ?? `${MCP_PACKAGE}@^${VERSION}`);
  }
  if (!install(devSpecs, true)) {
    return failed;
  }
  io.log(
    `✔ Installed ${PLUGIN_PACKAGE}${app.hasVite ? "" : " and Vite"}${mcp ? ` and ${MCP_PACKAGE}` : ""}`
  );

  let manual = false;

  if (app.viteConfig) {
    const configName = path.basename(app.viteConfig);
    const patch = patchViteConfig(readFileSync(app.viteConfig, "utf8"));
    if (patch.status === "patched") {
      writeFileSync(app.viteConfig, patch.code);
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
  } else {
    const configName = app.isEsm ? "vite.config.js" : "vite.config.mjs";
    writeFileSync(path.join(app.dir, configName), NEW_CONFIG);
    io.log(`✔ Created ${configName}`);
  }

  // Read again: the install has just written to it.
  let script = app.devScript;
  if (!script) {
    const raw = readFileSync(manifestFile, "utf8");
    const manifest = JSON.parse(raw.replace(/^\uFEFF/, "")) as { scripts?: Record<string, string> };
    script = manifest.scripts?.dev ? "dev:vite" : "dev";
    manifest.scripts = { ...manifest.scripts, [script]: "vite" };
    writeJsonLike(manifestFile, raw, manifest);
    io.log(`✔ Added a "${script}" script to package.json`);
  }

  if (!app.hasHtml) {
    if (app.entry) {
      writeFileSync(path.join(app.dir, "index.html"), newPage(app.name, app.entry));
      io.log(`✔ Created index.html, which loads ${app.entry}`);
    } else {
      manual = true;
      io.log("! There is no index.html here for Vite to serve. Add one that loads your code.");
    }
  }

  return { app, start: devCommand(app.packageManager, script), manual };
}

/** Registers the MCP server in every file an assistant here reads. Returns false if any was left to do by hand. */
function registerMcp(root: string, io: Io): boolean {
  let fine = true;
  const written: string[] = [];

  for (const { file, format } of mcpConfigFiles(root)) {
    const merged = mergeMcpConfig(existsSync(file) ? readFileSync(file, "utf8") : null, io.platform, format);
    const where = path.relative(io.cwd, file) || path.basename(file);
    if (merged.status === "added") {
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(file, merged.text);
      written.push(where);
      io.log(`✔ Registered the MCP server in ${where}`);
    } else if (merged.status === "already") {
      io.log(`✔ ${where} already registers the MCP server`);
    } else {
      fine = false;
      const key = format === "vscode" ? "servers" : "mcpServers";
      io.log(
        `! Could not edit ${where} (${merged.reason}). Add this under "${key}":\n\n` +
          `    "click-to-source": ${JSON.stringify(mcpServerEntry(io.platform))}\n`
      );
    }
  }

  if (written.length > 0) {
    io.log(`  Restart your assistant so it sees the new tools. Others: ${MCP_SETUP_URL}`);
  }
  return fine;
}

/**
 * Finds what to set up, installs what is missing, adds the plugin, and registers
 * the MCP server where an assistant is in use. Returns the process exit code.
 */
export async function init(flags: Flags, io: Io): Promise<number> {
  let apps = findApps(io.cwd);

  if (apps.length === 0) {
    const here = readProject(io.cwd);
    if (!flags.force) {
      io.error(
        `No three.js project found in ${io.cwd}. Run this in your app's folder. If this is ` +
          "the right place and it just doesn't use three.js yet, run it again with --force."
      );
      return 1;
    }
    apps = [here];
  }

  if (apps.length > 1) {
    io.log(`Found ${apps.length} apps that use three.js: ${apps.map((app) => app.name).join(", ")}\n`);
  }

  const root = apps[0].workspaceRoot;

  let mcp = flags.mcp;
  if (mcp === null) {
    const assistant = detectAssistant(root, ...apps.map((app) => app.dir));
    if (assistant) {
      mcp = true;
      io.log(`This project is set up for ${assistant}, so its tools are being set up too. (--no-mcp skips that.)\n`);
    } else {
      mcp =
        io.interactive && !flags.yes
          ? /^y/i.test((await io.ask("Set up AI-agent tools (MCP)? (y/N) ")).trim())
          : false;
    }
  }

  const outcomes = apps.map((app) => setUpApp(app, flags, mcp, io));
  const finished = outcomes.filter((outcome) => outcome.start !== null);

  let manual = finished.some((outcome) => outcome.manual);
  if (mcp && finished.length > 0 && !registerMcp(root, io)) {
    manual = true;
  }

  if (finished.length > 0) {
    // Last, so it is what is on screen when this ends. In a monorepo, a command
    // run from the wrong folder would start something else.
    const where = (outcome: Outcome) => path.relative(io.cwd, outcome.app.dir).split(path.sep).join("/");
    const lead = manual ? "Almost done" : "Done";
    const next = "press Alt+Shift+C (or the button in the corner of the canvas) and click any object.";
    if (finished.length === 1) {
      const folder = where(finished[0]);
      io.log(`\n${lead}. Start it${folder ? ` in ${folder}` : ""} with \`${finished[0].start}\`, then ${next}`);
    } else {
      io.log(`\n${lead}. Start whichever you want:`);
      for (const outcome of finished) {
        io.log(`  in ${where(outcome) || "."}: \`${outcome.start}\``);
      }
      io.log(`Then ${next}`);
    }
    if (manual) {
      io.log("Some of this needs doing by hand: see above.");
    }
  }
  return outcomes.some((outcome) => outcome.start === null) ? 1 : 0;
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
    has: (command) =>
      (windows
        ? spawnSync(`${command} --version`, { stdio: "ignore", shell: true })
        : spawnSync(command, ["--version"], { stdio: "ignore" })
      ).status === 0,
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

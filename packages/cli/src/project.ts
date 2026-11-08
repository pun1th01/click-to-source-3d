import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { VITE_CONFIG_NAMES } from "./viteConfig.js";

export type PackageManager = "npm" | "pnpm" | "yarn" | "bun";

export type Project = {
  /** The folder being looked at. */
  dir: string;
  name: string;
  /** Whether it has a package.json yet. A folder of scripts doesn't have to. */
  hasManifest: boolean;
  /** Why its package.json can't be read, if it has one that can't. */
  manifestError: string | null;
  packageManager: PackageManager;
  /** Absolute path of the Vite config, if there is one. */
  viteConfig: string | null;
  hasVite: boolean;
  /** The major version of Vite asked for, when it can be read. */
  viteMajor: number | null;
  hasR3F: boolean;
  /** three, React Three Fiber, or code that imports them. */
  usesThree: boolean;
  /** three is a dependency, so nothing has to be installed for it. */
  threeDeclared: boolean;
  /** The version of three to install, when a CDN link or a copy says which. */
  threeVersion: string | null;
  /** The revision of three this project asks for, when it can be read: 170 for 0.170.0. */
  threeRevision: number | null;
  /** Another build tool this project is built with. */
  otherBundler: string | null;
  /** The script that starts Vite, if one does. */
  devScript: string | null;
  isEsm: boolean;
  hasHtml: boolean;
  /** The script to load from a new index.html, if there's no page yet. */
  entry: string | null;
  /**
   * Where `.mcp.json` belongs: the repository root, since that is where an
   * assistant is usually started — in a monorepo, above the app.
   */
  workspaceRoot: string;
};

const LOCKFILES: Array<[string, PackageManager]> = [
  ["pnpm-lock.yaml", "pnpm"],
  ["yarn.lock", "yarn"],
  ["bun.lock", "bun"],
  ["bun.lockb", "bun"],
  ["package-lock.json", "npm"],
];

/**
 * The package manager a project uses: the nearest lockfile, looking up from
 * the project to the repository root, since a monorepo keeps one lockfile at
 * the top. With no lockfile — a project not installed yet — the manager that
 * launched init, from the user agent it sets.
 */
export function detectPackageManager(dir: string, userAgent = process.env.npm_config_user_agent ?? ""): PackageManager {
  for (let current = path.resolve(dir); ; current = path.dirname(current)) {
    for (const [file, manager] of LOCKFILES) {
      if (existsSync(path.join(current, file))) {
        return manager;
      }
    }
    if (existsSync(path.join(current, ".git")) || path.dirname(current) === current) {
      break;
    }
  }

  const launcher = userAgent.split("/")[0];
  return launcher === "pnpm" || launcher === "yarn" || launcher === "bun" ? launcher : "npm";
}

/** The nearest directory above `dir` holding .git, or `dir` itself. */
export function findWorkspaceRoot(dir: string): string {
  for (let current = path.resolve(dir); ; current = path.dirname(current)) {
    if (existsSync(path.join(current, ".git"))) {
      return current;
    }
    if (path.dirname(current) === current) {
      return path.resolve(dir);
    }
  }
}

type Manifest = {
  name?: string;
  type?: string;
  scripts?: Record<string, string>;
  workspaces?: string[] | { packages?: string[] };
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
};

function readManifest(dir: string): Manifest | null {
  return readManifestOrError(dir).manifest;
}

/** A package.json, or why there isn't one to use. Missing and unreadable are different things. */
function readManifestOrError(dir: string): { manifest: Manifest | null; error: string | null } {
  const file = path.join(dir, "package.json");
  if (!existsSync(file)) {
    return { manifest: null, error: null };
  }
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8").replace(/^\uFEFF/, "")) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? { manifest: parsed as Manifest, error: null }
      : { manifest: null, error: "it isn't a JSON object" };
  } catch (error) {
    return { manifest: null, error: (error as Error).message };
  }
}

/**
 * Tools that build the page some other way, and what to call each. A framework
 * built on Vite with a config file of its own, such as Astro, is here too: it has
 * no vite.config for the plugin to go in, and writing one would do nothing.
 */
const OTHER_BUNDLERS: Array<[string, string]> = [
  ["next", "Next.js"],
  ["react-scripts", "Create React App"],
  ["gatsby", "Gatsby"],
  ["@angular/core", "Angular"],
  ["parcel", "Parcel"],
  ["webpack", "webpack"],
  ["astro", "Astro"],
  ["nuxt", "Nuxt"],
];

const CODE_FILE = /\.(html?|[cm]?[jt]sx?)$/;
const SKIPPED_FOLDERS = new Set(["node_modules", "dist", "build", "out", ".git", ".next", ".vite", "coverage"]);
const MAX_SCANNED_FILES = 200;
const MAX_SCANNED_SIZE = 500_000;

/** An import of three, a link to it on a CDN, or an import map entry. */
const USES_THREE =
  /\bfrom\s+["'](?:three(?:\/[^"']*)?|[^"']*\bthree(?:\.module|\.core|\.min)*\.js|https?:[^"']*\bthree\b[^"']*)["']|\bimport\s*\(\s*["']three\b|["']three["']\s*:\s*["']|<script[^>]*\bsrc=["'][^"']*\bthree\b[^"']*["']|\brequire\(\s*["']three["']\s*\)/;

const ENTRY_NAMES = [
  "src/main.ts",
  "src/main.js",
  "src/index.ts",
  "src/index.js",
  "main.ts",
  "main.js",
  "index.js",
  "script.js",
  "app.js",
  "sketch.js",
];

/** The code files of a project, near the top, without wandering off. */
function codeFiles(dir: string): string[] {
  const files: string[] = [];
  const visit = (folder: string, depth: number) => {
    let entries: string[];
    try {
      entries = readdirSync(folder);
    } catch {
      return;
    }
    for (const entry of entries) {
      if (files.length >= MAX_SCANNED_FILES) {
        return;
      }
      const full = path.join(folder, entry);
      let isFolder: boolean;
      try {
        isFolder = statSync(full).isDirectory();
      } catch {
        continue;
      }
      if (isFolder) {
        // A folder with a package.json of its own is another project's.
        if (
          depth < 4 &&
          !SKIPPED_FOLDERS.has(entry) &&
          !entry.startsWith(".") &&
          !existsSync(path.join(full, "package.json"))
        ) {
          visit(full, depth + 1);
        }
      } else if (CODE_FILE.test(entry)) {
        files.push(full);
      }
    }
  };
  visit(dir, 0);
  return files;
}

/** Whether any code here uses three, and which version it says it wants. */
function scanForThree(dir: string): { uses: boolean; version: string | null; firstFile: string | null } {
  let uses = false;
  let version: string | null = null;
  let firstFile: string | null = null;

  for (const file of codeFiles(dir)) {
    let text: string;
    try {
      if (statSync(file).size > MAX_SCANNED_SIZE) {
        continue;
      }
      text = readFileSync(file, "utf8");
    } catch {
      continue;
    }
    if (USES_THREE.test(text)) {
      uses = true;
      if (!firstFile && !/\.html?$/.test(file)) {
        firstFile = file;
      }
      version ??= /\bthree@(\d[\w.-]*)/.exec(text)?.[1] ?? null;
    }
  }
  return { uses, version, firstFile };
}

/** A copy of three kept in the project says which revision it is. */
function vendoredThreeVersion(dir: string): string | null {
  for (const file of codeFiles(dir)) {
    if (/(^|[\\/])three(\.module|\.core|\.min)*\.js$/.test(file)) {
      try {
        const revision = /\bREVISION\s*=\s*["'](\d+)/.exec(readFileSync(file, "utf8"))?.[1];
        if (revision) {
          return `0.${revision}.0`;
        }
      } catch {
        // Unreadable: whatever three is newest will do.
      }
    }
  }
  return null;
}

function runsVite(command: string): boolean {
  return /(^|[\s;&|/])vite(\s|$)/.test(command) && !/\bvite\s+(build|preview|optimize)\b/.test(command);
}

export function readProject(dir: string): Project {
  const { manifest: pkg, error: manifestError } = readManifestOrError(dir);
  const deps = { ...pkg?.peerDependencies, ...pkg?.dependencies, ...pkg?.devDependencies };
  const config = VITE_CONFIG_NAMES.map((name) => path.join(dir, name)).find((file) => existsSync(file));
  const declared = "three" in deps || "@react-three/fiber" in deps;
  const scan = declared ? { uses: true, version: null, firstFile: null } : scanForThree(dir);
  const hasHtml = existsSync(path.join(dir, "index.html"));

  const devScript =
    Object.entries(pkg?.scripts ?? {}).find(([name, command]) => name === "dev" && runsVite(command))?.[0] ??
    Object.entries(pkg?.scripts ?? {}).find(([, command]) => runsVite(command))?.[0] ??
    null;

  const entry = hasHtml
    ? null
    : (ENTRY_NAMES.find((name) => existsSync(path.join(dir, name))) ??
      (scan.firstFile ? path.relative(dir, scan.firstFile).split(path.sep).join("/") : null));

  const threeVersion = declared ? null : (scan.version ?? vendoredThreeVersion(dir));

  return {
    dir,
    name: pkg?.name ?? path.basename(dir),
    // One that can't be read is still there, and nothing may replace it.
    hasManifest: pkg !== null || manifestError !== null,
    manifestError,
    packageManager: detectPackageManager(dir),
    viteConfig: config ?? null,
    hasVite: "vite" in deps,
    viteMajor: Number(/(\d+)/.exec(deps.vite ?? "")?.[1] ?? NaN) || null,
    hasR3F: "@react-three/fiber" in deps,
    usesThree: declared || scan.uses,
    threeDeclared: declared,
    threeVersion,
    threeRevision: Number(/\b0\.(\d+)/.exec(deps.three ?? threeVersion ?? "")?.[1] ?? NaN) || null,
    otherBundler: config || "vite" in deps ? null : (OTHER_BUNDLERS.find(([name]) => name in deps)?.[1] ?? null),
    devScript,
    isEsm: pkg?.type === "module" || pkg === null,
    hasHtml,
    entry,
    workspaceRoot: findWorkspaceRoot(dir),
  };
}

/** Whether something here is a page rather than a library that happens to use three. */
function isApp(project: Project): boolean {
  return project.viteConfig !== null || project.hasVite || project.hasHtml;
}

const COMMON_APP_FOLDERS = ["apps/*", "packages/*", "examples/*", "client", "frontend", "web", "app", "site", "demo"];

function workspacePatterns(dir: string): string[] {
  const manifest = readManifest(dir);
  const declared = Array.isArray(manifest?.workspaces) ? manifest.workspaces : (manifest?.workspaces?.packages ?? []);

  let pnpm: string[] = [];
  try {
    pnpm = [...readFileSync(path.join(dir, "pnpm-workspace.yaml"), "utf8").matchAll(/^\s*-\s*["']?([^"'\s#]+)["']?/gm)]
      .map((match) => match[1])
      .filter((entry) => !entry.startsWith("!"));
  } catch {
    // Not a pnpm workspace.
  }
  return [...new Set([...declared, ...pnpm, ...COMMON_APP_FOLDERS])];
}

/** The folders a monorepo's patterns name: `apps/*`, or a folder by name. */
function foldersFor(dir: string, patterns: string[]): string[] {
  const folders = new Set<string>();
  for (const pattern of patterns) {
    const clean = pattern.replace(/^\.\//, "").replace(/\/+$/, "");
    if (clean.endsWith("/*") || clean.endsWith("/**")) {
      const base = path.join(dir, clean.replace(/\/\*+$/, ""));
      let entries: string[] = [];
      try {
        entries = readdirSync(base);
      } catch {
        continue;
      }
      for (const entry of entries) {
        if (!SKIPPED_FOLDERS.has(entry) && existsSync(path.join(base, entry, "package.json"))) {
          folders.add(path.join(base, entry));
        }
      }
    } else if (!clean.includes("*") && existsSync(path.join(dir, clean, "package.json"))) {
      folders.add(path.join(dir, clean));
    }
  }
  return [...folders];
}

/**
 * The apps to set up, starting from where the command was run.
 *
 * From the app itself, that's the app. From a monorepo's root, every app in it
 * that uses three. From inside an app, such as its src folder, the app above. And
 * a folder of plain scripts counts as an app that just has no package.json yet.
 */
export function findApps(cwd: string): Project[] {
  const here = readProject(cwd);
  if (here.usesThree && (here.hasManifest ? isApp(here) || here.hasR3F : true)) {
    return [here];
  }

  const below = foldersFor(cwd, workspacePatterns(cwd))
    .map(readProject)
    .filter((project) => project.usesThree && isApp(project));
  if (below.length > 0) {
    return below;
  }

  const stop = findWorkspaceRoot(cwd);
  for (let current = path.resolve(cwd); current !== path.dirname(current); current = path.dirname(current)) {
    if (current !== path.resolve(cwd) && existsSync(path.join(current, "package.json"))) {
      const above = readProject(current);
      if (above.usesThree && isApp(above)) {
        return [above];
      }
    }
    if (current === stop) {
      break;
    }
  }

  return here.usesThree ? [here] : [];
}

/** The command that adds packages to a project. */
export function installCommand(
  manager: PackageManager,
  specs: string[],
  options: { dev?: boolean } = {}
): { command: string; args: string[] } {
  const dev = options.dev !== false;
  switch (manager) {
    case "pnpm":
      return { command: "pnpm", args: ["add", ...(dev ? ["-D"] : []), ...specs] };
    case "yarn":
      return { command: "yarn", args: ["add", ...(dev ? ["-D"] : []), ...specs] };
    case "bun":
      return { command: "bun", args: ["add", ...(dev ? ["-d"] : []), ...specs] };
    default:
      return { command: "npm", args: ["install", ...(dev ? ["-D"] : []), ...specs] };
  }
}

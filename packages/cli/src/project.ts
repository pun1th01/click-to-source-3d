import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { VITE_CONFIG_NAMES } from "./viteConfig.js";

export type PackageManager = "npm" | "pnpm" | "yarn" | "bun";

export type Project = {
  /** Directory holding the package.json init runs against. */
  dir: string;
  name: string;
  packageManager: PackageManager;
  /** Absolute path of the Vite config, if there is one. */
  viteConfig: string | null;
  hasVite: boolean;
  hasR3F: boolean;
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

export function readProject(dir: string): Project | null {
  const manifest = path.join(dir, "package.json");
  if (!existsSync(manifest)) {
    return null;
  }

  const pkg = JSON.parse(readFileSync(manifest, "utf8")) as {
    name?: string;
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
    peerDependencies?: Record<string, string>;
  };
  const deps = { ...pkg.peerDependencies, ...pkg.dependencies, ...pkg.devDependencies };
  const config = VITE_CONFIG_NAMES.map((name) => path.join(dir, name)).find((file) => existsSync(file));

  return {
    dir,
    name: pkg.name ?? path.basename(dir),
    packageManager: detectPackageManager(dir),
    viteConfig: config ?? null,
    hasVite: "vite" in deps || config !== undefined,
    hasR3F: "@react-three/fiber" in deps,
    workspaceRoot: findWorkspaceRoot(dir),
  };
}

/** The command that adds packages as dev dependencies. */
export function installCommand(manager: PackageManager, specs: string[]): { command: string; args: string[] } {
  switch (manager) {
    case "pnpm":
      return { command: "pnpm", args: ["add", "-D", ...specs] };
    case "yarn":
      return { command: "yarn", args: ["add", "-D", ...specs] };
    case "bun":
      return { command: "bun", args: ["add", "-d", ...specs] };
    default:
      return { command: "npm", args: ["install", "-D", ...specs] };
  }
}

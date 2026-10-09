import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { init, main, parseArgs, VERSION, type Io } from "../src/cli.js";
import { mergeMcpConfig } from "../src/mcpConfig.js";
import { detectPackageManager, installCommand } from "../src/project.js";

let root: string;

/** A project as `npm create vite` and `npm i @react-three/fiber three` leave it. */
function project(options: { r3f?: boolean; lockfile?: string; config?: string | null } = {}) {
  const dir = path.join(root, "app");
  mkdirSync(dir, { recursive: true });
  mkdirSync(path.join(root, ".git"), { recursive: true });
  writeFileSync(
    path.join(dir, "package.json"),
    JSON.stringify({
      name: "my-scene",
      dependencies: {
        react: "^19.0.0",
        three: "^0.180.0",
        ...(options.r3f === false ? {} : { "@react-three/fiber": "^9.0.0" }),
      },
      devDependencies: { vite: "^8.0.0" },
    })
  );
  if (options.lockfile) {
    writeFileSync(path.join(dir, options.lockfile), "");
  }
  if (options.config !== null) {
    writeFileSync(
      path.join(dir, "vite.config.ts"),
      options.config ?? "import { defineConfig } from 'vite'\nimport react from '@vitejs/plugin-react'\n\nexport default defineConfig({\n  plugins: [react()],\n})\n"
    );
  }
  return dir;
}

function fakeIo(cwd: string, overrides: Partial<Io> = {}) {
  const lines: string[] = [];
  const runs: Array<{ command: string; args: string[]; cwd: string }> = [];
  const io: Io = {
    cwd,
    log: (line) => lines.push(line),
    error: (line) => lines.push(`ERROR ${line}`),
    run: (command, args, dir) => {
      runs.push({ command, args, cwd: dir });
      return 0;
    },
    ask: async () => "n",
    interactive: false,
    platform: "linux",
    ...overrides,
  };
  return { io, lines, runs, output: () => lines.join("\n") };
}

const flags = (overrides: Partial<ReturnType<typeof parseArgs>["flags"]> = {}) => ({
  ...parseArgs([]).flags,
  ...overrides,
});

beforeEach(() => {
  root = mkdtempSync(path.join(os.tmpdir(), "cts-init-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("init", () => {
  it("installs the plugin and adds it to vite.config", async () => {
    const dir = project({ lockfile: "package-lock.json" });
    const { io, runs, output } = fakeIo(dir);

    expect(await init(flags(), io)).toBe(0);

    expect(runs).toEqual([
      {
        command: "npm",
        args: ["install", "-D", `@click-to-source-3d/vite-plugin@^${VERSION}`],
        cwd: dir,
      },
    ]);
    expect(readFileSync(path.join(dir, "vite.config.ts"), "utf8")).toContain(
      "plugins: [clickToSource(), react()]"
    );
    expect(output()).toContain("press Alt+Shift+C");
    expect(existsSync(path.join(root, ".mcp.json"))).toBe(false);
  });

  it("uses the project's package manager", async () => {
    const dir = project({ lockfile: "pnpm-lock.yaml" });
    const { io, runs, output } = fakeIo(dir);

    await init(flags(), io);

    expect(runs[0].command).toBe("pnpm");
    expect(runs[0].args.slice(0, 2)).toEqual(["add", "-D"]);
    expect(output()).toContain("`pnpm dev`");
  });

  it("asks about MCP when someone can answer, and sets it up on yes", async () => {
    const dir = project();
    const asked: string[] = [];
    const { io, runs, output } = fakeIo(dir, {
      interactive: true,
      ask: async (question) => {
        asked.push(question);
        return "y";
      },
    });

    await init(flags(), io);

    expect(asked).toHaveLength(1);
    expect(runs[0].args).toContain(`@click-to-source-3d/mcp@^${VERSION}`);
    // .mcp.json is Claude Code's; other assistants are pointed elsewhere.
    expect(output()).toContain("For Cursor, VS Code and others");
    // At the repository root, where an assistant is started.
    expect(JSON.parse(readFileSync(path.join(root, ".mcp.json"), "utf8"))).toEqual({
      mcpServers: {
        "click-to-source": { command: "npx", args: ["-y", "@click-to-source-3d/mcp"] },
      },
    });
  });

  it("does not ask with --yes, or when nobody is there to answer", async () => {
    for (const setup of [{ interactive: true, yes: true }, { interactive: false, yes: false }]) {
      const dir = project();
      let asked = false;
      const { io } = fakeIo(dir, {
        interactive: setup.interactive,
        ask: async () => {
          asked = true;
          return "y";
        },
      });

      await init(flags({ yes: setup.yes }), io);

      expect(asked).toBe(false);
      expect(existsSync(path.join(root, ".mcp.json"))).toBe(false);
    }
  });

  it("sets MCP up without asking under --mcp", async () => {
    const dir = project();
    const { io } = fakeIo(dir, { platform: "win32" });

    await init(flags({ mcp: true }), io);

    // MCP clients spawn without a shell, and npx is a .cmd script on Windows.
    expect(JSON.parse(readFileSync(path.join(root, ".mcp.json"), "utf8")).mcpServers["click-to-source"]).toEqual({
      command: "cmd",
      args: ["/c", "npx", "-y", "@click-to-source-3d/mcp"],
    });
  });

  it("changes nothing when the install fails", async () => {
    const dir = project();
    const before = readFileSync(path.join(dir, "vite.config.ts"), "utf8");
    const { io, output } = fakeIo(dir, { run: () => 1 });

    expect(await init(flags(), io)).toBe(1);
    expect(readFileSync(path.join(dir, "vite.config.ts"), "utf8")).toBe(before);
    expect(output()).toContain("The install failed");
  });

  it("prints the lines to paste when the config cannot be edited", async () => {
    const dir = project({ config: "export default makeConfig()\n" });
    const { io, output } = fakeIo(dir);

    expect(await init(flags(), io)).toBe(0);
    expect(output()).toContain('import { clickToSource } from "@click-to-source-3d/vite-plugin";');
    expect(output()).toContain("Almost done");
  });

  it("is safe to run twice", async () => {
    const dir = project();
    await init(flags(), fakeIo(dir).io);
    const once = readFileSync(path.join(dir, "vite.config.ts"), "utf8");

    const { io, output } = fakeIo(dir);
    await init(flags(), io);

    expect(readFileSync(path.join(dir, "vite.config.ts"), "utf8")).toBe(once);
    expect(output()).toContain("already uses clickToSource()");
  });

  it("refuses a project without React Three Fiber unless forced", async () => {
    const dir = project({ r3f: false });
    const refused = fakeIo(dir);

    expect(await init(flags(), refused.io)).toBe(1);
    expect(refused.runs).toEqual([]);
    expect(refused.output()).toContain("0.2.0");

    expect(await init(flags({ force: true }), fakeIo(dir).io)).toBe(0);
  });

  it("refuses a folder that is not a Vite project", async () => {
    const dir = project({ config: null });
    writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "x", dependencies: { "@react-three/fiber": "9" } }));
    const { io, output, runs } = fakeIo(dir);

    expect(await init(flags(), io)).toBe(1);
    expect(runs).toEqual([]);
    expect(output()).toContain("does not use Vite");
  });

  it("explains where to run it when there is no package.json", async () => {
    const { io, output } = fakeIo(root);

    expect(await init(flags(), io)).toBe(1);
    expect(output()).toContain("No package.json");
  });
});

describe("main", () => {
  it("runs init with no command, and only init", async () => {
    const dir = project();
    expect(await main([], fakeIo(dir).io)).toBe(0);

    const { io, output } = fakeIo(dir);
    expect(await main(["deploy"], io)).toBe(1);
    expect(output()).toContain('Unknown command "deploy"');
  });

  it("prints help and the version", async () => {
    const help = fakeIo(root);
    await main(["--help"], help.io);
    expect(help.output()).toContain("npx click-to-source-3d init");

    const version = fakeIo(root);
    await main(["--version"], version.io);
    expect(version.output()).toBe(VERSION);
  });
});

describe("pieces", () => {
  it("finds a monorepo's lockfile above the app", () => {
    const dir = project();
    writeFileSync(path.join(root, "yarn.lock"), "");

    expect(detectPackageManager(dir, "")).toBe("yarn");
  });

  it("falls back to the manager that launched it", () => {
    const dir = project();

    expect(detectPackageManager(dir, "pnpm/9.0.0 npm/? node/v22")).toBe("pnpm");
    expect(detectPackageManager(dir, "")).toBe("npm");
  });

  it("knows each manager's add command", () => {
    expect(installCommand("bun", ["x"])).toEqual({ command: "bun", args: ["add", "-d", "x"] });
    expect(installCommand("yarn", ["x"])).toEqual({ command: "yarn", args: ["add", "-D", "x"] });
  });

  it("keeps an existing .mcp.json's other servers and leaves an invalid one alone", () => {
    const merged = mergeMcpConfig(JSON.stringify({ mcpServers: { other: { command: "x" } } }), "linux");
    expect(merged.status === "added" && JSON.parse(merged.text).mcpServers).toEqual({
      other: { command: "x" },
      "click-to-source": { command: "npx", args: ["-y", "@click-to-source-3d/mcp"] },
    });

    expect(mergeMcpConfig("{ nope", "linux").status).toBe("invalid");
    expect(mergeMcpConfig(JSON.stringify({ mcpServers: { "click-to-source": {} } }), "linux").status).toBe(
      "already"
    );
  });
});

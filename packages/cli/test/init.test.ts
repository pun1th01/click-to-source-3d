import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { init, main, parseArgs, VERSION, type Io } from "../src/cli.js";
import { mergeMcpConfig } from "../src/mcpConfig.js";
import { detectPackageManager, findApps, installCommand, readProject } from "../src/project.js";

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
      scripts: { dev: "vite" },
      dependencies: {
        react: "^19.0.0",
        three: "^0.180.0",
        ...(options.r3f === false ? {} : { "@react-three/fiber": "^9.0.0" }),
      },
      devDependencies: { vite: "^8.0.0" },
    })
  );
  writeFileSync(path.join(dir, "index.html"), '<script type="module" src="/src/main.tsx"></script>');
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
    has: () => true,
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
    expect(output()).toContain("Start it with `npm run dev`");
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
    expect(output()).toContain("Restart your assistant");
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
    const dir = project({ config: "console.log('this exports nothing')\n" });
    const { io, output } = fakeIo(dir);

    expect(await init(flags(), io)).toBe(0);
    expect(output()).toContain('import { clickToSource } from "@click-to-source-3d/vite-plugin";');
    expect(output()).toContain("Almost done");
    expect(output()).toContain("needs doing by hand");
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

  it("sets up plain three.js the same as React Three Fiber", async () => {
    const dir = project({ r3f: false });
    const { io, runs, output } = fakeIo(dir);

    expect(await init(flags(), io)).toBe(0);
    expect(runs).toHaveLength(1);
    expect(output()).toContain("Done");
  });

  it("explains where to run it when there is nothing here", async () => {
    const { io, output, runs } = fakeIo(root);

    expect(await init(flags(), io)).toBe(1);
    expect(runs).toEqual([]);
    expect(output()).toContain("No three.js project found");
  });

  it("sets up a project with no three.js when forced", async () => {
    const dir = path.join(root, "app");
    mkdirSync(dir);
    writeFileSync(path.join(dir, "index.html"), "<html></html>");
    writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "x", devDependencies: { vite: "^7" } }));

    expect(await init(flags(), fakeIo(dir).io)).toBe(1);

    const { io, runs } = fakeIo(dir);
    expect(await init(flags({ force: true }), io)).toBe(0);
    expect(runs.flatMap((run) => run.args)).toContain("three");
  });
});

/** What `npm create vite` leaves for its vanilla template: Vite, but no config. */
function vanilla(overrides: Record<string, unknown> = {}) {
  const dir = path.join(root, "app");
  mkdirSync(path.join(dir, "src"), { recursive: true });
  writeFileSync(
    path.join(dir, "package.json"),
    JSON.stringify({
      name: "vanilla",
      type: "module",
      scripts: { dev: "vite", build: "vite build" },
      dependencies: { three: "^0.180.0" },
      devDependencies: { vite: "^8.0.0" },
      ...overrides,
    })
  );
  writeFileSync(path.join(dir, "index.html"), '<script type="module" src="/src/main.js"></script>');
  writeFileSync(path.join(dir, "src/main.js"), 'import * as THREE from "three";\n');
  return dir;
}

describe("a project with no Vite config", () => {
  it("creates one", async () => {
    const dir = vanilla();
    const { io, output } = fakeIo(dir);

    expect(await init(flags(), io)).toBe(0);

    const config = readFileSync(path.join(dir, "vite.config.js"), "utf8");
    expect(config).toContain("plugins: [clickToSource()]");
    expect(output()).toContain("Created vite.config.js");
    expect(output()).toContain("`npm run dev`");
    expect(output()).toContain("Done");
  });

  it("uses a name Node reads as a module when the project isn't one", async () => {
    const dir = vanilla({ type: undefined });

    await init(flags(), fakeIo(dir).io);

    expect(existsSync(path.join(dir, "vite.config.mjs"))).toBe(true);
    expect(existsSync(path.join(dir, "vite.config.js"))).toBe(false);
  });

  it("is safe to run twice", async () => {
    const dir = vanilla();
    await init(flags(), fakeIo(dir).io);
    const { io, output } = fakeIo(dir);

    await init(flags(), io);

    expect(output()).toContain("already uses clickToSource()");
  });
});

describe("a project with three.js but no build tool", () => {
  const scripts = (html = '<script type="importmap">{"imports":{"three":"https://unpkg.com/three@0.160.0/build/three.module.js"}}</script><script type="module" src="./main.js"></script>') => {
    const dir = path.join(root, "my sketch!");
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, "index.html"), html);
    writeFileSync(path.join(dir, "main.js"), 'import * as THREE from "three";\nnew THREE.Scene();\n');
    return dir;
  };

  it("turns a folder of scripts into a project", async () => {
    const dir = scripts();
    const { io, runs, output } = fakeIo(dir);

    expect(await init(flags(), io)).toBe(0);

    const manifest = JSON.parse(readFileSync(path.join(dir, "package.json"), "utf8"));
    expect(manifest).toMatchObject({ name: "my-sketch", private: true, type: "module", scripts: { dev: "vite" } });
    expect(runs[1].args).toEqual(expect.arrayContaining(["-D", "vite@^8"]));
    expect(existsSync(path.join(dir, "vite.config.js"))).toBe(true);
    expect(output()).toContain("`npm run dev`");
  });

  it("installs the version of three its CDN link asks for, as a real dependency", async () => {
    const dir = scripts();
    const { io, runs } = fakeIo(dir);

    await init(flags(), io);

    expect(runs[0].args).toEqual(["install", "three@0.160.0"]);
  });

  it("reads the version of a copy kept in the project", async () => {
    const dir = scripts('<script type="module" src="./main.js"></script>');
    writeFileSync(path.join(dir, "main.js"), 'import * as THREE from "./lib/three.module.js";\n');
    mkdirSync(path.join(dir, "lib"));
    writeFileSync(path.join(dir, "lib/three.module.js"), "const REVISION = '152';\n");
    const { io, runs } = fakeIo(dir);

    await init(flags(), io);

    expect(runs[0].args).toEqual(["install", "three@0.152.0"]);
  });

  it("adds a dev script to a package.json that has none", async () => {
    const dir = vanilla({ scripts: { test: "vitest" }, devDependencies: {} });
    const { io, runs } = fakeIo(dir);

    await init(flags(), io);

    expect(JSON.parse(readFileSync(path.join(dir, "package.json"), "utf8")).scripts).toEqual({
      test: "vitest",
      dev: "vite",
    });
    expect(runs[0].args).toContain("vite@^8");
  });

  it("leaves a dev script that does something else, and says which to run", async () => {
    const dir = vanilla({ scripts: { dev: "node server.js" }, devDependencies: {} });
    const { io, output } = fakeIo(dir);

    await init(flags(), io);

    expect(JSON.parse(readFileSync(path.join(dir, "package.json"), "utf8")).scripts).toEqual({
      dev: "node server.js",
      "dev:vite": "vite",
    });
    expect(output()).toContain("`npm run dev:vite`");
  });

  it("finds a script that runs Vite under another name", async () => {
    const dir = vanilla({ scripts: { start: "cross-env FOO=1 vite --host", build: "vite build" } });
    const { io, output } = fakeIo(dir);

    await init(flags(), io);

    expect(output()).toContain("`npm run start`");
    expect(JSON.parse(readFileSync(path.join(dir, "package.json"), "utf8")).scripts.dev).toBeUndefined();
  });

  it("writes a page that loads the code when there isn't one", async () => {
    const dir = path.join(root, "app");
    mkdirSync(path.join(dir, "src"), { recursive: true });
    writeFileSync(path.join(dir, "src/main.js"), 'import * as THREE from "three";\n');
    const { io, output } = fakeIo(dir);

    await init(flags(), io);

    expect(readFileSync(path.join(dir, "index.html"), "utf8")).toContain('src="/src/main.js"');
    expect(output()).toContain("Created index.html");
  });

  it("takes back the package.json it made if the install fails", async () => {
    const dir = scripts();
    const { io, output } = fakeIo(dir, { run: () => 1 });

    expect(await init(flags(), io)).toBe(1);
    expect(existsSync(path.join(dir, "package.json"))).toBe(false);
    expect(output()).toContain("The install failed");
  });
});

describe("a package.json it can't read", () => {
  // Read as missing, it used to be replaced by a new one, and everything in it lost.
  it("is left alone, with the reason", async () => {
    const dir = path.join(root, "app");
    mkdirSync(dir);
    writeFileSync(path.join(dir, "index.html"), '<script type="module" src="./main.js"></script>');
    writeFileSync(path.join(dir, "main.js"), 'import * as THREE from "three";\n');
    const broken = '{ "name": "mine", "dependencies": { "three": "^0.180.0", } }';
    writeFileSync(path.join(dir, "package.json"), broken);
    const { io, runs, output } = fakeIo(dir);

    expect(await init(flags(), io)).toBe(1);
    expect(readFileSync(path.join(dir, "package.json"), "utf8")).toBe(broken);
    expect(runs).toEqual([]);
    expect(output()).toContain("package.json can't be read");
  });

  it("reads one that starts with a byte order mark", async () => {
    const dir = vanilla();
    const file = path.join(dir, "package.json");
    writeFileSync(file, `\uFEFF${readFileSync(file, "utf8")}`);

    expect(await init(flags(), fakeIo(dir).io)).toBe(0);
  });
});

describe("what it writes", () => {
  it("keeps package.json's own indent and line endings", async () => {
    const dir = vanilla({ scripts: { test: "vitest" } });
    const file = path.join(dir, "package.json");
    const manifest = JSON.parse(readFileSync(file, "utf8"));
    writeFileSync(file, `${JSON.stringify(manifest, null, "\t").replace(/\n/g, "\r\n")}\r\n`);

    await init(flags(), fakeIo(dir).io);

    const written = readFileSync(file, "utf8");
    expect(written).toContain('\r\n\t"scripts": {\r\n\t\t"test": "vitest",\r\n\t\t"dev": "vite"');
    expect(written.endsWith("}\r\n")).toBe(true);
  });

  // Windows allows & in a folder's name, though not < or >.
  it("escapes a folder's name in the page it writes", async () => {
    const dir = path.join(root, "rock & roll");
    mkdirSync(path.join(dir, "src"), { recursive: true });
    writeFileSync(path.join(dir, "src/main.js"), 'import * as THREE from "three";\n');

    await init(flags(), fakeIo(dir).io);

    expect(readFileSync(path.join(dir, "index.html"), "utf8")).toContain("<title>rock &amp; roll</title>");
  });
});

describe("projects it can't set up", () => {
  it.each([
    ["next", "Next.js"],
    ["react-scripts", "Create React App"],
    ["webpack", "webpack"],
    ["parcel", "Parcel"],
    ["astro", "Astro"],
  ])("says so for %s, without touching anything", async (dependency, name) => {
    const dir = vanilla({ devDependencies: { [dependency]: "1" } });
    const { io, runs, output } = fakeIo(dir);

    expect(await init(flags(), io)).toBe(1);
    expect(runs).toEqual([]);
    expect(output()).toContain(name);
    expect(existsSync(path.join(dir, "vite.config.js"))).toBe(false);
  });

  it("does set up one that also has Vite", async () => {
    const dir = vanilla({ devDependencies: { vite: "^8", webpack: "5" } });

    expect(await init(flags(), fakeIo(dir).io)).toBe(0);
  });

  it("says how to update a three.js that is too old", async () => {
    const dir = vanilla({ dependencies: { three: "^0.128.0" } });
    const { io, runs, output } = fakeIo(dir);

    expect(await init(flags(), io)).toBe(1);
    expect(runs).toEqual([]);
    expect(output()).toContain("uses three.js 0.128");
    expect(output()).toContain("needs 0.150 or newer");
    expect(output()).toContain("npm install three@latest");
    expect(existsSync(path.join(dir, "vite.config.js"))).toBe(false);
  });

  it("says the same of one from a link, leaving the folder as it was", async () => {
    const dir = path.join(root, "app");
    mkdirSync(dir);
    writeFileSync(
      path.join(dir, "index.html"),
      '<script src="https://cdnjs.cloudflare.com/ajax/libs/three.js/r128/three.min.js"></script><script src="https://unpkg.com/three@0.128.0/build/three.min.js"></script>'
    );
    const { io, runs, output } = fakeIo(dir);

    expect(await init(flags(), io)).toBe(1);
    expect(runs).toEqual([]);
    expect(output()).toContain("Update the version in your page's link");
    expect(existsSync(path.join(dir, "package.json"))).toBe(false);
  });

  it("takes the oldest one it supports, and what a range or a tag says", async () => {
    for (const three of ["0.150.0", "^0.150.1", ">=0.160.0", "latest", "next"]) {
      const dir = vanilla({ dependencies: { three } });
      expect(await init(flags(), fakeIo(dir).io), three).toBe(0);
    }
  });

  it("says how to update a Vite that is too old", async () => {
    const dir = vanilla({ devDependencies: { vite: "^4.5.0" } });
    const { io, runs, output } = fakeIo(dir);

    expect(await init(flags(), io)).toBe(1);
    expect(runs).toEqual([]);
    expect(output()).toContain("needs Vite 5 or newer");
    expect(output()).toContain("npm install -D vite@latest");
  });
});

describe("a monorepo", () => {
  const app = (relative: string, manifest: Record<string, unknown>, files: Record<string, string> = {}) => {
    const dir = path.join(root, relative);
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: path.basename(relative), ...manifest }));
    for (const [name, text] of Object.entries(files)) {
      writeFileSync(path.join(dir, name), text);
    }
    return dir;
  };
  const threeApp = { dependencies: { three: "^0.180.0" }, devDependencies: { vite: "^8" }, scripts: { dev: "vite" } };

  beforeEach(() => {
    mkdirSync(path.join(root, ".git"));
    writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "repo", workspaces: ["apps/*", "libs/*"] }));
  });

  it("finds the one app from the root", async () => {
    const dir = app("apps/scene", threeApp);
    app("apps/docs", { dependencies: { react: "19" } });
    const { io, runs } = fakeIo(root);

    expect(await init(flags(), io)).toBe(0);
    expect(runs.map((run) => run.cwd)).toEqual([dir]);
    expect(existsSync(path.join(dir, "vite.config.mjs"))).toBe(true);
  });

  it("sets up every app that uses three.js, and says how to start each", async () => {
    const a = app("apps/one", threeApp);
    const b = app("apps/two", threeApp);
    const { io, runs, output } = fakeIo(root);

    expect(await init(flags(), io)).toBe(0);
    expect(runs.map((run) => run.cwd).sort()).toEqual([a, b].sort());
    expect(output()).toContain("Found 2 apps");
    expect(output()).toContain("in apps/one: `npm run dev`");
    expect(output()).toContain("in apps/two: `npm run dev`");
  });

  // From the root, the same command would run something else, or nothing.
  it("says which folder to start an app in", async () => {
    app("apps/scene", threeApp);
    const { io, output } = fakeIo(root);

    await init(flags(), io);

    expect(output()).toContain("Start it in apps/scene with `npm run dev`");
  });

  it("finishes with how to start it, after everything else it did", async () => {
    app("apps/scene", threeApp);
    const { io, lines } = fakeIo(root);

    await init(flags({ mcp: true }), io);

    expect(lines.findIndex((line) => line.includes("Registered the MCP server"))).toBeLessThan(
      lines.findIndex((line) => line.includes("Start it in"))
    );
  });

  it("leaves a library that only depends on three alone", async () => {
    const dir = app("apps/scene", threeApp);
    const library = app("libs/shapes", { dependencies: { three: "^0.180.0" } });
    const { io, runs } = fakeIo(root);

    await init(flags(), io);

    expect(runs.map((run) => run.cwd)).toEqual([dir]);
    expect(existsSync(path.join(library, "vite.config.mjs"))).toBe(false);
  });

  it("reads pnpm's list of workspaces", () => {
    writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "repo" }));
    writeFileSync(path.join(root, "pnpm-workspace.yaml"), "packages:\n  - 'sites/*'\n  - '!sites/skip'\n");
    const dir = app("sites/scene", threeApp);

    expect(findApps(root).map((found) => found.dir)).toEqual([dir]);
  });

  it("finds a conventional folder with nothing declared", () => {
    writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "repo" }));
    const dir = app("frontend", threeApp);

    expect(findApps(root).map((found) => found.dir)).toEqual([dir]);
  });

  it("finds the app from a folder inside it", () => {
    const dir = app("apps/scene", threeApp);
    const inside = path.join(dir, "src");
    mkdirSync(inside);

    expect(findApps(inside).map((found) => found.dir)).toEqual([dir]);
  });

  it("registers the MCP server once, at the root", async () => {
    app("apps/one", threeApp);
    app("apps/two", threeApp);

    await init(flags({ mcp: true }), fakeIo(root).io);

    expect(existsSync(path.join(root, ".mcp.json"))).toBe(true);
    expect(existsSync(path.join(root, "apps/one/.mcp.json"))).toBe(false);
  });

  it("carries on with the others when one can't be set up", async () => {
    const good = app("apps/good", threeApp);
    app("apps/bad", { dependencies: { three: "1", next: "15" }, devDependencies: {}, scripts: {} }, { "index.html": "" });
    const { io, runs, output } = fakeIo(root);

    expect(await init(flags(), io)).toBe(1);
    expect(runs.map((run) => run.cwd)).toEqual([good]);
    expect(output()).toContain("Next.js");
    expect(output()).toContain("Start it in apps/good with");
  });
});

describe("assistants", () => {
  it.each([
    [".claude", true],
    ["CLAUDE.md", false],
    [".cursor", true],
    [".cursorrules", false],
    [".windsurf", true],
    [".mcp.json", false],
  ])("sets up the tools without asking when it finds %s", async (sign, isFolder) => {
    const dir = project();
    const target = path.join(root, sign);
    if (isFolder) {
      mkdirSync(target);
    } else {
      writeFileSync(target, "{}");
    }
    const { io, runs, output } = fakeIo(dir, {
      interactive: true,
      ask: async () => {
        throw new Error("should not ask");
      },
    });

    expect(await init(flags(), io)).toBe(0);
    expect(runs[0].args).toContain(`@click-to-source-3d/mcp@^${VERSION}`);
    expect(existsSync(path.join(root, ".mcp.json"))).toBe(true);
    expect(output()).toContain("--no-mcp");
  });

  it("finds it in the app's own folder too", async () => {
    const dir = project();
    mkdirSync(path.join(dir, ".claude"));

    await init(flags(), fakeIo(dir).io);

    expect(existsSync(path.join(root, ".mcp.json"))).toBe(true);
  });

  it("does nothing of the kind under --no-mcp", async () => {
    const dir = project();
    mkdirSync(path.join(root, ".claude"));
    const { io, runs } = fakeIo(dir);

    await init(flags({ mcp: false }), io);

    expect(runs[0].args.join(" ")).not.toContain("mcp");
    expect(existsSync(path.join(root, ".mcp.json"))).toBe(false);
  });

  it("registers it for Cursor where Cursor is used", async () => {
    const dir = project();
    mkdirSync(path.join(root, ".cursor"));

    await init(flags(), fakeIo(dir).io);

    expect(JSON.parse(readFileSync(path.join(root, ".cursor/mcp.json"), "utf8")).mcpServers["click-to-source"]).toEqual({
      command: "npx",
      args: ["-y", "@click-to-source-3d/mcp"],
    });
  });

  it("registers it in VS Code's own format where VS Code is used", async () => {
    const dir = project();
    mkdirSync(path.join(root, ".vscode"));

    await init(flags({ mcp: true }), fakeIo(dir).io);

    expect(JSON.parse(readFileSync(path.join(root, ".vscode/mcp.json"), "utf8"))).toEqual({
      servers: {
        "click-to-source": { type: "stdio", command: "npx", args: ["-y", "@click-to-source-3d/mcp"] },
      },
    });
  });

  // A folder of editor settings is common, and says nothing about an assistant.
  it("doesn't take a .vscode folder alone as a sign of one", async () => {
    const dir = project();
    mkdirSync(path.join(root, ".vscode"));

    await init(flags(), fakeIo(dir).io);

    expect(existsSync(path.join(root, ".mcp.json"))).toBe(false);
  });

  it("keeps what is already in VS Code's file", async () => {
    const dir = project();
    mkdirSync(path.join(root, ".vscode"));
    writeFileSync(path.join(root, ".vscode/mcp.json"), JSON.stringify({ servers: { other: { type: "http" } }, inputs: [] }));

    await init(flags({ mcp: true }), fakeIo(dir).io);

    const written = JSON.parse(readFileSync(path.join(root, ".vscode/mcp.json"), "utf8"));
    expect(Object.keys(written.servers)).toEqual(["other", "click-to-source"]);
    expect(written.inputs).toEqual([]);
  });
});

describe("package managers", () => {
  it("runs one that isn't installed through npx", async () => {
    const dir = project({ lockfile: "pnpm-lock.yaml" });
    const { io, runs } = fakeIo(dir, { has: (command) => command !== "pnpm" });

    expect(await init(flags(), io)).toBe(0);
    expect(runs[0].command).toBe("npx");
    expect(runs[0].args.slice(0, 4)).toEqual(["-y", "pnpm@latest", "add", "-D"]);
  });

  it("assumes npm, which came with Node", async () => {
    const dir = project({ lockfile: "package-lock.json" });
    const { io, runs } = fakeIo(dir, { has: () => false });

    await init(flags(), io);

    expect(runs[0].command).toBe("npm");
  });

  it("adds a real dependency with each", () => {
    expect(installCommand("npm", ["three"], { dev: false }).args).toEqual(["install", "three"]);
    expect(installCommand("pnpm", ["three"], { dev: false }).args).toEqual(["add", "three"]);
    expect(installCommand("yarn", ["three"], { dev: false }).args).toEqual(["add", "three"]);
    expect(installCommand("bun", ["three"], { dev: false }).args).toEqual(["add", "three"]);
  });
});

describe("reading a project", () => {
  const folder = (files: Record<string, string>) => {
    const dir = path.join(root, "app");
    for (const [name, text] of Object.entries(files)) {
      mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
      writeFileSync(path.join(dir, name), text);
    }
    return dir;
  };

  it.each([
    ['import * as THREE from "three";', true],
    ["import { Mesh } from 'three';", true],
    ['import { OrbitControls } from "three/addons/controls/OrbitControls.js";', true],
    ['import * as THREE from "./lib/three.module.js";', true],
    ['import * as THREE from "https://cdn.jsdelivr.net/npm/three@0.160.0/build/three.module.js";', true],
    ['const THREE = await import("three");', true],
    ['const THREE = require("three");', true],
    ['import x from "threepio";', false],
    ['import x from "./my-three-helpers.js";', false],
    ["// three is a number", false],
  ])("%s", (code, uses) => {
    expect(readProject(folder({ "src/a.js": code })).usesThree).toBe(uses);
  });

  it("finds three in a page", () => {
    expect(readProject(folder({ "index.html": '<script src="https://unpkg.com/three@0.149.0/build/three.min.js"></script>' })).threeVersion).toBe("0.149.0");
    expect(readProject(folder({ "index.html": '{"imports":{"three":"./three.js"}}' })).usesThree).toBe(true);
  });

  it("doesn't take a folder of projects for one project", async () => {
    const dir = folder({
      "one/package.json": JSON.stringify({ name: "one" }),
      "one/src/a.js": 'import * as THREE from "three";',
      "two/package.json": JSON.stringify({ name: "two" }),
    });
    const { io, runs, output } = fakeIo(dir);

    expect(readProject(dir).usesThree).toBe(false);
    expect(await init(flags(), io)).toBe(1);
    expect(runs).toEqual([]);
    expect(output()).toContain("No three.js project found");
    expect(existsSync(path.join(dir, "package.json"))).toBe(false);
  });

  it("doesn't look in what isn't the project's", () => {
    expect(readProject(folder({ "node_modules/x/a.js": 'import "three";\nfrom "three"', "dist/a.js": 'import * as T from "three";' })).usesThree).toBe(false);
  });

  it("reads which Vite is asked for", () => {
    const manifest = (vite: string) => JSON.stringify({ devDependencies: { vite } });
    expect(readProject(folder({ "package.json": manifest("^8.2.1") })).viteMajor).toBe(8);
    expect(readProject(folder({ "package.json": manifest("~5.0.0") })).viteMajor).toBe(5);
    expect(readProject(folder({ "package.json": manifest("latest") })).viteMajor).toBeNull();
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
    expect(installCommand("npm", ["x"])).toEqual({ command: "npm", args: ["install", "-D", "x"] });
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

import { mkdtempSync, existsSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DevServerEntry } from "@click-to-source-3d/shared";
import { findDevServer } from "../src/discovery.js";

/** A pid that certainly belongs to no running process: one that has exited. */
const deadPid = (() => {
  const child = spawnSync(process.execPath, ["-e", "0"]);
  return child.pid as number;
})();

let directory: string;
const base = path.resolve(os.tmpdir(), "projects");

function announce(name: string, entry: Partial<DevServerEntry>) {
  const full: DevServerEntry = {
    origin: "http://localhost:5173",
    root: path.join(base, "app"),
    pid: process.pid,
    version: "0.1.5",
    startedAt: 1,
    ...entry,
  };
  writeFileSync(path.join(directory, `${name}.json`), JSON.stringify(full));
}

beforeEach(() => {
  directory = mkdtempSync(path.join(os.tmpdir(), "cts-registry-"));
});

afterEach(() => {
  rmSync(directory, { recursive: true, force: true });
});

describe("findDevServer", () => {
  it("finds nothing when no dev server has announced itself", () => {
    expect(findDevServer(base, directory)).toBeNull();
    expect(findDevServer(base, path.join(directory, "missing"))).toBeNull();
  });

  it("prefers the dev server rooted where the assistant was started", () => {
    announce("other", { origin: "http://localhost:5174", root: path.join(base, "other"), startedAt: 9 });
    announce("here", { origin: "http://localhost:5175", root: path.join(base, "app"), startedAt: 1 });

    expect(findDevServer(path.join(base, "app"), directory)?.origin).toBe("http://localhost:5175");
  });

  // A monorepo: the assistant runs at the repository root, the app below it.
  it("finds an app inside the project, the nearest first", () => {
    announce("deep", { origin: "http://localhost:5176", root: path.join(base, "repo", "apps", "web", "nested") });
    announce("near", { origin: "http://localhost:5177", root: path.join(base, "repo", "apps", "web") });

    expect(findDevServer(path.join(base, "repo"), directory)?.origin).toBe("http://localhost:5177");
  });

  it("falls back to the most recent of any when none is related", () => {
    announce("old", { origin: "http://localhost:5178", root: path.join(base, "x"), startedAt: 1 });
    announce("new", { origin: "http://localhost:5179", root: path.join(base, "y"), startedAt: 2 });

    expect(findDevServer(path.join(base, "z"), directory)?.origin).toBe("http://localhost:5179");
  });

  // A dev server killed rather than stopped leaves its file behind.
  it("ignores and clears an announcement whose process is gone", () => {
    announce("dead", { origin: "http://localhost:5180", pid: deadPid, root: path.join(base, "app") });

    expect(findDevServer(path.join(base, "app"), directory)).toBeNull();
    expect(existsSync(path.join(directory, "dead.json"))).toBe(false);
  });

  it("skips a file that is not an announcement", () => {
    writeFileSync(path.join(directory, "junk.json"), "{ not json");
    announce("good", {});

    expect(findDevServer(path.join(base, "app"), directory)?.origin).toBe("http://localhost:5173");
  });
});

import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getSource, listFiles } from "../src/tools.js";

/**
 * getSource reaches the file through the dev server, so these stub the
 * transport rather than standing up a server. What is under test is the line
 * arithmetic, which is the part a caller has to reason about.
 */
const FIXTURE = Array.from({ length: 100 }, (_, i) => `line ${i + 1}`).join("\n");

function stubRead(content: string) {
  vi.stubGlobal("fetch", async () => ({
    ok: true,
    status: 200,
    json: async () => ({ content }),
  }));
}

const context = { origin: "http://unused", root: "/unused" };

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("getSource line selection", () => {
  it("returns the whole file when no bounds are given", async () => {
    stubRead(FIXTURE);

    const result = await getSource(context, { file: "a.ts" });

    expect(result.startLine).toBe(1);
    expect(result.endLine).toBe(100);
    expect(result.content.split("\n")).toHaveLength(100);
  });

  it("centres a window on `around`", async () => {
    stubRead(FIXTURE);

    const result = await getSource(context, {
      file: "a.ts",
      around: 50,
      contextLines: 3,
    });

    expect([result.startLine, result.endLine]).toEqual([47, 53]);
    expect(result.content.split("\n")[0]).toBe("line 47");
  });

  it("defaults to 20 lines either side of `around`", async () => {
    stubRead(FIXTURE);

    const result = await getSource(context, { file: "a.ts", around: 50 });

    expect([result.startLine, result.endLine]).toEqual([30, 70]);
  });

  // Per-edge, not all-or-nothing: a caller that computed one bound and wants
  // the other centred gets exactly that, rather than having `around` ignored
  // wholesale the moment either explicit bound appears.
  it("lets an explicit startLine override the start of `around`", async () => {
    stubRead(FIXTURE);

    const result = await getSource(context, {
      file: "a.ts",
      around: 50,
      contextLines: 3,
      startLine: 48,
    });

    expect([result.startLine, result.endLine]).toEqual([48, 53]);
  });

  it("lets an explicit endLine override the end of `around`", async () => {
    stubRead(FIXTURE);

    const result = await getSource(context, {
      file: "a.ts",
      around: 50,
      contextLines: 3,
      endLine: 60,
    });

    expect([result.startLine, result.endLine]).toEqual([47, 60]);
  });

  it("clamps a window that runs past either end of the file", async () => {
    stubRead(FIXTURE);

    const atStart = await getSource(context, { file: "a.ts", around: 2, contextLines: 10 });
    const atEnd = await getSource(context, { file: "a.ts", around: 99, contextLines: 10 });

    expect(atStart.startLine).toBe(1);
    expect(atEnd.endLine).toBe(100);
  });
});

describe("listFiles", () => {
  it("reports the files it can see, and that it saw all of them", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cts-files-"));

    try {
      await fs.mkdir(path.join(root, "src"), { recursive: true });
      await fs.mkdir(path.join(root, "node_modules"), { recursive: true });
      await fs.writeFile(path.join(root, "src", "a.tsx"), "");
      await fs.writeFile(path.join(root, "src", "b.ts"), "");
      await fs.writeFile(path.join(root, "index.html"), "");
      await fs.writeFile(path.join(root, ".hidden.ts"), "");
      await fs.writeFile(path.join(root, "node_modules", "dep.js"), "");

      const result = await listFiles({ ...context, root });

      // Same filtering as the provenance scan: source extensions only, no
      // dotfiles, nothing under an ignored directory.
      expect(result.files).toEqual(["src/a.tsx", "src/b.ts"]);
      expect(result.truncated).toBe(false);
      expect(result.scannedFrom).toBe(root);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  // The budget was previously silent, so a partial scan was indistinguishable
  // from a complete one — a caller would conclude a file did not exist when the
  // walk had simply stopped before reaching it.
  it("says so when it stops at the scan limit", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cts-budget-"));

    try {
      const OVER_BUDGET = 2001;
      const names = Array.from({ length: OVER_BUDGET }, (_, i) => `f${i}.ts`);

      for (let i = 0; i < names.length; i += 200) {
        await Promise.all(
          names
            .slice(i, i + 200)
            .map((name) => fs.writeFile(path.join(root, name), ""))
        );
      }

      const result = await listFiles({ ...context, root });

      expect(result.truncated).toBe(true);
      expect(result.files.length).toBeLessThan(OVER_BUDGET);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  }, 30000);
});

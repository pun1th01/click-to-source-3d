import fsSync, { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { listProvenance } from "../src/tools.js";

/**
 * The provenance scanner is the only part of this package that reads the
 * filesystem directly. Everything else goes through the dev server, which
 * resolves symlinks and re-checks containment before answering. These tests
 * pin the scanner to the same boundary.
 */

const REF = (file: string, fn: string) =>
  `export const Thing = () => <mesh userData={{\n` +
  `  sourceRef: { file: "${file}", function: "${fn}", line: 1, args: { count } },\n` +
  `}} />;\n`;

let root: string;
let outside: string;

/**
 * Whether this platform can create a symlink at all, decided synchronously at
 * module scope.
 *
 * It has to be known before `describe` runs. `it.runIf(...)` evaluates its
 * condition during collection, and `beforeAll` runs after collection — so a
 * flag assigned in `beforeAll` is still false when runIf reads it, and the
 * guarded tests skip on every platform including the ones where symlinks work
 * perfectly well. That is exactly what happened: these tests skipped on Linux
 * CI for the same reason they skip on Windows, and nothing said so.
 */
const linksSupported = (() => {
  let probe: string | undefined;

  try {
    probe = fsSync.mkdtempSync(path.join(os.tmpdir(), "cts-symprobe-"));
    fsSync.writeFileSync(path.join(probe, "target.ts"), "");
    fsSync.symlinkSync(
      path.join(probe, "target.ts"),
      path.join(probe, "link.ts"),
      "file"
    );

    return true;
  } catch {
    // Needs elevation or Developer Mode on Windows. Said out loud, because a
    // name in a skip list does not tell you what stopped being checked.
    console.warn(
      "[cts] symlink containment tests SKIPPED — fs.symlink is unavailable " +
        "(needs elevation or Developer Mode on Windows). The scanner's " +
        "containment boundary is UNVERIFIED on this platform."
    );

    return false;
  } finally {
    if (probe) {
      fsSync.rmSync(probe, { recursive: true, force: true });
    }
  }
})();

beforeAll(async () => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "cts-scan-"));
  root = path.join(base, "root");
  outside = path.join(base, "outside");

  await fs.mkdir(path.join(root, "src"), { recursive: true });
  await fs.mkdir(outside, { recursive: true });

  await fs.writeFile(path.join(root, "src", "inRoot.ts"), REF("src/inRoot.ts", "inRoot"));
  await fs.writeFile(path.join(outside, "secret.ts"), REF("secret.ts", "outsideTheRoot"));

  // Only where the probe above already proved it works. Failing here would
  // abort the whole file rather than skip the two tests that need them.
  if (linksSupported) {
    await fs.symlink(
      path.join(outside, "secret.ts"),
      path.join(root, "src", "linked.ts"),
      "file"
    );
    await fs.symlink(outside, path.join(root, "src", "linkedDir"), "dir");
  }
});

afterAll(async () => {
  if (root) {
    await fs.rm(path.dirname(root), { recursive: true, force: true });
  }
});

describe("provenance scan containment", () => {
  it("finds a real source file under the root", async () => {
    const { sites } = await listProvenance({ origin: "http://unused", root });

    expect(sites.map((site) => site.function)).toContain("inRoot");
  });

  it.runIf(linksSupported)(
    "does not follow a symlinked file out of the project root",
    async () => {
      const { sites } = await listProvenance({ origin: "http://unused", root });

      expect(sites.map((site) => site.function)).not.toContain("outsideTheRoot");
      expect(sites.map((site) => site.file)).not.toContain("src/linked.ts");
    }
  );

  it.runIf(linksSupported)(
    "does not descend a symlinked directory out of the project root",
    async () => {
      const { sites } = await listProvenance({ origin: "http://unused", root });

      expect(
        sites.filter((site) => site.file.startsWith("src/linkedDir"))
      ).toHaveLength(0);
    }
  );

  // Skipping is correct on Windows without elevation, and wrong anywhere
  // else. The two tests above are the only coverage of the scanner's
  // containment boundary, so a platform that silently stops running them
  // should fail rather than stay green — otherwise the boundary is untested
  // and nothing says so.
  it.runIf(process.platform !== "win32")(
    "can create symlinks, so the containment tests above actually ran",
    () => {
      expect(linksSupported).toBe(true);
    }
  );
});

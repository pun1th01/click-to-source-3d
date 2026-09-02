import { promises as fs } from "node:fs";
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
let linksSupported = false;

beforeAll(async () => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "cts-scan-"));
  root = path.join(base, "root");
  outside = path.join(base, "outside");

  await fs.mkdir(path.join(root, "src"), { recursive: true });
  await fs.mkdir(outside, { recursive: true });

  await fs.writeFile(path.join(root, "src", "inRoot.ts"), REF("src/inRoot.ts", "inRoot"));
  await fs.writeFile(path.join(outside, "secret.ts"), REF("secret.ts", "outsideTheRoot"));

  // Creating a symlink needs elevation or Developer Mode on Windows. When it
  // is unavailable the containment tests skip rather than pass vacuously —
  // a silent pass here would be worse than no test, since it would report
  // the boundary as verified on a platform where it was never exercised.
  try {
    await fs.symlink(
      path.join(outside, "secret.ts"),
      path.join(root, "src", "linked.ts"),
      "file"
    );
    await fs.symlink(outside, path.join(root, "src", "linkedDir"), "dir");
    linksSupported = true;
  } catch {
    linksSupported = false;

    // Named at the moment it is decided. The runner reports skips by name
    // rather than as a count, but a name alone does not say what stopped
    // being checked — and "2 skipped" in a log nobody opens is how a
    // security-shaped boundary quietly becomes untested.
    console.warn(
      "[cts] symlink containment tests SKIPPED — fs.symlink is unavailable " +
        "(needs elevation or Developer Mode on Windows). The scanner's " +
        "containment boundary is UNVERIFIED on this platform."
    );
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

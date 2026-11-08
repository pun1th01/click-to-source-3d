import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

/**
 * Plain three.js, as a developer meets it: an example with no click-to-source
 * code in it at all, only `clickToSource()` in its Vite config, and nothing
 * tagged by hand. Everything here comes from reading the code when it is served.
 */

test.use({ baseURL: "http://localhost:5198" });

const EXAMPLE = path.resolve("packages/examples-three");
const file = (name: string) => path.join(EXAMPLE, name);
const MAIN = file("src/main.js");
const WORLD = file("src/world.js");
const NOISE = file("src/noise.js");
const PAGE = file("edge-cases.html");
const originals = new Map([MAIN, WORLD, NOISE, PAGE].map((name) => [name, readFileSync(name, "utf8")]));
// A run stopped halfway leaves its edits behind, and the next would take those for how things are.
for (const [name, text] of [
  [MAIN, "buildWorld(scene, 7);"],
  [WORLD, "const TERRAIN_SIZE = 40;"],
  [WORLD, "roughness: 0.9"],
  [NOISE, "let amplitude = 0.5;"],
  [PAGE, "color: 0x3399ff"],
] as const) {
  if (!originals.get(name)!.includes(text)) {
    throw new Error(`${name} no longer has ${text}: an earlier run left it edited. Put it back first.`);
  }
}

/** Writes a file back, waiting out a sync client that has it open for a moment. */
async function restore(name: string, text: string) {
  for (let attempt = 0; ; attempt++) {
    try {
      writeFileSync(name, text);
      return;
    } catch (error) {
      if (attempt >= 20) {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
}

const lineIn = (name: string, text: string) =>
  (originals.get(name) ?? readFileSync(name, "utf8")).split(/\r?\n/).findIndex((line) => line.includes(text)) + 1;

const TERRAIN_LINE = lineIn(WORLD, "const terrain = new THREE.Mesh(");
const CUBE_LINE = lineIn(MAIN, "const cube = new THREE.Mesh(");
const ROCK_LINE = lineIn(WORLD, "return new THREE.Mesh(geometry, material);");
const CLONE_LINE = lineIn(WORLD, "const secondRock = rock.clone();");
const STONES_LINE = lineIn(WORLD, "const stones = new THREE.InstancedMesh(");
const BEACON_LINE = lineIn(file("src/beacon.js"), "loader.parse(");

type Selection = {
  file: string;
  line: number;
  kind: string;
  function: string;
  how: string | null;
  modelPath: string | null;
  instanceId: number | null;
  trace: Array<{ name: string; calledAt?: { file: string; line: number } }>;
  generators: Array<{ name: string; uses: Array<{ name: string; depth: number }> }>;
  props: Array<{ element: string; name: string; file: string }>;
  materials: string[];
};
type Devtools = {
  setInspecting(on: boolean): void;
  isInspecting(): boolean;
  selection(): Selection | null;
  screenPointOf(file: string, line: number): { x: number; y: number } | null;
  describeAt(x: number, y: number): { kind: string; file: string | null; line: number | null } | null;
};
declare global {
  interface Window {
    __CTS_DEVTOOLS__?: Devtools;
    __CTS_TRACE__?: unknown;
    __edge?: { scene: unknown; camera: unknown; workerReply: Promise<unknown> };
    __classicRan?: boolean;
  }
}

/** Fails a test on anything the page complains about. */
function watchForErrors(page: Page) {
  const problems: string[] = [];
  page.on("pageerror", (error) => problems.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error" && !message.location().url.endsWith("favicon.ico")) {
      problems.push(message.text());
    }
  });
  return problems;
}

async function ready(page: Page, url = "/") {
  await page.goto(url);
  await expect
    .poll(
      () =>
        page.evaluate(
          ([name, line]) => window.__CTS_DEVTOOLS__?.screenPointOf(name as string, line as number) ?? null,
          ["src/main.js", CUBE_LINE]
        ),
      { timeout: 30_000 }
    )
    .not.toBeNull();
}

const pointOf = (page: Page, name: string, line: number) =>
  page.evaluate(
    ([where, at]) => window.__CTS_DEVTOOLS__!.screenPointOf(where as string, at as number)!,
    [name, line]
  );

async function select(page: Page, x: number, y: number) {
  await page.evaluate(() => window.__CTS_DEVTOOLS__!.setInspecting(true));
  await page.mouse.click(x, y);
  await expect.poll(() => page.evaluate(() => window.__CTS_DEVTOOLS__!.selection())).not.toBeNull();
  return (await page.evaluate(() => window.__CTS_DEVTOOLS__!.selection()))!;
}

/**
 * Somewhere on the page where an object made at a line is what a click would find.
 * Its middle won't do: there may be something in front of it, or a hole in it.
 */
async function pointOn(page: Page, name: string, line: number) {
  let point: { x: number; y: number } | null = null;
  await expect
    .poll(
      async () => {
        point = await page.evaluate(
          ([where, at]) => {
            for (let y = 16; y < window.innerHeight; y += 24) {
              for (let x = 16; x < window.innerWidth; x += 24) {
                const hit = window.__CTS_DEVTOOLS__!.describeAt(x, y);
                if (hit?.file === where && hit.line === at) {
                  return { x, y };
                }
              }
            }
            return null;
          },
          [name, line] as const
        );
        return point;
      },
      { timeout: 15_000 }
    )
    .not.toBeNull();
  return point as unknown as { x: number; y: number };
}

async function selectAtLine(page: Page, name: string, line: number) {
  const point = await pointOn(page, name, line);
  return select(page, point.x, point.y);
}

const selectTerrain = (page: Page) => selectAtLine(page, "src/world.js", TERRAIN_LINE);

const panel = (page: Page) => page.locator("cts-devtools .panel");

test.afterEach(async ({ page }) => {
  // Off the page first, so restoring a file doesn't reload it under the next test.
  // A save can have Vite's reload on its way, and when the two navigations collide
  // this can fail, or never return. The page itself is fine, so it is just tried again.
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      await page.goto("about:blank", { timeout: 5000 });
      break;
    } catch {
      // Whatever happens here, the files below still have to go back.
    }
  }
  let restored = false;
  for (const [name, text] of originals) {
    if (readFileSync(name, "utf8") !== text) {
      await restore(name, text);
      restored = true;
    }
  }
  // Long enough for Vite's reload to go out with no page there to hear it. Heard by
  // the next test's page, it would wipe whatever that test has just typed.
  if (restored) {
    await new Promise((resolve) => setTimeout(resolve, 3000));
  }
});

test("a click finds the line that made a mesh, with nothing tagged", async ({ page }) => {
  const problems = watchForErrors(page);
  await ready(page);

  const selected = await selectTerrain(page);

  expect(selected).toMatchObject({
    kind: "Mesh",
    file: "src/world.js",
    line: TERRAIN_LINE,
    function: "createTerrain",
    how: "new",
  });
  await expect(panel(page)).toContainText(`src/world.js:${TERRAIN_LINE}`);
  expect(problems).toEqual([]);
});

test("hovering names what is under the pointer", async ({ page }) => {
  await ready(page);
  await page.evaluate(() => window.__CTS_DEVTOOLS__!.setInspecting(true));
  const point = await pointOn(page, "src/main.js", CUBE_LINE);
  await page.mouse.move(point.x, point.y);

  await expect(page.locator("cts-devtools .tip")).toContainText(`src/main.js:${CUBE_LINE}`);
});

test("the panel shows the calls that led to a mesh, with the values they were given", async ({ page }) => {
  await ready(page);
  const selected = await selectTerrain(page);

  expect(selected.trace.map((frame) => frame.name)).toEqual(["buildWorld", "createTerrain"]);
  expect(selected.trace[0].calledAt?.file).toBe("src/main.js");

  const frames = panel(page).locator("[data-cts-frame]");
  await expect(frames.nth(0)).toHaveAttribute("data-cts-frame", "createTerrain");
  await expect(frames.nth(1)).toHaveAttribute("data-cts-frame", "buildWorld");

  // Written as a constant, and editable where the constant is.
  const size = panel(page).locator('[data-cts-edit="createTerrain.size"]');
  await expect(size).toHaveValue("40");
  await expect(panel(page)).toContainText("TERRAIN_SIZE · line");
  // Written as a literal in main.js.
  await expect(panel(page).locator('[data-cts-edit="buildWorld.seed"]')).toHaveValue("7");
  // An object can only be shown.
  await expect(frames.nth(1)).toContainText("<Scene>");
});

test("the panel shows the noise function behind a mesh, and what that calls", async ({ page }) => {
  await ready(page);
  const selected = await selectTerrain(page);

  expect(selected.generators[0].uses.map((use) => `${"  ".repeat(use.depth)}${use.name}`)).toEqual([
    "fbm",
    "  valueNoise",
    "    smooth",
    "    hash",
  ]);

  const fbm = panel(page).locator('[data-cts-use="fbm"]');
  await expect(fbm).toContainText("fbm(x, y, octaves)");
  await expect(fbm).toContainText("src/noise.js:");

  // Its numbers open up under it.
  await fbm.locator("summary").click({ position: { x: 3, y: 8 } });
  await expect(fbm.locator('[data-cts-edit="fbm.line 22[0]"]')).toHaveValue("0.5");
});

test("the panel gathers a mesh's geometry and material, wherever they are written", async ({ page }) => {
  await ready(page);
  await selectTerrain(page);

  await expect(panel(page).locator('[data-cts-edit="PlaneGeometry.args[2]"]')).toHaveValue("96");
  await expect(panel(page).locator('[data-cts-edit="MeshStandardMaterial.color"]')).toHaveValue("#4f7a4a");
  await expect(panel(page).locator('[data-cts-edit="MeshStandardMaterial.roughness"]')).toHaveValue("0.9");
  await expect(panel(page).locator('[data-cts-edit="Mesh.name"]')).toHaveValue("terrain");
});

test("a value changes the scene as it is dragged, and Esc puts it back", async ({ page }) => {
  await ready(page);
  await selectTerrain(page);

  const roughness = panel(page).locator('[data-cts-slider="MeshStandardMaterial.roughness"]');
  const field = panel(page).locator('[data-cts-edit="MeshStandardMaterial.roughness"]');
  await roughness.fill("0.3");
  await expect(field).toHaveValue("0.3");
  expect(readFileSync(WORLD, "utf8")).toBe(originals.get(WORLD));

  await field.press("Escape");
  await expect(field).toHaveValue("0.9");
});

test("a colour changes the scene as it is typed", async ({ page }) => {
  await ready(page);
  await selectTerrain(page);
  const shown = async () => (await page.evaluate(() => window.__CTS_DEVTOOLS__!.selection()))!.materials[0];

  const color = panel(page).locator('[data-cts-edit="MeshStandardMaterial.color"]');
  expect(await shown()).toContain("#4f7a4a");

  // Not a colour yet, so the scene waits.
  await color.fill("#ff");
  expect(await shown()).toContain("#4f7a4a");

  await color.fill("#ff0000");
  expect(await shown()).toContain("#ff0000");
  // Only on screen so far.
  expect(readFileSync(WORLD, "utf8")).toBe(originals.get(WORLD));

  await color.press("Escape");
  await expect(color).toHaveValue("#4f7a4a");
  expect(await shown()).toContain("#4f7a4a");
});

test("a typed argument is saved at the call, and the page comes back with it selected", async ({ page }) => {
  await ready(page);
  await selectTerrain(page);

  const seed = panel(page).locator('[data-cts-edit="buildWorld.seed"]');
  await seed.fill("12");
  await seed.press("Enter");

  await expect.poll(() => readFileSync(MAIN, "utf8")).toContain("buildWorld(scene, 12);");
  // Nothing hot-swaps in plain three.js, so that was a full reload.
  await expect(panel(page).locator('[data-cts-edit="buildWorld.seed"]')).toHaveValue("12", { timeout: 15_000 });
  expect((await page.evaluate(() => window.__CTS_DEVTOOLS__!.selection()))?.line).toBe(TERRAIN_LINE);
});

test("a helper's number is saved in the helper's file", async ({ page }) => {
  await ready(page);
  await selectTerrain(page);

  const fbm = panel(page).locator('[data-cts-use="fbm"]');
  await fbm.locator("summary").click({ position: { x: 3, y: 8 } });
  const amplitude = fbm.locator('[data-cts-edit="fbm.line 22[0]"]');
  await amplitude.fill("0.25");
  await amplitude.press("Enter");

  await expect.poll(() => readFileSync(NOISE, "utf8")).toContain("let amplitude = 0.25;");
});

test("several values across several files save together", async ({ page }) => {
  await ready(page);
  await selectTerrain(page);

  await panel(page).locator('[data-cts-edit="buildWorld.seed"]').fill("3");
  await panel(page).locator('[data-cts-edit="MeshStandardMaterial.roughness"]').fill("0.5");
  await panel(page).locator('[data-cts-edit="createTerrain.size"]').fill("50");
  await expect(panel(page).locator(".unsaved")).toContainText("3 unsaved values");
  await panel(page).locator('[data-cts-action="save"]').click();

  // One save, though the first file written is enough to reload the page.
  await expect.poll(() => readFileSync(MAIN, "utf8")).toContain("buildWorld(scene, 3);");
  await expect.poll(() => readFileSync(WORLD, "utf8")).toContain("roughness: 0.5");
  await expect.poll(() => readFileSync(WORLD, "utf8")).toContain("const TERRAIN_SIZE = 50;");
});

test("after a file changes, what other files say about it is up to date", async ({ page }) => {
  await ready(page);
  await selectTerrain(page);

  // Moves everything in noise.js down a line.
  writeFileSync(NOISE, `// a new first line\n${originals.get(NOISE)}`);

  await expect
    .poll(
      async () => {
        const fbm = panel(page).locator('[data-cts-use="fbm"]');
        return (await fbm.count()) > 0 ? fbm.textContent() : "";
      },
      { timeout: 15_000 }
    )
    .toContain(`src/noise.js:${lineIn(NOISE, "export function fbm(") + 1}`);
});

test("an object that moves its geometry after the constructor isn't rebuilt to preview", async ({ page }) => {
  await ready(page);
  await selectTerrain(page);

  // The terrain's vertices come from fbm, which the geometry's parameters don't record.
  await expect(panel(page).locator('[data-cts-edit="PlaneGeometry.args[2]"]')).toBeVisible();
  await expect(panel(page).locator('[data-cts-slider="PlaneGeometry.args[2]"]')).toHaveCount(0);
});

test("a geometry nobody has changed since previews by being rebuilt", async ({ page }) => {
  await ready(page);
  await selectAtLine(page, "src/main.js", CUBE_LINE);

  const width = panel(page).locator('[data-cts-slider="BoxGeometry.args[0]"]');
  await expect(width).toBeVisible();
  await width.fill("5");
  await expect(panel(page).locator('[data-cts-edit="BoxGeometry.args[0]"]')).toHaveValue("5");
});

test("values set on an object elsewhere in the file are found, and a loop's are editable", async ({ page }) => {
  await ready(page);
  await selectAtLine(page, "src/main.js", CUBE_LINE);

  await expect(panel(page).locator('[data-cts-edit="Mesh.position[1]"]')).toHaveValue("9");
  // In animate(), written before nothing and read on every frame.
  await expect(panel(page).locator('[data-cts-edit="Mesh.rotation-y +="]')).toHaveValue("0.01");
  await expect(panel(page).locator('[data-cts-slider="Mesh.rotation-y +="]')).toHaveCount(0);
});

test("a class's objects are traced through its constructor, from a TypeScript file", async ({ page }) => {
  await ready(page);
  const selected = await selectAtLine(page, "src/tree.ts", 9);

  expect(selected.file).toBe("src/tree.ts");
  expect(selected.trace.map((frame) => frame.name)).toEqual(["buildWorld", "Tree"]);
  await expect(panel(page).locator('[data-cts-edit="ConeGeometry.args[0]"], [data-cts-edit="CylinderGeometry.args[0]"]')).toBeVisible();
});

test("a clone is found where it was cloned", async ({ page }) => {
  await ready(page);
  const selected = await selectAtLine(page, "src/world.js", CLONE_LINE);

  expect(selected).toMatchObject({ line: CLONE_LINE, how: "clone" });
  await expect(panel(page)).toContainText("A clone of another object");
  await expect(panel(page).locator('[data-cts-edit="rock.clone.position[0]"]')).toHaveValue("-7");
});

test("the original of a clone is found where it was made, with its literal arguments", async ({ page }) => {
  await ready(page);
  const selected = await selectAtLine(page, "src/world.js", ROCK_LINE);

  expect(selected).toMatchObject({ line: ROCK_LINE, function: "createRock", how: "new" });
  await expect(panel(page).locator('[data-cts-edit="createRock.radius"]')).toHaveValue("1.6");
  await expect(panel(page).locator('[data-cts-edit="createRock.color"]')).toHaveValue("#8a8f98");
});

test("one instance of an InstancedMesh is told apart from the rest", async ({ page }) => {
  await ready(page);
  const selected = await selectAtLine(page, "src/world.js", STONES_LINE);

  expect(selected.kind).toBe("InstancedMesh");
  expect(selected.line).toBe(STONES_LINE);
  expect(selected.instanceId).not.toBeNull();
});

test("a part of a loaded model is found by the call that loaded it", async ({ page }) => {
  await ready(page);
  const selected = await selectAtLine(page, "src/beacon.js", BEACON_LINE);

  expect(selected).toMatchObject({ kind: "Mesh", file: "src/beacon.js", how: "load", function: "loadBeacon" });
  // three's loader turns the spaces in a node's name into underscores.
  expect(selected.modelPath).toMatch(/^beacon › (left|right)_blade$/);
  expect(selected.trace.map((frame) => frame.name)).toEqual(["buildWorld", "loadBeacon"]);
  await expect(panel(page)).toContainText(`Part of a model loaded here: ${selected.modelPath}.`);
});

test("a part of a loaded model stays selected after a reload", async ({ page }) => {
  await ready(page);
  const selected = await selectAtLine(page, "src/beacon.js", BEACON_LINE);

  await page.reload();

  await expect(panel(page)).toContainText(selected.modelPath!, { timeout: 15_000 });
});

test.describe("what a page can do to get in the way", () => {
  const CENTER_LINE = () => lineIn(file("src/edge-cases.js"), "const center = new THREE.Mesh(");

  async function edge(page: Page) {
    await page.goto("/edge-cases.html");
    await expect
      .poll(
        () =>
          page.evaluate(
            ([name, line]) => window.__CTS_DEVTOOLS__?.screenPointOf(name as string, line as number) ?? null,
            ["edge-cases.html", lineIn(PAGE, "const inPage = new THREE.Mesh(")]
          ),
        { timeout: 30_000 }
      )
      .not.toBeNull();
  }

  test.beforeAll(() => {
    originals.set(file("src/edge-cases.js"), readFileSync(file("src/edge-cases.js"), "utf8"));
  });

  test("a script written in the page is found at its line in the page", async ({ page }) => {
    const problems = watchForErrors(page);
    await edge(page);
    const selected = await selectAtLine(page, "edge-cases.html", lineIn(PAGE, "const inPage = new THREE.Mesh("));

    expect(selected).toMatchObject({ file: "edge-cases.html", line: lineIn(PAGE, "const inPage = new THREE.Mesh(") });
    await expect(panel(page).locator('[data-cts-edit="MeshBasicMaterial.color"]')).toHaveValue("0x3399ff");
    expect(problems).toEqual([]);
  });

  test("a value in a page's script is saved in the page, keeping its form", async ({ page }) => {
    await edge(page);
    await selectAtLine(page, "edge-cases.html", lineIn(PAGE, "const inPage = new THREE.Mesh("));

    const color = panel(page).locator('[data-cts-edit="MeshBasicMaterial.color"]');
    await color.fill("0xff0000");
    await color.press("Enter");

    await expect.poll(() => readFileSync(PAGE, "utf8")).toContain("color: 0xff0000");
  });

  test("a click on a layer above the canvas reaches the scene", async ({ page }) => {
    await edge(page);
    const point = await pointOn(page, "src/edge-cases.js", CENTER_LINE());

    // The overlay is on top of the canvas, as CSS2DRenderer's is.
    expect(await page.evaluate(([x, y]) => document.elementFromPoint(x, y)?.id, [point.x, point.y])).toBe("overlay");
    const selected = await select(page, point.x, point.y);

    expect(selected.line).toBe(CENTER_LINE());
  });

  test("a control on the page keeps its click", async ({ page }) => {
    await edge(page);
    await page.evaluate(() => {
      window.__CTS_DEVTOOLS__!.setInspecting(true);
      (window as unknown as { clicked: boolean }).clicked = false;
      document.getElementById("button")!.addEventListener("click", () => {
        (window as unknown as { clicked: boolean }).clicked = true;
      });
    });

    await page.locator("#button").click();

    expect(await page.evaluate(() => (window as unknown as { clicked: boolean }).clicked)).toBe(true);
    expect(await page.evaluate(() => window.__CTS_DEVTOOLS__!.selection())).toBeNull();
  });

  test("a grid doesn't take clicks from what stands in front of or behind it", async ({ page }) => {
    await edge(page);
    const point = await pointOf(page, "src/edge-cases.js", CENTER_LINE());

    // The grid is nearer the camera, with a line within a world unit of every point,
    // and this point is well clear of them.
    const hit = await page.evaluate(([x, y]) => window.__CTS_DEVTOOLS__!.describeAt(x, y), [point.x, point.y]);
    expect(hit).toMatchObject({ kind: "Mesh", line: CENTER_LINE() });
  });

  test("something that draws nothing doesn't take the click", async ({ page }) => {
    await edge(page);
    const line = lineIn(file("src/edge-cases.js"), "const behind = new THREE.Mesh(");
    const point = await pointOf(page, "src/edge-cases.js", line);

    const hit = await page.evaluate(([x, y]) => window.__CTS_DEVTOOLS__!.describeAt(x, y), [point.x, point.y]);
    expect(hit?.line).toBe(line);
  });

  test("a function called across a circular import still works", async ({ page }) => {
    const problems = watchForErrors(page);
    await edge(page);
    const line = lineIn(file("src/circular-a.js"), "return new THREE_MESH();");
    const selected = await selectAtLine(page, "src/circular-a.js", line);

    expect(selected).toMatchObject({ file: "src/circular-a.js", line, function: "makeCircular" });
    expect(problems).toEqual([]);
  });

  test("a module shared with a worker runs there too", async ({ page }) => {
    const problems = watchForErrors(page);
    await edge(page);

    expect(await page.evaluate(() => window.__edge!.workerReply)).toEqual({ type: "Group", children: 1 });
    expect(problems).toEqual([]);
  });

  test("a classic script runs, with no import to choke on", async ({ page }) => {
    const problems = watchForErrors(page);
    await edge(page);

    expect(await page.evaluate(() => window.__classicRan)).toBe(true);
    expect(problems).toEqual([]);
  });
});

test.describe("for an assistant", () => {
  let client: Client;

  test.beforeAll(async () => {
    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(process.env)) {
      if (value !== undefined && !key.startsWith("CTS_")) {
        env[key] = value;
      }
    }
    client = new Client({ name: "e2e", version: "1.0.0" });
    await client.connect(
      new StdioClientTransport({
        command: process.execPath,
        args: [path.resolve("packages/mcp/dist/server.js")],
        cwd: EXAMPLE,
        env,
      })
    );
  });

  test.afterAll(async () => {
    await client?.close();
  });

  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const result = (await client.callTool({ name, arguments: args })) as {
      content: Array<{ type: string; text?: string }>;
    };
    return JSON.parse(result.content.find((item) => item.type === "text")!.text!) as {
      status: string;
      result: {
        pointing: Array<{
          source: unknown;
          how: string;
          trace: Array<{ name: string }>;
          generators: Array<{ uses: Array<{ name: string }> }>;
          props: Array<{ element: string }>;
        }>;
      };
    };
  };

  test("an object pointed at comes with its calls and helpers", async ({ page }) => {
    await ready(page);
    await page.evaluate(() => window.__CTS_DEVTOOLS__!.setInspecting(true));
    const terrainPoint = await pointOn(page, "src/world.js", TERRAIN_LINE);
    await page.keyboard.down("Shift");
    await page.mouse.click(terrainPoint.x, terrainPoint.y);
    await page.keyboard.up("Shift");

    await expect
      .poll(async () => (await call("get_selection")).result?.pointing?.length ?? 0, { timeout: 15_000 })
      .toBe(1);

    const [terrain] = (await call("get_selection")).result.pointing;
    expect(terrain.source).toMatchObject({ file: "src/world.js", line: TERRAIN_LINE, function: "createTerrain" });
    expect(terrain.how).toBe("new");
    expect(terrain.trace.map((frame) => frame.name)).toEqual(["buildWorld", "createTerrain"]);
    expect(terrain.generators[0].uses[0].name).toBe("fbm");
    expect(terrain.props.map((prop) => prop.element)).toContain("PlaneGeometry");
  });
});

test("nothing reaches a production build", () => {
  const out = path.join(EXAMPLE, "dist-e2e");
  try {
    execFileSync("npx", ["vite", "build", "--outDir", "dist-e2e", "--logLevel", "silent"], {
      cwd: EXAMPLE,
      shell: process.platform === "win32",
      stdio: "pipe",
    });

    const assets = path.join(out, "assets");
    const bundle = readdirSync(assets)
      .filter((name) => name.endsWith(".js"))
      .map((name) => readFileSync(path.join(assets, name), "utf8"))
      .join("");
    expect(bundle.length).toBeGreaterThan(1000);
    for (const text of ["__cts", "ctsNew", "click-to-source", "src/world.js", "createTerrain\""]) {
      expect(bundle, text).not.toContain(text);
    }
    expect(readFileSync(path.join(out, "index.html"), "utf8")).not.toContain("click-to-source");
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});

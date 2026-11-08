import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { expect, test, type Page } from "@playwright/test";

/**
 * React Three Fiber and plain three.js in one scene, as many projects are: JSX
 * elements, a <primitive> made by a plain helper, a class of its own, a geometry
 * from useMemo, and a mesh added to R3F's scene by hand.
 */

const MIXED = path.resolve("packages/examples/src/mixed.tsx");
const HELPERS = path.resolve("packages/examples/src/mixedHelpers.ts");
const originals = new Map([MIXED, HELPERS].map((name) => [name, readFileSync(name, "utf8")]));
const lineIn = (name: string, text: string) =>
  originals.get(name)!.split(/\r?\n/).findIndex((line) => line.includes(text)) + 1;

if (!originals.get(MIXED)!.includes("makeTower(3)")) {
  throw new Error(`${MIXED} no longer has makeTower(3): an earlier run left it edited. Put it back first.`);
}

const BOX = lineIn(MIXED, "<mesh position={[-4, 0, 0]}>");
const ROCK = lineIn(MIXED, "<primitive object={rock}");
const SPINNER = lineIn(MIXED, "<mesh ref={spinner}");
const ROCK_MADE = lineIn(HELPERS, "const rock = new THREE.Mesh(");
const TOWER = lineIn(HELPERS, "const tower = new THREE.Mesh(");
const LAMP_MESH = lineIn(HELPERS, "this.add(new THREE.Mesh(");

type Selection = {
  file: string;
  line: number;
  function: string;
  trace: Array<{ name: string; args: Array<{ name: string; value: string }> }>;
  props: Array<{ element: string; name: string; file: string }>;
};
type Devtools = {
  setInspecting(on: boolean): void;
  selection(): Selection | null;
  describeAt(x: number, y: number): { file: string | null; line: number | null } | null;
};
const api = "(window as unknown as { __CTS_DEVTOOLS__: Devtools }).__CTS_DEVTOOLS__";
void api;

/**
 * The middle of where an object is drawn, once that has stopped moving. R3F sizes its
 * canvas to the page just after the first frames, so a point found before then can be
 * somewhere else by the time it is clicked.
 */
async function pointOn(page: Page, file: string, line: number) {
  const find = () =>
    page.evaluate(
      ([where, at]) => {
        const devtools = (window as unknown as { __CTS_DEVTOOLS__?: Devtools }).__CTS_DEVTOOLS__;
        const found: Array<{ x: number; y: number }> = [];
        for (let y = 12; devtools && y < innerHeight; y += 16) {
          for (let x = 12; x < innerWidth; x += 16) {
            const hit = devtools.describeAt(x, y);
            if (hit?.file === where && hit.line === at) {
              found.push({ x, y });
            }
          }
        }
        return found.length > 0 ? found[Math.floor(found.length / 2)] : null;
      },
      [file, line] as const
    );

  let point: { x: number; y: number } | null = null;
  await expect
    .poll(
      async () => {
        const first = await find();
        await page.waitForTimeout(300);
        const second = await find();
        point = first && second && first.x === second.x && first.y === second.y ? first : null;
        return point;
      },
      { timeout: 30_000 }
    )
    .not.toBeNull();
  return point as unknown as { x: number; y: number };
}

async function select(page: Page, file: string, line: number) {
  const point = await pointOn(page, file, line);
  await page.evaluate(() => (window as unknown as { __CTS_DEVTOOLS__: Devtools }).__CTS_DEVTOOLS__.setInspecting(true));
  await page.mouse.click(point.x, point.y);
  await expect
    .poll(() => page.evaluate(() => (window as unknown as { __CTS_DEVTOOLS__: Devtools }).__CTS_DEVTOOLS__.selection()?.line ?? null))
    .toBe(line);
  return (await page.evaluate(() => (window as unknown as { __CTS_DEVTOOLS__: Devtools }).__CTS_DEVTOOLS__.selection()))!;
}

const panel = (page: Page) => page.locator("cts-devtools .panel");

test.beforeEach(async ({ page }) => {
  await page.goto("/mixed.html");
});

test.afterEach(async ({ page }) => {
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      await page.goto("about:blank", { timeout: 5000 });
      break;
    } catch {
      // A reload on its way; the files below still go back.
    }
  }
  let restored = false;
  for (const [name, text] of originals) {
    if (readFileSync(name, "utf8") !== text) {
      writeFileSync(name, text);
      restored = true;
    }
  }
  if (restored) {
    await new Promise((resolve) => setTimeout(resolve, 3000));
  }
});

test("a JSX mesh is found at its element, as before", async ({ page }) => {
  const selected = await select(page, "src/mixed.tsx", BOX);

  expect(selected.function).toBe("Scene");
  await expect(panel(page).locator('[data-cts-edit="boxGeometry.args[0]"]')).toHaveValue("1.5");
  await expect(panel(page).locator("[data-cts-made]")).toHaveCount(0);
});

test("a mesh placed by <primitive> is found at the JSX, and where plain code made it", async ({ page }) => {
  const selected = await select(page, "src/mixed.tsx", ROCK);

  await expect(panel(page).locator("[data-cts-made]")).toContainText("makeRock");
  await expect(panel(page).locator("[data-cts-made]")).toContainText(`src/mixedHelpers.ts:${ROCK_MADE}`);
  expect(selected.trace.map((frame) => frame.name)).toEqual(["Scene", "makeRock"]);
  await expect(panel(page).locator('[data-cts-edit="makeRock.radius"]')).toHaveValue("1.2");

  // What the JSX set, and what the plain code did.
  const props = selected.props.map((prop) => `${prop.element}.${prop.name} ${prop.file}`);
  expect(props).toContain("primitive.position src/mixed.tsx");
  expect(props).toContain("Mesh.name src/mixedHelpers.ts");
  expect(props).toContain("IcosahedronGeometry.args src/mixedHelpers.ts");
});

test("a mesh added to R3F's scene by hand is found where it was made", async ({ page }) => {
  const selected = await select(page, "src/mixedHelpers.ts", TOWER);

  expect(selected.function).toBe("makeTower");
  expect(selected.trace.map((frame) => frame.name)).toEqual(["makeTower"]);
  await expect(panel(page).locator('[data-cts-edit="makeTower.height"]')).toHaveValue("3");
});

test("a geometry made in plain code shows its values on the JSX mesh using it", async ({ page }) => {
  const selected = await select(page, "src/mixed.tsx", SPINNER);

  expect(selected.props.map((prop) => `${prop.element}.${prop.name}`)).toContain("TorusGeometry.args");
  await expect(panel(page).locator('[data-cts-edit="TorusGeometry.args[0]"]')).toHaveValue("0.8");
});

test("a class handed to <primitive> is followed into the mesh it makes", async ({ page }) => {
  const selected = await select(page, "src/mixedHelpers.ts", LAMP_MESH);

  expect(selected.trace.map((frame) => frame.name)).toEqual(["Scene", "Lamp"]);
  await expect(panel(page).locator('[data-cts-edit="Lamp.size"]')).toHaveValue("0.8");
});

test("a value for a plain-code object is saved, and the object is found again after", async ({ page }) => {
  await select(page, "src/mixedHelpers.ts", TOWER);

  const height = panel(page).locator('[data-cts-edit="makeTower.height"]');
  await height.fill("5");
  await height.press("Enter");

  await expect.poll(() => readFileSync(MIXED, "utf8")).toContain("makeTower(5)");
  // A new tower is made, by the update or a reload, and it is the one in the panel.
  await expect(panel(page).locator('[data-cts-edit="makeTower.height"]')).toHaveValue("5", { timeout: 20_000 });
});

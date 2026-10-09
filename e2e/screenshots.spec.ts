import { readFileSync } from "node:fs";
import path from "node:path";
import { expect, test, type Page } from "@playwright/test";

/**
 * The README's screenshots, taken from the real example rather than drawn.
 * Run on demand, not in CI:
 *
 *   CTS_SCREENSHOTS=1 CTS_E2E_CHANNEL=msedge npx playwright test screenshots
 */

test.skip(!process.env.CTS_SCREENSHOTS, "set CTS_SCREENSHOTS=1 to refresh the README images");

const ASSETS = path.resolve("docs/assets");
const source = readFileSync(path.resolve("packages/examples/src/main.tsx"), "utf8").split("\n");
const lineOf = (text: string) => source.findIndex((line) => line.includes(text)) + 1;

type Hit = { kind: string; instanceId: number | null; file: string | null; line: number | null } | null;
type Api = {
  screenPointOf(file: string, line: number): { x: number; y: number } | null;
  describeAt(x: number, y: number): Hit;
};

async function ready(page: Page) {
  await page.goto("/");
  await expect
    .poll(() =>
      page.evaluate(
        (line) => (window as unknown as { __CTS_DEVTOOLS__?: Api }).__CTS_DEVTOOLS__?.screenPointOf("src/main.tsx", line) ?? null,
        lineOf("<mesh position={[-2.2")
      )
    )
    .not.toBeNull();
  await page.waitForTimeout(500);
}

async function pointOf(page: Page, text: string) {
  return page.evaluate(
    (line) => (window as unknown as { __CTS_DEVTOOLS__: Api }).__CTS_DEVTOOLS__.screenPointOf("src/main.tsx", line)!,
    lineOf(text)
  );
}

/** A pixel showing one tree: scanned, since trees are instances, not objects. */
async function treePoint(page: Page) {
  for (let y = 380; y < 700; y += 12) {
    for (let x = 200; x < 1100; x += 12) {
      const hit = await page.evaluate(([px, py]) => (window as unknown as { __CTS_DEVTOOLS__: Api }).__CTS_DEVTOOLS__.describeAt(px, py), [x, y]);
      if (hit?.kind === "InstancedMesh" && hit.instanceId !== null) {
        return { x, y };
      }
    }
  }
  throw new Error("no tree on screen");
}

test("panel for the box", async ({ page }) => {
  await ready(page);
  await page.keyboard.press("Alt+Shift+C");
  const box = await pointOf(page, "<mesh position={[-2.2");
  await page.mouse.click(box.x, box.y);
  await page.mouse.move(640, 120);
  await page.waitForTimeout(400);
  await page.screenshot({ path: path.join(ASSETS, "inspector-panel.png") });
});

test("hover tooltip", async ({ page }) => {
  await ready(page);
  await page.keyboard.press("Alt+Shift+C");
  const sphere = await pointOf(page, "<mesh position={[2.2");
  await page.mouse.move(sphere.x, sphere.y);
  await page.waitForTimeout(400);
  await page.screenshot({ path: path.join(ASSETS, "inspector-hover.png") });
});

test("one instance of an InstancedMesh", async ({ page }) => {
  await ready(page);
  await page.keyboard.press("Alt+Shift+C");
  const tree = await treePoint(page);
  await page.mouse.click(tree.x, tree.y);
  await page.mouse.move(640, 120);
  await page.waitForTimeout(400);
  await page.screenshot({ path: path.join(ASSETS, "inspector-instance.png") });
});

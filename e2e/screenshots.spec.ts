import { readFileSync } from "node:fs";
import path from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

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

/** A pixel of an object the inspector really hits: a tree may stand in front of its middle. */
async function hitOn(page: Page, line: number) {
  return page.evaluate((target) => {
    const api = (window as unknown as { __CTS_DEVTOOLS__: Api }).__CTS_DEVTOOLS__;
    const center = api.screenPointOf("src/main.tsx", target)!;
    for (let radius = 0; radius < 60; radius += 3) {
      for (let angle = 0; angle < 8; angle++) {
        const x = center.x + radius * Math.cos((angle * Math.PI) / 4);
        const y = center.y + radius * Math.sin((angle * Math.PI) / 4);
        if (api.describeAt(x, y)?.line === target) {
          return { x, y };
        }
      }
    }
    throw new Error("nothing to click");
  }, line);
}

async function assistant() {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && !key.startsWith("CTS_")) {
      env[key] = value;
    }
  }
  const client = new Client({ name: "claude-code", version: "1" });
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [path.resolve("packages/mcp/dist/server.js")],
      cwd: path.resolve("packages/examples"),
      env,
    })
  );
  return client;
}

test("pointing an assistant at objects", async ({ page }) => {
  const client = await assistant();
  try {
    await ready(page);
    await page.locator("cts-devtools .toggle.pointer").click();

    const box = await hitOn(page, lineOf("<mesh position={[-2.2"));
    const sphere = await hitOn(page, lineOf("<mesh position={[2.2"));
    await page.mouse.click(box.x, box.y);
    await page.mouse.click(sphere.x, sphere.y);
    await expect(page.locator('cts-devtools [data-cts-tab="agent"]')).toContainText("Pointing at 2");

    await client.callTool({ name: "get_selection", arguments: {} });
    await client.callTool({ name: "get_source", arguments: { file: "src/main.tsx", around: lineOf("<mesh position={[-2.2") } });
    await client.callTool({ name: "get_canvas_screenshot", arguments: {} });
    await expect(page.locator("cts-devtools .log-row")).toHaveCount(3);
    await page.mouse.move(40, 40);
    await page.waitForTimeout(4500);

    await page.screenshot({ path: path.join(ASSETS, "inspector-agent.png") });
  } finally {
    await client.close();
  }
});

test("comparing two objects", async ({ page }) => {
  await ready(page);
  await page.keyboard.press("Alt+Shift+C");
  const box = await hitOn(page, lineOf("<mesh position={[-2.2"));
  await page.mouse.click(box.x, box.y);
  await page.locator('cts-devtools [data-cts-action="pin"]').click();
  const sphere = await hitOn(page, lineOf("<mesh position={[2.2"));
  await page.mouse.click(sphere.x, sphere.y);
  await page.locator('cts-devtools [data-cts-open-tab="compare"]').click();
  await page.locator('cts-devtools [data-cts-action="differences-only"]').check();
  await page.mouse.move(40, 40);
  await page.waitForTimeout(300);

  await page.screenshot({ path: path.join(ASSETS, "inspector-compare.png") });
});

test("previewing a value", async ({ page }) => {
  await ready(page);
  await page.keyboard.press("Alt+Shift+C");
  const box = await hitOn(page, lineOf("<mesh position={[-2.2"));
  await page.mouse.click(box.x, box.y);
  await page.locator('cts-devtools [data-cts-slider="boxGeometry.args[1]"]').fill("3");
  await page.locator("cts-devtools summary", { hasText: "Performance" }).click();
  await page.mouse.move(40, 40);
  await page.waitForTimeout(300);

  await page.screenshot({ path: path.join(ASSETS, "inspector-preview.png") });
});

import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

/**
 * The inspector as a developer meets it: the example app has no
 * click-to-source code in it at all, only `clickToSource()` in its Vite config.
 */

const EXAMPLE = path.resolve("packages/examples");
const MAIN = path.join(EXAMPLE, "src", "main.tsx");
const original = readFileSync(MAIN, "utf8");
const lineOf = (text: string) => original.split("\n").findIndex((line) => line.includes(text)) + 1;
const BOX_LINE = lineOf("<mesh position={[-2.2, BOX_HEIGHT / 2, 6]}>");

type Devtools = {
  setInspecting(on: boolean): void;
  isInspecting(): boolean;
  selection(): { file: string; line: number; kind: string; instanceId: number | null } | null;
  screenPointOf(file: string, line: number): { x: number; y: number } | null;
};
declare global {
  interface Window {
    __CTS_DEVTOOLS__?: Devtools;
  }
}

/** Loads the app and waits until the inspector can see the box. */
async function ready(page: Page) {
  await page.goto("/");
  await expect
    .poll(() => page.evaluate((line) => window.__CTS_DEVTOOLS__?.screenPointOf("src/main.tsx", line) ?? null, BOX_LINE), {
      timeout: 30_000,
    })
    .not.toBeNull();
}

const boxPoint = (page: Page) =>
  page.evaluate((line) => window.__CTS_DEVTOOLS__!.screenPointOf("src/main.tsx", line)!, BOX_LINE);

async function inspectBox(page: Page) {
  await page.keyboard.press("Alt+Shift+C");
  await expect.poll(() => page.evaluate(() => window.__CTS_DEVTOOLS__!.isInspecting())).toBe(true);
  const point = await boxPoint(page);
  await page.mouse.click(point.x, point.y);
}

test.afterAll(() => {
  writeFileSync(MAIN, original);
});

test("Alt+Shift+C and a click show where the box came from", async ({ page }) => {
  await ready(page);
  await inspectBox(page);

  expect(await page.evaluate(() => window.__CTS_DEVTOOLS__!.selection())).toMatchObject({
    file: "src/main.tsx",
    line: BOX_LINE,
    kind: "Mesh",
  });

  const panel = page.locator("cts-devtools .panel");
  await expect(panel).toContainText(`src/main.tsx:${BOX_LINE}`);
  // Found by the build step, with no metadata written in the app.
  await expect(panel.locator('[data-cts-edit="boxGeometry.args[1]"]')).toHaveValue("1.4");
  await expect(panel).toContainText("BOX_HEIGHT · line");
});

test("hovering in inspect mode names the object under the pointer", async ({ page }) => {
  await ready(page);
  await page.keyboard.press("Alt+Shift+C");
  const point = await boxPoint(page);
  await page.mouse.move(point.x, point.y);

  await expect(page.locator("cts-devtools .tip")).toContainText(`src/main.tsx:${BOX_LINE}`);
});

test("a value edited in the panel is written to source, and the panel survives the reload", async ({ page }) => {
  await ready(page);
  await inspectBox(page);

  const height = page.locator('cts-devtools [data-cts-edit="boxGeometry.args[1]"]');
  await height.fill("2");
  await height.press("Enter");

  await expect.poll(() => readFileSync(MAIN, "utf8")).toContain("const BOX_HEIGHT = 2;");
  // main.tsx is the entry, so Vite reloads the page; the selection comes back.
  await expect(page.locator('cts-devtools [data-cts-edit="boxGeometry.args[1]"]')).toHaveValue("2", {
    timeout: 20_000,
  });

  // Leave the page before the file is restored, so the restore's reload does
  // not race the page closing. The file is put back in afterAll.
  await page.goto("about:blank");
});

test("Open asks the dev server to open the file at the element", async ({ page }) => {
  const requests: unknown[] = [];
  // Answered here rather than by the dev server, which would launch an
  // editor on the machine running the test. The endpoint has its own tests.
  await page.route("**/__cts/open", async (route) => {
    requests.push(route.request().postDataJSON());
    await route.fulfill({ status: 200, contentType: "application/json", body: '{"opened":true}' });
  });

  await ready(page);
  await inspectBox(page);
  await page.locator("cts-devtools .open").click();

  await expect.poll(() => requests).toEqual([{ file: "src/main.tsx", line: BOX_LINE, column: 7 }]);
});

test("an assistant's MCP server answers about the open page with no configuration", async ({ page }) => {
  await ready(page);

  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && !key.startsWith("CTS_")) {
      env[key] = value;
    }
  }
  const client = new Client({ name: "e2e", version: "0" });
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [path.resolve("packages/mcp/dist/server.js")],
      cwd: EXAMPLE,
      env,
    })
  );

  try {
    const result = await client.callTool({ name: "list_scene_provenance", arguments: {} });
    const text = (result.content as Array<{ type: string; text: string }>)[0].text;
    const answer = JSON.parse(text) as { status: string; result: { status: string; objects: unknown[] } };

    expect(answer.status).toBe("answered");
    expect(answer.result.status).toBe("ready");
    expect(answer.result.objects.length).toBeGreaterThan(3);
  } finally {
    await client.close();
  }
});

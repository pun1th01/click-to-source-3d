import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

/**
 * Working with an assistant, end to end: a real MCP server talking to a real
 * page through a real dev server, about the example app.
 */

const EXAMPLE = path.resolve("packages/examples");
const MAIN = path.join(EXAMPLE, "src", "main.tsx");
const original = readFileSync(MAIN, "utf8");
const lineOf = (text: string) => original.split("\n").findIndex((line) => line.includes(text)) + 1;
const BOX_LINE = lineOf("<mesh position={[-2.2, BOX_HEIGHT / 2, 6]}>");
const SPHERE_LINE = lineOf("<mesh position={[2.2, SPHERE_RADIUS, 6]}>");

type Hit = { kind: string; instanceId: number | null; file: string | null; line: number | null } | null;
type Devtools = {
  isInspecting(): boolean;
  selection(): { file: string; line: number; kind: string } | null;
  screenPointOf(file: string, line: number): { x: number; y: number } | null;
  describeAt(x: number, y: number): Hit;
  pointing(): Array<{ what: string; where: string | null }>;
  pins(): Array<{ what: string; where: string | null }>;
  looking(): Array<{ kind: string; instanceId: number | null | undefined }>;
};
const devtools = (page: Page) => ({
  evaluate: <T,>(fn: (api: Devtools, arg: never) => T, arg?: unknown) =>
    page.evaluate(
      ([source, value]) => new Function("api", "arg", `return (${source})(api, arg)`)(
        (window as unknown as { __CTS_DEVTOOLS__: Devtools }).__CTS_DEVTOOLS__,
        value
      ),
      [fn.toString(), arg] as const
    ) as Promise<T>,
});

async function ready(page: Page) {
  await page.goto("/");
  await expect
    .poll(
      () =>
        page.evaluate(
          (line) =>
            (window as unknown as { __CTS_DEVTOOLS__?: Devtools }).__CTS_DEVTOOLS__?.screenPointOf("src/main.tsx", line) ?? null,
          BOX_LINE
        ),
      { timeout: 30_000 }
    )
    .not.toBeNull();
}

/** A pixel of an object the inspector really hits: a tree may stand in front of its middle. */
async function pointOn(page: Page, line: number) {
  const point = await page.evaluate(
    (target) => {
      const api = (window as unknown as { __CTS_DEVTOOLS__: Devtools }).__CTS_DEVTOOLS__;
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
      return null;
    },
    line
  );
  expect(point).not.toBeNull();
  return point!;
}

async function connectAssistant(name = "claude-code") {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && !key.startsWith("CTS_")) {
      env[key] = value;
    }
  }
  const client = new Client({ name, version: "1" });
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [path.resolve("packages/mcp/dist/server.js")],
      cwd: EXAMPLE,
      env,
    })
  );
  return client;
}

async function toolJson(client: Client, name: string, args: Record<string, unknown> = {}) {
  const result = await client.callTool({ name, arguments: args });
  const content = result.content as Array<{ type: string; text?: string }>;
  return JSON.parse(content.find((item) => item.type === "text")!.text!) as {
    status: string;
    result: Record<string, never>;
  };
}

const panel = (page: Page) => page.locator("cts-devtools .panel");
const agentTab = (page: Page) => page.locator('cts-devtools [data-cts-tab="agent"]');

test.afterAll(() => {
  writeFileSync(MAIN, original);
});

test.describe("pointing an assistant at objects", () => {
  test("it sees the objects the developer points at, and can edit them", async ({ page }) => {
    const client = await connectAssistant();
    try {
      await ready(page);

      // The pointer button comes up once there is an assistant to point.
      const pointer = page.locator("cts-devtools .toggle.pointer");
      await expect(pointer).toBeVisible();
      await pointer.click();

      await expect(agentTab(page)).toContainText("Claude Code connected");

      const box = await pointOn(page, BOX_LINE);
      const sphere = await pointOn(page, SPHERE_LINE);
      await page.mouse.click(box.x, box.y);
      await page.mouse.click(sphere.x, sphere.y);

      await expect(agentTab(page)).toContainText("Pointing at 2");
      await expect(agentTab(page)).toContainText(`src/main.tsx:${BOX_LINE}`);
      await expect(agentTab(page)).toContainText(`src/main.tsx:${SPHERE_LINE}`);
      await expect(pointer.locator(".count")).toHaveText("2");

      // The developer goes to their terminal and types "make these bigger".
      const answer = await toolJson(client, "get_selection");
      expect(answer.status).toBe("answered");
      const pointing = answer.result.pointing as unknown as Array<{
        kind: string;
        source: { file: string; line: number };
        props: Array<{ element: string; name: string; values: Array<{ raw: string; line: number; column: number; via?: string }> }>;
        cost: { triangles: number };
      }>;
      expect(pointing.map((object) => object.source.line)).toEqual([BOX_LINE, SPHERE_LINE]);
      expect(pointing[0]).toMatchObject({ kind: "Mesh", cost: { triangles: 12 } });

      // It shows up in the developer's log.
      await expect(agentTab(page).locator(".log-row").first()).toContainText("get_selection");
      await expect(agentTab(page).locator(".log-row").first()).toContainText("2 objects pointed at");

      // What get_selection returned is what edit_parameter takes.
      const args = pointing[0].props.find((prop) => prop.element === "boxGeometry")!;
      const height = args.values[1];
      expect(height.via).toBe("BOX_HEIGHT");
      await toolJson(client, "edit_parameter", {
        file: "src/main.tsx",
        line: height.line,
        column: height.column,
        expected: height.raw,
        newValue: 2,
      });
      await expect.poll(() => readFileSync(MAIN, "utf8")).toContain("const BOX_HEIGHT = 2;");

      // main.tsx is the entry, so Vite reloads the page. Pointing survives, and
      // the assistant sees the new value at its new position.
      await expect
        .poll(
          async () => {
            const after = await toolJson(client, "get_selection");
            const objects = after.result.pointing as unknown as typeof pointing;
            return objects[0]?.props.find((prop) => prop.element === "boxGeometry")?.values[1].raw;
          },
          { timeout: 20_000 }
        )
        .toBe("2");
      await expect(page.locator("cts-devtools .toggle.pointer .count")).toHaveText("2", { timeout: 20_000 });

      // The edit is marked in the log, which outlived the reload.
      await expect(agentTab(page).locator(".log-row", { hasText: "edit_parameter" }).first()).toContainText(
        "1.4 → 2"
      );
      await expect(agentTab(page).locator(".pill.edit").first()).toBeVisible();

      await page.goto("about:blank");
    } finally {
      writeFileSync(MAIN, original);
      await client.close();
    }
  });

  test("Shift+click points too, and a plain click still selects", async ({ page }) => {
    const client = await connectAssistant();
    try {
      await ready(page);
      await page.keyboard.press("Alt+Shift+C");

      const box = await pointOn(page, BOX_LINE);
      await page.keyboard.down("Shift");
      await page.mouse.click(box.x, box.y);
      await page.keyboard.up("Shift");

      await expect.poll(() => devtools(page).evaluate((api) => api.pointing().length)).toBe(1);
      expect(await devtools(page).evaluate((api) => api.selection())).toBeNull();

      const sphere = await pointOn(page, SPHERE_LINE);
      await page.mouse.click(sphere.x, sphere.y);

      await expect.poll(() => devtools(page).evaluate((api) => api.selection()?.line)).toBe(SPHERE_LINE);
      expect(await devtools(page).evaluate((api) => api.pointing().length)).toBe(1);

      // Both are in the answer, kept apart.
      await expect
        .poll(async () => {
          const answer = await toolJson(client, "get_selection");
          return (answer.result.selected as unknown as { source?: { line: number } } | null)?.source?.line;
        })
        .toBe(SPHERE_LINE);
      const answer = await toolJson(client, "get_selection");
      expect((answer.result.pointing as unknown as unknown[]).length).toBe(1);
    } finally {
      await client.close();
    }
  });

  test("with nothing pointed at, the assistant is told so", async ({ page }) => {
    const client = await connectAssistant();
    try {
      await ready(page);

      const answer = await toolJson(client, "get_selection");

      expect(answer.status).toBe("answered");
      expect(answer.result.pointing).toEqual([]);
      expect(answer.result.hint).toContain("has not selected or pointed at anything");
    } finally {
      await client.close();
    }
  });
});

test.describe("the Agent tab", () => {
  test("shows who is connected, and when they go", async ({ page }) => {
    const client = await connectAssistant();
    await ready(page);
    await page.keyboard.press("Alt+Shift+C");
    await page.locator("cts-devtools .toggle.pointer").click();
    await expect(agentTab(page)).toContainText("Claude Code connected");
    await expect(page.locator('cts-devtools [data-cts-open-tab="agent"] .dot.on')).toBeVisible();

    await client.close();

    await expect(agentTab(page)).toContainText("No assistant connected", { timeout: 20_000 });
    await expect(agentTab(page)).toContainText("npx click-to-source-3d init --mcp");
  });

  test("a line of the log leads to the object it was about", async ({ page }) => {
    const client = await connectAssistant();
    try {
      await ready(page);
      await page.locator("cts-devtools .toggle.pointer").click();
      await page.keyboard.press("Escape");

      await toolJson(client, "get_instance_provenance", {
        file: "src/main.tsx",
        function: "Scene",
        line: BOX_LINE,
        ordinal: 0,
      });
      const row = agentTab(page).locator(".log-row.link").first();
      await expect(row).toContainText("get_instance_provenance");

      await row.click();

      await expect.poll(() => devtools(page).evaluate((api) => api.selection()?.line)).toBe(BOX_LINE);
      await expect(page.locator('cts-devtools [data-cts-tab="inspect"]')).toBeVisible();
    } finally {
      await client.close();
    }
  });
});

test.describe("what the assistant can do on screen", () => {
  test("it can outline an object for the developer, and clear it", async ({ page }) => {
    const client = await connectAssistant();
    try {
      await ready(page);

      const answer = await toolJson(client, "highlight_object", {
        targets: [{ file: "src/main.tsx", line: SPHERE_LINE }, { file: "src/main.tsx", line: 99999 }],
        seconds: 60,
      });

      expect(answer.result).toMatchObject({
        status: "ready",
        highlighted: [{ kind: "Mesh", line: SPHERE_LINE }],
        missing: [{ line: 99999 }],
        seconds: 60,
      });
      expect(await devtools(page).evaluate((api) => api.looking())).toEqual([
        { kind: "Mesh", instanceId: null },
      ]);

      await toolJson(client, "highlight_object", { targets: [] });
      expect(await devtools(page).evaluate((api) => api.looking())).toEqual([]);
    } finally {
      await client.close();
    }
  });

  test("objects it asks about are outlined for a moment", async ({ page }) => {
    const client = await connectAssistant();
    try {
      await ready(page);

      await toolJson(client, "get_instance_provenance", {
        file: "src/main.tsx",
        function: "Scene",
        line: BOX_LINE,
        ordinal: 0,
      });

      await expect
        .poll(() => devtools(page).evaluate((api) => api.looking().length))
        .toBe(1);
      await expect
        .poll(() => devtools(page).evaluate((api) => api.looking().length), { timeout: 8000 })
        .toBe(0);
    } finally {
      await client.close();
    }
  });

  test("it can see the scene", async ({ page }) => {
    const client = await connectAssistant();
    try {
      await ready(page);

      const result = await client.callTool({ name: "get_canvas_screenshot", arguments: { maxSize: 640 } });
      const content = result.content as Array<{ type: string; data?: string; mimeType?: string; text?: string }>;
      const image = content.find((item) => item.type === "image")!;
      const about = JSON.parse(content.find((item) => item.type === "text")!.text!) as {
        width: number;
        height: number;
        via: string;
      };

      expect(image.mimeType).toBe("image/jpeg");
      expect(about).toMatchObject({ width: 640, via: "frame" });

      // A WebGL canvas read at the wrong moment comes back empty, so look at it.
      const colours = await page.evaluate(async (data) => {
        const bitmap = await createImageBitmap(await (await fetch(`data:image/jpeg;base64,${data}`)).blob());
        const canvas = document.createElement("canvas");
        canvas.width = bitmap.width;
        canvas.height = bitmap.height;
        const context = canvas.getContext("2d")!;
        context.drawImage(bitmap, 0, 0);
        const pixels = context.getImageData(0, 0, bitmap.width, bitmap.height).data;
        const seen = new Set<number>();
        for (let i = 0; i < pixels.length; i += 4 * 97) {
          seen.add((pixels[i] >> 4) | ((pixels[i + 1] >> 4) << 4) | ((pixels[i + 2] >> 4) << 8));
        }
        return seen.size;
      }, image.data!);
      expect(colours).toBeGreaterThan(5);
    } finally {
      await client.close();
    }
  });

  // A hidden tab draws no frames, which is when an assistant is likely to ask:
  // the developer has gone to their terminal.
  test("it can see the scene when no frame is coming", async ({ page }) => {
    const client = await connectAssistant();
    try {
      await ready(page);
      // What a hidden page does to a render loop: no animation frames. One
      // already requested still runs, so give it time to.
      await page.evaluate(() => {
        window.requestAnimationFrame = () => 0;
      });
      await page.waitForTimeout(500);

      const result = await client.callTool({ name: "get_canvas_screenshot", arguments: {} });
      const content = result.content as Array<{ type: string; data?: string; text?: string }>;

      expect(JSON.parse(content.find((item) => item.type === "text")!.text!)).toMatchObject({ via: "direct" });
      expect(content.find((item) => item.type === "image")!.data!.length).toBeGreaterThan(1000);
    } finally {
      await client.close();
    }
  });
});

test.describe("previewing a value", () => {
  const slider = (page: Page) => page.locator('cts-devtools [data-cts-slider="boxGeometry.args[1]"]');
  const field = (page: Page) => page.locator('cts-devtools [data-cts-edit="boxGeometry.args[1]"]');

  /** A point just above the box's top, which a taller box will cover. */
  async function aboveBox(page: Page) {
    const box = await pointOn(page, BOX_LINE);
    const hit = await page.evaluate(
      ({ x, y, line }) => {
        const api = (window as unknown as { __CTS_DEVTOOLS__: Devtools }).__CTS_DEVTOOLS__;
        for (let up = y; up > 0; up -= 2) {
          if (api.describeAt(x, up)?.line !== line) {
            return { x, y: up - 6 };
          }
        }
        return null;
      },
      { ...box, line: BOX_LINE }
    );
    return hit!;
  }

  test("a slider changes the scene without touching the file, until saved", async ({ page }) => {
    await ready(page);
    await page.keyboard.press("Alt+Shift+C");
    const box = await pointOn(page, BOX_LINE);
    const above = await aboveBox(page);
    await page.mouse.click(box.x, box.y);

    const onBox = () =>
      page.evaluate(({ x, y }) => (window as unknown as { __CTS_DEVTOOLS__: Devtools }).__CTS_DEVTOOLS__.describeAt(x, y)?.line, above);
    expect(await onBox()).not.toBe(BOX_LINE);

    await slider(page).fill("4");

    await expect(field(page)).toHaveValue("4");
    await expect(page.locator("cts-devtools .unsaved")).toContainText("1 unsaved value");
    await expect.poll(onBox).toBe(BOX_LINE);
    expect(readFileSync(MAIN, "utf8")).toBe(original);

    // Revert puts it all back.
    await page.locator('cts-devtools [data-cts-action="revert"]').click();
    await expect(field(page)).toHaveValue("1.4");
    await expect.poll(onBox).not.toBe(BOX_LINE);
    await expect(page.locator("cts-devtools .unsaved")).toBeHidden();

    // Save writes it.
    await slider(page).fill("3");
    await page.locator('cts-devtools [data-cts-action="save"]').click();
    await expect.poll(() => readFileSync(MAIN, "utf8"), { timeout: 20_000 }).toContain("const BOX_HEIGHT = 3;");
    await expect(field(page)).toHaveValue("3", { timeout: 20_000 });

    await page.goto("about:blank");
    writeFileSync(MAIN, original);
  });
});

test.describe("understanding an object", () => {
  test("the panel says what it costs", async ({ page }) => {
    await ready(page);
    await page.keyboard.press("Alt+Shift+C");
    const box = await pointOn(page, BOX_LINE);
    await page.mouse.click(box.x, box.y);

    const summary = panel(page).locator("summary", { hasText: "Performance" });
    await expect(summary).toContainText("12 triangles · 1 draw call");
    await summary.click();

    // 120 trees of 14 triangles, a sphere, a plane and this box.
    await expect(panel(page)).toContainText("vertices");
    await expect(panel(page)).toContainText("of the frame");
    await expect(panel(page)).toContainText(/\d+% of [\d,]+ triangles/);
  });

  test("two objects can be pinned and compared", async ({ page }) => {
    await ready(page);
    await page.keyboard.press("Alt+Shift+C");

    const box = await pointOn(page, BOX_LINE);
    await page.mouse.click(box.x, box.y);
    await page.locator('cts-devtools [data-cts-action="pin"]').click();
    await expect.poll(() => devtools(page).evaluate((api) => api.pins().length)).toBe(1);

    const sphere = await pointOn(page, SPHERE_LINE);
    await page.mouse.click(sphere.x, sphere.y);
    await page.locator('cts-devtools [data-cts-open-tab="compare"]').click();

    const tab = page.locator('cts-devtools [data-cts-tab="compare"]');
    await expect(tab).toContainText(`src/main.tsx:${BOX_LINE}`);
    await expect(tab).toContainText(`src/main.tsx:${SPHERE_LINE}`);
    await expect(tab).toContainText("MeshStandardMaterial #c2643c");
    await expect(tab).toContainText("MeshStandardMaterial #4a86c8");
    await expect(tab.locator(".cell.differs").first()).toBeVisible();

    await tab.locator('[data-cts-action="differences-only"]').check();
    await expect(tab.locator(".cell:not(.differs)")).toHaveCount(0);

    // Pins survive a reload, like the rest.
    await page.reload();
    await expect
      .poll(() =>
        page.evaluate(() => (window as unknown as { __CTS_DEVTOOLS__?: Devtools }).__CTS_DEVTOOLS__?.pins().length)
      , { timeout: 30_000 })
      .toBe(1);
  });

  test("Report copies it as Markdown, with a screenshot for rich targets", async ({ page, context }) => {
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    await ready(page);
    await page.keyboard.press("Alt+Shift+C");
    const box = await pointOn(page, BOX_LINE);
    await page.mouse.click(box.x, box.y);

    await page.locator('cts-devtools [data-cts-action="report"]').click();
    await expect(page.locator("cts-devtools .status")).toContainText("Copied the report");

    const copied = await page.evaluate(async () => {
      const [item] = await navigator.clipboard.read();
      return {
        text: await (await item.getType("text/plain")).text(),
        html: await (await item.getType("text/html")).text(),
      };
    });

    expect(copied.text).toContain(`### Mesh at \`src/main.tsx:${BOX_LINE}\``);
    expect(copied.text).toContain("| position | -2.2, 0.7, 6 |");
    expect(copied.text).toContain("`<boxGeometry>` args: `1.2`, `BOX_HEIGHT = 1.4`, `1.2`");
    expect(copied.text).toContain("Cost: 12 triangles, 1 draw call");
    expect(copied.html).toContain("<img");
    expect(copied.html).toContain("data:image/png;base64,");
  });

  test("Image copies a picture of the canvas", async ({ page, context }) => {
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    await ready(page);
    await page.keyboard.press("Alt+Shift+C");
    const box = await pointOn(page, BOX_LINE);
    await page.mouse.click(box.x, box.y);

    await page.locator('cts-devtools [data-cts-action="screenshot"]').click();
    await expect(page.locator("cts-devtools .status")).toContainText("Copied a screenshot");

    const size = await page.evaluate(async () => {
      const [item] = await navigator.clipboard.read();
      return (await item.getType("image/png")).size;
    });
    expect(size).toBeGreaterThan(1000);
  });
});

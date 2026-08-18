import { describe, expect, it } from "vitest";
import type { SourceEditFetch } from "../src/sourceEditClient";
import { editSourceFile } from "../src/sourceEditClient";

function jsonResponse(body: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  };
}

describe("source edit client", () => {
  it("reads through Step 6 before sending the selected SourceRef edit", async () => {
    const calls: Array<{ input: string; body: Record<string, unknown> }> = [];
    const fetchImpl: SourceEditFetch = async (input, init) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      calls.push({ input, body });

      if (input === "/__cts/read-file") {
        return jsonResponse({ content: '<mesh color="hotpink" />' });
      }

      return jsonResponse({ success: true });
    };

    await editSourceFile(
      {
        file: "src/main.tsx",
        function: "Scene",
        line: 77,
        args: { color: "hotpink" },
      },
      "color",
      "rebeccapurple",
      fetchImpl
    );

    expect(calls).toEqual([
      {
        input: "/__cts/read-file",
        body: { file: "src/main.tsx" },
      },
      {
        input: "/__cts/write-file",
        body: {
          file: "src/main.tsx",
          line: 77,
          argName: "color",
          newValue: "rebeccapurple",
          content: '<mesh color="hotpink" />',
        },
      },
    ]);
  });

  it("resolves a display key through argSources to its declared identifier", async () => {
    const calls: Array<{ input: string; body: Record<string, unknown> }> = [];
    const fetchImpl: SourceEditFetch = async (input, init) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      calls.push({ input, body });

      if (input === "/__cts/read-file") {
        return jsonResponse({ content: "const WATER_LEVEL = -13" });
      }

      return jsonResponse({ success: true });
    };

    await editSourceFile(
      {
        file: "src/components/Water.jsx",
        function: "Water",
        line: 6,
        args: { waterLevel: -13 },
        argSources: { waterLevel: "WATER_LEVEL" },
      },
      "waterLevel",
      -20,
      fetchImpl
    );

    const write = calls.find((call) => call.input === "/__cts/write-file");
    expect(write?.body.argName).toBe("WATER_LEVEL");
    expect(write?.body.newValue).toBe(-20);
  });

  it("passes an unmapped key through unchanged when argSources is absent", async () => {
    const calls: Array<{ input: string; body: Record<string, unknown> }> = [];
    const fetchImpl: SourceEditFetch = async (input, init) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      calls.push({ input, body });

      if (input === "/__cts/read-file") {
        return jsonResponse({ content: "const noiseFloor = -30" });
      }

      return jsonResponse({ success: true });
    };

    await editSourceFile(
      {
        file: "src/components/Terrain.jsx",
        function: "Terrain",
        line: 20,
        args: { noiseFloor: -30 },
      },
      "noiseFloor",
      -40,
      fetchImpl
    );

    const write = calls.find((call) => call.input === "/__cts/write-file");
    expect(write?.body.argName).toBe("noiseFloor");
    expect(write?.body.newValue).toBe(-40);
  });

  it("surfaces a failed file transport response", async () => {
    const fetchImpl: SourceEditFetch = async () =>
      jsonResponse({ error: "Source edit failed" }, 400);

    await expect(
      editSourceFile(
        {
          file: "src/main.tsx",
          function: "Scene",
          line: 77,
          args: { color: "hotpink" },
        },
        "color",
        "rebeccapurple",
        fetchImpl
      )
    ).rejects.toMatchObject({
      name: "SourceEditTransportError",
      status: 400,
      message: "Source edit failed",
    });
  });
});

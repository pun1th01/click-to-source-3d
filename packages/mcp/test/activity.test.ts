import { afterEach, describe, expect, it, vi } from "vitest";
import { ActivityReporter, agentName, describeCall } from "../src/activity.js";

const answered = (result: unknown) => ({ result: { status: "answered", pageId: 1, result } });

describe("agentName", () => {
  it("writes known clients as people do", () => {
    expect(agentName("claude-code")).toBe("Claude Code");
    expect(agentName("cursor-vscode")).toBe("Cursor");
  });

  it("makes the best of any other", () => {
    expect(agentName("my_cool-agent")).toBe("My Cool Agent");
    expect(agentName("Visual Studio Code")).toBe("Visual Studio Code");
  });

  it("has something to say with nothing to go on", () => {
    expect(agentName(undefined)).toBe("Assistant");
  });
});

describe("describeCall", () => {
  it("says which part of which file was read", () => {
    expect(
      describeCall(
        "get_source",
        { file: "src/World.tsx", around: 40 },
        { result: { file: "src/World.tsx", content: "", startLine: 20, endLine: 60 } },
        5
      )
    ).toEqual({
      tool: "get_source",
      durationMs: 5,
      status: "ok",
      effect: "read",
      detail: "src/World.tsx",
      result: "lines 20-60",
      targets: [{ file: "src/World.tsx", line: 40 }],
    });
  });

  it("marks an edit, with the old value and the new", () => {
    expect(
      describeCall(
        "edit_parameter",
        { file: "src/main.tsx", line: 16, column: 20, expected: "1.4", newValue: 2.5 },
        { result: {} },
        1
      )
    ).toMatchObject({
      effect: "edit",
      detail: "src/main.tsx:16",
      result: "1.4 → 2.5",
      targets: [{ file: "src/main.tsx", line: 16, column: 20 }],
    });
  });

  it("names an edit by argument when that is how it was asked for", () => {
    expect(
      describeCall("edit_parameter", { file: "a.tsx", line: 3, argName: "ROCK_SIZE", newValue: "big" }, { result: {} }, 1)
    ).toMatchObject({ detail: "a.tsx:3 ROCK_SIZE", result: '→ "big"' });
  });

  it("gives what was found under a point, and leads to it", () => {
    const address = { file: "a.tsx", line: 41, ordinal: 2, instanceId: 7 };

    expect(
      describeCall(
        "resolve_at_point",
        { x: 0.21, y: -0.1 },
        answered({ status: "ready", address, sourceRef: { file: "a.tsx", line: 41, function: "Rock" } }),
        1
      )
    ).toMatchObject({
      detail: "(0.21, -0.1)",
      result: "Rock · a.tsx:41",
      targets: [address],
    });
  });

  it("says when nothing was found under a point", () => {
    expect(
      describeCall("resolve_at_point", { x: 0, y: 0 }, answered({ status: "ready", address: null, sourceRef: null }), 1)
    ).toMatchObject({ status: "ok", result: "nothing with a source there", targets: [] });
  });

  it("counts what the listing tools found", () => {
    expect(describeCall("list_files", {}, { result: { files: ["a", "b"] } }, 1).result).toBe("2 files");
    expect(describeCall("list_provenance", {}, { result: { sites: ["a"] } }, 1).result).toBe("1 site");
    expect(describeCall("search_by_generator", { function: "Tree" }, { result: { matched: 3 } }, 1)).toMatchObject({
      detail: "Tree",
      result: "3 sites",
    });
    expect(
      describeCall("list_scene_provenance", {}, answered({ status: "ready", objects: [1, 2, 3, 4] }), 1).result
    ).toBe("4 objects");
  });

  it("leads to one instance", () => {
    expect(
      describeCall(
        "get_instance_provenance",
        { file: "a.tsx", function: "T", line: 5, ordinal: 0, instanceId: 3 },
        answered({ status: "ready", sourceRef: { function: "T" } }),
        1
      )
    ).toMatchObject({
      detail: "a.tsx:5 #3",
      result: "T",
      targets: [{ file: "a.tsx", line: 5, ordinal: 0, instanceId: 3 }],
    });
  });

  describe("get_selection", () => {
    it("says how many objects it saw", () => {
      expect(
        describeCall("get_selection", {}, answered({ status: "ready", pointing: [{}, {}], selected: null }), 1).result
      ).toBe("2 objects pointed at");
    });

    it("says when it fell back on the selection", () => {
      expect(
        describeCall("get_selection", {}, answered({ status: "ready", pointing: [], selected: {} }), 1).result
      ).toBe("the selected object");
    });

    it("says when there was nothing", () => {
      expect(
        describeCall("get_selection", {}, answered({ status: "ready", pointing: [], selected: null }), 1).result
      ).toBe("nothing pointed at");
    });

    // The objects are already outlined in the developer's own colour.
    it("names no targets, so nothing is outlined on top of them", () => {
      expect(
        describeCall("get_selection", {}, answered({ status: "ready", pointing: [{}], selected: null }), 1).targets
      ).toEqual([]);
    });
  });

  it("marks what it drew on the developer's screen", () => {
    const targets = [{ file: "a.tsx", line: 5 }];

    expect(
      describeCall("highlight_object", { targets }, answered({ status: "ready", highlighted: [{}] }), 1)
    ).toMatchObject({ effect: "point", detail: "a.tsx:5", result: "1 object outlined", targets });

    expect(
      describeCall("highlight_object", { targets: [] }, answered({ status: "ready", highlighted: [] }), 1).result
    ).toBe("cleared");
  });

  it("gives a screenshot's size, and never its data", () => {
    const activity = describeCall(
      "get_canvas_screenshot",
      {},
      answered({ status: "ready", width: 1024, height: 576, data: "A".repeat(100000) }),
      1
    );

    expect(activity.result).toBe("1024×576 image");
    expect(JSON.stringify(activity)).not.toContain("AAAA");
  });

  describe("when things go wrong", () => {
    it("reports a thrown error as it was given", () => {
      expect(
        describeCall("edit_parameter", { file: "a.tsx", line: 1, newValue: 1 }, { error: "No such argument" }, 1)
      ).toMatchObject({ status: "error", effect: "edit", result: "No such argument" });
    });

    it.each([
      [{ status: "disconnected" }, "no page is open"],
      [{ status: "disabled", reason: "off" }, "the scene bridge is off"],
      [{ status: "ambiguous", pages: [{}, {}] }, "2 pages are open"],
      [{ status: "timeout", pageId: 1 }, "the page did not answer"],
    ])("puts %j in words", (outcome, words) => {
      expect(describeCall("list_scene_provenance", {}, { result: outcome }, 1)).toMatchObject({
        status: "error",
        result: words,
      });
    });

    it.each([
      [{ status: "no_scene" }, "no scene yet"],
      [{ status: "address_not_found" }, "no such object"],
      [{ status: "instance_not_recorded" }, "no such instance"],
      [{ status: "unsupported", reason: "needs the inspector" }, "needs the inspector"],
      [{ status: "error", message: "boom" }, "boom"],
    ])("puts the page's answer %j in words", (inner, words) => {
      expect(describeCall("get_instance_provenance", { file: "a", line: 1 }, answered(inner), 1)).toMatchObject({
        status: "error",
        result: words,
      });
    });
  });

  // Nothing about how a call is worded may turn into a failed call.
  it("copes with a shape it does not know", () => {
    expect(describeCall("some_future_tool", {}, { result: 5 }, 1)).toMatchObject({
      tool: "some_future_tool",
      status: "ok",
    });
    expect(() => describeCall("get_source", {}, {}, 1)).not.toThrow();
    expect(() => describeCall("highlight_object", {}, {}, 1)).not.toThrow();
  });
});

describe("ActivityReporter", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  function reporter() {
    const posted: Array<{ url: string; body: Record<string, unknown> }> = [];
    vi.stubGlobal("fetch", async (url: string, init: { body: string }) => {
      posted.push({ url, body: JSON.parse(init.body) as Record<string, unknown> });
      return new Response("{}", { status: 200 });
    });
    return {
      posted,
      reporter: new ActivityReporter(
        () => ({ origin: "http://localhost:5173" }),
        () => ({ id: "7", name: "Claude Code" })
      ),
    };
  }

  it("says it is here at once, and keeps saying so", async () => {
    vi.useFakeTimers();
    const { reporter: subject, posted } = reporter();

    subject.start();
    expect(posted).toHaveLength(1);
    expect(posted[0].url).toBe("http://localhost:5173/__cts/agent/report");
    expect(posted[0].body).toEqual({ agent: { id: "7", name: "Claude Code" } });

    await vi.advanceTimersByTimeAsync(10_000);
    expect(posted).toHaveLength(3);

    await subject.leave();
  });

  // An assistant can send anything as arguments, and by then the real work has
  // succeeded. The answer must still get through.
  it("does not fail a call it cannot put in words", () => {
    const { reporter: subject } = reporter();
    const strange = {
      get file(): string {
        throw new Error("no");
      },
    };

    expect(() => subject.call("get_source", strange, {}, 1)).not.toThrow();
  });

  it("reports a call", () => {
    const { reporter: subject, posted } = reporter();

    subject.call("list_files", {}, { result: { files: [] } }, 1);

    expect(posted[0].body.activity).toMatchObject({ tool: "list_files", result: "0 files" });
  });

  it("says when it is leaving, and stops", async () => {
    vi.useFakeTimers();
    const { reporter: subject, posted } = reporter();
    subject.start();

    await subject.leave();
    expect(posted.at(-1)!.body).toMatchObject({ leaving: true });

    const count = posted.length;
    await vi.advanceTimersByTimeAsync(20_000);
    expect(posted).toHaveLength(count);
  });

  // A dev server that has not started yet is the normal case at startup.
  it("never fails, whatever the dev server does", async () => {
    vi.stubGlobal("fetch", async () => {
      throw new Error("connection refused");
    });
    const subject = new ActivityReporter(
      () => ({ origin: "http://localhost:1" }),
      () => ({ id: "7", name: "x" })
    );

    expect(() => subject.call("list_files", {}, {}, 1)).not.toThrow();
    await expect(subject.leave()).resolves.toBeUndefined();
  });

  it("asks where the dev server is every time", async () => {
    const origins = ["http://localhost:5173", "http://localhost:5174"];
    const posted: string[] = [];
    vi.stubGlobal("fetch", async (url: string) => {
      posted.push(url);
      return new Response("{}");
    });
    const subject = new ActivityReporter(
      () => ({ origin: origins.shift()! }),
      () => ({ id: "7", name: "x" })
    );

    subject.call("list_files", {}, {}, 1);
    subject.call("list_files", {}, {}, 1);

    expect(posted).toEqual([
      "http://localhost:5173/__cts/agent/report",
      "http://localhost:5174/__cts/agent/report",
    ]);
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AGENT_ACTIVITY_EVENT,
  AGENT_STATE_EVENT,
  type AgentActivity,
  type AgentState,
} from "@click-to-source-3d/shared";
import { AgentHub } from "../src/agentHub.js";

const agent = { id: "111", name: "Claude Code" };
const call = {
  tool: "get_source",
  detail: "src/World.tsx",
  result: "lines 1-40",
  status: "ok",
  effect: "read",
  durationMs: 12,
  targets: [{ file: "src/World.tsx", line: 1 }],
};

function pointed(line: number) {
  return { kind: "Mesh", source: { file: "src/World.tsx", function: "World", line } };
}

const pageA = { pageId: 1, session: "a", url: "http://localhost:5173/" };
const pageB = { pageId: 2, session: "b", url: "http://localhost:5173/other" };

describe("AgentHub", () => {
  let now: number;
  let sent: Array<{ event: string; data: unknown }>;
  let hub: AgentHub;

  beforeEach(() => {
    vi.useFakeTimers();
    now = 1_000_000;
    sent = [];
    hub = new AgentHub((event, data) => sent.push({ event, data }), () => now);
  });

  afterEach(() => {
    hub.dispose();
    vi.useRealTimers();
  });

  describe("who is connected", () => {
    it("announces an assistant the first time it is heard from", () => {
      hub.report({ agent });

      expect(hub.state().agents).toEqual([{ id: "111", name: "Claude Code", lastCallAt: null }]);
      expect(sent.map((message) => message.event)).toEqual([AGENT_STATE_EVENT]);

      // Every heartbeat after that says nothing new.
      hub.report({ agent });
      expect(sent).toHaveLength(1);
    });

    it("forgets an assistant that says it is leaving, at once", () => {
      hub.report({ agent });
      hub.report({ agent, leaving: true });

      expect(hub.state().agents).toEqual([]);
      expect((sent.at(-1)!.data as AgentState).agents).toEqual([]);
    });

    // Found by a test that made a call and quit straight away.
    it("is not fooled by the last call's report arriving after the goodbye", () => {
      hub.report({ agent });
      hub.report({ agent, leaving: true });

      hub.report({ agent, activity: call });

      expect(hub.state().agents).toEqual([]);
      expect(hub.state().log).toHaveLength(1);
    });

    it("recognises the same id again once it has long gone", () => {
      hub.report({ agent });
      hub.report({ agent, leaving: true });

      now += 20_000;
      vi.advanceTimersByTime(5000);
      hub.report({ agent });

      expect(hub.state().agents).toHaveLength(1);
    });

    it("forgets an assistant that stops being heard from", () => {
      hub.report({ agent });

      now += 14_000;
      vi.advanceTimersByTime(5000);
      expect(hub.state().agents).toHaveLength(1);

      now += 2000;
      vi.advanceTimersByTime(5000);
      expect(hub.state().agents).toEqual([]);
      expect(sent.at(-1)!.event).toBe(AGENT_STATE_EVENT);
    });

    it("keeps an assistant that keeps saying it is here", () => {
      hub.report({ agent });
      for (let beat = 0; beat < 10; beat++) {
        now += 5000;
        hub.report({ agent });
        vi.advanceTimersByTime(5000);
      }

      expect(hub.state().agents).toHaveLength(1);
    });
  });

  describe("what it has done", () => {
    it("numbers and times a call, and passes it on to the pages", () => {
      hub.report({ agent, activity: call });

      const entry = sent.at(-1)!;
      expect(entry.event).toBe(AGENT_ACTIVITY_EVENT);
      expect(entry.data).toEqual({ ...call, id: 1, at: now, agent: "Claude Code" });
      expect(hub.state().log).toEqual([entry.data]);
      expect(hub.state().agents[0].lastCallAt).toBe(now);
    });

    it("keeps the log for a page that opens later, within a limit", () => {
      hub.report({ agent });
      for (let index = 0; index < 250; index++) {
        hub.report({ agent, activity: call });
      }

      const log = hub.state().log;
      expect(log).toHaveLength(200);
      expect(log[0].id).toBe(51);
      expect(log.at(-1)!.id).toBe(250);
    });

    // Any local process can post here, and the page draws what it receives.
    it("takes nothing from a report on trust", () => {
      hub.report({ agent: { id: 42 } });
      hub.report(null);
      expect(hub.state().agents).toEqual([]);

      hub.report({
        agent,
        activity: {
          tool: "x".repeat(1000),
          status: "fine",
          effect: "delete everything",
          durationMs: "soon",
          targets: [{ file: "a.tsx", line: 1, extra: "<img>" }, { file: 1 }, null],
        },
      });

      const entry = hub.state().log[0] as AgentActivity;
      expect(entry.tool).toHaveLength(300);
      expect(entry.status).toBe("ok");
      expect(entry.effect).toBe("read");
      expect(entry.durationMs).toBe(0);
      expect(entry.targets).toEqual([{ file: "a.tsx", line: 1 }]);
    });

    it("calls an assistant with no name of its own what it is", () => {
      hub.report({ agent: { id: "9" } });

      expect(hub.state().agents[0].name).toBe("Assistant");
    });
  });

  describe("what the developer is pointing at", () => {
    const resultOf = (outcome: ReturnType<AgentHub["selectionOutcome"]>) =>
      (outcome as { result: { pointing: unknown[]; selected: unknown; url: string; hint?: string } }).result;

    it("answers from what the page last published", () => {
      hub.setSelection(pageA, { pointing: [pointed(10), pointed(20)], selected: pointed(30) });

      const outcome = hub.selectionOutcome(["a"]);

      expect(outcome).toMatchObject({ status: "answered", pageId: 1 });
      expect(resultOf(outcome).pointing).toEqual([pointed(10), pointed(20)]);
      expect(resultOf(outcome).selected).toEqual(pointed(30));
      expect(resultOf(outcome).url).toBe(pageA.url);
    });

    it("says so when there is no page at all", () => {
      expect(hub.selectionOutcome([])).toEqual({ status: "disconnected" });
    });

    it("says what to do when a page is open and nothing is pointed at", () => {
      hub.setSelection(pageA, { pointing: [], selected: null });

      const outcome = hub.selectionOutcome(["a"]);

      expect(outcome.status).toBe("answered");
      expect(resultOf(outcome).pointing).toEqual([]);
      expect(resultOf(outcome).hint).toContain("has not selected or pointed at anything");
    });

    // Two open tabs make a question about a scene ambiguous, but the developer's
    // latest gesture says which one they mean here.
    it("takes the page the developer touched last", () => {
      hub.setSelection(pageA, { pointing: [pointed(10)], selected: null });
      now += 1000;
      hub.setSelection(pageB, { pointing: [pointed(20)], selected: null });

      expect(hub.selectionOutcome(["a", "b"])).toMatchObject({ pageId: 2 });

      now += 1000;
      hub.setSelection(pageA, { pointing: [pointed(11)], selected: null });
      expect(hub.selectionOutcome(["a", "b"])).toMatchObject({ pageId: 1 });
    });

    it("skips a page that has since let go of everything", () => {
      hub.setSelection(pageA, { pointing: [pointed(10)], selected: null });
      now += 1000;
      hub.setSelection(pageB, { pointing: [], selected: null });

      expect(hub.selectionOutcome(["a", "b"])).toMatchObject({ pageId: 1 });
    });

    // An assistant's own edit can cause the reload it then asks during.
    it("still answers while a page is reloading", () => {
      hub.setSelection(pageA, { pointing: [pointed(10)], selected: null });
      hub.pageLeft(pageA);

      expect(resultOf(hub.selectionOutcome([])).pointing).toEqual([pointed(10)]);
    });

    it("still answers once the reloaded page is back, before it has published", () => {
      hub.setSelection(pageA, { pointing: [pointed(10)], selected: null });
      hub.pageLeft(pageA);

      // The same session, reconnected, still looking for its objects.
      expect(resultOf(hub.selectionOutcome(["a"])).pointing).toEqual([pointed(10)]);
    });

    // Found by a test that opened a fresh page right after another closed.
    it("gives a closed tab no say over a different page that is open", () => {
      hub.setSelection(pageA, { pointing: [pointed(10)], selected: null });
      hub.pageLeft(pageA);

      const result = resultOf(hub.selectionOutcome(["someone-else"]));

      expect(result.pointing).toEqual([]);
      expect(result.hint).toBeDefined();
    });

    it("lets go once a page has been gone a while", () => {
      hub.setSelection(pageA, { pointing: [pointed(10)], selected: null });
      hub.pageLeft(pageA);

      now += 16_000;

      expect(hub.selectionOutcome([])).toEqual({ status: "disconnected" });
    });

    it("does not mistake a reloaded page's old connection closing for the page leaving", () => {
      const reloaded = { ...pageA, pageId: 5 };
      hub.setSelection(reloaded, { pointing: [pointed(10)], selected: null });
      hub.pageLeft(pageA); // the old socket's close, arriving late

      now += 16_000;

      expect(resultOf(hub.selectionOutcome(["a"])).pointing).toEqual([pointed(10)]);
    });

    it("keeps nothing that is not an object description", () => {
      hub.setSelection(pageA, { pointing: [pointed(10), "nonsense", null, 5], selected: "nonsense" });

      const result = resultOf(hub.selectionOutcome(["a"]));
      expect(result.pointing).toEqual([pointed(10)]);
      expect(result.selected).toBeNull();
    });

    it("holds a bounded number of objects", () => {
      hub.setSelection(pageA, {
        pointing: Array.from({ length: 100 }, (_, index) => pointed(index)),
        selected: null,
      });

      expect(resultOf(hub.selectionOutcome(["a"])).pointing).toHaveLength(64);
    });
  });
});

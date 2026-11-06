// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as THREE from "three";
import {
  AGENT_ACTIVITY_EVENT,
  AGENT_SELECTION_EVENT,
  AGENT_STATE_EVENT,
  type AgentActivity,
} from "@click-to-source-3d/shared";
import { AgentLink } from "../../src/client/agentLink.js";
import { Discovery } from "../../src/client/discovery.js";

function fakeHot() {
  const sent: Array<{ event: string; data: unknown }> = [];
  const listeners = new Map<string, Array<(data: never) => void>>();
  return {
    sent,
    hot: {
      send: (event: string, data?: unknown) => sent.push({ event, data }),
      on: (event: string, listener: (data: never) => void) =>
        listeners.set(event, [...(listeners.get(event) ?? []), listener]),
    },
    emit: (event: string, data?: unknown) =>
      (listeners.get(event) ?? []).forEach((listener) => listener(data as never)),
  };
}

function activity(overrides: Partial<AgentActivity> = {}): AgentActivity {
  return {
    id: 1,
    at: 1000,
    agent: "Claude Code",
    tool: "get_source",
    detail: "",
    result: "",
    status: "ok",
    effect: "read",
    durationMs: 1,
    targets: [],
    ...overrides,
  };
}

describe("AgentLink", () => {
  let canvas: HTMLCanvasElement;
  let discovery: Discovery;
  let link: AgentLink;
  let channel: ReturnType<typeof fakeHot>;
  let box: THREE.Mesh;
  let sphere: THREE.Mesh;

  beforeEach(() => {
    vi.useFakeTimers();
    delete (globalThis as { __THREE_DEVTOOLS__?: EventTarget }).__THREE_DEVTOOLS__;
    discovery = new Discovery(null);
    discovery.install();

    canvas = document.createElement("canvas");
    canvas.getBoundingClientRect = () =>
      ({ left: 0, top: 0, right: 100, bottom: 100, width: 100, height: 100, x: 0, y: 0 }) as DOMRect;
    document.body.append(canvas);

    const renderer = {
      isWebGLRenderer: true,
      domElement: canvas,
      autoClear: true,
      xr: { isPresenting: false },
      getRenderTarget: () => null,
      render: () => undefined,
    } as unknown as THREE.WebGLRenderer;
    (globalThis as { __THREE_DEVTOOLS__?: EventTarget }).__THREE_DEVTOOLS__!.dispatchEvent(
      new CustomEvent("observe", { detail: renderer })
    );

    const scene = new THREE.Scene();
    box = new THREE.Mesh(new THREE.BoxGeometry());
    box.userData.__ctsSource = { file: "src/A.tsx", function: "A", line: 10 };
    sphere = new THREE.Mesh(new THREE.SphereGeometry());
    sphere.userData.__ctsSource = { file: "src/A.tsx", function: "A", line: 20 };
    scene.add(box, sphere);
    renderer.render(scene, new THREE.PerspectiveCamera());

    channel = fakeHot();
    link = new AgentLink(discovery, channel.hot);
  });

  afterEach(() => {
    canvas.remove();
    vi.useRealTimers();
  });

  const outlined = () => discovery.all()[0].layer.all("agent").map((target) => target.object);

  describe("what the server tells it", () => {
    it("takes the whole picture on hello", () => {
      let changes = 0;
      link.onChange(() => changes++);

      channel.emit(AGENT_STATE_EVENT, {
        agents: [{ id: "1", name: "Claude Code", lastCallAt: null }],
        log: [activity()],
      });

      expect(link.connected).toBe(true);
      expect(link.log).toHaveLength(1);
      expect(changes).toBe(1);
    });

    it("adds each call to the log, and notes when it was", () => {
      channel.emit(AGENT_STATE_EVENT, {
        agents: [{ id: "1", name: "Claude Code", lastCallAt: null }],
        log: [],
      });

      channel.emit(AGENT_ACTIVITY_EVENT, activity({ at: 5000 }));

      expect(link.log).toHaveLength(1);
      expect(link.agents[0].lastCallAt).toBe(5000);
    });

    it("is not connected until an assistant is", () => {
      expect(link.connected).toBe(false);
    });
  });

  describe("what the assistant is looking at", () => {
    it("outlines an object it asks about, for a moment", () => {
      channel.emit(AGENT_ACTIVITY_EVENT, activity({ targets: [{ file: "src/A.tsx", line: 10 }] }));

      expect(outlined()).toEqual([box]);

      vi.advanceTimersByTime(4000);
      expect(outlined()).toEqual([]);
    });

    it("draws nothing for a call that names no object in the scene", () => {
      channel.emit(AGENT_ACTIVITY_EVENT, activity({ targets: [{ file: "src/Other.tsx", line: 1 }] }));

      expect(outlined()).toEqual([]);
    });

    it("outlines what it asks to, for as long as it asks", () => {
      const answer = link.answer({
        kind: "highlight_objects",
        targets: [{ file: "src/A.tsx", line: 20 }],
        seconds: 30,
      });

      expect(answer).toMatchObject({
        status: "ready",
        seconds: 30,
        missing: [],
        highlighted: [{ kind: "Mesh", file: "src/A.tsx", line: 20, instanceId: null }],
      });
      expect(outlined()).toEqual([sphere]);

      vi.advanceTimersByTime(29_000);
      expect(outlined()).toEqual([sphere]);

      vi.advanceTimersByTime(2000);
      expect(outlined()).toEqual([]);
    });

    // Found by using it: a passing resolve_at_point wiped the outline the
    // assistant had just asked to keep on screen for thirty seconds.
    it("does not let a passing question cut that short", () => {
      link.answer({ kind: "highlight_objects", targets: [{ file: "src/A.tsx", line: 20 }], seconds: 30 });

      channel.emit(AGENT_ACTIVITY_EVENT, activity({ targets: [{ file: "src/A.tsx", line: 10 }] }));
      expect(outlined()).toEqual([sphere, box]);

      vi.advanceTimersByTime(5000);
      expect(outlined()).toEqual([sphere]);
    });

    it("does not outline again what it already outlined on request", () => {
      link.answer({ kind: "highlight_objects", targets: [{ file: "src/A.tsx", line: 20 }] });

      channel.emit(
        AGENT_ACTIVITY_EVENT,
        activity({ tool: "highlight_object", effect: "point", targets: [{ file: "src/A.tsx", line: 20 }] })
      );

      expect(outlined()).toEqual([sphere]);
    });

    it("clears on an empty list", () => {
      link.answer({ kind: "highlight_objects", targets: [{ file: "src/A.tsx", line: 20 }] });
      link.answer({ kind: "highlight_objects", targets: [] });

      expect(outlined()).toEqual([]);
    });

    it("reports what it could not find", () => {
      const answer = link.answer({
        kind: "highlight_objects",
        targets: [
          { file: "src/A.tsx", line: 10 },
          { file: "src/A.tsx", line: 999 },
        ],
      });

      expect(answer).toMatchObject({
        highlighted: [{ line: 10 }],
        missing: [{ file: "src/A.tsx", line: 999 }],
      });
    });

    it("keeps a requested time within reason", () => {
      const answer = link.answer({
        kind: "highlight_objects",
        targets: [{ file: "src/A.tsx", line: 10 }],
        seconds: 100000,
      });

      expect(answer).toMatchObject({ seconds: 120 });
    });

    it("says when there is no canvas", () => {
      canvas.remove();

      expect(link.answer({ kind: "highlight_objects", targets: [] })).toEqual({ status: "no_scene" });
      expect(link.answer({ kind: "capture_canvas" })).toEqual({ status: "no_scene" });
    });
  });

  it("leaves everything else to the bridge", () => {
    expect(link.answer({ kind: "list_scene_provenance" })).toBeUndefined();
  });

  describe("telling the server what is pointed at", () => {
    const selection = { pointing: [], selected: null };

    it("sends it as it changes", () => {
      link.publish(selection);

      expect(channel.sent).toEqual([{ event: AGENT_SELECTION_EVENT, data: selection }]);
    });

    // A restarted dev server has forgotten, and nothing else would remind it.
    it("sends it again when the connection comes back", () => {
      link.publish(selection);
      channel.sent.length = 0;

      channel.emit("vite:ws:connect");

      expect(channel.sent).toEqual([{ event: AGENT_SELECTION_EVENT, data: selection }]);
    });

    it("has nothing to send before anything was published", () => {
      channel.emit("vite:ws:connect");

      expect(channel.sent).toEqual([]);
    });
  });
});

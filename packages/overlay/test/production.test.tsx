// @vitest-environment jsdom
import { afterAll, describe, expect, it, vi } from "vitest";
import * as THREE from "three";
import React, { act } from "react";
import { createRoot } from "react-dom/client";

/**
 * A consumer who mounts the overlay unconditionally ships it. Each component
 * must therefore do nothing at all in a production build: no panel, no render
 * loop takeover, and no bridge connection — the endpoint exists only on the
 * dev server, and EventSource would retry it for as long as the page is open.
 *
 * DEV is read once, when the module loads, so NODE_ENV is stubbed before any
 * component is imported.
 */

vi.stubEnv("NODE_ENV", "production");

const eventSources: string[] = [];
vi.stubGlobal(
  "EventSource",
  class {
    constructor(url: string) {
      eventSources.push(url);
    }
    close() {}
  }
);

// Were any component to reach its R3F hooks outside a Canvas, these would
// throw, so rendering them bare also proves the hooks were never called.
vi.mock("@react-three/fiber", () => ({
  useThree: () => {
    throw new Error("useThree called in production");
  },
  useFrame: () => {
    throw new Error("useFrame called in production");
  },
}));

const { GenerationTrace, SelectionHighlight, ClickToSourceBridge, useOverlayStore } =
  await import("../src/index.js");

afterAll(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("the overlay in a production build", () => {
  it("renders nothing and connects nothing", () => {
    useOverlayStore.getState().select({
      object: new THREE.Mesh(),
      sourceRef: { file: "src/Scene.tsx", function: "Scene", line: 4, args: { r: 1 } },
    });

    const container = document.createElement("div");
    const root = createRoot(container);

    act(() => {
      root.render(
        <>
          <GenerationTrace />
          <SelectionHighlight />
          <ClickToSourceBridge />
        </>
      );
    });

    expect(container.innerHTML).toBe("");
    expect(eventSources).toEqual([]);

    act(() => root.unmount());
  });
});

// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { blobOf, captureView } from "../../src/client/capture.js";
import type { View } from "../../src/client/discovery.js";

/**
 * jsdom has no canvas to draw on, so the 2D context is a recording stand-in.
 * Reading a real WebGL canvas in time is what the end-to-end test checks; this
 * checks when the read happens, and what is asked for.
 */
const drawn: Array<{ width: number; height: number }> = [];
let fillStyle: string | null;

beforeEach(() => {
  vi.useFakeTimers();
  drawn.length = 0;
  fillStyle = null;

  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(function (this: HTMLCanvasElement) {
    const output = this;
    return {
      set fillStyle(value: string) {
        fillStyle = value;
      },
      fillRect: () => undefined,
      drawImage: () => drawn.push({ width: output.width, height: output.height }),
    } as never;
  });
  vi.spyOn(HTMLCanvasElement.prototype, "toDataURL").mockImplementation(
    (type?: string) => `data:${type};base64,AAAA`
  );
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

function fakeView(width = 800, height = 400) {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  document.body.append(canvas);

  let waiter: (() => void) | null = null;
  const view = {
    canvas,
    redraw: vi.fn(),
    drawNow: vi.fn(() => true),
    afterScreenFrame: (callback: () => void) => {
      waiter = callback;
      return () => {
        waiter = null;
      };
    },
  };
  return {
    view: view as unknown as View,
    raw: view,
    /** The application draws a frame to the screen. */
    frame: () => {
      const callback = waiter;
      waiter = null;
      callback?.();
    },
  };
}

describe("captureView", () => {
  it("asks for a frame, and reads the canvas right after it", async () => {
    const { view, raw, frame } = fakeView();

    const capture = captureView(view);
    expect(raw.redraw).toHaveBeenCalled();
    expect(drawn).toEqual([]);

    frame();
    await vi.advanceTimersByTimeAsync(0);

    await expect(capture).resolves.toMatchObject({ data: "AAAA", mimeType: "image/jpeg", via: "frame" });
    expect(raw.drawNow).not.toHaveBeenCalled();
  });

  // An application may draw to the screen more than once in a frame, so the read
  // has to wait for the frame's script to end: three's buffer lasts until then.
  it("reads after the frame's script has finished, not in the middle of it", async () => {
    const { view, frame } = fakeView();

    const capture = captureView(view);
    frame();
    expect(drawn).toEqual([]);

    await vi.advanceTimersByTimeAsync(0);
    expect(drawn).toHaveLength(1);
    await capture;
  });

  // A background tab draws nothing, which is exactly when an assistant asks:
  // the developer has switched to their terminal.
  it("draws the scene itself when no frame comes", async () => {
    const { view, raw } = fakeView();

    const capture = captureView(view);
    await vi.advanceTimersByTimeAsync(400);

    await expect(capture).resolves.toMatchObject({ via: "direct" });
    expect(raw.drawNow).toHaveBeenCalledTimes(1);
  });

  it("does not answer twice when its own drawing counts as a frame", async () => {
    const { view, raw, frame } = fakeView();
    raw.drawNow.mockImplementation(() => {
      frame();
      return true;
    });

    const capture = captureView(view);
    await vi.advanceTimersByTimeAsync(400);
    await vi.advanceTimersByTimeAsync(0);

    await expect(capture).resolves.toMatchObject({ via: "direct" });
    expect(drawn).toHaveLength(1);
  });

  it("says so when nothing has ever been drawn", async () => {
    const { view, raw } = fakeView();
    raw.drawNow.mockReturnValue(false);

    const capture = captureView(view);
    const failed = expect(capture).rejects.toThrow("Nothing has been drawn");
    await vi.advanceTimersByTimeAsync(400);

    await failed;
  });

  it("scales the longest edge down to the limit, keeping the shape", async () => {
    const { view, frame } = fakeView(2000, 1000);

    const capture = captureView(view, { maxSize: 1024 });
    frame();
    await vi.advanceTimersByTimeAsync(0);

    await expect(capture).resolves.toMatchObject({ width: 1024, height: 512 });
    expect(drawn[0]).toEqual({ width: 1024, height: 512 });
  });

  it("never scales up", async () => {
    const { view, frame } = fakeView(300, 200);

    const capture = captureView(view, { maxSize: 1024 });
    frame();
    await vi.advanceTimersByTimeAsync(0);

    await expect(capture).resolves.toMatchObject({ width: 300, height: 200 });
  });

  // R3F's canvas is transparent by default, and JPEG has no alpha: left alone,
  // whatever the page shows through comes out black.
  it("paints what is behind the canvas under a format with no alpha", async () => {
    const { view, raw, frame } = fakeView();
    document.body.style.backgroundColor = "rgb(10, 20, 30)";
    raw.canvas.style.backgroundColor = "transparent";

    const capture = captureView(view);
    frame();
    await vi.advanceTimersByTimeAsync(0);
    await capture;

    expect(fillStyle).toBe("rgb(10, 20, 30)");
    document.body.style.backgroundColor = "";
  });

  it("leaves transparency alone in a format that has it", async () => {
    const { view, frame } = fakeView();

    const capture = captureView(view, { mimeType: "image/png" });
    frame();
    await vi.advanceTimersByTimeAsync(0);

    await expect(capture).resolves.toMatchObject({ mimeType: "image/png" });
    expect(fillStyle).toBeNull();
  });

  it("refuses a canvas with no size", async () => {
    const { view, frame } = fakeView(0, 0);

    const capture = captureView(view);
    const failed = expect(capture).rejects.toThrow("no size");
    frame();
    await vi.advanceTimersByTimeAsync(0);

    await failed;
  });
});

describe("blobOf", () => {
  it("turns a capture back into a file", async () => {
    const blob = blobOf({ data: btoa("hello"), mimeType: "image/png", width: 1, height: 1, via: "frame" });

    expect(blob.type).toBe("image/png");
    expect(blob.size).toBe(5);
  });
});

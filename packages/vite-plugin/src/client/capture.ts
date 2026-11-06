import type { View } from "./discovery.js";

export type Capture = {
  /** Base64, with no data: prefix. */
  data: string;
  mimeType: string;
  width: number;
  height: number;
  /**
   * `frame` is a frame the application drew itself. `direct` means none came,
   * as in a background tab, so the scene was drawn just for this: without any
   * post-processing the application normally does.
   */
  via: "frame" | "direct";
};

export type CaptureOptions = {
  /** Longest edge in pixels. The canvas is never scaled up. */
  maxSize?: number;
  mimeType?: "image/jpeg" | "image/png";
};

/** How long to wait for the application's own frame before drawing one. */
const FRAME_WAIT_MS = 400;

/** The colour behind a canvas with transparent parts, for a format with no alpha. */
function backdropOf(canvas: HTMLCanvasElement): string {
  for (let element: Element | null = canvas; element; element = element.parentElement) {
    const color = getComputedStyle(element).backgroundColor;
    if (color && color !== "transparent" && !/^rgba\(.*,\s*0\)$/.test(color)) {
      return color;
    }
  }
  return "#ffffff";
}

function encode(canvas: HTMLCanvasElement, options: CaptureOptions, via: Capture["via"]): Capture {
  const mimeType = options.mimeType ?? "image/jpeg";
  const longest = Math.max(canvas.width, canvas.height);
  if (longest === 0) {
    throw new Error("The canvas has no size");
  }

  const scale = Math.min(1, (options.maxSize ?? longest) / longest);
  const width = Math.max(1, Math.round(canvas.width * scale));
  const height = Math.max(1, Math.round(canvas.height * scale));

  const output = document.createElement("canvas");
  output.width = width;
  output.height = height;
  const context = output.getContext("2d");
  if (!context) {
    throw new Error("Could not read the canvas");
  }
  if (mimeType === "image/jpeg") {
    context.fillStyle = backdropOf(canvas);
    context.fillRect(0, 0, width, height);
  }
  context.drawImage(canvas, 0, 0, width, height);

  const url = output.toDataURL(mimeType, 0.85);
  return { data: url.slice(url.indexOf(",") + 1), mimeType, width, height, via };
}

/**
 * A picture of a canvas as it is on screen, highlights included.
 *
 * A WebGL canvas can only be read in the same task that drew it: three does not
 * keep the drawing buffer, and the browser clears it once it has been shown. So
 * the read is done right after a frame, in a microtask, which runs once the
 * frame's whole script has finished. That catches an application that draws to
 * the screen more than once a frame, and a post-processing composer's last pass.
 *
 * A background tab draws no frames, and an application that draws only on
 * demand may ignore the request for one. Rather than time out, the scene is then
 * drawn once here, which is why `via` says which happened.
 */
export function captureView(view: View, options: CaptureOptions = {}): Promise<Capture> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (via: Capture["via"]) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      cancel();
      try {
        resolve(encode(view.canvas, options, via));
      } catch (error) {
        reject(error);
      }
    };

    const cancel = view.afterScreenFrame(() => queueMicrotask(() => finish("frame")));
    const timer = setTimeout(() => {
      if (settled) {
        return;
      }
      if (view.drawNow()) {
        finish("direct");
      } else {
        settled = true;
        cancel();
        reject(new Error("Nothing has been drawn to this canvas yet"));
      }
    }, FRAME_WAIT_MS);

    view.redraw();
  });
}

/** A capture as a file. */
export function blobOf(capture: Capture): Blob {
  const bytes = Uint8Array.from(atob(capture.data), (character) => character.charCodeAt(0));
  return new Blob([bytes], { type: capture.mimeType });
}

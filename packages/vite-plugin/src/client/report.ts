import type { PointedObject } from "@click-to-source-3d/shared";
import { formatBytes, plural, valueText, vectorText } from "./format.js";

export type ReportContext = {
  url: string;
  threeRevision: string;
  userAgent: string;
};

/** Markdown code that survives whatever is inside it. */
function code(text: string): string {
  const fence = text.includes("`") ? "``" : "`";
  return `${fence}${text}${fence}`;
}

/** What one object is and where it came from, as Markdown to paste into an issue or a chat. */
export function reportMarkdown(object: PointedObject, context: ReportContext): string {
  const instance = object.instanceId !== null ? ` instance ${object.instanceId}` : "";
  const name = object.name ? ` "${object.name}"` : "";
  const lines: string[] = [];

  if (object.source) {
    const { file, line, column } = object.source;
    lines.push(`### ${object.kind}${instance}${name} at ${code(`${file}:${line}`)}`);
    lines.push("");
    lines.push(
      `Created in ${code(object.source.function)}, ${code(`${file}:${line}${column ? `:${column}` : ""}`)}.`
    );
  } else {
    lines.push(`### ${object.kind}${instance}${name}, with no source found`);
    if (object.parents.length > 0) {
      lines.push("");
      lines.push(`In ${object.parents.join(" › ")}.`);
    }
  }

  lines.push("");
  lines.push("| transform | |");
  lines.push("|---|---|");
  lines.push(`| position | ${vectorText(object.transform.position)} |`);
  lines.push(`| rotation | ${vectorText(object.transform.rotation)} |`);
  lines.push(`| scale | ${vectorText(object.transform.scale)} |`);
  lines.push(`| world position | ${vectorText(object.transform.worldPosition)} |`);

  if (object.props.length > 0) {
    lines.push("");
    lines.push("Values in source:");
    lines.push("");
    for (const prop of object.props) {
      lines.push(`- ${code(`<${prop.element}>`)} ${prop.name}: ${prop.values.map((value) => code(valueText(value))).join(", ")}`);
    }
  }

  if (object.materials.length > 0) {
    lines.push("");
    lines.push(`Materials: ${object.materials.join(", ")}.`);
  }

  const cost = object.cost;
  if (cost) {
    const textures = cost.textures.length > 0
      ? `${plural(cost.textures.length, "texture")} (${formatBytes(cost.textureBytes)})`
      : "no textures";
    lines.push("");
    lines.push(
      `Cost: ${plural(cost.triangles, "triangle")}, ${plural(cost.drawCalls, "draw call")}, ` +
        `${formatBytes(cost.geometryBytes)} of geometry, ${textures}.`
    );
  }

  lines.push("");
  lines.push(`three.js r${context.threeRevision}, ${context.url}, ${context.userAgent}`);

  return lines.join("\n");
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function toDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

/** Copies through a hidden field: all there is on a page that is not a secure context. */
function copyWithSelection(text: string): void {
  const field = document.createElement("textarea");
  field.value = text;
  field.style.cssText = "position:fixed;opacity:0;";
  document.body.append(field);
  field.select();
  const copied = document.execCommand("copy");
  field.remove();
  if (!copied) {
    throw new Error("The browser refused to copy");
  }
}

/**
 * Puts a report on the clipboard.
 *
 * Markdown text cannot hold a picture, so the screenshot travels as the rich
 * version of the same copy: a tool that pastes rich text (a doc, a chat app)
 * gets the picture, and one that pastes plain text (an issue form, a terminal)
 * gets the Markdown. `image` is a promise because the clipboard has to be
 * claimed during the click, and a screenshot takes a frame to arrive.
 *
 * Returns whether the picture went along.
 */
export async function copyReport(markdown: string, image: Promise<Blob>): Promise<{ picture: boolean }> {
  const clipboard = navigator.clipboard;

  if (clipboard?.write && typeof ClipboardItem !== "undefined") {
    try {
      const html = image.then(async (blob) => {
        const picture = `<img src="${await toDataUrl(blob)}" alt="Screenshot of the scene">`;
        return new Blob([`<pre>${escapeHtml(markdown)}</pre>${picture}`], { type: "text/html" });
      });
      await clipboard.write([
        new ClipboardItem({
          "text/plain": new Blob([markdown], { type: "text/plain" }),
          "text/html": html,
        }),
      ]);
      return { picture: true };
    } catch {
      // A browser or a policy that refuses rich copies can still take the text.
    }
  }

  if (clipboard?.writeText) {
    await clipboard.writeText(markdown);
  } else {
    copyWithSelection(markdown);
  }
  return { picture: false };
}

/** Puts one picture on the clipboard, for pasting into an issue, which uploads it. */
export async function copyImage(image: Promise<Blob>): Promise<void> {
  if (!navigator.clipboard?.write || typeof ClipboardItem === "undefined") {
    throw new Error("This browser cannot copy pictures here");
  }
  await navigator.clipboard.write([new ClipboardItem({ "image/png": image })]);
}

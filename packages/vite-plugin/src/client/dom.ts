type Child = Node | string | null | false | undefined;

type Props = {
  class?: string;
  text?: string;
  title?: string;
  attrs?: Record<string, string>;
  on?: Partial<Record<keyof HTMLElementEventMap, (event: Event) => void>>;
};

/**
 * Builds one element. Text always goes in through textContent: file names,
 * function names and expressions shown here come from source code, and none
 * of it is ever parsed as markup.
 */
export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Props = {},
  children: Child[] = []
): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);

  if (props.class) {
    element.className = props.class;
  }
  if (props.text !== undefined) {
    element.textContent = props.text;
  }
  if (props.title) {
    element.title = props.title;
  }
  for (const [name, value] of Object.entries(props.attrs ?? {})) {
    element.setAttribute(name, value);
  }
  for (const [event, listener] of Object.entries(props.on ?? {})) {
    element.addEventListener(event, listener as EventListener);
  }
  for (const child of children) {
    if (child !== null && child !== false && child !== undefined) {
      element.append(child);
    }
  }

  return element;
}

/** An inline SVG icon from path data, sized by CSS. */
export function icon(paths: string[]): SVGSVGElement {
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "2");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("aria-hidden", "true");
  for (const d of paths) {
    const path = document.createElementNS(ns, "path");
    path.setAttribute("d", d);
    svg.append(path);
  }
  return svg;
}

export const ICONS = {
  crosshair: ["M12 3v4", "M12 17v4", "M3 12h4", "M17 12h4", "M12 8a4 4 0 1 0 0.01 0"],
  close: ["M6 6l12 12", "M18 6L6 18"],
  open: ["M14 4h6v6", "M20 4l-9 9", "M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"],
};

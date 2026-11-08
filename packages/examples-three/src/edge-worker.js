import { makePart } from "./shared.js";

self.onmessage = () => {
  const part = makePart();
  self.postMessage({ type: part.type, children: part.children.length });
};

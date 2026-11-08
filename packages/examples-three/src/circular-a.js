import { made } from "./circular-b.js";

// Called by circular-b.js while it is evaluated, before the rest of this file has run.
export function makeCircular() {
  return new THREE_MESH();
}

export const circularMesh = made;

import { Mesh as THREE_MESH } from "three";

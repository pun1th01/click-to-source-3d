import { BoxGeometry, MeshBasicMaterial } from "three";
import { makeCircular } from "./circular-a.js";

export const made = makeCircular();
made.geometry = new BoxGeometry(2, 2, 2);
made.material = new MeshBasicMaterial({ color: "#aa66ff" });
made.name = "made across a circular import";

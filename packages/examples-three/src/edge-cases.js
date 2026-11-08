import * as THREE from "three";
import { CSS2DRenderer } from "three/addons/renderers/CSS2DRenderer.js";
import { circularMesh } from "./circular-a.js";
import { makePart } from "./shared.js";

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setSize(window.innerWidth, window.innerHeight);
document.body.prepend(renderer.domElement);

// Labels sit in an element of their own on top of the canvas, and clicks land on it.
const labels = new CSS2DRenderer({ element: document.getElementById("overlay") });
labels.setSize(window.innerWidth, window.innerHeight);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(50, window.innerWidth / window.innerHeight, 0.1, 100);
camera.position.set(0, 0, 14);
scene.add(new THREE.AmbientLight("#ffffff", 3));

const center = new THREE.Mesh(
  new THREE.BoxGeometry(2, 2, 2),
  new THREE.MeshStandardMaterial({ color: "#e0556a" })
);
center.name = "center";
scene.add(center);

// Made while a circular import was being evaluated.
circularMesh.position.set(4, 0, 0);
scene.add(circularMesh);

const part = makePart();
part.position.set(0, 3, 0);
scene.add(part);

// A grid that would take every click near it, at three's default threshold.
const grid = new THREE.GridHelper(40, 40);
grid.rotation.x = Math.PI / 2;
// Offset by half a cell, so what the camera sees through it isn't on a line.
grid.position.set(0.5, 0.5, 4);
scene.add(grid);

// A stand-in for picking that draws nothing, in front of what can be seen.
const hidden = new THREE.Mesh(
  new THREE.BoxGeometry(3, 3, 1),
  new THREE.MeshBasicMaterial({ visible: false })
);
hidden.name = "hidden stand-in";
hidden.position.set(0, -3, 3);
scene.add(hidden);
const behind = new THREE.Mesh(new THREE.BoxGeometry(2, 2, 2), new THREE.MeshBasicMaterial({ color: "#44cc88" }));
behind.name = "behind the stand-in";
behind.position.set(0, -3, 0);
scene.add(behind);

// A module shared with the page, which also runs in a worker with no document.
const worker = new Worker(new URL("./edge-worker.js", import.meta.url), { type: "module" });
const workerReply = new Promise((resolve, reject) => {
  worker.onmessage = (event) => resolve(event.data);
  worker.onerror = (event) => reject(new Error(event.message));
  worker.postMessage("go");
});

window.__edge = { scene, camera, workerReply };

renderer.setAnimationLoop(() => {
  renderer.render(scene, camera);
  labels.render(scene, camera);
});

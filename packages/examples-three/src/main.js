import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { buildWorld } from "./world.js";

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
document.body.append(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color("#10131a");

const camera = new THREE.PerspectiveCamera(50, window.innerWidth / window.innerHeight, 0.1, 500);
camera.position.set(0, 20, 38);

const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;

const sun = new THREE.DirectionalLight("#ffffff", 2.5);
sun.position.set(10, 30, 20);
scene.add(sun, new THREE.AmbientLight("#8899bb", 0.8));

buildWorld(scene, 7);

const cube = new THREE.Mesh(
  new THREE.BoxGeometry(3, 3, 3),
  new THREE.MeshStandardMaterial({ color: "#e0556a", roughness: 0.35 })
);
cube.name = "spinning cube";
cube.position.set(0, 9, 0);
scene.add(cube);

function animate() {
  cube.rotation.y += 0.01;
  controls.update();
  renderer.render(scene, camera);
}
renderer.setAnimationLoop(animate);

window.addEventListener("resize", () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

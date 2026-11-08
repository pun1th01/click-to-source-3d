import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";

// A small model written out here, so the example needs no asset files.
const MODEL = {
  asset: { version: "2.0" },
  scene: 0,
  scenes: [{ nodes: [0] }],
  nodes: [
    { name: "beacon", children: [1, 2] },
    { name: "left blade", mesh: 0, translation: [-1.2, 0, 0] },
    { name: "right blade", mesh: 0, translation: [0.2, 0, 0] },
  ],
  meshes: [{ primitives: [{ attributes: { POSITION: 0 }, material: 0 }] }],
  materials: [{ doubleSided: true, pbrMetallicRoughness: { baseColorFactor: [1, 0.7, 0.2, 1] } }],
  accessors: [
    { bufferView: 0, componentType: 5126, count: 3, type: "VEC3", min: [0, 0, 0], max: [1, 1, 0] },
  ],
  bufferViews: [{ buffer: 0, byteLength: 36 }],
  buffers: [
    {
      byteLength: 36,
      uri: "data:application/octet-stream;base64,AAAAAAAAAAAAAAAAAACAPwAAAAAAAAAAAAAAAAAAgD8AAAAA",
    },
  ],
};

export function loadBeacon(scene) {
  const loader = new GLTFLoader();
  loader.parse(JSON.stringify(MODEL), "", (gltf) => {
    gltf.scene.position.set(-16, 12, 0);
    gltf.scene.scale.setScalar(5);
    scene.add(gltf.scene);
  });
}

import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { clickToSource } from "@click-to-source-3d/vite-plugin";

export default defineConfig({
  plugins: [
    // Listed first by convention. @vitejs/plugin-react performs no JSX
    // transform of its own, so with it either order stamps identically.
    clickToSource({
      stampSource: true, // file/function/line into userData.__ctsSource
      captureInstances: true, // per-instance transforms for InstancedMesh
      bridge: true, // let @click-to-source-3d/mcp query the running scene
    }),
    react(),
  ],
});

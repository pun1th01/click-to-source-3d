import { defineConfig } from "vite";
import { clickToSource } from "@click-to-source-3d/vite-plugin";

export default defineConfig({
  // The whole setup. Nothing in src/ knows about click-to-source.
  plugins: [clickToSource()],
});

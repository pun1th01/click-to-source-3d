import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { clickToSource } from "@click-to-source-3d/vite-plugin";

export default defineConfig({
  plugins: [react(), clickToSource()],
});

import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { clickToSource } from "@click-to-source-3d/vite-plugin";

export default defineConfig({
  // The whole setup. In dev it stamps every element with where it came from,
  // injects the inspector (Alt+Shift+C), and opens the bridge the MCP server
  // talks to. In a build it does nothing.
  plugins: [clickToSource(), react()],
});

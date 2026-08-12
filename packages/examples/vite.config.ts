import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileIoPlugin } from "./vite-file-io";

export default defineConfig({
  plugins: [react(), fileIoPlugin()],
});

import { defineConfig } from "@playwright/test";

/**
 * End-to-end tests against the example app, driven the way a developer would
 * use the inspector: a key, a click, an edit, a request from an assistant.
 *
 * Locally, set CTS_E2E_CHANNEL=msedge (or chrome) to use an installed browser
 * instead of downloading one. CI installs Chromium.
 */
const PORT = 5199;

export default defineConfig({
  testDir: "e2e",
  timeout: 60_000,
  workers: 1,
  reporter: process.env.CI ? [["list"], ["github"]] : "list",
  use: {
    baseURL: `http://localhost:${PORT}`,
    channel: process.env.CTS_E2E_CHANNEL || undefined,
    viewport: { width: 1280, height: 720 },
    launchOptions: {
      // WebGL in a headless browser runs on SwiftShader, which recent
      // Chromium only enables when asked.
      args: ["--enable-unsafe-swiftshader", "--use-angle=swiftshader"],
    },
  },
  webServer: {
    command: `npm run dev -w @click-to-source-3d/examples -- --port ${PORT} --strictPort`,
    url: `http://localhost:${PORT}`,
    reuseExistingServer: false,
    timeout: 120_000,
  },
});

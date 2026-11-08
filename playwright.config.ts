import { defineConfig } from "@playwright/test";

/**
 * End-to-end: the real server (built client + Node) and two real browsers.
 * Locally the installed Google Chrome is used; in CI the Playwright Chromium.
 */
export default defineConfig({
  testDir: "e2e",
  timeout: 30_000,
  reporter: process.env.CI ? "github" : "list",
  use: {
    baseURL: "http://localhost:8099",
    ...(process.env.CI ? {} : { channel: "chrome" }),
    launchOptions: { args: ["--mute-audio"] },
  },
  webServer: {
    command: "node server/src/index.ts",
    url: "http://localhost:8099/health",
    env: { PORT: "8099", LOG_LEVEL: "warn" },
    reuseExistingServer: false,
    timeout: 30_000,
  },
});

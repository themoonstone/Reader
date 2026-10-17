import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "./tests/cloud-e2e",
  workers: 1,
  fullyParallel: false,
  use: {
    baseURL: "http://127.0.0.1:3104",
    channel: "chrome",
    headless: true,
    viewport: { width: 1280, height: 800 },
    trace: "retain-on-failure",
  },
  webServer: {
    command: "node tests/fixtures/cloud-server.mts",
    url: "http://127.0.0.1:3104/api/health",
    timeout: 120000,
    reuseExistingServer: false,
  },
});

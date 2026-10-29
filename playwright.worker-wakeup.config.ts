import { defineConfig, devices } from "@playwright/test";
export default defineConfig({
  testDir: "./tests/e2e",
  testMatch: "delegated-parent-wakeup.spec.ts",
  timeout: 120000,
  workers: 1,
  reporter: [["list"]],
  use: {
    ...devices["Desktop Chrome"],
    baseURL: "http://127.0.0.1:4173",
    screenshot: "off",
    trace: "off",
  },
  webServer: {
    command: "python3 -m http.server 4173 -d dist",
    url: "http://127.0.0.1:4173",
    reuseExistingServer: false,
  },
});

import { defineConfig, devices } from "@playwright/test";

/**
 * Standalone Playwright config for the Streamdown table overflow layout test.
 * This test uses page.setContent() with inline CSS, so it does not need the
 * app's webServer. Keeping a separate config avoids requiring a built dist/.
 */
export default defineConfig({
  testDir: "./tests/e2e",
  testMatch: ["**/table-overflow.spec.ts"],
  timeout: 30_000,
  retries: 0,
  workers: 1,
  reporter: [["list"]],
  use: {
    ...devices["Desktop Chrome"],
  },
});

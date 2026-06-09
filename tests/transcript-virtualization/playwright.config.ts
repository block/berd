import { defineConfig, devices } from "@playwright/test";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const baseURL =
  process.env.TRANSCRIPT_VIRTUALIZATION_BASE_URL ?? "http://127.0.0.1:1520";
const startServer = process.env.TRANSCRIPT_VIRTUALIZATION_START_SERVER === "1";
const reuseExistingServer =
  process.env.TRANSCRIPT_VIRTUALIZATION_REUSE_SERVER === "1";
const serverCommand =
  process.env.TRANSCRIPT_VIRTUALIZATION_SERVER_COMMAND ??
  "pnpm dev --host 127.0.0.1";
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

export default defineConfig({
  testDir: ".",
  testMatch: ["**/*.spec.ts"],
  timeout: 180_000,
  retries: 0,
  workers: 1,
  reporter: [
    ["list"],
    ["html", { open: "never", outputFolder: "transcript-playwright-report" }],
  ],
  use: {
    baseURL,
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
    video: "retain-on-failure",
  },
  projects: [
    {
      name: "desktop",
      use: { ...devices["Desktop Chrome"] },
    },
    {
      name: "compact",
      use: {
        ...devices["Desktop Chrome"],
        viewport: { width: 390, height: 844 },
      },
    },
  ],
  ...(startServer
    ? {
        webServer: {
          command: serverCommand,
          cwd: repoRoot,
          reuseExistingServer,
          timeout: 120_000,
          url: baseURL,
        },
      }
    : {}),
});

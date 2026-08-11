import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["scripts/release/tests/**/*.test.mjs"],
    testTimeout: 15_000,
  },
});

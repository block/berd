import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import { resolve } from "node:path";
import { readFileSync } from "node:fs";
import process from "node:process";

const packageJson = JSON.parse(
  readFileSync(new URL("./package.json", import.meta.url), "utf8"),
) as { version: string };

type AvatarFormat = "webm" | "hevc";

function isDarwinTarget(): boolean {
  return (
    process.env.TAURI_ENV_PLATFORM === "darwin" ||
    process.env.TAURI_ENV_TARGET_TRIPLE?.endsWith("-darwin") === true
  );
}

function resolveAvatarFormat(): AvatarFormat {
  const explicitFormat = process.env.GOOSE_AVATAR_FORMAT?.toLowerCase();
  if (explicitFormat === "webm" || explicitFormat === "hevc") {
    return explicitFormat;
  }
  if (explicitFormat) {
    throw new Error(
      `Unsupported GOOSE_AVATAR_FORMAT "${explicitFormat}". Expected "webm" or "hevc".`,
    );
  }

  return isDarwinTarget() ? "hevc" : "webm";
}

const avatarFormat = resolveAvatarFormat();

export default defineConfig({
  plugins: [react()],
  assetsInclude: ["**/*.mov", "**/*.mp4"],
  define: {
    "import.meta.env.VITE_APP_VERSION": JSON.stringify(packageJson.version),
  },
  resolve: {
    alias: [
      {
        find: "@/shared/avatars/catalog-assets",
        replacement: resolve(
          __dirname,
          `./src/shared/avatars/catalog-assets.${avatarFormat}.ts`,
        ),
      },
      {
        find: "@",
        replacement: resolve(__dirname, "./src"),
      },
    ],
  },
  test: {
    globals: true,
    environment: "jsdom",
    setupFiles: ["./src/test/setup.ts"],
    include: ["src/**/*.{test,spec}.{ts,tsx}"],
    css: true,
  },
});

import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const host = process.env.TAURI_DEV_HOST;
const rootDir = fileURLToPath(new URL(".", import.meta.url));
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

export default defineConfig(async () => {
  const avatarFormat = resolveAvatarFormat();

  return {
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
            rootDir,
            `src/shared/avatars/catalog-assets.${avatarFormat}.ts`,
          ),
        },
        {
          find: "@",
          replacement: resolve(rootDir, "src"),
        },
      ],
    },
    clearScreen: false,
    server: {
      port: parseInt(process.env.VITE_PORT || "1520", 10),
      strictPort: true,
      host: host || false,
      hmr: host
        ? {
            protocol: "ws",
            host,
            port: parseInt(process.env.VITE_PORT || "1520", 10) + 1,
          }
        : undefined,
      watch: {
        ignored: ["**/src-tauri/**"],
      },
    },
  };
});

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

export default defineConfig(async () => {
  return {
    plugins: [react()],
    define: {
      "import.meta.env.VITE_APP_VERSION": JSON.stringify(packageJson.version),
    },
    resolve: {
      alias: [
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

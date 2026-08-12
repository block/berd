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

type BuildEnvironment = "production" | "staging" | "development";

const BUILD_ENVIRONMENTS: readonly BuildEnvironment[] = [
  "production",
  "staging",
  "development",
];

function resolveBuildEnvironment(): BuildEnvironment {
  const environment = process.env.VITE_ENVIRONMENT || "development";
  if (!BUILD_ENVIRONMENTS.includes(environment as BuildEnvironment)) {
    throw new Error(
      `Invalid VITE_ENVIRONMENT "${environment}". Expected one of: ${BUILD_ENVIRONMENTS.join(", ")}`,
    );
  }
  return environment as BuildEnvironment;
}

function resolveAppVersion(): string {
  return process.env.VITE_APP_VERSION?.trim() || packageJson.version;
}

export default defineConfig(async ({ command }) => {
  const define: Record<string, string> = {
    "import.meta.env.VITE_APP_VERSION": JSON.stringify(resolveAppVersion()),
  };

  // Generic builds must stay telemetry-inert unless a release/staging path
  // explicitly opts in. Release scripts set VITE_ENVIRONMENT=production;
  // staging builds set VITE_ENVIRONMENT=staging. Unset build env means
  // development, so local/e2e/smoke `pnpm build` artifacts cannot emit live
  // telemetry by accident.
  if (command === "build") {
    define["import.meta.env.VITE_ENVIRONMENT"] = JSON.stringify(
      resolveBuildEnvironment(),
    );
  }

  return {
    plugins: [react()],
    define,
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

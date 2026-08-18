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

// Telemetry-gateway endpoints, in the shape the pipeline expects: the full
// `https://<host>/v1/logs` URL. The native layer derives the anonymous
// `/v1/bootstrap` URL from this same endpoint, so only the logs URL is ever
// injected. An endpoint host lives at four sites that change together, with
// no code-path changes: this default (or VITE_OTLP_LOGS_ENDPOINT in the build
// env), ALLOWED_OTEL_LOGS_HOSTS in src-tauri/src/commands/telemetry.rs,
// tauri.conf.json's CSP connect-src, and the pinned test values.
//
// The production gateway (squareup/berd-monitoring's production deployment) —
// injected whenever VITE_ENVIRONMENT=production.
const PRODUCTION_OTLP_LOGS_ENDPOINT = "https://otel.berd.xyz/v1/logs";

// The staging gateway (squareup/berd-monitoring's staging deployment) —
// injected whenever VITE_ENVIRONMENT=staging.
const STAGING_OTLP_LOGS_ENDPOINT =
  "https://otel.test.blockstaging.build/v1/logs";

// DUMMY placeholder for development. The telemetry send path (OTel logs over
// OTLP) is gated to production/staging, so this fake host is never contacted
// in dev or external clones.
const DUMMY_OTLP_LOGS_ENDPOINT =
  "https://otlp.invalid.goose-internal.example/v1/logs";

function resolveOtlpLogsEndpoint(): string {
  const explicit = process.env.VITE_OTLP_LOGS_ENDPOINT?.trim();
  if (explicit) {
    return explicit;
  }
  switch (resolveBuildEnvironment()) {
    case "production":
      return PRODUCTION_OTLP_LOGS_ENDPOINT;
    case "staging":
      return STAGING_OTLP_LOGS_ENDPOINT;
    case "development":
      return DUMMY_OTLP_LOGS_ENDPOINT;
  }
}

export default defineConfig(async ({ command }) => {
  const define: Record<string, string> = {
    "import.meta.env.VITE_APP_VERSION": JSON.stringify(resolveAppVersion()),
    "import.meta.env.VITE_OTLP_LOGS_ENDPOINT": JSON.stringify(
      resolveOtlpLogsEndpoint(),
    ),
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

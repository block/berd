// Release-time injector for the one distribution-owned provider value Berd
// accepts. The application owns the runtime-config schema; a distribution owns
// the Databricks workspace hostname it packages.
import { readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  runtimeConfigSchema,
  type RuntimeConfig,
} from "../src/shared/runtime-config/schema";

const PROVIDER_ID = "databricks_v2";
const ENV_KEY = "DATABRICKS_HOST";

export function normalizeDatabricksHost(raw: string): string {
  if (raw !== raw.trim() || raw.endsWith("/")) {
    throw new Error(
      "DATABRICKS_HOST must be a canonical URL without whitespace or a trailing slash",
    );
  }

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("DATABRICKS_HOST must be a valid URL");
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.port ||
    url.pathname !== "/" ||
    url.search ||
    url.hash ||
    url.origin !== raw
  ) {
    throw new Error(
      "DATABRICKS_HOST must be a canonical HTTPS origin without credentials, port, path, query, fragment, or trailing slash",
    );
  }
  return url.origin;
}

export function setRuntimeConfigDatabricksHost(
  input: unknown,
  rawHost: string,
): RuntimeConfig {
  const config = runtimeConfigSchema.parse(input);
  const host = normalizeDatabricksHost(rawHost);
  const providers = config.goose.modelProviders.filter(
    (provider) => provider.id === PROVIDER_ID,
  );
  if (providers.length !== 1) {
    throw new Error(
      `runtime config must contain exactly one ${PROVIDER_ID} provider; found ${providers.length}`,
    );
  }
  providers[0].endpointEnv = {
    ...providers[0].endpointEnv,
    [ENV_KEY]: host,
  };
  return runtimeConfigSchema.parse(config);
}

function main(argv: readonly string[]) {
  if (argv.length !== 2) {
    throw new Error(
      "usage: tsx scripts/set-runtime-config-databricks-host.ts <runtime-config.json> <https-origin>",
    );
  }
  const [path, host] = argv;
  const input = JSON.parse(readFileSync(path, "utf8"));
  const configured = setRuntimeConfigDatabricksHost(input, host);
  const temporary = join(dirname(path), `.${process.pid}.runtime-config.tmp`);
  writeFileSync(temporary, `${JSON.stringify(configured, null, 2)}\n`, {
    flag: "wx",
  });
  renameSync(temporary, path);
}

function invokedDirectly(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (invokedDirectly()) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

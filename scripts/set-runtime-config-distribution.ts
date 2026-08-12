// Release-time injector for the distribution-owned provider values Berd
// accepts. The application owns the runtime-config schema; a distribution owns
// the Databricks workspace hostname it packages and the fast model its gateway
// serves. Both are optional: an official public build supplies neither and
// ships the committed config unchanged.
import { readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  runtimeConfigSchema,
  type RuntimeConfig,
} from "../src/shared/runtime-config/schema";

const PROVIDER_ID = "databricks_v2";
const ENV_KEY = "DATABRICKS_HOST";

const USAGE =
  "usage: tsx scripts/set-runtime-config-distribution.ts [--databricks-host=<https-origin>] [--fast-model-id=<id>] <runtime-config.json>";

// A served endpoint id, not a display name: conservative charset plus a length
// cap, because the value is exported into a spawned `goose serve` process's
// environment (GOOSE_FAST_MODEL) and appears in logs. Deliberately NOT checked
// for membership in the provider's `models` — fast models are intentionally not
// surfaced in the model picker, so a fast model id has no entry there.
const FAST_MODEL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/;
const FAST_MODEL_ID_MAX_LENGTH = 128;

export interface DistributionValues {
  databricksHost?: string;
  fastModelId?: string;
}

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

export function normalizeFastModelId(raw: string): string {
  if (raw.length === 0 || raw !== raw.trim()) {
    throw new Error(
      "FAST_MODEL_ID must not be empty or padded with whitespace",
    );
  }
  if (raw.length > FAST_MODEL_ID_MAX_LENGTH) {
    throw new Error(
      `FAST_MODEL_ID must be at most ${FAST_MODEL_ID_MAX_LENGTH} characters`,
    );
  }
  if (!FAST_MODEL_ID_PATTERN.test(raw)) {
    throw new Error(
      "FAST_MODEL_ID must be a served endpoint id of alphanumerics and . _ : / - starting with an alphanumeric",
    );
  }
  return raw;
}

export function applyDistributionValues(
  input: unknown,
  { databricksHost, fastModelId }: DistributionValues,
): RuntimeConfig {
  const config = runtimeConfigSchema.parse(input);
  const providers = config.goose.modelProviders.filter(
    (provider) => provider.id === PROVIDER_ID,
  );
  if (providers.length !== 1) {
    throw new Error(
      `runtime config must contain exactly one ${PROVIDER_ID} provider; found ${providers.length}`,
    );
  }

  const provider = providers[0];
  if (databricksHost !== undefined) {
    provider.endpointEnv = {
      ...provider.endpointEnv,
      [ENV_KEY]: normalizeDatabricksHost(databricksHost),
    };
  }
  if (fastModelId !== undefined) {
    provider.fastModelId = normalizeFastModelId(fastModelId);
  }

  return runtimeConfigSchema.parse(config);
}

function main(argv: readonly string[]) {
  const values: DistributionValues = {};
  const paths: string[] = [];

  for (const arg of argv) {
    if (arg.startsWith("--databricks-host=")) {
      values.databricksHost = arg.slice("--databricks-host=".length);
    } else if (arg.startsWith("--fast-model-id=")) {
      values.fastModelId = arg.slice("--fast-model-id=".length);
    } else if (arg.startsWith("-")) {
      throw new Error(`unknown option: ${arg}\n${USAGE}`);
    } else {
      paths.push(arg);
    }
  }

  if (paths.length !== 1) {
    throw new Error(USAGE);
  }
  if (values.databricksHost === undefined && values.fastModelId === undefined) {
    throw new Error(
      `at least one of --databricks-host or --fast-model-id is required\n${USAGE}`,
    );
  }

  const [path] = paths;
  const input = JSON.parse(readFileSync(path, "utf8"));
  const configured = applyDistributionValues(input, values);
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

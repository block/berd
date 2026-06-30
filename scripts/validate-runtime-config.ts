// Build-time validator for a bundled runtime-config.json.
//
// Reuses the shared `runtimeConfigSchema` (src/shared/runtime-config/schema.ts)
// — the same `.strict()` schema the renderer parses bundled config with, which
// mirrors the Rust `RuntimeConfig`'s `deny_unknown_fields`. The release build
// (scripts/buildkite/release/build-macos.sh) runs this over the merged config
// of a CUSTOM build so a malformed blob or a typo'd/unknown key hard-fails
// before the expensive `pnpm tauri build`, instead of mid-build.
//
// The schema alone is NOT enough for a custom build. `featureToggles` is a
// free-form record<string, boolean> (mirroring the Rust HashMap), so a
// misspelled toggle KEY (e.g. `voiceDictaton`) passes the schema, then no-ops
// at runtime — the capability finds no toggle and defaults ON — silently
// shipping an unrestricted build, the exact failure this path must prevent.
// `--strict-toggles` (knownToggleKeysOnly) additionally rejects any
// `featureToggles` key outside RUNTIME_FEATURE_TOGGLE_KEYS, and the release
// build enables it for custom builds.
//
// Run via tsx: `pnpm exec tsx scripts/validate-runtime-config.ts [--strict-toggles] [path]`
// (or `pnpm run validate:runtime-config`). Defaults to the bundled
// src-tauri/resources/runtime-config.json. Exits 0 on success, 1 on a
// read/parse/schema/toggle-key error, 2 on usage error.

import { readFileSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { RUNTIME_FEATURE_TOGGLE_KEYS } from "../src/shared/profile/runtimeFeatureToggles";
import { runtimeConfigSchema } from "../src/shared/runtime-config/schema";

export const DEFAULT_RUNTIME_CONFIG_PATH =
  "src-tauri/resources/runtime-config.json";

const RUNTIME_CONFIG_USAGE =
  "usage: tsx scripts/validate-runtime-config.ts [--strict-toggles] [runtime-config.json]";

const RUNTIME_FEATURE_TOGGLE_KEY_SET = new Set<string>(
  RUNTIME_FEATURE_TOGGLE_KEYS,
);

export interface RuntimeConfigValidation {
  ok: boolean;
  /** Human-readable problems when `ok` is false. */
  errors: string[];
}

export interface ValidateRuntimeConfigOptions {
  /**
   * When true, reject any `featureToggles` key outside
   * RUNTIME_FEATURE_TOGGLE_KEYS in addition to the schema check. The schema
   * accepts arbitrary toggle keys (free-form record), so this is what catches a
   * fat-fingered toggle that would otherwise validate and silently no-op.
   * Custom release builds enable it; the official build never runs the
   * validator.
   */
  knownToggleKeysOnly?: boolean;
}

export type RuntimeConfigCliArgs =
  | { ok: true; knownToggleKeysOnly: boolean; target: string }
  | { ok: false; errors: string[] };

export function parseRuntimeConfigCliArgs(
  argv: readonly string[],
): RuntimeConfigCliArgs {
  const targets: string[] = [];
  const errors: string[] = [];
  let knownToggleKeysOnly = false;

  for (const arg of argv) {
    if (arg === "--strict-toggles") {
      knownToggleKeysOnly = true;
      continue;
    }

    if (arg.startsWith("-")) {
      errors.push(`unknown option: ${arg}`);
      continue;
    }

    targets.push(arg);
  }

  if (targets.length > 1) {
    errors.push(
      `expected at most one runtime-config path, got ${targets.length}: ${targets.join(", ")}`,
    );
  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }

  return {
    ok: true,
    knownToggleKeysOnly,
    target: targets[0] ?? DEFAULT_RUNTIME_CONFIG_PATH,
  };
}

/**
 * Validate the JSON file at `path` against `runtimeConfigSchema`. Never throws:
 * read failure, invalid JSON, and schema violations all surface as
 * `{ ok: false, errors }`. With `knownToggleKeysOnly`, unrecognized
 * `featureToggles` keys also surface as errors.
 */
export function validateRuntimeConfigFile(
  path: string,
  { knownToggleKeysOnly = false }: ValidateRuntimeConfigOptions = {},
): RuntimeConfigValidation {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (error) {
    return { ok: false, errors: [`failed to read ${path}: ${String(error)}`] };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    return { ok: false, errors: [`invalid JSON in ${path}: ${String(error)}`] };
  }

  const result = runtimeConfigSchema.safeParse(parsed);
  if (!result.success) {
    return {
      ok: false,
      errors: result.error.issues.map((issue) => {
        const where = issue.path.join(".") || "<root>";
        return `${where}: ${issue.message}`;
      }),
    };
  }

  if (knownToggleKeysOnly && result.data.featureToggles) {
    const unknownKeys = Object.keys(result.data.featureToggles).filter(
      (key) => !RUNTIME_FEATURE_TOGGLE_KEY_SET.has(key),
    );
    if (unknownKeys.length > 0) {
      return {
        ok: false,
        errors: unknownKeys.map(
          (key) =>
            `featureToggles.${key}: unknown toggle key (known keys: ${RUNTIME_FEATURE_TOGGLE_KEYS.join(", ")})`,
        ),
      };
    }
  }

  return { ok: true, errors: [] };
}

function invokedDirectly(): boolean {
  const entry = process.argv[1];
  if (!entry) {
    return false;
  }
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (invokedDirectly()) {
  const args = parseRuntimeConfigCliArgs(process.argv.slice(2));
  if (!args.ok) {
    for (const error of args.errors) {
      console.error(error);
    }
    console.error(RUNTIME_CONFIG_USAGE);
    process.exit(2);
  }

  const validation = validateRuntimeConfigFile(args.target, {
    knownToggleKeysOnly: args.knownToggleKeysOnly,
  });
  if (!validation.ok) {
    console.error(`runtime-config validation failed for ${args.target}:`);
    for (const error of validation.errors) {
      console.error(`  - ${error}`);
    }
    process.exit(1);
  }

  console.log(`runtime-config OK: ${args.target}`);
}

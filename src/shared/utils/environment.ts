/**
 * Environment utilities for checking the current deploy environment.
 *
 * Ported from g2's `src/shared/utils/environment.ts`. The environment is read
 * from `import.meta.env.VITE_ENVIRONMENT`, which is injected at build time by
 * `vite.config.ts`. Release/staging scripts must set it explicitly; generic
 * builds and dev (`vite` serve) default to `"development"` so telemetry stays
 * inert.
 */

export type Environment = "production" | "staging" | "development";

const KNOWN_ENVIRONMENTS: readonly Environment[] = [
  "production",
  "staging",
  "development",
];

/**
 * Gets the current environment from `VITE_ENVIRONMENT`, defaulting to
 * `"development"` when unset or unrecognized.
 */
export function getEnvironment(): Environment {
  const value = import.meta.env.VITE_ENVIRONMENT;
  return KNOWN_ENVIRONMENTS.includes(value as Environment)
    ? (value as Environment)
    : "development";
}

/** Checks if the current environment is production. */
export function isProduction(): boolean {
  return getEnvironment() === "production";
}

/** Checks if the current environment is staging. */
export function isStaging(): boolean {
  return getEnvironment() === "staging";
}

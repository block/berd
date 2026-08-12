// Authoritative set of `featureToggles` keys a bundled/endpoint runtime-config
// may set. Most flip profile capabilities off and are exactly the `toggle`
// values of the `runtimeFeature` entries in PROFILE_CAPABILITY_REGISTRY
// (capabilities.ts types its toggles against `RuntimeFeatureToggleKey`, and
// capabilities.test.ts pins the two in sync). Other keys gate focused runtime
// consumers outside profile capabilities and must be listed explicitly below.
//
// `featureToggles` is a free-form record<string, boolean> in both the zod
// schema and the Rust `RuntimeConfig` (HashMap<String, bool>), so a misspelled
// toggle key validates cleanly and then silently no-ops at runtime — the
// capability finds no toggle and defaults ON. That is the exact failure a
// restricted custom build must not ship, so the release-build runtime-config
// validator rejects any `featureToggles` key outside
// RUNTIME_FEATURE_TOGGLE_KEYS.
//
// Kept dependency-free on purpose: the build-time validator
// (scripts/validate-runtime-config.ts) imports it under tsx, where
// `import.meta.env` is unavailable, so it must not pull in buildProfile/React.
export const PROFILE_RUNTIME_FEATURE_TOGGLE_KEYS = [
  "automations",
  "builderbot",
  "agentToolsTip",
  "telemetry",
  "voiceDictation",
  "kgooseConnections",
] as const;

export type RuntimeFeatureToggleKey =
  (typeof PROFILE_RUNTIME_FEATURE_TOGGLE_KEYS)[number];

export const RUNTIME_FEATURE_TOGGLE_KEYS = [
  ...PROFILE_RUNTIME_FEATURE_TOGGLE_KEYS,
  "costTracking",
] as const;

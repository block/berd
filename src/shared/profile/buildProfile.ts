export type BuildFeature =
  | "authGate"
  | "agentToolsTip"
  | "automations"
  | "builderbot"
  | "byoKeyProviders"
  | "telemetry"
  | "voiceDictation"
  | "kgooseConnections"
  | "securityMl"
  | "updater";

const BUILD_FEATURES: Record<BuildFeature, boolean> = {
  authGate: import.meta.env.VITE_AUTH_GATE === "1",
  agentToolsTip: true,
  automations: true,
  builderbot: true,
  // Bring-your-own-key model providers (openai/anthropic/google surfaced from
  // goose's setup catalog so a user can enter their own API key). Defaults ON;
  // a restricted build opts out with VITE_BYO_KEY_PROVIDERS=0. With it off,
  // the runtime-config allowlist (default: databricks_v2 only) is the only
  // source of goose model providers and no provider-setup/key-entry UI is
  // exposed anywhere (settings, chat model picker, berdctl).
  byoKeyProviders: import.meta.env.VITE_BYO_KEY_PROVIDERS !== "0",
  // Defaults on; a restricted build opts out with VITE_TELEMETRY=0.
  telemetry: import.meta.env.VITE_TELEMETRY !== "0",
  // Defaults on; a restricted build opts out with VITE_VOICE_DICTATION=0.
  voiceDictation: import.meta.env.VITE_VOICE_DICTATION !== "0",
  // The kgoose-backed "Company-managed" connections tab. Named after the
  // backing system (kgoose), not the UI label. Defaults on; a restricted build
  // opts out with VITE_KGOOSE_CONNECTIONS=0.
  kgooseConnections: import.meta.env.VITE_KGOOSE_CONNECTIONS !== "0",
  // Defaults on; a restricted custom build opts out with VITE_SECURITY_ML=0.
  securityMl: import.meta.env.VITE_SECURITY_ML !== "0",
  // Dev keeps the Updates settings page visible; custom/restricted builds opt
  // out explicitly with VITE_UPDATER_ENABLED=false.
  updater: import.meta.env.VITE_UPDATER_ENABLED !== "false",
};

export function getBuildFeatureState(): Record<BuildFeature, boolean> {
  return BUILD_FEATURES;
}

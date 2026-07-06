import { getPlatform, type Platform } from "@/shared/lib/platform";

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
  // Bring-your-own-key model providers (openai/anthropic surfaced from goose's
  // setup catalog so a user can enter their own API key). Defaults OFF; a build
  // opts in with VITE_BYO_KEY_PROVIDERS=1 (e.g. `VITE_BYO_KEY_PROVIDERS=1 just
  // dev`). With it off, databricks_v2 is the only goose model provider and no
  // provider-setup/key-entry UI is exposed anywhere (settings, chat model
  // picker, berdctl).
  byoKeyProviders: import.meta.env.VITE_BYO_KEY_PROVIDERS === "1",
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

interface PlatformScopedMetadata {
  platforms?: readonly Platform[];
}

export function filterExperimentRegistryForBuildProfile<T>(
  registry: readonly T[],
): readonly T[] {
  const platform = getPlatform();
  const filtered = registry.filter((definition) => {
    const platforms = (definition as PlatformScopedMetadata).platforms;
    return !platforms || platforms.includes(platform);
  });
  return filtered.length === registry.length ? registry : filtered;
}

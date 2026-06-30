export type BuildFeature =
  | "authGate"
  | "agentToolsTip"
  | "automations"
  | "builderbot"
  | "telemetry"
  | "voiceDictation"
  | "kgooseConnections"
  | "updater";

const BUILD_FEATURES: Record<BuildFeature, boolean> = {
  authGate: import.meta.env.VITE_AUTH_GATE === "1",
  agentToolsTip: true,
  automations: true,
  builderbot: true,
  // Defaults on; a restricted build opts out with VITE_TELEMETRY=0.
  telemetry: import.meta.env.VITE_TELEMETRY !== "0",
  // Defaults on; a restricted build opts out with VITE_VOICE_DICTATION=0.
  voiceDictation: import.meta.env.VITE_VOICE_DICTATION !== "0",
  // The kgoose-backed "Company-managed" connections tab. Named after the
  // backing system (kgoose), not the UI label. Defaults on; a restricted build
  // opts out with VITE_KGOOSE_CONNECTIONS=0.
  kgooseConnections: import.meta.env.VITE_KGOOSE_CONNECTIONS !== "0",
  // Dev keeps the Updates settings page visible; custom/restricted builds opt
  // out explicitly with VITE_UPDATER_ENABLED=false.
  updater: import.meta.env.VITE_UPDATER_ENABLED !== "false",
};

export function getBuildFeatureState(): Record<BuildFeature, boolean> {
  return BUILD_FEATURES;
}

export function filterExperimentRegistryForBuildProfile<T>(
  registry: readonly T[],
): readonly T[] {
  return registry;
}

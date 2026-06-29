export type BuildFeature =
  | "authGate"
  | "agentToolsTip"
  | "automations"
  | "builderbot"
  | "telemetry";

const BUILD_FEATURES: Record<BuildFeature, boolean> = {
  authGate: import.meta.env.VITE_AUTH_GATE === "1",
  agentToolsTip: true,
  automations: true,
  builderbot: true,
  telemetry: true,
};

export function getBuildFeatureState(): Record<BuildFeature, boolean> {
  return BUILD_FEATURES;
}

export function filterExperimentRegistryForBuildProfile<T>(
  registry: readonly T[],
): readonly T[] {
  return registry;
}

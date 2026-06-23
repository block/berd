export type BuildFeature =
  | "agentToolsTip"
  | "automations"
  | "builderbot"
  | "telemetry";

const BUILD_FEATURES: Record<BuildFeature, boolean> = {
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

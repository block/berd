import { useMemo } from "react";
import {
  BUILDERBOT_SURFACE_EXPERIMENT_ID,
  VOICE_CONVERSATION_EXPERIMENT_ID,
} from "@/features/experiments/experimentDefinitions";
import {
  type ExperimentState,
  useExperimentList,
} from "@/features/experiments/experimentPreferences";
import { useRuntimeConfigStore } from "@/shared/runtime-config/runtimeConfigStore";
import type { RuntimeConfig } from "@/shared/runtime-config/schema";
import { getBuildFeatureState, type BuildFeature } from "./buildProfile";
import type { RuntimeFeatureToggleKey } from "./runtimeFeatureToggles";

export type ProfileCapabilityId =
  | "automations"
  | "builderbot"
  | "agentToolsTip"
  | "telemetry"
  | "voiceDictation"
  | "voiceConversation"
  | "kgooseConnections"
  | "updates"
  | "feedback"
  | "doctor";

type CapabilitySource =
  | { kind: "buildFeature"; feature: BuildFeature; experiment?: string }
  | {
      kind: "runtimeFeature";
      feature: BuildFeature;
      toggle: RuntimeFeatureToggleKey;
      experiment?: string;
    }
  | { kind: "runtimeConfigSection"; field: "feedback" | "doctor" };

export type ProfileCapabilityRegistry = Record<
  ProfileCapabilityId,
  CapabilitySource
>;

export const PROFILE_CAPABILITY_REGISTRY: ProfileCapabilityRegistry = {
  automations: {
    kind: "runtimeFeature",
    feature: "automations",
    toggle: "automations",
  },
  builderbot: {
    kind: "runtimeFeature",
    feature: "builderbot",
    toggle: "builderbot",
    experiment: BUILDERBOT_SURFACE_EXPERIMENT_ID,
  },
  agentToolsTip: {
    kind: "runtimeFeature",
    feature: "agentToolsTip",
    toggle: "agentToolsTip",
  },
  telemetry: {
    kind: "runtimeFeature",
    feature: "telemetry",
    toggle: "telemetry",
  },
  voiceDictation: {
    kind: "runtimeFeature",
    feature: "voiceDictation",
    toggle: "voiceDictation",
  },
  voiceConversation: {
    kind: "runtimeFeature",
    feature: "voiceDictation",
    toggle: "voiceDictation",
    experiment: VOICE_CONVERSATION_EXPERIMENT_ID,
  },
  kgooseConnections: {
    kind: "runtimeFeature",
    feature: "kgooseConnections",
    toggle: "kgooseConnections",
  },
  updates: {
    kind: "buildFeature",
    feature: "updater",
  },
  feedback: { kind: "runtimeConfigSection", field: "feedback" },
  doctor: { kind: "runtimeConfigSection", field: "doctor" },
};

export type ProfileCapabilityState = Record<ProfileCapabilityId, boolean>;

interface ResolveProfileCapabilitiesInput {
  buildFeatures: Record<BuildFeature, boolean>;
  experiments?: readonly Pick<ExperimentState, "id" | "enabled">[];
  runtimeConfig?: RuntimeConfig | null;
  runtimeConfigLoaded?: boolean;
}

function isExperimentEnabled(
  experiments: readonly Pick<ExperimentState, "id" | "enabled">[] | undefined,
  experimentId: string,
) {
  return Boolean(
    experiments?.some(
      (experiment) => experiment.id === experimentId && experiment.enabled,
    ),
  );
}

export function resolveProfileCapabilities({
  buildFeatures,
  experiments,
  runtimeConfig,
  runtimeConfigLoaded = true,
}: ResolveProfileCapabilitiesInput): ProfileCapabilityState {
  const capabilities = {} as ProfileCapabilityState;
  const runtimeConfigReady = runtimeConfigLoaded && runtimeConfig != null;

  for (const id of Object.keys(
    PROFILE_CAPABILITY_REGISTRY,
  ) as ProfileCapabilityId[]) {
    const source = PROFILE_CAPABILITY_REGISTRY[id];

    if (source.kind === "buildFeature") {
      capabilities[id] =
        buildFeatures[source.feature] &&
        (!source.experiment ||
          isExperimentEnabled(experiments, source.experiment));
      continue;
    }

    if (source.kind === "runtimeFeature") {
      capabilities[id] =
        buildFeatures[source.feature] &&
        (!runtimeConfigReady ||
          runtimeConfig.featureToggles?.[source.toggle] !== false) &&
        (!source.experiment ||
          isExperimentEnabled(experiments, source.experiment));
      continue;
    }

    capabilities[id] =
      !runtimeConfigReady || runtimeConfig[source.field]?.enabled !== false;
  }

  return capabilities;
}

export function getProfileCapabilitySnapshot(id: ProfileCapabilityId): boolean {
  const state = useRuntimeConfigStore.getState();
  return resolveProfileCapabilities({
    buildFeatures: getBuildFeatureState(),
    runtimeConfig: state.config,
    runtimeConfigLoaded: state.loaded,
  })[id];
}

export function useProfileCapabilities(): ProfileCapabilityState {
  const experiments = useExperimentList();
  const runtimeConfig = useRuntimeConfigStore((state) => state.config);
  const runtimeConfigLoaded = useRuntimeConfigStore((state) => state.loaded);

  return useMemo(
    () =>
      resolveProfileCapabilities({
        buildFeatures: getBuildFeatureState(),
        experiments,
        runtimeConfig,
        runtimeConfigLoaded,
      }),
    [runtimeConfig, runtimeConfigLoaded, experiments],
  );
}

export function useProfileCapability(id: ProfileCapabilityId): boolean {
  return useProfileCapabilities()[id];
}

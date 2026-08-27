import { useMemo } from "react";
import {
  BUILDERBOT_SURFACE_EXPERIMENT_ID,
  VOICE_CONVERSATION_EXPERIMENT_ID,
} from "@/features/experiments/experimentDefinitions";
import {
  type ExperimentState,
  useExperimentList,
} from "@/features/experiments/experimentPreferences";
import { useDistroStore } from "@/features/settings/stores/distroStore";
import { useRuntimeConfigStore } from "@/shared/runtime-config/runtimeConfigStore";
import type { RuntimeConfig } from "@/shared/runtime-config/schema";
import { getBuildFeatureState, type BuildFeature } from "./buildProfile";
import type { RuntimeFeatureToggleKey } from "./runtimeFeatureToggles";

export type ProfileCapabilityId =
  | "automations"
  | "builderbot"
  | "agentTools"
  | "telemetry"
  | "voiceDictation"
  | "voiceConversation"
  | "managedConnections"
  | "updates"
  | "feedback"
  | "feedbackSurveys"
  | "doctor";

type CapabilitySource =
  | {
      kind: "buildFeature";
      feature: BuildFeature;
      experiment?: string;
      requiresKgoose?: true;
      runtimeConfigSection?: "feedback";
    }
  | {
      kind: "runtimeFeature";
      feature: BuildFeature;
      toggle: RuntimeFeatureToggleKey;
      experiment?: string;
      requiresKgoose?: true;
    }
  | {
      kind: "runtimeConfigSection";
      field: "doctor";
      requiresKgoose?: true;
    };

export type ProfileCapabilityRegistry = Record<
  ProfileCapabilityId,
  CapabilitySource
>;

export const PROFILE_CAPABILITY_REGISTRY: ProfileCapabilityRegistry = {
  automations: {
    kind: "runtimeFeature",
    feature: "automations",
    toggle: "automations",
    requiresKgoose: true,
  },
  builderbot: {
    kind: "runtimeFeature",
    feature: "builderbot",
    toggle: "builderbot",
    experiment: BUILDERBOT_SURFACE_EXPERIMENT_ID,
    requiresKgoose: true,
  },
  agentTools: {
    kind: "runtimeFeature",
    feature: "agentTools",
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
    requiresKgoose: true,
  },
  voiceConversation: {
    kind: "buildFeature",
    feature: "voiceConversation",
    experiment: VOICE_CONVERSATION_EXPERIMENT_ID,
  },
  managedConnections: {
    kind: "runtimeFeature",
    feature: "managedConnections",
    toggle: "kgooseConnections",
    requiresKgoose: true,
  },
  updates: {
    kind: "buildFeature",
    feature: "updater",
  },
  feedback: {
    kind: "buildFeature",
    feature: "feedback",
    requiresKgoose: true,
    runtimeConfigSection: "feedback",
  },
  feedbackSurveys: {
    kind: "buildFeature",
    feature: "feedbackSurveys",
  },
  doctor: { kind: "runtimeConfigSection", field: "doctor" },
};

export type ProfileCapabilityState = Record<ProfileCapabilityId, boolean>;

interface ResolveProfileCapabilitiesInput {
  buildFeatures: Record<BuildFeature, boolean>;
  experiments?: readonly Pick<ExperimentState, "id" | "enabled">[];
  runtimeConfig?: RuntimeConfig | null;
  runtimeConfigLoaded?: boolean;
  kgooseConfigured?: boolean;
  kgooseConfigLoaded?: boolean;
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
  kgooseConfigured = false,
  kgooseConfigLoaded = true,
}: ResolveProfileCapabilitiesInput): ProfileCapabilityState {
  const capabilities = {} as ProfileCapabilityState;
  const runtimeConfigReady = runtimeConfigLoaded && runtimeConfig != null;

  for (const id of Object.keys(
    PROFILE_CAPABILITY_REGISTRY,
  ) as ProfileCapabilityId[]) {
    const source = PROFILE_CAPABILITY_REGISTRY[id];
    const kgooseAvailable =
      !source.requiresKgoose || !kgooseConfigLoaded || kgooseConfigured;

    if (source.kind === "buildFeature") {
      capabilities[id] =
        kgooseAvailable &&
        buildFeatures[source.feature] &&
        (!source.runtimeConfigSection ||
          !runtimeConfigReady ||
          runtimeConfig[source.runtimeConfigSection]?.enabled !== false) &&
        (!source.experiment ||
          isExperimentEnabled(experiments, source.experiment));
      continue;
    }

    if (source.kind === "runtimeFeature") {
      capabilities[id] =
        kgooseAvailable &&
        buildFeatures[source.feature] &&
        (!runtimeConfigReady ||
          runtimeConfig.featureToggles?.[source.toggle] !== false) &&
        (!source.experiment ||
          isExperimentEnabled(experiments, source.experiment));
      continue;
    }

    capabilities[id] =
      kgooseAvailable &&
      (!runtimeConfigReady || runtimeConfig[source.field]?.enabled !== false);
  }

  return capabilities;
}

export function getProfileCapabilitySnapshot(id: ProfileCapabilityId): boolean {
  const runtimeState = useRuntimeConfigStore.getState();
  const distroState = useDistroStore.getState();
  return resolveProfileCapabilities({
    buildFeatures: getBuildFeatureState(),
    runtimeConfig: runtimeState.config,
    runtimeConfigLoaded: runtimeState.loaded,
    kgooseConfigured: distroState.manifest.kgooseConfigured,
    kgooseConfigLoaded: distroState.loaded,
  })[id];
}

export function useProfileCapabilities(): ProfileCapabilityState {
  const experiments = useExperimentList();
  const runtimeConfig = useRuntimeConfigStore((state) => state.config);
  const runtimeConfigLoaded = useRuntimeConfigStore((state) => state.loaded);
  const kgooseConfigured = useDistroStore(
    (state) => state.manifest.kgooseConfigured,
  );
  const kgooseConfigLoaded = useDistroStore((state) => state.loaded);

  return useMemo(
    () =>
      resolveProfileCapabilities({
        buildFeatures: getBuildFeatureState(),
        experiments,
        runtimeConfig,
        runtimeConfigLoaded,
        kgooseConfigured,
        kgooseConfigLoaded,
      }),
    [
      runtimeConfig,
      runtimeConfigLoaded,
      kgooseConfigured,
      kgooseConfigLoaded,
      experiments,
    ],
  );
}

export function useProfileCapability(id: ProfileCapabilityId): boolean {
  return useProfileCapabilities()[id];
}

import { describe, expect, it } from "vitest";

import {
  BUILDERBOT_SURFACE_EXPERIMENT_ID,
  VOICE_CONVERSATION_EXPERIMENT_ID,
} from "@/features/experiments/experimentDefinitions";
import {
  PROFILE_CAPABILITY_REGISTRY,
  resolveProfileCapabilities,
  type ProfileCapabilityState,
} from "./capabilities";
import type { BuildFeature } from "./buildProfile";
import {
  PROFILE_RUNTIME_FEATURE_TOGGLE_KEYS,
  RUNTIME_FEATURE_TOGGLE_KEYS,
} from "./runtimeFeatureToggles";
import {
  DEFAULT_RUNTIME_CONFIG,
  type RuntimeConfig,
} from "@/shared/runtime-config/schema";

const enabledBuildFeatures: Record<BuildFeature, boolean> = {
  authGate: false,
  agentTools: true,
  automations: true,
  builderbot: true,
  byoKeyProviders: false,
  feedback: true,
  feedbackSurveys: true,
  managedConnections: true,
  skillDiscovery: true,
  telemetry: true,
  telemetryEnforced: false,
  voiceConversation: true,
  voiceDictation: true,
  securityMl: true,
  updater: true,
};

const readyRuntimeConfig = {
  ...DEFAULT_RUNTIME_CONFIG,
  kgoose: { baseUrl: "https://kgoose.example.test" },
} satisfies RuntimeConfig;

function resolve(
  input: Partial<Parameters<typeof resolveProfileCapabilities>[0]> = {},
): ProfileCapabilityState {
  return resolveProfileCapabilities({
    buildFeatures: enabledBuildFeatures,
    experiments: [],
    runtimeConfig: readyRuntimeConfig,
    kgooseConfigured: true,
    ...input,
  });
}

describe("profile capabilities", () => {
  it("disables build-backed capabilities when their build feature is false", () => {
    expect(
      resolve({
        buildFeatures: {
          ...enabledBuildFeatures,
          automations: false,
          agentTools: false,
          telemetry: false,
          updater: false,
        },
      }),
    ).toMatchObject({
      automations: false,
      agentTools: false,
      telemetry: false,
      updates: false,
    });
  });

  it("enables builderbot only when runtime config, build feature, and experiment are enabled", () => {
    expect(
      resolve({
        experiments: [{ id: BUILDERBOT_SURFACE_EXPERIMENT_ID, enabled: true }],
      }).builderbot,
    ).toBe(true);

    expect(
      resolve({
        buildFeatures: {
          ...enabledBuildFeatures,
          builderbot: false,
        },
        experiments: [{ id: BUILDERBOT_SURFACE_EXPERIMENT_ID, enabled: true }],
      }).builderbot,
    ).toBe(false);

    expect(
      resolve({
        experiments: [{ id: BUILDERBOT_SURFACE_EXPERIMENT_ID, enabled: false }],
      }).builderbot,
    ).toBe(false);
  });

  it("AND-gates voice dictation across its build feature and runtime toggle", () => {
    // Both build feature and runtime toggle allow it -> enabled.
    expect(resolve().voiceDictation).toBe(true);

    // Build feature off -> disabled regardless of runtime config.
    expect(
      resolve({
        buildFeatures: {
          ...enabledBuildFeatures,
          voiceDictation: false,
        },
      }).voiceDictation,
    ).toBe(false);

    // Runtime toggle off -> disabled even with the build feature on.
    expect(
      resolve({
        runtimeConfig: {
          ...DEFAULT_RUNTIME_CONFIG,
          featureToggles: { voiceDictation: false },
        },
      }).voiceDictation,
    ).toBe(false);

    // Runtime config not yet loaded -> safe default of enabled (build feature
    // is the no-flicker gate; runtime toggle is for the future endpoint).
    expect(
      resolve({
        runtimeConfigLoaded: true,
        runtimeConfig: null,
      }).voiceDictation,
    ).toBe(true);
  });

  it("exposes native voice settings only when its experiment is enabled", () => {
    expect(resolve().voiceConversation).toBe(false);
    expect(
      resolve({
        experiments: [{ id: VOICE_CONVERSATION_EXPERIMENT_ID, enabled: true }],
      }).voiceConversation,
    ).toBe(true);
    expect(
      resolve({
        buildFeatures: {
          ...enabledBuildFeatures,
          voiceDictation: false,
        },
        experiments: [{ id: VOICE_CONVERSATION_EXPERIMENT_ID, enabled: true }],
      }).voiceConversation,
    ).toBe(true);
  });

  it("AND-gates telemetry across its build feature and runtime toggle", () => {
    // Both build feature and runtime toggle allow it -> enabled.
    expect(resolve().telemetry).toBe(true);

    // Build feature off -> disabled regardless of runtime config.
    expect(
      resolve({
        buildFeatures: {
          ...enabledBuildFeatures,
          telemetry: false,
        },
      }).telemetry,
    ).toBe(false);

    // Runtime toggle off -> disabled even with the build feature on.
    expect(
      resolve({
        runtimeConfig: {
          ...DEFAULT_RUNTIME_CONFIG,
          featureToggles: { telemetry: false },
        },
      }).telemetry,
    ).toBe(false);

    // Runtime config not yet loaded -> safe default of enabled (build feature
    // is the no-flicker gate; runtime toggle is for the future endpoint).
    expect(
      resolve({
        runtimeConfigLoaded: true,
        runtimeConfig: null,
      }).telemetry,
    ).toBe(true);
  });

  it("AND-gates managedConnections across its build feature and runtime toggle", () => {
    // Both build feature and runtime toggle allow it -> enabled.
    expect(resolve().managedConnections).toBe(true);

    // Build feature off -> disabled regardless of runtime config (build-time is
    // the hard floor: a gated build can never be turned back on by config).
    expect(
      resolve({
        buildFeatures: {
          ...enabledBuildFeatures,
          managedConnections: false,
        },
      }).managedConnections,
    ).toBe(false);

    // Runtime toggle off -> disabled even with the build feature on.
    expect(
      resolve({
        runtimeConfig: {
          ...DEFAULT_RUNTIME_CONFIG,
          featureToggles: { kgooseConnections: false },
        },
      }).managedConnections,
    ).toBe(false);

    // Runtime config not yet loaded -> safe default of enabled (build feature
    // is the no-flicker gate; runtime toggle is for the future endpoint).
    expect(
      resolve({
        runtimeConfigLoaded: true,
        runtimeConfig: null,
      }).managedConnections,
    ).toBe(true);
  });

  it("fails Kgoose-backed capabilities closed after config sources load without an endpoint", () => {
    expect(
      resolve({
        kgooseConfigured: false,
        runtimeConfig: DEFAULT_RUNTIME_CONFIG,
        experiments: [{ id: VOICE_CONVERSATION_EXPERIMENT_ID, enabled: true }],
      }),
    ).toMatchObject({
      automations: false,
      voiceDictation: false,
      voiceConversation: true,
      managedConnections: false,
      feedback: false,
      feedbackSurveys: true,
      agentTools: true,
      telemetry: true,
      doctor: true,
    });
  });

  it("does not gate native voice conversation on Kgoose configuration", () => {
    expect(
      resolve({
        kgooseConfigured: false,
        runtimeConfig: DEFAULT_RUNTIME_CONFIG,
        experiments: [{ id: VOICE_CONVERSATION_EXPERIMENT_ID, enabled: true }],
      }).voiceConversation,
    ).toBe(true);
  });

  it("keeps feedback surveys independent of Kgoose issue feedback", () => {
    expect(
      resolve({
        kgooseConfigured: false,
        runtimeConfig: {
          ...DEFAULT_RUNTIME_CONFIG,
          feedback: { enabled: false, responseRatingEnabled: true },
        },
      }),
    ).toMatchObject({
      feedback: false,
      feedbackSurveys: true,
    });

    expect(
      resolve({
        buildFeatures: {
          ...enabledBuildFeatures,
          feedbackSurveys: false,
        },
      }).feedbackSurveys,
    ).toBe(false);
  });

  it("enables Kgoose-backed capabilities for an explicit distro or environment endpoint", () => {
    expect(
      resolve({
        kgooseConfigured: true,
        runtimeConfig: {
          ...DEFAULT_RUNTIME_CONFIG,
          kgoose: undefined,
        },
        experiments: [{ id: VOICE_CONVERSATION_EXPERIMENT_ID, enabled: true }],
      }),
    ).toMatchObject({
      automations: true,
      voiceDictation: true,
      voiceConversation: true,
      managedConnections: true,
      feedback: true,
    });
  });

  it("enables Kgoose-backed capabilities for an explicit runtime endpoint", () => {
    expect(
      resolve({
        kgooseConfigured: true,
        runtimeConfig: {
          ...DEFAULT_RUNTIME_CONFIG,
          kgoose: { baseUrl: "https://runtime.example.test/" },
        },
        experiments: [{ id: VOICE_CONVERSATION_EXPERIMENT_ID, enabled: true }],
      }),
    ).toMatchObject({
      automations: true,
      voiceDictation: true,
      voiceConversation: true,
      managedConnections: true,
      feedback: true,
    });
  });

  it("does not infer configuration from malformed runtime kgoose values", () => {
    for (const kgoose of [
      { baseUrl: "not a URL" },
      { baseUrl: "https://runtime.example.test/", path: "   " },
    ]) {
      expect(
        resolve({
          kgooseConfigured: false,
          runtimeConfig: {
            ...DEFAULT_RUNTIME_CONFIG,
            kgoose,
          },
        }),
      ).toMatchObject({
        automations: false,
        voiceDictation: false,
        managedConnections: false,
        feedback: false,
      });
    }
  });

  it("preserves build defaults until Kgoose configuration finishes loading", () => {
    expect(
      resolve({
        kgooseConfigLoaded: false,
        kgooseConfigured: false,
      }).voiceDictation,
    ).toBe(true);
  });

  it("does not let endpoint presence override runtime or build gates", () => {
    expect(
      resolve({
        runtimeConfig: {
          ...readyRuntimeConfig,
          featureToggles: {
            voiceDictation: false,
            kgooseConnections: false,
          },
          feedback: { enabled: false },
        },
      }),
    ).toMatchObject({
      voiceDictation: false,
      managedConnections: false,
      feedback: false,
    });
  });

  it("defaults runtime config capabilities to enabled when fields are absent", () => {
    expect(resolve()).toMatchObject({
      automations: true,
      agentTools: true,
      feedback: true,
      doctor: true,
    });
  });

  it("uses safe default capabilities while runtime config is unavailable", () => {
    expect(
      resolve({
        runtimeConfigLoaded: true,
        runtimeConfig: null,
      }),
    ).toMatchObject({
      automations: true,
      builderbot: false,
      agentTools: true,
      telemetry: true,
      feedback: true,
      doctor: true,
    });
  });

  it("disables runtime-backed feature capabilities when runtime feature toggles disable them", () => {
    expect(
      resolve({
        experiments: [{ id: BUILDERBOT_SURFACE_EXPERIMENT_ID, enabled: true }],
        runtimeConfig: {
          ...DEFAULT_RUNTIME_CONFIG,
          featureToggles: {
            agentToolsTip: false,
            automations: false,
            builderbot: false,
          },
        },
      }),
    ).toMatchObject({
      agentTools: false,
      automations: false,
      builderbot: false,
      telemetry: true,
    });
  });

  it("keeps profile runtime toggle keys in sync with the registry's runtime toggles", () => {
    // The build-time runtime-config validator rejects custom-build
    // featureToggles keys outside RUNTIME_FEATURE_TOGGLE_KEYS, so the profile
    // toggle subset must stay exactly the toggles the registry actually
    // consults — otherwise a newly added runtime toggle would be wrongly
    // rejected, or a removed one wrongly accepted.
    const registryToggles = Object.values(PROFILE_CAPABILITY_REGISTRY)
      .filter((source) => source.kind === "runtimeFeature")
      .map((source) => source.toggle);

    expect([...PROFILE_RUNTIME_FEATURE_TOGGLE_KEYS].sort()).toEqual(
      [...new Set(registryToggles)].sort(),
    );
  });

  it("keeps non-profile runtime toggle keys explicit for strict validation", () => {
    const profileToggles = new Set<string>(PROFILE_RUNTIME_FEATURE_TOGGLE_KEYS);
    const nonProfileToggles = RUNTIME_FEATURE_TOGGLE_KEYS.filter(
      (key) => !profileToggles.has(key),
    );

    expect(nonProfileToggles).toEqual(["costTracking"]);
  });

  it("disables feedback and doctor when runtime config disables them", () => {
    expect(
      resolve({
        runtimeConfig: {
          ...DEFAULT_RUNTIME_CONFIG,
          feedback: { enabled: false },
          doctor: { enabled: false },
        },
      }),
    ).toMatchObject({
      feedback: false,
      doctor: false,
    });
  });
});

import { describe, expect, it } from "vitest";

import { BUILDERBOT_SURFACE_EXPERIMENT_ID } from "@/features/experiments/experimentDefinitions";
import {
  resolveProfileCapabilities,
  type ProfileCapabilityState,
} from "./capabilities";
import type { BuildFeature } from "./buildProfile";
import type { RuntimeConfig } from "@/shared/runtime-config/schema";

const enabledBuildFeatures: Record<BuildFeature, boolean> = {
  agentToolsTip: true,
  automations: true,
  builderbot: true,
  telemetry: true,
};

const readyRuntimeConfig = {
  schemaVersion: 1,
} satisfies RuntimeConfig;

function resolve(
  input: Partial<Parameters<typeof resolveProfileCapabilities>[0]> = {},
): ProfileCapabilityState {
  return resolveProfileCapabilities({
    buildFeatures: enabledBuildFeatures,
    experiments: [],
    runtimeConfig: readyRuntimeConfig,
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
          agentToolsTip: false,
          telemetry: false,
        },
      }),
    ).toMatchObject({
      automations: false,
      agentToolsTip: false,
      telemetry: false,
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

  it("defaults runtime config capabilities to enabled when fields are absent", () => {
    expect(resolve()).toMatchObject({
      automations: true,
      agentToolsTip: true,
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
      agentToolsTip: true,
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
          schemaVersion: 1,
          featureToggles: {
            agentToolsTip: false,
            automations: false,
            builderbot: false,
          },
        },
      }),
    ).toMatchObject({
      agentToolsTip: false,
      automations: false,
      builderbot: false,
      telemetry: true,
    });
  });

  it("disables feedback and doctor when runtime config disables them", () => {
    expect(
      resolve({
        runtimeConfig: {
          schemaVersion: 1,
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

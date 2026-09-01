import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { getBuildFeatureState } from "./buildProfile";

describe("buildProfile", () => {
  beforeEach(() => {
    // Feature env stubs from other files share the worker's import.meta.env.
    // Every case in this suite begins from the real public-build default.
    vi.unstubAllEnvs();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it("defaults distribution-specific product families off", () => {
    expect(getBuildFeatureState()).toEqual({
      authGate: false,
      agentTools: false,
      automations: false,
      builderbot: false,
      byoKeyProviders: true,
      feedback: false,
      feedbackSurveys: false,
      managedConnections: false,
      skillDiscovery: false,
      telemetry: true,
      telemetryEnforced: false,
      voiceConversation: true,
      voiceDictation: false,
      securityMl: false,
      updater: true,
    });
  });

  it.each([
    ["VITE_AGENT_TOOLS", "agentTools"],
    ["VITE_AUTOMATIONS", "automations"],
    ["VITE_BUILDERBOT", "builderbot"],
    ["VITE_FEEDBACK_SURVEYS", "feedbackSurveys"],
    ["VITE_MANAGED_CONNECTIONS", "managedConnections"],
    ["VITE_SKILL_DISCOVERY", "skillDiscovery"],
    ["VITE_VOICE_DICTATION", "voiceDictation"],
  ] as const)("enables %s independently", async (env, feature) => {
    vi.resetModules();
    vi.stubEnv(env, "1");
    const { getBuildFeatureState: fresh } = await import("./buildProfile");
    const enabled = fresh();
    expect(enabled[feature]).toBe(true);
    for (const other of [
      "agentTools",
      "automations",
      "builderbot",
      "feedback",
      "feedbackSurveys",
      "managedConnections",
      "skillDiscovery",
      "voiceDictation",
    ] as const) {
      if (other !== feature) expect(enabled[other]).toBe(false);
    }
  });

  it("keeps VITE_FEEDBACK as the compatibility opt-in for issue feedback and surveys", async () => {
    vi.resetModules();
    vi.stubEnv("VITE_FEEDBACK", "1");
    const { getBuildFeatureState: fresh } = await import("./buildProfile");

    expect(fresh()).toMatchObject({
      feedback: true,
      feedbackSurveys: true,
    });
  });

  it("disables bring-your-own-key providers when VITE_BYO_KEY_PROVIDERS is 0 (inverse-positive default-on)", async () => {
    vi.resetModules();
    vi.stubEnv("VITE_BYO_KEY_PROVIDERS", "0");

    const { getBuildFeatureState: getFreshBuildFeatureState } = await import(
      "./buildProfile"
    );

    expect(getFreshBuildFeatureState().byoKeyProviders).toBe(false);
  });

  it("keeps bring-your-own-key providers on for any VITE_BYO_KEY_PROVIDERS value other than 0", async () => {
    vi.resetModules();
    vi.stubEnv("VITE_BYO_KEY_PROVIDERS", "true");

    const { getBuildFeatureState: getFreshBuildFeatureState } = await import(
      "./buildProfile"
    );

    expect(getFreshBuildFeatureState().byoKeyProviders).toBe(true);
  });

  it("disables telemetry when VITE_TELEMETRY is set to 0 (inverse-positive default-on)", async () => {
    vi.resetModules();
    vi.stubEnv("VITE_TELEMETRY", "0");

    const { getBuildFeatureState: getFreshBuildFeatureState } = await import(
      "./buildProfile"
    );

    expect(getFreshBuildFeatureState().telemetry).toBe(false);
  });

  it("keeps telemetry on for any VITE_TELEMETRY value other than 0", async () => {
    vi.resetModules();
    vi.stubEnv("VITE_TELEMETRY", "1");

    const { getBuildFeatureState: getFreshBuildFeatureState } = await import(
      "./buildProfile"
    );

    expect(getFreshBuildFeatureState().telemetry).toBe(true);
  });

  it("enforces telemetry consent only when VITE_TELEMETRY_ENFORCED is exactly 1", async () => {
    vi.resetModules();
    vi.stubEnv("VITE_TELEMETRY_ENFORCED", "1");
    const { getBuildFeatureState: enforced } = await import("./buildProfile");
    expect(enforced().telemetryEnforced).toBe(true);

    vi.resetModules();
    vi.stubEnv("VITE_TELEMETRY_ENFORCED", "true");
    const { getBuildFeatureState: nonOptIn } = await import("./buildProfile");
    expect(nonOptIn().telemetryEnforced).toBe(false);
  });

  it("keeps skill discovery off unless VITE_SKILL_DISCOVERY is exactly 1", async () => {
    vi.resetModules();
    vi.stubEnv("VITE_SKILL_DISCOVERY", "true");

    const { getBuildFeatureState: nonOptIn } = await import("./buildProfile");
    expect(nonOptIn().skillDiscovery).toBe(false);
  });

  it("keeps managed connections off for a non-opt-in value", async () => {
    vi.resetModules();
    vi.stubEnv("VITE_MANAGED_CONNECTIONS", "0");

    const { getBuildFeatureState: getFreshBuildFeatureState } = await import(
      "./buildProfile"
    );

    expect(getFreshBuildFeatureState().managedConnections).toBe(false);
  });

  it("enables security ML only when VITE_SECURITY_ML is set to 1", async () => {
    vi.resetModules();
    vi.stubEnv("VITE_SECURITY_ML", "1");

    const { getBuildFeatureState: getFreshBuildFeatureState } = await import(
      "./buildProfile"
    );

    expect(getFreshBuildFeatureState().securityMl).toBe(true);
  });

  it("disables updater when VITE_UPDATER_ENABLED is false", async () => {
    vi.resetModules();
    vi.stubEnv("VITE_UPDATER_ENABLED", "false");

    const { getBuildFeatureState: getFreshBuildFeatureState } = await import(
      "./buildProfile"
    );

    expect(getFreshBuildFeatureState().updater).toBe(false);
  });

  it("keeps updater visible for explicit release builds", async () => {
    vi.resetModules();
    vi.stubEnv("VITE_UPDATER_ENABLED", "true");

    const { getBuildFeatureState: getFreshBuildFeatureState } = await import(
      "./buildProfile"
    );

    expect(getFreshBuildFeatureState().updater).toBe(true);
  });
});

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  filterExperimentRegistryForBuildProfile,
  getBuildFeatureState,
} from "./buildProfile";

const registry = [
  { id: "builderbot-surface", label: "Builderbot" },
  { id: "pane-jump-navigation", label: "Pane jump" },
  { id: "transcript-virtual-renderer", label: "Virtual transcript" },
] as const;

describe("buildProfile", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it("enables generic bundled app build features", () => {
    expect(getBuildFeatureState()).toEqual({
      authGate: false,
      agentToolsTip: true,
      automations: true,
      builderbot: true,
      telemetry: true,
      voiceDictation: true,
      kgooseConnections: true,
      updater: true,
    });
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

  it("disables kgooseConnections when VITE_KGOOSE_CONNECTIONS is set to 0 (inverse-positive default-on)", async () => {
    vi.resetModules();
    vi.stubEnv("VITE_KGOOSE_CONNECTIONS", "0");

    const { getBuildFeatureState: getFreshBuildFeatureState } = await import(
      "./buildProfile"
    );

    expect(getFreshBuildFeatureState().kgooseConnections).toBe(false);
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

  it("keeps every registered experiment for the single app build", () => {
    expect(filterExperimentRegistryForBuildProfile(registry)).toBe(registry);
  });
});

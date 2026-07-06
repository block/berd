import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const getPlatformMock = vi.hoisted(() => vi.fn(() => "mac"));
vi.mock("@/shared/lib/platform", () => ({
  getPlatform: getPlatformMock,
}));

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
  beforeEach(() => {
    getPlatformMock.mockReturnValue("mac");
  });

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
      byoKeyProviders: false,
      telemetry: true,
      voiceDictation: true,
      kgooseConnections: true,
      securityMl: true,
      updater: true,
    });
  });

  it("enables bring-your-own-key providers only when VITE_BYO_KEY_PROVIDERS is 1 (default off)", async () => {
    vi.resetModules();
    vi.stubEnv("VITE_BYO_KEY_PROVIDERS", "1");

    const { getBuildFeatureState: getFreshBuildFeatureState } = await import(
      "./buildProfile"
    );

    expect(getFreshBuildFeatureState().byoKeyProviders).toBe(true);
  });

  it("keeps bring-your-own-key providers off for any VITE_BYO_KEY_PROVIDERS value other than 1", async () => {
    vi.resetModules();
    vi.stubEnv("VITE_BYO_KEY_PROVIDERS", "true");

    const { getBuildFeatureState: getFreshBuildFeatureState } = await import(
      "./buildProfile"
    );

    expect(getFreshBuildFeatureState().byoKeyProviders).toBe(false);
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

  it("disables security ML when VITE_SECURITY_ML is set to 0 (inverse-positive default-on)", async () => {
    vi.resetModules();
    vi.stubEnv("VITE_SECURITY_ML", "0");

    const { getBuildFeatureState: getFreshBuildFeatureState } = await import(
      "./buildProfile"
    );

    expect(getFreshBuildFeatureState().securityMl).toBe(false);
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

  it("filters platform-scoped experiments", () => {
    const platformRegistry = [
      { id: "general" },
      { id: "mac-only", platforms: ["mac"] },
      { id: "windows-only", platforms: ["windows"] },
    ] as const;

    expect(
      filterExperimentRegistryForBuildProfile(platformRegistry).map(
        (definition) => definition.id,
      ),
    ).toEqual(["general", "mac-only"]);

    getPlatformMock.mockReturnValue("windows");

    expect(
      filterExperimentRegistryForBuildProfile(platformRegistry).map(
        (definition) => definition.id,
      ),
    ).toEqual(["general", "windows-only"]);
  });
});

import { describe, expect, it } from "vitest";

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
  it("enables generic bundled app build features", () => {
    expect(getBuildFeatureState()).toEqual({
      agentToolsTip: true,
      automations: true,
      builderbot: true,
      telemetry: true,
    });
  });

  it("keeps every registered experiment for the single app build", () => {
    expect(filterExperimentRegistryForBuildProfile(registry)).toBe(registry);
  });
});

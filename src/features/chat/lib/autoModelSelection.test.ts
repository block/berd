import { beforeEach, describe, expect, it } from "vitest";
import { useRuntimeConfigStore } from "@/shared/runtime-config/runtimeConfigStore";
import {
  DEFAULT_RUNTIME_CONFIG,
  type RuntimeAutoRoutingConfig,
} from "@/shared/runtime-config/schema";
import { getAutoModeExecutionTarget } from "./autoModelSelection";

function routingSnapshot(
  modelProviderId: string,
  modelId: string,
): RuntimeAutoRoutingConfig {
  return {
    url: "https://router.example",
    defaultModeId: "balanced",
    modes: [
      {
        id: "balanced",
        displayName: "Auto Balanced",
        modelProviderId,
        fallback: { modelId, effort: "medium" },
        models: [
          {
            modelId,
            routerModel: `router-${modelId}`,
            harness: "candidate-harness",
          },
        ],
      },
    ],
  };
}

function setLiveRouting(autoRouting: RuntimeAutoRoutingConfig) {
  useRuntimeConfigStore.setState({
    config: {
      ...DEFAULT_RUNTIME_CONFIG,
      goose: { ...DEFAULT_RUNTIME_CONFIG.goose, autoRouting },
    },
  });
}

describe("getAutoModeExecutionTarget", () => {
  beforeEach(() => {
    setLiveRouting(routingSnapshot("provider-b", "fallback-b"));
  });

  it("derives captured snapshot A while the live store contains B", () => {
    const autoRouting = routingSnapshot("provider-a", "fallback-a");
    expect(getAutoModeExecutionTarget("balanced", { autoRouting })).toEqual({
      harnessId: "goose",
      modelProviderId: "provider-a",
      modelId: "fallback-a",
      modelName: "fallback-a",
    });
    expect(useRuntimeConfigStore.getState().config.goose.autoRouting).not.toBe(
      autoRouting,
    );
    expect(getAutoModeExecutionTarget("balanced")).toEqual({
      harnessId: "goose",
      modelProviderId: "provider-b",
      modelId: "fallback-b",
      modelName: "fallback-b",
    });
  });

  it("keeps the GUI default bound to the current live routing", () => {
    setLiveRouting(routingSnapshot("provider-c", "fallback-c"));
    expect(getAutoModeExecutionTarget("balanced")).toEqual({
      harnessId: "goose",
      modelProviderId: "provider-c",
      modelId: "fallback-c",
      modelName: "fallback-c",
    });
  });

  it.each([
    undefined,
    null,
    "missing",
  ])("does not infer a mode for %s", (modeId) => {
    expect(getAutoModeExecutionTarget(modeId)).toBeUndefined();
    expect(
      getAutoModeExecutionTarget(modeId, {
        autoRouting: routingSnapshot("provider-a", "fallback-a"),
      }),
    ).toBeUndefined();
  });

  it("does not fall back to live routing when the captured routing is absent", () => {
    expect(
      getAutoModeExecutionTarget("balanced", { autoRouting: undefined }),
    ).toBeUndefined();
    expect(
      getAutoModeExecutionTarget("balanced", {
        autoRouting: { url: "https://router.example", modes: [] },
      }),
    ).toBeUndefined();
  });
});

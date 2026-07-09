import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_RUNTIME_CONFIG } from "@/shared/runtime-config/schema";
import { useRuntimeConfigStore } from "@/shared/runtime-config/runtimeConfigStore";
import type { ProviderCatalogEntry } from "@/shared/types/providers";
import { useProviderCatalogStore } from "../stores/providerCatalogStore";
import { useProviderModelCacheStore } from "../stores/providerModelCacheStore";
import { useProviderModels } from "./useProviderModels";

vi.mock("@/shared/profile/buildProfile", () => ({
  getBuildFeatureState: () => ({
    authGate: false,
    agentToolsTip: true,
    automations: true,
    builderbot: true,
    byoKeyProviders: true,
    kgooseConnections: true,
    telemetry: true,
    updater: true,
    voiceDictation: true,
  }),
}));

function modelProvider(
  id: string,
  fields?: ProviderCatalogEntry["fields"],
): ProviderCatalogEntry {
  return {
    id,
    displayName: id,
    category: "model",
    description: id,
    setupMethod: fields ? "config_fields" : "none",
    group: "default",
    fields,
  };
}

describe("useProviderModels", () => {
  beforeEach(() => {
    useProviderCatalogStore.getState().reset();
    useRuntimeConfigStore.setState({
      loaded: true,
      config: DEFAULT_RUNTIME_CONFIG,
      result: {
        status: "ready",
        source: "appDefault",
        config: DEFAULT_RUNTIME_CONFIG,
      },
    });
    useProviderModelCacheStore.setState({
      providers: new Map(),
      refreshingProviderIds: new Set(),
      runtimeManagedProviderIds: new Set(),
    });
  });

  it("recomputes configured and refreshable model providers when the catalog changes", () => {
    const { result } = renderHook(() => useProviderModels());

    expect(result.current.configuredModelProviderIds).toEqual([
      "databricks_v2",
    ]);
    expect(result.current.modelCacheRefreshProviderIds).toEqual([
      "databricks_v2",
      "claude-acp",
      "codex-acp",
      "copilot-acp",
      "cursor-agent",
    ]);

    act(() => {
      useProviderCatalogStore.getState().mergeEntries([
        modelProvider("anthropic", [
          {
            key: "ANTHROPIC_API_KEY",
            label: "API Key",
            secret: true,
            required: true,
          },
        ]),
      ]);
    });

    expect(result.current.configuredModelProviderIds).toEqual([
      "databricks_v2",
      "anthropic",
    ]);
    expect(result.current.modelCacheRefreshProviderIds).toEqual([
      "databricks_v2",
      "anthropic",
      "claude-acp",
      "codex-acp",
      "copilot-acp",
      "cursor-agent",
    ]);

    act(() => {
      useProviderCatalogStore.getState().mergeEntries([
        {
          ...modelProvider("custom-openrouter"),
          displayName: "OpenRouter",
          group: "additional",
          customProvider: true,
        },
      ]);
    });

    expect(result.current.configuredModelProviderIds).toEqual([
      "databricks_v2",
      "anthropic",
      "custom-openrouter",
    ]);
    expect(result.current.modelCacheRefreshProviderIds).toContain(
      "custom-openrouter",
    );
  });
});

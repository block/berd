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
    agentTools: true,
    automations: true,
    builderbot: true,
    byoKeyProviders: true,
    managedConnections: true,
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
    catalogSource: "setup",
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

  it("does not refresh unconfigured first-class providers from the picker", () => {
    useProviderCatalogStore.getState().mergeEntries([
      {
        ...modelProvider("github_copilot"),
        nativeConnectQuery: "GitHub Copilot",
      },
    ]);

    const { result } = renderHook(() => useProviderModels());

    expect(result.current.configuredModelProviderIds).toContain(
      "github_copilot",
    );
    expect(result.current.modelCacheRefreshProviderIds).not.toContain(
      "github_copilot",
    );
  });

  it("reacts when a provisional model inventory becomes authoritative", () => {
    const models = [
      {
        id: "goose-gpt-5-5",
        name: "GPT-5.5",
        providerId: "databricks_v2",
      },
    ];
    useProviderModelCacheStore.setState({
      providers: new Map([
        [
          "databricks_v2",
          { providerId: "databricks_v2", models, fetchedAt: 0 },
        ],
      ]),
    });
    const { result } = renderHook(() => useProviderModels());

    expect(result.current.isModelInventoryAuthoritative("databricks_v2")).toBe(
      false,
    );

    act(() => {
      useProviderModelCacheStore.setState({
        providers: new Map([
          [
            "databricks_v2",
            {
              providerId: "databricks_v2",
              models,
              fetchedAt: Date.now(),
            },
          ],
        ]),
      });
    });

    expect(result.current.isModelInventoryAuthoritative("databricks_v2")).toBe(
      true,
    );
  });

  it("recomputes configured and refreshable model providers when the catalog changes", () => {
    const { result } = renderHook(() => useProviderModels());

    expect(result.current.configuredModelProviderIds).toEqual([
      "databricks_v2",
    ]);
    expect(result.current.modelCacheRefreshProviderIds).toEqual([
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

  it("keeps provider-local recommendations out of the Goose curated shortlist", () => {
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
    useProviderModelCacheStore.setState({
      providers: new Map([
        [
          "databricks_v2",
          {
            providerId: "databricks_v2",
            fetchedAt: Date.now(),
            models: [
              {
                id: "goose-gpt-5-6-sol",
                name: "GPT-5.6 Sol",
                providerId: "databricks_v2",
                recommended: true,
                featured: true,
              },
            ],
          },
        ],
        [
          "anthropic",
          {
            providerId: "anthropic",
            fetchedAt: Date.now(),
            models: [
              {
                id: "claude-opus-5",
                name: "Claude Opus 5",
                providerId: "anthropic",
                recommended: true,
                featured: true,
              },
            ],
          },
        ],
      ]),
    });

    const { result } = renderHook(() => useProviderModels());

    expect(result.current.getModelsForAgent("goose")).toEqual([
      expect.objectContaining({
        id: "goose-gpt-5-6-sol",
        recommended: true,
        featured: true,
      }),
      expect.objectContaining({
        id: "claude-opus-5",
        recommended: false,
        featured: false,
      }),
    ]);
    expect(result.current.getModelsForProvider("anthropic")).toEqual([
      expect.objectContaining({
        id: "claude-opus-5",
        recommended: true,
        featured: true,
      }),
    ]);
  });

  it("keeps only explicitly curated models recommended for refreshable runtime providers", () => {
    const runtimeConfig = {
      ...DEFAULT_RUNTIME_CONFIG,
      goose: {
        ...DEFAULT_RUNTIME_CONFIG.goose,
        modelProviders: [
          ...DEFAULT_RUNTIME_CONFIG.goose.modelProviders,
          {
            id: "openai",
            displayName: "OpenAI",
            modelInventoryMode: "refreshable" as const,
            models: [
              {
                id: "gpt-curated",
                name: "GPT Curated",
                recommended: true,
                featured: true,
              },
            ],
          },
        ],
      },
    };
    useRuntimeConfigStore.setState({
      loaded: true,
      config: runtimeConfig,
      result: {
        status: "ready",
        source: "fakeEndpoint",
        config: runtimeConfig,
      },
    });
    useProviderCatalogStore.getState().mergeEntries([modelProvider("openai")]);
    useProviderModelCacheStore.setState({
      providers: new Map([
        [
          "openai",
          {
            providerId: "openai",
            fetchedAt: Date.now(),
            models: [
              {
                id: "gpt-curated",
                name: "GPT Curated",
                providerId: "openai",
                recommended: true,
                featured: true,
              },
              {
                id: "gpt-discovered",
                name: "GPT Discovered",
                providerId: "openai",
                recommended: true,
                featured: true,
              },
            ],
          },
        ],
      ]),
    });

    const { result } = renderHook(() => useProviderModels());

    expect(result.current.getModelsForAgent("goose")).toEqual([
      expect.objectContaining({
        id: "gpt-curated",
        recommended: true,
        featured: true,
      }),
      expect.objectContaining({
        id: "gpt-discovered",
        recommended: false,
        featured: false,
      }),
    ]);
  });
});

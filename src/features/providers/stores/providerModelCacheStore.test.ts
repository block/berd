import { waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ModelOption } from "@/features/chat/types";
import {
  DEFAULT_RUNTIME_CONFIG,
  type RuntimeConfig,
} from "@/shared/runtime-config/schema";
import { useRuntimeConfigStore } from "@/shared/runtime-config/runtimeConfigStore";
import { useProviderModelCacheStore } from "./providerModelCacheStore";

const mocks = vi.hoisted(() => ({
  getClient: vi.fn(),
  supportedModelsList: vi.fn(),
}));

vi.mock("@/shared/api/acpConnection", () => ({
  getClient: () => mocks.getClient(),
}));

function seededModel(overrides: Partial<ModelOption> = {}): ModelOption {
  return {
    id: "seeded-model",
    name: "Seeded model",
    displayName: "Seeded model",
    providerId: "databricks_v2",
    providerName: "Databricks",
    recommended: false,
    featured: false,
    ...overrides,
  };
}

describe("providerModelCacheStore", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    window.localStorage.clear();
    useProviderModelCacheStore.setState({
      providers: new Map(),
      refreshingProviderIds: new Set(),
      runtimeManagedProviderIds: new Set(),
    });
    useRuntimeConfigStore.setState({ config: DEFAULT_RUNTIME_CONFIG });
    mocks.getClient.mockResolvedValue({
      goose: {
        GooseUnstableProvidersSupportedModelsList: mocks.supportedModelsList,
      },
    });
  });

  it("seeds runtime models as authoritative runtime-managed entries", async () => {
    const model = seededModel({
      contextLimit: 128000,
      recommended: true,
      featured: true,
      sortOrder: 0,
    });

    useProviderModelCacheStore
      .getState()
      .seedRuntimeModels(new Map([["databricks_v2", [model]]]));
    await useProviderModelCacheStore
      .getState()
      .refreshAllModelProviders(["databricks_v2"]);
    await useProviderModelCacheStore
      .getState()
      .refreshProviderModels("databricks_v2", { force: true });

    const entry = useProviderModelCacheStore
      .getState()
      .providers.get("databricks_v2");
    expect(entry?.runtimeManaged).toBe(true);
    expect(
      useProviderModelCacheStore
        .getState()
        .getModelsForProvider("databricks_v2"),
    ).toEqual([model]);
    expect(mocks.supportedModelsList).not.toHaveBeenCalled();
  });

  it("preserves runtime-managed models after invalidation and forced refresh", async () => {
    const model = seededModel({
      contextLimit: 128000,
      recommended: true,
      featured: true,
      sortOrder: 0,
    });

    useProviderModelCacheStore
      .getState()
      .seedRuntimeModels(new Map([["databricks_v2", [model]]]));
    useProviderModelCacheStore.getState().invalidateProvider("databricks_v2");

    await useProviderModelCacheStore
      .getState()
      .refreshProviderModels("databricks_v2", { force: true });

    const entry = useProviderModelCacheStore
      .getState()
      .providers.get("databricks_v2");
    expect(entry?.runtimeManaged).toBe(true);
    expect(
      useProviderModelCacheStore
        .getState()
        .getModelsForProvider("databricks_v2"),
    ).toEqual([model]);
    expect(mocks.supportedModelsList).not.toHaveBeenCalled();
  });

  it("keeps refreshable runtime models provisional until discovery succeeds", async () => {
    const configuredModel = seededModel({ id: "goose-gpt-5-5" });
    useProviderModelCacheStore
      .getState()
      .seedRuntimeModels(new Map([["databricks_v2", [configuredModel]]]), {
        runtimeManagedProviderIds: new Set(),
      });

    expect(
      useProviderModelCacheStore
        .getState()
        .isModelInventoryAuthoritative("databricks_v2"),
    ).toBe(false);

    mocks.supportedModelsList.mockResolvedValueOnce({
      models: ["goose-gpt-5-5", "goose-claude-fable"],
    });
    await useProviderModelCacheStore
      .getState()
      .refreshProviderModels("databricks_v2");

    expect(
      useProviderModelCacheStore
        .getState()
        .isModelInventoryAuthoritative("databricks_v2"),
    ).toBe(true);
  });

  it.each([
    {
      label: "stale",
      fetchedAt: 1,
      force: false,
      error: undefined,
    },
    {
      label: "fresh forced with an error",
      fetchedAt: Date.now(),
      force: true,
      error: "authentication failed",
    },
    {
      label: "retryable with an error",
      fetchedAt: 0,
      force: false,
      error: "authentication failed",
    },
  ])("preserves a $label populated cache and retries after empty discovery", async ({
    fetchedAt,
    force,
    error,
  }) => {
    const cachedEntry = {
      providerId: "openrouter",
      models: [
        seededModel({
          providerId: "openrouter",
          providerName: "OpenRouter",
        }),
      ],
      fetchedAt,
      ...(error ? { error } : {}),
    };
    window.localStorage.setItem(
      "goose:providerModelCache:v2",
      JSON.stringify([cachedEntry]),
    );
    useProviderModelCacheStore.getState().loadPersisted();
    mocks.supportedModelsList
      .mockResolvedValueOnce({ models: [] })
      .mockResolvedValueOnce({ models: ["replacement-model"] });

    await useProviderModelCacheStore
      .getState()
      .refreshProviderModels("openrouter", { force });

    const retryableEntry = { ...cachedEntry, fetchedAt: 0 };
    delete retryableEntry.error;
    expect(
      useProviderModelCacheStore.getState().providers.get("openrouter"),
    ).toEqual(retryableEntry);
    expect(
      JSON.parse(
        window.localStorage.getItem("goose:providerModelCache:v2") ?? "[]",
      ),
    ).toEqual([retryableEntry]);
    expect(useProviderModelCacheStore.getState().getError("openrouter")).toBe(
      null,
    );

    await useProviderModelCacheStore
      .getState()
      .refreshProviderModels("openrouter");

    expect(mocks.supportedModelsList).toHaveBeenCalledTimes(2);
    expect(
      useProviderModelCacheStore
        .getState()
        .getModelsForProvider("openrouter")
        .map((model) => model.id),
    ).toEqual(["replacement-model"]);
  });

  it("keeps configured models provisional and retryable after empty discovery", async () => {
    const configuredModel = seededModel({
      providerId: "openrouter",
      providerName: "OpenRouter",
    });
    useProviderModelCacheStore
      .getState()
      .seedRuntimeModels(new Map([["openrouter", [configuredModel]]]), {
        runtimeManagedProviderIds: new Set(),
      });
    mocks.supportedModelsList
      .mockResolvedValueOnce({ models: [] })
      .mockResolvedValueOnce({ models: ["discovered-model"] });

    await useProviderModelCacheStore
      .getState()
      .refreshProviderModels("openrouter");

    const provisionalEntry = useProviderModelCacheStore
      .getState()
      .providers.get("openrouter");
    expect(provisionalEntry).toEqual({
      providerId: "openrouter",
      models: [configuredModel],
      configuredModels: [configuredModel],
      fetchedAt: 0,
    });
    expect(
      useProviderModelCacheStore
        .getState()
        .isModelInventoryAuthoritative("openrouter"),
    ).toBe(false);

    await useProviderModelCacheStore
      .getState()
      .refreshProviderModels("openrouter");

    expect(mocks.supportedModelsList).toHaveBeenCalledTimes(2);
    expect(
      useProviderModelCacheStore
        .getState()
        .getModelsForProvider("openrouter")
        .map((model) => model.id),
    ).toEqual(["discovered-model", configuredModel.id]);
  });

  it("retries after an empty refresh with no cached entry", async () => {
    mocks.supportedModelsList
      .mockResolvedValueOnce({ models: [] })
      .mockResolvedValueOnce({ models: ["openrouter-model"] });

    await useProviderModelCacheStore
      .getState()
      .refreshProviderModels("openrouter");
    expect(
      useProviderModelCacheStore.getState().providers.has("openrouter"),
    ).toBe(false);

    await useProviderModelCacheStore
      .getState()
      .refreshProviderModels("openrouter");

    expect(mocks.supportedModelsList).toHaveBeenCalledTimes(2);
    expect(
      useProviderModelCacheStore
        .getState()
        .getModelsForProvider("openrouter")
        .map((model) => model.id),
    ).toEqual(["openrouter-model"]);
  });

  it("ignores legacy fresh-empty cache entries", async () => {
    window.localStorage.setItem(
      "goose:providerModelCache:v1",
      JSON.stringify([
        {
          providerId: "openrouter",
          models: [],
          fetchedAt: Date.now(),
        },
      ]),
    );
    useProviderModelCacheStore.getState().loadPersisted();
    expect(
      useProviderModelCacheStore
        .getState()
        .isModelInventoryAuthoritative("openrouter"),
    ).toBe(false);
    mocks.supportedModelsList
      .mockResolvedValueOnce({ models: [] })
      .mockResolvedValueOnce({ models: ["openrouter-model"] });

    await useProviderModelCacheStore
      .getState()
      .refreshProviderModels("openrouter");

    expect(
      useProviderModelCacheStore
        .getState()
        .isModelInventoryAuthoritative("openrouter"),
    ).toBe(false);

    await useProviderModelCacheStore
      .getState()
      .refreshProviderModels("openrouter");

    expect(mocks.supportedModelsList).toHaveBeenCalledTimes(2);
    expect(
      useProviderModelCacheStore
        .getState()
        .getModelsForProvider("openrouter")
        .map((model) => model.id),
    ).toEqual(["openrouter-model"]);
  });

  it("applies the runtime model id prefix allowlist to discovery", async () => {
    const config: RuntimeConfig = {
      schemaVersion: 1,
      goose: {
        defaultModelProviderId: "databricks_v2",
        modelProviders: [
          {
            id: "databricks_v2",
            displayName: "Databricks",
            allowedModelIdPrefixes: ["goose-", "team.approved."],
            models: [],
          },
        ],
      },
    };
    useRuntimeConfigStore.setState({ config });
    mocks.supportedModelsList.mockResolvedValueOnce({
      models: [
        "goose-gpt-5-5",
        "team.approved.chat-model",
        "other.schema.chat-model",
      ],
    });

    await useProviderModelCacheStore
      .getState()
      .refreshProviderModels("databricks_v2");

    expect(
      useProviderModelCacheStore
        .getState()
        .getModelsForProvider("databricks_v2")
        .map((model) => model.id),
    ).toEqual(["goose-gpt-5-5", "team.approved.chat-model"]);
  });

  it("caches a successful inventory when every discovered model is filtered", async () => {
    const config: RuntimeConfig = {
      schemaVersion: 1,
      goose: {
        defaultModelProviderId: "databricks_v2",
        modelProviders: [
          {
            id: "databricks_v2",
            displayName: "Databricks",
            allowedModelIdPrefixes: ["goose-"],
            models: [],
          },
        ],
      },
    };
    useRuntimeConfigStore.setState({ config });
    mocks.supportedModelsList.mockResolvedValue({
      models: ["other.schema.chat-model"],
    });

    await useProviderModelCacheStore
      .getState()
      .refreshProviderModels("databricks_v2");
    await useProviderModelCacheStore
      .getState()
      .refreshProviderModels("databricks_v2");

    expect(mocks.supportedModelsList).toHaveBeenCalledTimes(1);
    expect(
      useProviderModelCacheStore
        .getState()
        .isModelInventoryAuthoritative("databricks_v2"),
    ).toBe(true);
    expect(
      useProviderModelCacheStore
        .getState()
        .getModelsForProvider("databricks_v2"),
    ).toEqual([]);
  });

  it("preserves bundled metadata while refreshing the available model list", async () => {
    const configuredModel = seededModel({
      id: "goose-gpt-5-6-sol",
      name: "GPT-5.6 Sol",
      displayName: "GPT-5.6 Sol",
      recommended: true,
      featured: true,
    });
    useProviderModelCacheStore
      .getState()
      .seedRuntimeModels(new Map([["databricks_v2", [configuredModel]]]), {
        runtimeManagedProviderIds: new Set(),
      });
    mocks.supportedModelsList.mockResolvedValueOnce({
      models: ["goose-gpt-5-5", "goose-gpt-5-6-sol", "goose-claude-opus-4"],
    });

    await useProviderModelCacheStore
      .getState()
      .refreshProviderModels("databricks_v2");

    expect(mocks.supportedModelsList).toHaveBeenCalledWith({
      providerId: "databricks_v2",
    });
    const models = useProviderModelCacheStore
      .getState()
      .getModelsForProvider("databricks_v2");
    expect(models).toHaveLength(3);
    expect(models.find((model) => model.id === "goose-gpt-5-5")).toEqual(
      expect.objectContaining({
        id: "goose-gpt-5-5",
        recommended: true,
        featured: false,
      }),
    );
    expect(models.find((model) => model.id === "goose-gpt-5-6-sol")).toEqual(
      expect.objectContaining(configuredModel),
    );
    expect(models.find((model) => model.id === "goose-claude-opus-4")).toEqual(
      expect.objectContaining({
        id: "goose-claude-opus-4",
        recommended: true,
        featured: false,
      }),
    );
  });

  it("keeps configured models that are missing from the provider model list", async () => {
    const configuredModel = seededModel({
      id: "goose-gpt-5-6-sol",
      name: "GPT-5.6 Sol",
      displayName: "GPT-5.6 Sol",
      recommended: true,
      featured: true,
    });
    useProviderModelCacheStore
      .getState()
      .seedRuntimeModels(new Map([["databricks_v2", [configuredModel]]]), {
        runtimeManagedProviderIds: new Set(),
      });
    mocks.supportedModelsList.mockResolvedValueOnce({
      models: ["goose-gpt-5-5"],
    });

    await useProviderModelCacheStore
      .getState()
      .refreshProviderModels("databricks_v2");

    const models = useProviderModelCacheStore
      .getState()
      .getModelsForProvider("databricks_v2");
    expect(models.map((model) => model.id)).toEqual([
      "goose-gpt-5-5",
      "goose-gpt-5-6-sol",
    ]);
    expect(models.find((model) => model.id === "goose-gpt-5-6-sol")).toEqual(
      expect.objectContaining(configuredModel),
    );
  });

  it("keeps configured models after a failed refresh and retry", async () => {
    const configuredModel = seededModel({
      id: "goose-gpt-5-6-sol",
      name: "GPT-5.6 Sol",
      displayName: "GPT-5.6 Sol",
      recommended: true,
    });
    useProviderModelCacheStore
      .getState()
      .seedRuntimeModels(new Map([["databricks_v2", [configuredModel]]]), {
        runtimeManagedProviderIds: new Set(),
      });
    mocks.supportedModelsList
      .mockRejectedValueOnce(new Error("not authenticated"))
      .mockResolvedValueOnce({ models: ["goose-gpt-5-5"] });

    await useProviderModelCacheStore
      .getState()
      .refreshProviderModels("databricks_v2");
    await useProviderModelCacheStore
      .getState()
      .refreshProviderModels("databricks_v2", { force: true });

    expect(
      useProviderModelCacheStore
        .getState()
        .getModelsForProvider("databricks_v2")
        .map((model) => model.id),
    ).toEqual(["goose-gpt-5-5", "goose-gpt-5-6-sol"]);
  });

  it("removes stale runtime-managed providers when runtime config changes", () => {
    const model = seededModel();

    useProviderModelCacheStore.getState().seedRuntimeModels(
      new Map([
        ["databricks_v2", [model]],
        [
          "block_openai_compatible",
          [
            {
              ...model,
              providerId: "block_openai_compatible",
              providerName: "Block AI Gateway",
            },
          ],
        ],
      ]),
    );
    useProviderModelCacheStore
      .getState()
      .seedRuntimeModels(new Map([["databricks_v2", [model]]]));

    expect(
      useProviderModelCacheStore
        .getState()
        .providers.has("block_openai_compatible"),
    ).toBe(false);
    expect(
      useProviderModelCacheStore.getState().providers.has("databricks_v2"),
    ).toBe(true);
  });

  it("runs a forced refresh after an in-flight refresh finishes", async () => {
    let rejectInitialRefresh!: (error: Error) => void;
    const initialRefresh = new Promise<{ models: string[] }>(
      (_resolve, reject) => {
        rejectInitialRefresh = reject;
      },
    );
    mocks.supportedModelsList
      .mockReturnValueOnce(initialRefresh)
      .mockResolvedValueOnce({
        models: ["goose-gpt-5-5"],
      });

    const firstRefreshPromise = useProviderModelCacheStore
      .getState()
      .refreshProviderModels("databricks_v2");

    await waitFor(() =>
      expect(mocks.supportedModelsList).toHaveBeenCalledTimes(1),
    );

    const forcedRefreshPromise = useProviderModelCacheStore
      .getState()
      .refreshProviderModels("databricks_v2", { force: true });

    rejectInitialRefresh(new Error("not authenticated"));

    await Promise.all([firstRefreshPromise, forcedRefreshPromise]);

    expect(mocks.supportedModelsList).toHaveBeenCalledTimes(2);
    expect(
      useProviderModelCacheStore
        .getState()
        .getModelsForProvider("databricks_v2")
        .map((model) => model.id),
    ).toEqual(["goose-gpt-5-5"]);
    expect(
      useProviderModelCacheStore.getState().getError("databricks_v2"),
    ).toBe(null);
  });

  it("does not write stale refresh results after invalidation", async () => {
    let resolveInitialRefresh!: (value: { models: string[] }) => void;
    const initialRefresh = new Promise<{ models: string[] }>((resolve) => {
      resolveInitialRefresh = resolve;
    });
    mocks.supportedModelsList.mockReturnValueOnce(initialRefresh);

    const refreshPromise = useProviderModelCacheStore
      .getState()
      .refreshProviderModels("databricks_v2");

    await waitFor(() =>
      expect(mocks.supportedModelsList).toHaveBeenCalledTimes(1),
    );

    useProviderModelCacheStore.getState().invalidateProvider("databricks_v2");
    resolveInitialRefresh({ models: ["goose-gpt-5-5"] });
    await refreshPromise;

    expect(
      useProviderModelCacheStore
        .getState()
        .getModelsForProvider("databricks_v2"),
    ).toEqual([]);
  });

  it("stores ACP error data when supported model refresh fails", async () => {
    const error = new Error("Internal error") as Error & { data: string };
    error.name = "RequestError";
    error.data =
      "Failed to fetch provider supported models: Databricks token expired";
    mocks.supportedModelsList.mockRejectedValueOnce(error);

    await useProviderModelCacheStore
      .getState()
      .refreshProviderModels("databricks_v2");

    expect(
      useProviderModelCacheStore.getState().getError("databricks_v2"),
    ).toBe(
      "Failed to fetch provider supported models: Databricks token expired",
    );
  });
});

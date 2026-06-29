import { waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ModelOption } from "@/features/chat/types";
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
    vi.clearAllMocks();
    window.localStorage.clear();
    useProviderModelCacheStore.setState({
      providers: new Map(),
      refreshingProviderIds: new Set(),
      runtimeManagedProviderIds: new Set(),
    });
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

  it("seeds bundled runtime models as stale refreshable entries", async () => {
    useProviderModelCacheStore
      .getState()
      .seedRuntimeModels(new Map([["databricks_v2", [seededModel()]]]), {
        runtimeManagedProviderIds: new Set(),
      });
    mocks.supportedModelsList.mockResolvedValueOnce({
      models: ["goose-gpt-5-5"],
    });

    await useProviderModelCacheStore
      .getState()
      .refreshProviderModels("databricks_v2");

    expect(mocks.supportedModelsList).toHaveBeenCalledWith({
      providerId: "databricks_v2",
    });
    expect(
      useProviderModelCacheStore
        .getState()
        .getModelsForProvider("databricks_v2")
        .map((model) => model.id),
    ).toEqual(["goose-gpt-5-5"]);
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

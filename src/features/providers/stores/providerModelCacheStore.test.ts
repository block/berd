import { waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ModelOption } from "@/features/chat/types";
import {
  isModelSelectionAllowedByCachedInventory,
  MODEL_CACHE_TTL_MS,
  publishProvenModelInventory,
  useProviderModelCacheStore,
} from "./providerModelCacheStore";

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

  it("keeps runtime-managed configuration seeds advisory until live discovery succeeds", async () => {
    const model = seededModel({
      contextLimit: 128000,
      recommended: true,
      featured: true,
      sortOrder: 0,
    });
    useProviderModelCacheStore
      .getState()
      .seedRuntimeModels(new Map([["databricks_v2", [model]]]));

    expect(
      useProviderModelCacheStore
        .getState()
        .isModelInventoryAuthoritative("databricks_v2"),
    ).toBe(false);
    expect(
      useProviderModelCacheStore
        .getState()
        .getProvenModelsForProvider("databricks_v2"),
    ).toEqual([]);

    mocks.supportedModelsList.mockResolvedValueOnce({ models: [] });
    await useProviderModelCacheStore
      .getState()
      .refreshProviderModels("databricks_v2");

    const entry = useProviderModelCacheStore
      .getState()
      .providers.get("databricks_v2");
    expect(entry?.runtimeManaged).toBe(true);
    expect(entry?.provenModelIds).toEqual([]);
    expect(
      useProviderModelCacheStore
        .getState()
        .getModelsForProvider("databricks_v2"),
    ).toEqual([model]);
    expect(mocks.supportedModelsList).toHaveBeenCalledWith({
      providerId: "databricks_v2",
    });
  });

  it("lets a newer ACP acknowledgement supersede retained negative proof", () => {
    const model = seededModel({ id: "old-model" });
    const proofRevision = 10;
    useProviderModelCacheStore.setState({
      providers: new Map([
        [
          "databricks_v2",
          {
            providerId: "databricks_v2",
            models: [model],
            provenModelIds: ["old-model"],
            proofRevision,
            fetchedAt: Date.now() - MODEL_CACHE_TTL_MS - 1,
          },
        ],
      ]),
    });

    expect(
      isModelSelectionAllowedByCachedInventory(
        "databricks_v2",
        "newly-prepared-model",
      ),
    ).toBe(false);
    expect(
      isModelSelectionAllowedByCachedInventory(
        "databricks_v2",
        "newly-prepared-model",
        proofRevision + 1,
      ),
    ).toBe(true);

    useProviderModelCacheStore.setState((state) => {
      const providers = new Map(state.providers);
      const entry = providers.get("databricks_v2");
      if (!entry) throw new Error("expected seeded provider");
      providers.set("databricks_v2", {
        ...entry,
        error: "offline",
      });
      return { providers };
    });
    expect(
      isModelSelectionAllowedByCachedInventory(
        "databricks_v2",
        "newly-prepared-model",
      ),
    ).toBe(false);
    expect(
      isModelSelectionAllowedByCachedInventory(
        "databricks_v2",
        "newly-prepared-model",
        proofRevision + 1,
      ),
    ).toBe(true);
  });

  it("publishes successful live preflight as the shared fresh authority", () => {
    publishProvenModelInventory("databricks_v2", ["new-model"]);

    expect(
      useProviderModelCacheStore
        .getState()
        .isModelInventoryAuthoritative("databricks_v2"),
    ).toBe(true);
    expect(
      isModelSelectionAllowedByCachedInventory("databricks_v2", "new-model"),
    ).toBe(true);
    expect(
      isModelSelectionAllowedByCachedInventory("databricks_v2", "old-model"),
    ).toBe(false);
  });

  it("invalidates runtime-managed proof without discarding its display seed", async () => {
    const model = seededModel({ recommended: true, featured: true });
    useProviderModelCacheStore
      .getState()
      .seedRuntimeModels(new Map([["databricks_v2", [model]]]));
    mocks.supportedModelsList
      .mockResolvedValueOnce({ models: ["goose-gpt-5-5"] })
      .mockResolvedValueOnce({ models: ["goose-gpt-5-5"] });

    await useProviderModelCacheStore
      .getState()
      .refreshProviderModels("databricks_v2");
    useProviderModelCacheStore.getState().invalidateProvider("databricks_v2");

    const invalidatedEntry = useProviderModelCacheStore
      .getState()
      .providers.get("databricks_v2");
    expect(invalidatedEntry?.provenModelIds).toBeUndefined();
    expect(invalidatedEntry?.models).toEqual([model]);
    expect(
      useProviderModelCacheStore
        .getState()
        .isModelInventoryAuthoritative("databricks_v2"),
    ).toBe(false);

    await useProviderModelCacheStore
      .getState()
      .refreshProviderModels("databricks_v2", { force: true });

    const entry = useProviderModelCacheStore
      .getState()
      .providers.get("databricks_v2");
    expect(entry?.runtimeManaged).toBe(true);
    expect(entry?.provenModelIds).toEqual(["goose-gpt-5-5"]);
    expect(
      useProviderModelCacheStore
        .getState()
        .getModelsForProvider("databricks_v2")
        .map((candidate) => candidate.id),
    ).toEqual(["goose-gpt-5-5", "seeded-model"]);
    expect(mocks.supportedModelsList).toHaveBeenLastCalledWith({
      providerId: "databricks_v2",
    });
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
    expect(
      useProviderModelCacheStore
        .getState()
        .getProvenModelsForProvider("databricks_v2")
        .map((model) => model.id),
    ).toEqual(["goose-gpt-5-5"]);
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

  it.each([
    { provenModelIds: ["supported-model"], expected: ["supported-model"] },
    { provenModelIds: [], expected: [] },
  ])("preserves prior proof data and runtime policy but revokes authority after refresh failure: $provenModelIds", async ({
    provenModelIds,
    expected,
  }) => {
    const model = seededModel({ id: "configured-model" });
    useProviderModelCacheStore.setState({
      providers: new Map([
        [
          "databricks_v2",
          {
            providerId: "databricks_v2",
            models: [model],
            configuredModels: [model],
            provenModelIds,
            fetchedAt: 123,
            runtimeManaged: true,
          },
        ],
      ]),
      runtimeManagedProviderIds: new Set(["databricks_v2"]),
    });
    mocks.supportedModelsList.mockRejectedValueOnce(new Error("offline"));

    await useProviderModelCacheStore
      .getState()
      .refreshProviderModels("databricks_v2", { force: true });

    const entry = useProviderModelCacheStore
      .getState()
      .providers.get("databricks_v2");
    expect(entry?.provenModelIds).toEqual(expected);
    expect(entry?.runtimeManaged).toBe(true);
    expect(entry?.configuredModels).toEqual([model]);
    expect(entry?.fetchedAt).toBe(123);
    expect(
      useProviderModelCacheStore
        .getState()
        .isModelInventoryAuthoritative("databricks_v2"),
    ).toBe(false);
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

  it("keeps configuration-only runtime seeds provisional across restart", () => {
    const model = seededModel({ recommended: true, featured: true });
    useProviderModelCacheStore
      .getState()
      .seedRuntimeModels(new Map([["databricks_v2", [model]]]));

    useProviderModelCacheStore.setState({
      providers: new Map(),
      runtimeManagedProviderIds: new Set(),
    });
    useProviderModelCacheStore.getState().loadPersisted();

    const entry = useProviderModelCacheStore
      .getState()
      .providers.get("databricks_v2");
    expect(entry?.provenModelIds).toBeUndefined();
    expect(
      useProviderModelCacheStore
        .getState()
        .isModelInventoryAuthoritative("databricks_v2"),
    ).toBe(false);
  });

  it("persists authority only after a successful live response", async () => {
    const model = seededModel({ recommended: true, featured: true });
    useProviderModelCacheStore
      .getState()
      .seedRuntimeModels(new Map([["databricks_v2", [model]]]));
    mocks.supportedModelsList.mockResolvedValueOnce({ models: [] });

    await useProviderModelCacheStore
      .getState()
      .refreshProviderModels("databricks_v2");
    useProviderModelCacheStore.setState({
      providers: new Map(),
      runtimeManagedProviderIds: new Set(),
    });
    useProviderModelCacheStore.getState().loadPersisted();

    const entry = useProviderModelCacheStore
      .getState()
      .providers.get("databricks_v2");
    expect(entry?.provenModelIds).toEqual([]);
    expect(
      useProviderModelCacheStore
        .getState()
        .isModelInventoryAuthoritative("databricks_v2"),
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

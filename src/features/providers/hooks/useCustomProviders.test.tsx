import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useProviderCatalogStore } from "@/features/providers/stores/providerCatalogStore";
import { useProviderModelCacheStore } from "@/features/providers/stores/providerModelCacheStore";
import { useCustomProviders } from "./useCustomProviders";

const createCustomProvider = vi.fn();
const deleteCustomProvider = vi.fn();
const getCustomProviderTemplate = vi.fn();
const listCustomProviderCatalog = vi.fn();
const readCustomProvider = vi.fn();
const updateCustomProvider = vi.fn();

vi.mock("@/features/providers/api/customProviders", () => ({
  createCustomProvider: (...args: unknown[]) => createCustomProvider(...args),
  deleteCustomProvider: (...args: unknown[]) => deleteCustomProvider(...args),
  getCustomProviderTemplate: (...args: unknown[]) =>
    getCustomProviderTemplate(...args),
  listCustomProviderCatalog: (...args: unknown[]) =>
    listCustomProviderCatalog(...args),
  readCustomProvider: (...args: unknown[]) => readCustomProvider(...args),
  updateCustomProvider: (...args: unknown[]) => updateCustomProvider(...args),
}));

function status(providerId: string) {
  return { providerId, isConfigured: true };
}

function upsertRequest(displayName: string) {
  return {
    displayName,
    apiUrl: "https://example.com/v1",
    engine: "openai_compatible" as const,
    requiresAuth: true,
    models: ["model-a"],
  };
}

describe("useCustomProviders", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useProviderCatalogStore.getState().reset();
    useProviderModelCacheStore.setState({
      providers: new Map(),
      refreshingProviderIds: new Set(),
      runtimeManagedProviderIds: new Set(),
    });
  });

  it("adds created custom providers to the catalog used by the model picker", async () => {
    createCustomProvider.mockResolvedValue({
      providerId: "custom-openrouter",
      refresh: { started: ["custom-openrouter"] },
      status: status("custom-openrouter"),
    });

    const refreshProviderModels = vi.spyOn(
      useProviderModelCacheStore.getState(),
      "refreshProviderModels",
    );
    refreshProviderModels.mockResolvedValue(undefined);

    const { result } = renderHook(() => useCustomProviders());

    await act(async () => {
      await result.current.create(upsertRequest("OpenRouter"));
    });

    expect(
      useProviderCatalogStore
        .getState()
        .entries.find((entry) => entry.id === "custom-openrouter"),
    ).toMatchObject({
      displayName: "OpenRouter",
      category: "model",
      customProvider: true,
    });
    expect(refreshProviderModels).toHaveBeenCalledWith("custom-openrouter", {
      force: true,
    });
  });

  it("updates and removes custom provider catalog entries", async () => {
    updateCustomProvider.mockResolvedValue({
      providerId: "custom-openrouter",
      refresh: { started: ["custom-openrouter"] },
      status: status("custom-openrouter"),
    });
    deleteCustomProvider.mockResolvedValue({
      providerId: "custom-openrouter",
      refresh: { started: [] },
    });
    vi.spyOn(
      useProviderModelCacheStore.getState(),
      "refreshProviderModels",
    ).mockResolvedValue(undefined);

    const { result } = renderHook(() => useCustomProviders());

    await act(async () => {
      await result.current.update(
        "custom-openrouter",
        upsertRequest("OpenRouter Updated"),
      );
    });

    expect(
      useProviderCatalogStore
        .getState()
        .entries.find((entry) => entry.id === "custom-openrouter"),
    ).toMatchObject({ displayName: "OpenRouter Updated" });

    await act(async () => {
      await result.current.remove("custom-openrouter");
    });

    expect(
      useProviderCatalogStore
        .getState()
        .entries.some((entry) => entry.id === "custom-openrouter"),
    ).toBe(false);
  });
});

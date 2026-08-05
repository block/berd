import { beforeEach, describe, expect, it, vi } from "vitest";
import { useProviderModelCacheStore } from "@/features/providers/stores/providerModelCacheStore";
import { useDefaultProviderReadinessStore } from "@/features/providers/stores/defaultProviderReadinessStore";
import { checkAllProviderStatus } from "@/features/providers/api/credentials";
import { resolveSupportedSessionModelPreference } from "./resolveSessionModelPreference";

vi.mock("@/features/providers/api/credentials", () => ({
  checkAllProviderStatus: vi.fn().mockResolvedValue([]),
}));

const mockCheckAllProviderStatus = vi.mocked(checkAllProviderStatus);

function setCachedModels(providerId: string, models: string[]) {
  useProviderModelCacheStore.setState({
    providers: new Map([
      [
        providerId,
        {
          providerId,
          models: models.map((id) => ({ id, name: id, providerId })),
          fetchedAt: Date.now(),
        },
      ],
    ]),
    refreshingProviderIds: new Set(),
  });
}

function setStoredPreference(agentId: string, providerId: string) {
  window.localStorage.setItem(
    "goose:preferredModelsByAgent",
    JSON.stringify({
      [agentId]: {
        modelId: "gpt-5.4",
        modelName: "GPT-5.4",
        providerId,
      },
    }),
  );
}

describe("resolveSupportedSessionModelPreference", () => {
  beforeEach(() => {
    window.localStorage.clear();
    useProviderModelCacheStore.setState({
      providers: new Map(),
      refreshingProviderIds: new Set(),
    });
    useDefaultProviderReadinessStore.setState({ readiness: null });
    mockCheckAllProviderStatus.mockReset();
    mockCheckAllProviderStatus.mockResolvedValue([]);
  });

  it("resolves a ready backend Goose default when local preference is missing", async () => {
    useDefaultProviderReadinessStore.setState({
      readiness: {
        status: "ready",
        providerId: "openai",
        modelId: "gpt-5.4",
      },
    });

    await expect(
      resolveSupportedSessionModelPreference("goose", new Map()),
    ).resolves.toEqual({
      providerId: "openai",
      modelId: "gpt-5.4",
      modelName: "gpt-5.4",
    });
  });

  it("preserves a stored model when cached models are missing", async () => {
    setStoredPreference("goose", "openai");

    await expect(
      resolveSupportedSessionModelPreference("goose", new Map()),
    ).resolves.toEqual({
      providerId: "openai",
      modelId: "gpt-5.4",
      modelName: "GPT-5.4",
    });
  });

  it("preserves a preferred model when cached models are missing", async () => {
    await expect(
      resolveSupportedSessionModelPreference("openai", new Map(), "gpt-5.4"),
    ).resolves.toEqual({
      providerId: "openai",
      modelId: "gpt-5.4",
      modelName: "gpt-5.4",
    });
  });

  it("preserves the selected model when the model cache has no model list", async () => {
    setCachedModels("openai", []);

    await expect(
      resolveSupportedSessionModelPreference("openai", undefined, "gpt-5.4"),
    ).resolves.toEqual({
      providerId: "openai",
      modelId: "gpt-5.4",
      modelName: "gpt-5.4",
    });
  });

  it("drops an unsupported model when populated model cache is available", async () => {
    setCachedModels("openai", ["gpt-5.3"]);

    await expect(
      resolveSupportedSessionModelPreference("openai", undefined, "gpt-5.4"),
    ).resolves.toEqual({
      providerId: "openai",
    });
  });

  it("keeps a supported model when populated model cache is available", async () => {
    setCachedModels("openai", ["gpt-5.4"]);

    await expect(
      resolveSupportedSessionModelPreference("openai", undefined, "gpt-5.4"),
    ).resolves.toEqual({
      providerId: "openai",
      modelId: "gpt-5.4",
      modelName: "gpt-5.4",
    });
  });

  it("drops a stored model whose provider is disconnected", async () => {
    setStoredPreference("goose", "openai");
    mockCheckAllProviderStatus.mockResolvedValue([
      { providerId: "openai", isConfigured: false },
    ]);

    await expect(
      resolveSupportedSessionModelPreference("goose", new Map()),
    ).resolves.toEqual({
      providerId: "goose",
    });
  });

  it("falls back to the Goose default when the stored model's provider is disconnected", async () => {
    setStoredPreference("goose", "openai");
    useDefaultProviderReadinessStore.setState({
      readiness: {
        status: "ready",
        providerId: "databricks_v2",
        modelId: "goose-gpt-5-5",
      },
    });
    mockCheckAllProviderStatus.mockResolvedValue([
      { providerId: "openai", isConfigured: false },
    ]);

    await expect(
      resolveSupportedSessionModelPreference("goose", new Map()),
    ).resolves.toEqual({
      providerId: "databricks_v2",
      modelId: "goose-gpt-5-5",
      modelName: "goose-gpt-5-5",
    });
  });

  it("keeps a stored model when its provider is still configured", async () => {
    setStoredPreference("goose", "openai");
    mockCheckAllProviderStatus.mockResolvedValue([
      { providerId: "openai", isConfigured: true },
    ]);

    await expect(
      resolveSupportedSessionModelPreference("goose", new Map()),
    ).resolves.toEqual({
      providerId: "openai",
      modelId: "gpt-5.4",
      modelName: "GPT-5.4",
    });
  });

  it("keeps a stored model when the provider status read fails", async () => {
    setStoredPreference("goose", "openai");
    mockCheckAllProviderStatus.mockRejectedValue(new Error("offline"));

    await expect(
      resolveSupportedSessionModelPreference("goose", new Map()),
    ).resolves.toEqual({
      providerId: "openai",
      modelId: "gpt-5.4",
      modelName: "GPT-5.4",
    });
  });

  it("skips the provider status read when the stored provider is the ready default", async () => {
    setStoredPreference("goose", "openai");
    useDefaultProviderReadinessStore.setState({
      readiness: {
        status: "ready",
        providerId: "openai",
        modelId: "gpt-5.3",
      },
    });

    await expect(
      resolveSupportedSessionModelPreference("goose", new Map()),
    ).resolves.toEqual({
      providerId: "openai",
      modelId: "gpt-5.4",
      modelName: "GPT-5.4",
    });
    expect(mockCheckAllProviderStatus).not.toHaveBeenCalled();
  });
});

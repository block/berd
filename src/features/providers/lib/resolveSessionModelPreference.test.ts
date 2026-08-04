import { beforeEach, describe, expect, it } from "vitest";
import { useProviderModelCacheStore } from "@/features/providers/stores/providerModelCacheStore";
import { useDefaultProviderReadinessStore } from "@/features/providers/stores/defaultProviderReadinessStore";
import { resolveSupportedSessionModelPreference } from "./resolveSessionModelPreference";

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

describe("resolveSupportedSessionModelPreference", () => {
  beforeEach(() => {
    window.localStorage.clear();
    useProviderModelCacheStore.setState({
      providers: new Map(),
      refreshingProviderIds: new Set(),
    });
    useDefaultProviderReadinessStore.setState({ readiness: null });
  });

  it("resolves a ready backend Goose default when local preference is missing", async () => {
    useDefaultProviderReadinessStore.setState({
      readiness: {
        status: "ready",
        providerId: "openai",
        modelId: "gpt-5.4",
      },
    });

    expect(resolveSupportedSessionModelPreference("goose", new Map())).toEqual({
      providerId: "openai",
      modelId: "gpt-5.4",
      modelName: "gpt-5.4",
    });
  });

  it("preserves a stored model when cached models are missing", async () => {
    window.localStorage.setItem(
      "goose:preferredModelsByAgent",
      JSON.stringify({
        goose: {
          modelId: "gpt-5.4",
          modelName: "GPT-5.4",
          providerId: "openai",
        },
      }),
    );

    expect(resolveSupportedSessionModelPreference("goose", new Map())).toEqual({
      providerId: "openai",
      modelId: "gpt-5.4",
      modelName: "GPT-5.4",
    });
  });

  it("preserves a preferred model when cached models are missing", async () => {
    expect(
      resolveSupportedSessionModelPreference("openai", new Map(), "gpt-5.4"),
    ).toEqual({
      providerId: "openai",
      modelId: "gpt-5.4",
      modelName: "gpt-5.4",
    });
  });

  it("preserves the selected model when the model cache has no model list", async () => {
    setCachedModels("openai", []);

    expect(
      resolveSupportedSessionModelPreference("openai", undefined, "gpt-5.4"),
    ).toEqual({
      providerId: "openai",
      modelId: "gpt-5.4",
      modelName: "gpt-5.4",
    });
  });

  it("drops an unsupported model when populated model cache is available", async () => {
    setCachedModels("openai", ["gpt-5.3"]);

    expect(
      resolveSupportedSessionModelPreference("openai", undefined, "gpt-5.4"),
    ).toEqual({
      providerId: "openai",
    });
  });

  it("keeps a supported model when populated model cache is available", async () => {
    setCachedModels("openai", ["gpt-5.4"]);

    expect(
      resolveSupportedSessionModelPreference("openai", undefined, "gpt-5.4"),
    ).toEqual({
      providerId: "openai",
      modelId: "gpt-5.4",
      modelName: "gpt-5.4",
    });
  });
});

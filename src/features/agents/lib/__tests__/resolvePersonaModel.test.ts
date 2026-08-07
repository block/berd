import { describe, expect, it } from "vitest";
import type { ProviderCatalogEntry } from "@/shared/types/providers";
import { resolvePersonaModel } from "../resolvePersonaModel";

const CATALOG_ENTRIES: ProviderCatalogEntry[] = ["openai", "anthropic"].map(
  (id) => ({
    id,
    displayName: id,
    category: "model",
    description: id,
    setupMethod: "single_api_key",
    group: "default",
  }),
);

const PERSONA = {
  provider: "goose",
  model: "shared-model",
  modelProviderId: "openai",
};

describe("resolvePersonaModel", () => {
  it("rejects a provider hint contradicted by qualified inventory", () => {
    expect(
      resolvePersonaModel(
        PERSONA,
        "goose",
        [
          {
            id: "shared-model",
            name: "Anthropic model",
            providerId: "anthropic",
          },
        ],
        CATALOG_ENTRIES,
      ),
    ).toBeUndefined();
  });

  it("preserves the provider hint when inventory is absent", () => {
    expect(resolvePersonaModel(PERSONA, "goose", [], CATALOG_ENTRIES)).toEqual({
      modelId: "shared-model",
      modelName: "shared-model",
      modelProviderId: "openai",
    });
  });

  it("preserves the provider hint for unqualified inventory", () => {
    expect(
      resolvePersonaModel(
        PERSONA,
        "goose",
        [{ id: "shared-model", displayName: "Shared model" }],
        CATALOG_ENTRIES,
      ),
    ).toEqual({
      modelId: "shared-model",
      modelName: "Shared model",
      modelProviderId: "openai",
    });
  });

  it("prefers a legacy persona provider over the current provider", () => {
    expect(
      resolvePersonaModel(
        { provider: "openai", model: "shared-model" },
        "goose",
        [
          {
            id: "shared-model",
            name: "OpenAI model",
            providerId: "openai",
          },
          {
            id: "shared-model",
            name: "Anthropic model",
            providerId: "anthropic",
          },
        ],
        CATALOG_ENTRIES,
        { modelId: "shared-model", modelProviderId: "anthropic" },
      ),
    ).toEqual({
      modelId: "shared-model",
      modelName: "OpenAI model",
      modelProviderId: "openai",
    });
  });
});

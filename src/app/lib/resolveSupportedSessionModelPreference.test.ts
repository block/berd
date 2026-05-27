import type { ProviderInventoryEntryDto } from "@aaif/goose-sdk";
import { beforeEach, describe, expect, it } from "vitest";
import { resolveSupportedSessionModelPreference } from "./resolveSupportedSessionModelPreference";

function inventoryEntry(models: string[]): ProviderInventoryEntryDto {
  return {
    name: "openai",
    displayName: "OpenAI",
    models: models.map((id) => ({ id })),
  } as unknown as ProviderInventoryEntryDto;
}

describe("resolveSupportedSessionModelPreference", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it("preserves a stored model when inventory is missing", async () => {
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

    await expect(
      resolveSupportedSessionModelPreference("goose", new Map()),
    ).resolves.toEqual({
      providerId: "openai",
      modelId: "gpt-5.4",
      modelName: "GPT-5.4",
    });
  });

  it("preserves a preferred model when inventory is missing", async () => {
    await expect(
      resolveSupportedSessionModelPreference("openai", new Map(), "gpt-5.4"),
    ).resolves.toEqual({
      providerId: "openai",
      modelId: "gpt-5.4",
      modelName: "gpt-5.4",
    });
  });

  it("preserves the selected model when inventory has no model list", async () => {
    const entries = new Map<string, ProviderInventoryEntryDto>([
      ["openai", inventoryEntry([])],
    ]);

    await expect(
      resolveSupportedSessionModelPreference("openai", entries, "gpt-5.4"),
    ).resolves.toEqual({
      providerId: "openai",
      modelId: "gpt-5.4",
      modelName: "gpt-5.4",
    });
  });

  it("drops an unsupported model when populated inventory is available", async () => {
    const entries = new Map<string, ProviderInventoryEntryDto>([
      ["openai", inventoryEntry(["gpt-5.3"])],
    ]);

    await expect(
      resolveSupportedSessionModelPreference("openai", entries, "gpt-5.4"),
    ).resolves.toEqual({
      providerId: "openai",
    });
  });

  it("keeps a supported model when populated inventory is available", async () => {
    const entries = new Map<string, ProviderInventoryEntryDto>([
      ["openai", inventoryEntry(["gpt-5.4"])],
    ]);

    await expect(
      resolveSupportedSessionModelPreference("openai", entries, "gpt-5.4"),
    ).resolves.toEqual({
      providerId: "openai",
      modelId: "gpt-5.4",
      modelName: "gpt-5.4",
    });
  });
});

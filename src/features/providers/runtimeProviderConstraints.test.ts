import { describe, expect, it } from "vitest";
import { DEFAULT_RUNTIME_CONFIG } from "@/shared/runtime-config/schema";
import { filterModelProvidersForRuntimeConfig } from "./runtimeProviderConstraints";

describe("filterModelProvidersForRuntimeConfig", () => {
  const providers = [
    {
      id: "databricks_v2",
      displayName: "Databricks",
      category: "model",
      description: "Databricks models",
      setupMethod: "single_api_key",
      group: "default",
    },
    {
      id: "block_openai_compatible",
      displayName: "Block AI Gateway",
      category: "model",
      description: "Block models",
      setupMethod: "none",
      group: "default",
    },
    {
      id: "openai",
      displayName: "OpenAI",
      category: "model",
      description: "GPT models",
      setupMethod: "single_api_key",
      group: "default",
    },
  ] as const;

  it("returns all providers when runtime config is unavailable", () => {
    expect(filterModelProvidersForRuntimeConfig([...providers], null)).toEqual(
      providers,
    );
  });

  it("uses runtime goose providers as the authoritative model provider set", () => {
    expect(
      filterModelProvidersForRuntimeConfig(
        [...providers],
        DEFAULT_RUNTIME_CONFIG,
      ),
    ).toEqual([providers[0]]);
  });

  it("updates providers when runtime config changes", () => {
    expect(
      filterModelProvidersForRuntimeConfig([...providers], {
        ...DEFAULT_RUNTIME_CONFIG,
        goose: {
          ...DEFAULT_RUNTIME_CONFIG.goose,
          defaultModelProviderId: "block_openai_compatible",
          modelProviders: [
            {
              id: "block_openai_compatible",
              displayName: "Block AI Gateway",
              models: [{ id: "goose-gpt-5-5", name: "GPT-5.5" }],
            },
          ],
        },
      }),
    ).toEqual([providers[1]]);
  });
});

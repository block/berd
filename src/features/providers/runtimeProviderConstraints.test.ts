import { describe, expect, it } from "vitest";
import { DEFAULT_RUNTIME_CONFIG } from "@/shared/runtime-config/schema";
import type { RuntimeConfig } from "@/shared/runtime-config/schema";
import type { ProviderCatalogEntry } from "@/shared/types/providers";
import { filterModelProvidersForRuntimeConfig } from "./runtimeProviderConstraints";

const MANAGED_RUNTIME_CONFIG: RuntimeConfig = {
  ...DEFAULT_RUNTIME_CONFIG,
  goose: {
    defaultModelProviderId: "databricks_v2",
    defaultModelId: "goose-gpt-5-5",
    modelProviders: [
      {
        id: "databricks_v2",
        displayName: "Databricks AI Gateway",
        models: [{ id: "goose-gpt-5-5", name: "GPT-5.5" }],
      },
    ],
  },
};

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
        MANAGED_RUNTIME_CONFIG,
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

  const fieldsProviders: ProviderCatalogEntry[] = [
    ...providers,
    {
      id: "anthropic",
      catalogSource: "setup",
      displayName: "Anthropic",
      category: "model",
      description: "Claude models",
      setupMethod: "single_api_key",
      group: "default",
      fields: [
        {
          key: "ANTHROPIC_API_KEY",
          label: "API Key",
          secret: true,
          required: true,
        },
      ],
    },
    {
      id: "ollama",
      displayName: "Ollama",
      category: "model",
      description: "Local models",
      setupMethod: "config_fields",
      group: "default",
      fields: [
        {
          key: "OLLAMA_HOST",
          label: "Host",
          secret: false,
          required: true,
        },
      ],
    },
  ];

  it("keeps only explicit goose-setup-catalog BYO providers when bring-your-own-key is on", () => {
    // openai/anthropic come from goose's setup catalog with their own secret
    // API-key fields; with the bring-your-own-key feature on they bypass the
    // runtime allowlist (which defaults to just databricks_v2). Other fields-
    // bearing providers remain governed by the allowlist.
    expect(
      filterModelProvidersForRuntimeConfig(
        fieldsProviders,
        MANAGED_RUNTIME_CONFIG,
        { byoKeyProvidersEnabled: true },
      ),
    ).toEqual([providers[0], fieldsProviders[3]]);
  });

  it("does not let fields-bearing providers bypass the allowlist when bring-your-own-key is off", () => {
    // Flag off is the pre-feature behavior: the allowlist alone decides, so a
    // fields-bearing anthropic entry is filtered out and only databricks_v2
    // (the default allowlist) survives.
    expect(
      filterModelProvidersForRuntimeConfig(
        fieldsProviders,
        MANAGED_RUNTIME_CONFIG,
        { byoKeyProvidersEnabled: false },
      ),
    ).toEqual([providers[0]]);
  });

  it("defaults to the build feature (on by default), letting BYO providers bypass the allowlist", () => {
    // Without an explicit option the function reads getBuildFeatureState().
    // byoKeyProviders defaults ON (restricted builds opt out with
    // VITE_BYO_KEY_PROVIDERS=0), so goose-setup-catalog BYO providers pass.
    expect(
      filterModelProvidersForRuntimeConfig(
        fieldsProviders,
        MANAGED_RUNTIME_CONFIG,
      ),
    ).toEqual([providers[0], fieldsProviders[3]]);
  });
});

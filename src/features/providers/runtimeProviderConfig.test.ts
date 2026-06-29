import { beforeEach, describe, expect, it } from "vitest";
import {
  DEFAULT_RUNTIME_CONFIG,
  type RuntimeConfig,
} from "@/shared/runtime-config/schema";
import type { ProviderCatalogEntry } from "@/shared/types/providers";
import { getModelCacheRefreshProviderIds } from "./modelCacheRefresh";
import { runtimeModelInventory } from "./runtimeProviderConfig";
import { useProviderCatalogStore } from "./stores/providerCatalogStore";

function catalogEntry(
  id: string,
  category: ProviderCatalogEntry["category"],
  supportsModelList = true,
): ProviderCatalogEntry {
  return {
    id,
    displayName: id,
    category,
    description: id,
    setupMethod: category === "agent" ? "cli_auth" : "none",
    group: "default",
    supportsModelList,
  };
}

describe("runtimeModelInventory", () => {
  it("preserves inline admin model metadata and derives featured from default", () => {
    const config: RuntimeConfig = {
      schemaVersion: 1,
      goose: {
        defaultModelProviderId: "block_openai_compatible",
        defaultModelId: "llama4:70b",
        modelProviders: [
          {
            id: "block_openai_compatible",
            displayName: "Block AI Gateway",
            models: [
              {
                id: "qwen3.6:27b-mlx",
                name: "Qwen 3.6 27B MLX",
                recommended: true,
                contextLimit: 128000,
              },
              {
                id: "llama4:70b",
                name: "Llama 4 70B",
                recommended: false,
                contextLimit: null,
              },
            ],
          },
        ],
      },
    };

    const models = runtimeModelInventory(config).get("block_openai_compatible");

    expect(
      models?.map(({ id, contextLimit, recommended, featured, sortOrder }) => ({
        id,
        contextLimit,
        recommended,
        featured,
        sortOrder,
      })),
    ).toEqual([
      {
        id: "qwen3.6:27b-mlx",
        contextLimit: 128000,
        recommended: true,
        featured: false,
        sortOrder: 0,
      },
      {
        id: "llama4:70b",
        contextLimit: null,
        recommended: false,
        featured: true,
        sortOrder: 1,
      },
    ]);
  });
});

describe("getModelCacheRefreshProviderIds", () => {
  beforeEach(() => {
    useProviderCatalogStore
      .getState()
      .setEntries([
        catalogEntry("goose", "agent"),
        catalogEntry("databricks_v2", "model"),
        catalogEntry("codex-acp", "agent"),
        catalogEntry("amp-acp", "agent", false),
      ]);
  });

  it("excludes runtime-managed model providers from startup refresh", () => {
    expect(getModelCacheRefreshProviderIds(DEFAULT_RUNTIME_CONFIG)).toEqual([
      "codex-acp",
    ]);
  });

  it("includes model providers for bundled appDefault refresh", () => {
    expect(
      getModelCacheRefreshProviderIds(DEFAULT_RUNTIME_CONFIG, {
        defaultModelInventoryMode: "refreshable",
      }),
    ).toEqual(["databricks_v2", "codex-acp"]);
  });

  it("includes explicitly refreshable runtime model providers", () => {
    expect(
      getModelCacheRefreshProviderIds({
        ...DEFAULT_RUNTIME_CONFIG,
        goose: {
          ...DEFAULT_RUNTIME_CONFIG.goose,
          modelProviders: [
            {
              ...DEFAULT_RUNTIME_CONFIG.goose.modelProviders[0],
              modelInventoryMode: "refreshable",
            },
          ],
        },
      }),
    ).toEqual(["databricks_v2", "codex-acp"]);
  });
});

import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_RUNTIME_CONFIG,
  type RuntimeConfig,
} from "@/shared/runtime-config/schema";
import type { ProviderCatalogEntry } from "@/shared/types/providers";
import { getModelCacheRefreshProviderIds } from "./modelCacheRefresh";
import {
  applyRuntimeProviderConfig,
  defaultModelInventoryModeForLoadResult,
  mergeRuntimeProviderCatalog,
  runtimeModelInventory,
} from "./runtimeProviderConfig";
import { useProviderCatalogStore } from "./stores/providerCatalogStore";

// applyRuntimeProviderConfig also syncs custom providers over ACP; stub it so
// the catalog-merge gating can be tested without a live client.
vi.mock("@/features/providers/api/customProviders", () => ({
  syncRuntimeCustomProviders: vi.fn().mockResolvedValue(undefined),
}));

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

describe("runtimeModelInventory", () => {
  it("preserves inline admin model metadata with featured independent of default", () => {
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
                featured: true,
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
        featured: true,
        sortOrder: 0,
      },
      {
        id: "llama4:70b",
        contextLimit: null,
        recommended: false,
        featured: false,
        sortOrder: 1,
      },
    ]);
  });
});

describe("mergeRuntimeProviderCatalog", () => {
  it("preserves explicit BYO setup entries and drops stale non-BYO entries", () => {
    const existing: ProviderCatalogEntry[] = [
      {
        id: "openai",
        catalogSource: "setup",
        displayName: "OpenAI",
        category: "model",
        description: "GPT models",
        setupMethod: "config_fields",
        group: "default",
        fields: [
          {
            key: "OPENAI_API_KEY",
            label: "API Key",
            secret: true,
            required: false,
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
      // Absent from the runtime config and not an explicit BYO provider: stale
      // entries that the authoritative runtime config should drop.
      catalogEntry("stale_provider", "model"),
    ];

    const merged = mergeRuntimeProviderCatalog(
      existing,
      MANAGED_RUNTIME_CONFIG,
    );
    const ids = merged.map((entry) => entry.id);

    expect(ids).toContain("openai");
    expect(ids).toContain("databricks_v2");
    expect(ids).not.toContain("ollama");
    expect(ids).not.toContain("stale_provider");
    expect(merged.find((entry) => entry.id === "openai")?.fields).toHaveLength(
      1,
    );
  });

  it("combines runtime inventory with same-id setup behavior", () => {
    const config: RuntimeConfig = {
      ...DEFAULT_RUNTIME_CONFIG,
      goose: {
        ...DEFAULT_RUNTIME_CONFIG.goose,
        modelProviders: [
          {
            id: "openai",
            displayName: "Managed OpenAI",
            models: [{ id: "gpt-5", name: "GPT-5" }],
          },
        ],
      },
    };
    const existing: ProviderCatalogEntry[] = [
      {
        ...catalogEntry("openai", "model"),
        catalogSource: "setup",
        setupCatalogProvider: true,
        setupMethod: "config_fields",
        fields: [
          {
            key: "OPENAI_API_KEY",
            label: "API Key",
            secret: true,
            required: false,
          },
        ],
        docsUrl: "https://platform.openai.com",
      },
    ];

    const [openai] = mergeRuntimeProviderCatalog(existing, config).filter(
      (entry) => entry.id === "openai",
    );

    expect(openai).toMatchObject({
      displayName: "Managed OpenAI",
      catalogSource: "runtime",
      setupCatalogProvider: true,
      setupMethod: "config_fields",
      docsUrl: "https://platform.openai.com",
    });
    expect(openai.fields?.map((field) => field.key)).toEqual([
      "OPENAI_API_KEY",
    ]);
  });

  it("keeps managed Databricks setup fields hidden", () => {
    const existing: ProviderCatalogEntry[] = [
      {
        ...catalogEntry("databricks_v2", "model"),
        catalogSource: "setup",
        setupCatalogProvider: true,
        fields: [
          {
            key: "DATABRICKS_HOST",
            label: "Host",
            secret: false,
            required: true,
          },
          {
            key: "DATABRICKS_TOKEN",
            label: "Token",
            secret: true,
            required: false,
          },
        ],
      },
    ];

    const managedConfig: RuntimeConfig = {
      ...DEFAULT_RUNTIME_CONFIG,
      goose: {
        ...DEFAULT_RUNTIME_CONFIG.goose,
        ...MANAGED_RUNTIME_CONFIG.goose,
        modelProviders: [
          {
            ...MANAGED_RUNTIME_CONFIG.goose.modelProviders[0],
            endpointEnv: {
              DATABRICKS_HOST: "https://internal.example.com",
            },
          },
        ],
      },
    };
    const [databricks] = mergeRuntimeProviderCatalog(
      existing,
      managedConfig,
    ).filter((entry) => entry.id === "databricks_v2");

    expect(databricks.fields).toBeUndefined();
    expect(databricks.displayName).toBe("Databricks AI Gateway");
  });

  it("keeps only the Databricks host field when runtime config has no endpoint env", () => {
    const configWithoutEndpointEnv: RuntimeConfig = {
      ...DEFAULT_RUNTIME_CONFIG,
      goose: {
        ...DEFAULT_RUNTIME_CONFIG.goose,
        modelProviders: [
          {
            ...MANAGED_RUNTIME_CONFIG.goose.modelProviders[0],
            endpointEnv: undefined,
          },
        ],
      },
    };
    const existing: ProviderCatalogEntry[] = [
      {
        ...catalogEntry("databricks_v2", "model"),
        fields: [
          {
            key: "DATABRICKS_HOST",
            label: "Host",
            secret: false,
            required: true,
          },
          {
            key: "DATABRICKS_TOKEN",
            label: "Token",
            secret: true,
            required: false,
          },
        ],
      },
    ];

    const databricks = mergeRuntimeProviderCatalog(
      existing,
      configWithoutEndpointEnv,
    ).find((entry) => entry.id === "databricks_v2");

    expect(databricks?.fields?.map((field) => field.key)).toEqual([
      "DATABRICKS_HOST",
    ]);
  });
});

describe("applyRuntimeProviderConfig catalog gating", () => {
  function seedFieldsBearingEntry() {
    useProviderCatalogStore.getState().setEntries([
      {
        id: "openai",
        catalogSource: "setup",
        displayName: "OpenAI",
        category: "model",
        description: "GPT models",
        setupMethod: "config_fields",
        group: "default",
        fields: [
          {
            key: "OPENAI_API_KEY",
            label: "API Key",
            secret: true,
            required: false,
          },
        ],
      },
    ]);
  }

  it("merges and preserves fields-bearing entries when bring-your-own-key is on", async () => {
    seedFieldsBearingEntry();

    await applyRuntimeProviderConfig(MANAGED_RUNTIME_CONFIG, {
      byoKeyProvidersEnabled: true,
    });

    const ids = useProviderCatalogStore
      .getState()
      .entries.map((entry) => entry.id);
    expect(ids).toContain("openai");
    expect(ids).toContain("databricks_v2");
  });

  it("wholesale-replaces the catalog (pre-feature behavior) when bring-your-own-key is off", async () => {
    seedFieldsBearingEntry();

    await applyRuntimeProviderConfig(MANAGED_RUNTIME_CONFIG, {
      byoKeyProvidersEnabled: false,
    });

    const ids = useProviderCatalogStore
      .getState()
      .entries.map((entry) => entry.id);
    // The seeded fields-bearing openai entry is dropped — the runtime config is
    // the sole catalog source, exactly as before the feature existed.
    expect(ids).not.toContain("openai");
    expect(ids).toContain("databricks_v2");
  });

  it("defaults to the build feature (on by default), preserving fields-bearing entries", async () => {
    // byoKeyProviders defaults ON (restricted builds opt out with
    // VITE_BYO_KEY_PROVIDERS=0), so the merge path is the default behavior.
    seedFieldsBearingEntry();

    await applyRuntimeProviderConfig(MANAGED_RUNTIME_CONFIG);

    const ids = useProviderCatalogStore
      .getState()
      .entries.map((entry) => entry.id);
    expect(ids).toContain("openai");
    expect(ids).toContain("databricks_v2");
  });
});

describe("defaultModelInventoryModeForLoadResult", () => {
  it("treats the bundled file like the app default (refreshable)", () => {
    // Individual bundled providers can still opt into authoritative inventory.
    expect(
      defaultModelInventoryModeForLoadResult({
        status: "ready",
        source: "bundledFile",
        config: DEFAULT_RUNTIME_CONFIG,
      }),
    ).toBe("refreshable");
  });

  it("keeps the app default refreshable", () => {
    expect(
      defaultModelInventoryModeForLoadResult({
        status: "ready",
        source: "appDefault",
        config: DEFAULT_RUNTIME_CONFIG,
      }),
    ).toBe("refreshable");
  });

  it("treats a live/cached endpoint response as authoritative", () => {
    expect(
      defaultModelInventoryModeForLoadResult({
        status: "ready",
        source: "endpoint",
        config: DEFAULT_RUNTIME_CONFIG,
      }),
    ).toBe("authoritative");
    expect(
      defaultModelInventoryModeForLoadResult({
        status: "ready",
        source: "cachedEndpoint",
        config: DEFAULT_RUNTIME_CONFIG,
      }),
    ).toBe("authoritative");
  });

  it("falls back to refreshable when the config is unavailable", () => {
    expect(
      defaultModelInventoryModeForLoadResult({
        status: "unavailable",
        source: "bundledFile",
        reason: "missing",
        message: "no bundled config",
      }),
    ).toBe("refreshable");
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
      getModelCacheRefreshProviderIds(MANAGED_RUNTIME_CONFIG, {
        defaultModelInventoryMode: "refreshable",
      }),
    ).toEqual(["databricks_v2", "codex-acp"]);
  });

  it("includes configured BYO setup providers when bring-your-own-key is on", () => {
    useProviderCatalogStore.getState().mergeEntries([
      {
        ...catalogEntry("anthropic", "model"),
        catalogSource: "setup",
        fields: [
          {
            key: "ANTHROPIC_API_KEY",
            label: "API Key",
            secret: true,
            required: true,
          },
        ],
      },
    ]);

    expect(
      getModelCacheRefreshProviderIds(DEFAULT_RUNTIME_CONFIG, {
        byoKeyProvidersEnabled: true,
        configuredProviderIds: ["anthropic"],
      }),
    ).toEqual(["anthropic", "codex-acp"]);
  });

  it("does not refresh unconfigured setup providers at startup", () => {
    useProviderCatalogStore.getState().mergeEntries([
      {
        ...catalogEntry("anthropic", "model"),
        catalogSource: "setup",
        setupCatalogProvider: true,
      },
      {
        ...catalogEntry("openrouter", "model"),
        catalogSource: "setup",
        setupCatalogProvider: true,
      },
    ]);

    expect(
      getModelCacheRefreshProviderIds(DEFAULT_RUNTIME_CONFIG, {
        byoKeyProvidersEnabled: true,
        configuredProviderIds: ["anthropic"],
      }),
    ).toEqual(["anthropic", "codex-acp"]);
  });

  it("does not include unconfigured providers when bring-your-own-key is on", () => {
    useProviderCatalogStore.getState().mergeEntries([
      {
        ...catalogEntry("ollama", "model"),
        fields: [
          {
            key: "OLLAMA_HOST",
            label: "Host",
            secret: false,
            required: true,
          },
        ],
      },
    ]);

    expect(
      getModelCacheRefreshProviderIds(DEFAULT_RUNTIME_CONFIG, {
        byoKeyProvidersEnabled: true,
      }),
    ).toEqual(["codex-acp"]);
  });

  it("includes explicitly refreshable runtime model providers", () => {
    expect(
      getModelCacheRefreshProviderIds({
        ...MANAGED_RUNTIME_CONFIG,
        goose: {
          ...MANAGED_RUNTIME_CONFIG.goose,
          modelProviders: [
            {
              ...MANAGED_RUNTIME_CONFIG.goose.modelProviders[0],
              modelInventoryMode: "refreshable",
            },
          ],
        },
      }),
    ).toEqual(["databricks_v2", "codex-acp"]);
  });
});

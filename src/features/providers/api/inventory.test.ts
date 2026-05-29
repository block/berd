import type { ProviderInventoryEntryDto } from "@aaif/goose-sdk";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  backgroundRefreshInventory,
  fetchProviderSupportedModels,
  getProviderInventory,
} from "./inventory";

const mockClient = vi.hoisted(() => ({
  GooseUnstableProvidersList: vi.fn(),
  GooseUnstableProvidersInventoryRefresh: vi.fn(),
  GooseUnstableProvidersSupportedModelsList: vi.fn(),
}));

vi.mock("@/shared/api/acpConnection", () => ({
  getClient: vi.fn(async () => ({
    goose: mockClient,
  })),
}));

function providerEntry(
  overrides: Partial<ProviderInventoryEntryDto>,
): ProviderInventoryEntryDto {
  return {
    providerId: "openai",
    providerName: "OpenAI",
    description: "",
    defaultModel: "",
    configured: false,
    providerType: "Preferred",
    category: "model",
    configKeys: [],
    setupSteps: [],
    supportsRefresh: false,
    refreshing: false,
    models: [],
    stale: false,
    ...overrides,
  };
}

describe("backgroundRefreshInventory", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockClient.GooseUnstableProvidersSupportedModelsList.mockResolvedValue({
      providerId: "",
      models: [],
    });
  });

  it("merges fetched inventory before returning when no providers are configured", async () => {
    const entries = [
      providerEntry({ providerId: "openai", providerName: "OpenAI" }),
    ];
    const inventoryStore = { mergeEntries: vi.fn() };
    mockClient.GooseUnstableProvidersList.mockResolvedValue({ entries });

    await backgroundRefreshInventory(inventoryStore);

    expect(inventoryStore.mergeEntries).toHaveBeenCalledWith(entries);
    expect(
      mockClient.GooseUnstableProvidersInventoryRefresh,
    ).not.toHaveBeenCalled();
  });

  it("merges fetched inventory before returning when no refresh starts", async () => {
    const entries = [
      providerEntry({
        providerId: "openai",
        providerName: "OpenAI",
        configured: true,
      }),
    ];
    const inventoryStore = { mergeEntries: vi.fn() };
    mockClient.GooseUnstableProvidersList.mockResolvedValue({ entries });
    mockClient.GooseUnstableProvidersInventoryRefresh.mockResolvedValue({
      started: [],
    });

    await backgroundRefreshInventory(inventoryStore);

    expect(inventoryStore.mergeEntries).toHaveBeenCalledWith(entries);
    expect(
      mockClient.GooseUnstableProvidersInventoryRefresh,
    ).toHaveBeenCalledWith({
      providerIds: ["openai"],
    });
  });

  it("does not re-merge entries supplied by a caller that already stored them", async () => {
    const entries = [
      providerEntry({
        providerId: "openai",
        providerName: "OpenAI",
        configured: true,
      }),
    ];
    const inventoryStore = { mergeEntries: vi.fn() };
    mockClient.GooseUnstableProvidersInventoryRefresh.mockResolvedValue({
      started: [],
    });

    await backgroundRefreshInventory(inventoryStore, {
      initialEntries: entries,
    });

    expect(mockClient.GooseUnstableProvidersList).not.toHaveBeenCalled();
    expect(inventoryStore.mergeEntries).not.toHaveBeenCalled();
    expect(
      mockClient.GooseUnstableProvidersInventoryRefresh,
    ).toHaveBeenCalledWith({
      providerIds: ["openai"],
    });
  });

  it("refreshes only configured providers inside the supported refresh set", async () => {
    const entries = [
      providerEntry({
        providerId: "atomic_chat",
        providerName: "Atomic Chat",
        configured: true,
      }),
      providerEntry({
        providerId: "claude-acp",
        providerName: "Claude Code",
        configured: true,
        category: "agent",
      }),
      providerEntry({
        providerId: "databricks_v2",
        providerName: "Databricks AI Gateway",
        configured: true,
      }),
    ];
    const inventoryStore = { mergeEntries: vi.fn() };
    mockClient.GooseUnstableProvidersInventoryRefresh.mockResolvedValue({
      started: [],
    });

    await backgroundRefreshInventory(inventoryStore, {
      initialEntries: entries,
      rawSupportedModelsCache: new Map(),
      rawSupportedModelsProviderIds: new Set(["databricks_v2"]),
      refreshProviderIds: new Set(["claude-acp", "databricks_v2"]),
    });

    expect(
      mockClient.GooseUnstableProvidersInventoryRefresh,
    ).toHaveBeenCalledWith({
      providerIds: ["claude-acp", "databricks_v2"],
    });
  });
});

describe("fetchProviderSupportedModels", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns the raw model IDs from the ACP response", async () => {
    mockClient.GooseUnstableProvidersSupportedModelsList.mockResolvedValue({
      providerId: "databricks_v2",
      models: ["claude-opus-4-8", "goose-claude-opus-4-7"],
    });

    const models = await fetchProviderSupportedModels("databricks_v2");

    expect(models).toEqual(["claude-opus-4-8", "goose-claude-opus-4-7"]);
    expect(
      mockClient.GooseUnstableProvidersSupportedModelsList,
    ).toHaveBeenCalledWith({ providerId: "databricks_v2" });
  });
});

describe("getProviderInventory", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("appends raw supported model IDs not already present in the recommended list", async () => {
    mockClient.GooseUnstableProvidersList.mockResolvedValue({
      entries: [
        providerEntry({
          providerId: "databricks_v2",
          providerName: "Databricks AI Gateway",
          configured: true,
          models: [
            {
              id: "goose-claude-opus-4-7",
              name: "Claude Opus 4.7",
              recommended: true,
              contextLimit: 200000,
            },
          ],
        }),
      ],
    });
    mockClient.GooseUnstableProvidersSupportedModelsList.mockResolvedValue({
      providerId: "databricks_v2",
      models: ["goose-claude-opus-4-7", "claude-opus-4-8"],
    });

    const entries = await getProviderInventory();

    expect(entries[0]?.models).toEqual([
      {
        id: "goose-claude-opus-4-7",
        name: "Claude Opus 4.7",
        recommended: true,
        contextLimit: 200000,
      },
      { id: "claude-opus-4-8", name: "Claude Opus 4.8", recommended: false },
    ]);
  });

  it("skips the raw fetch for providers that are not configured", async () => {
    mockClient.GooseUnstableProvidersList.mockResolvedValue({
      entries: [
        providerEntry({
          providerId: "anthropic",
          providerName: "Anthropic",
          configured: false,
        }),
      ],
    });

    const entries = await getProviderInventory();

    expect(
      mockClient.GooseUnstableProvidersSupportedModelsList,
    ).not.toHaveBeenCalled();
    expect(entries[0]?.models).toEqual([]);
  });

  it("skips raw fetches for providers outside the raw supported-model allowlist", async () => {
    mockClient.GooseUnstableProvidersList.mockResolvedValue({
      entries: [
        providerEntry({
          providerId: "aws_bedrock",
          providerName: "Bedrock",
          configured: true,
          models: [{ id: "claude-3-5-sonnet", name: "Claude 3.5 Sonnet" }],
        }),
        providerEntry({
          providerId: "databricks_v2",
          providerName: "Databricks AI Gateway",
          configured: true,
          models: [],
        }),
      ],
    });
    mockClient.GooseUnstableProvidersSupportedModelsList.mockResolvedValue({
      providerId: "databricks_v2",
      models: ["goose-claude-opus-4-7"],
    });

    const entries = await getProviderInventory(undefined, {
      rawSupportedModelsProviderIds: new Set(["databricks_v2"]),
    });

    expect(
      mockClient.GooseUnstableProvidersSupportedModelsList,
    ).toHaveBeenCalledTimes(1);
    expect(
      mockClient.GooseUnstableProvidersSupportedModelsList,
    ).toHaveBeenCalledWith({ providerId: "databricks_v2" });
    expect(entries.map((entry) => entry.providerId)).toEqual([
      "aws_bedrock",
      "databricks_v2",
    ]);
    expect(
      entries.find((entry) => entry.providerId === "databricks_v2")?.models,
    ).toEqual([
      {
        id: "goose-claude-opus-4-7",
        name: "Claude Opus 4.7",
        recommended: false,
      },
    ]);
  });

  it("falls back to the recommended list when the raw fetch fails", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    mockClient.GooseUnstableProvidersList.mockResolvedValue({
      entries: [
        providerEntry({
          providerId: "databricks_v2",
          providerName: "Databricks AI Gateway",
          configured: true,
          models: [{ id: "goose-claude-opus-4-7", name: "Claude Opus 4.7" }],
        }),
      ],
    });
    mockClient.GooseUnstableProvidersSupportedModelsList.mockRejectedValue(
      new Error("supported-models endpoint not implemented"),
    );

    const entries = await getProviderInventory();

    expect(entries[0]?.models).toEqual([
      { id: "goose-claude-opus-4-7", name: "Claude Opus 4.7" },
    ]);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("caches raw supported model failures as null for the shared cache", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const cache = new Map<string, Promise<string[] | null>>();
    mockClient.GooseUnstableProvidersList.mockResolvedValue({
      entries: [
        providerEntry({
          providerId: "databricks_v2",
          providerName: "Databricks AI Gateway",
          configured: true,
          models: [{ id: "goose-claude-opus-4-7", name: "Claude Opus 4.7" }],
        }),
      ],
    });
    mockClient.GooseUnstableProvidersSupportedModelsList.mockRejectedValue(
      new Error("supported-models endpoint not implemented"),
    );

    const firstEntries = await getProviderInventory(undefined, {
      rawSupportedModelsCache: cache,
    });
    const secondEntries = await getProviderInventory(undefined, {
      rawSupportedModelsCache: cache,
    });

    expect(
      mockClient.GooseUnstableProvidersSupportedModelsList,
    ).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(firstEntries[0]?.models).toEqual([
      { id: "goose-claude-opus-4-7", name: "Claude Opus 4.7" },
    ]);
    expect(secondEntries[0]?.models).toEqual(firstEntries[0]?.models);
    warn.mockRestore();
  });
});

import { beforeEach, describe, expect, it, vi } from "vitest";
import { useProviderCatalogStore } from "@/features/providers/stores/providerCatalogStore";
import { useRuntimeConfigStore } from "@/shared/runtime-config/runtimeConfigStore";
import type { RuntimeConfig } from "@/shared/runtime-config/schema";
import { getClient } from "@/shared/api/acpConnection";
import {
  repairManagedGooseModelSelection,
  resetManagedModelSelectionRepairCacheForTests,
} from "./managedModelSelectionRepair";
import { notifyProviderModelInventoryInvalidated } from "./providerModelInventoryEvents";

vi.mock("@/shared/api/acpConnection", () => ({
  getClient: vi.fn(),
  invalidateClientConnection: vi.fn().mockResolvedValue(undefined),
}));

const managedConfig: RuntimeConfig = {
  schemaVersion: 1,
  goose: {
    defaultModelProviderId: "databricks_v2",
    defaultModelId: "goose-gpt-5-5",
    modelProviders: [
      {
        id: "databricks_v2",
        displayName: "Databricks v2",
        models: [{ id: "goose-gpt-5-5", name: "GPT-5.5" }],
      },
    ],
  },
};

describe("repairManagedGooseModelSelection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetManagedModelSelectionRepairCacheForTests();
    useRuntimeConfigStore.setState({
      loaded: true,
      config: managedConfig,
      result: { status: "ready", source: "endpoint", config: managedConfig },
    });
    useProviderCatalogStore.setState({
      entries: [
        {
          id: "goose",
          displayName: "Goose",
          category: "agent",
          description: "Goose agent",
          setupMethod: "none",
          group: "default",
          catalogSource: "setup",
        },
        {
          id: "claude-acp",
          displayName: "Claude Code",
          category: "agent",
          description: "Claude Code agent",
          setupMethod: "none",
          group: "default",
          catalogSource: "setup",
        },
      ],
      loaded: true,
    });
  });

  it("keeps an authoritative-empty same-provider target provider-only", async () => {
    vi.mocked(getClient).mockResolvedValue({
      goose: {
        GooseUnstableProvidersSupportedModelsList: vi.fn().mockResolvedValue({
          models: [],
        }),
      },
    } as never);

    await expect(
      repairManagedGooseModelSelection(
        { providerId: "databricks_v2" },
        "session",
      ),
    ).resolves.toEqual({ providerId: "databricks_v2", modelId: undefined });
  });

  it("preserves same-provider model-free intent when live proof cannot be read", async () => {
    vi.mocked(getClient).mockRejectedValue(new Error("offline"));

    await expect(
      repairManagedGooseModelSelection(
        { providerId: "databricks_v2" },
        "session",
      ),
    ).resolves.toEqual({ providerId: "databricks_v2", modelId: undefined });
  });

  it("repairs any model absent from the live target-provider inventory", async () => {
    vi.mocked(getClient).mockResolvedValue({
      goose: {
        GooseUnstableProvidersSupportedModelsList: vi.fn().mockResolvedValue({
          models: ["goose-gpt-5-5"],
        }),
      },
    } as never);

    await expect(
      repairManagedGooseModelSelection(
        { providerId: "databricks_v2", modelId: "arbitrary-missing-model" },
        "session",
      ),
    ).resolves.toEqual({
      providerId: "databricks_v2",
      modelId: "goose-gpt-5-5",
    });
  });

  it("drops its cached inventory when the provider inventory refreshes", async () => {
    const supportedModelsList = vi
      .fn()
      .mockResolvedValueOnce({ models: ["goose-gpt-5-5"] })
      .mockResolvedValueOnce({
        models: ["goose-gpt-5-5", "newly-available-model"],
      });
    vi.mocked(getClient).mockResolvedValue({
      goose: {
        GooseUnstableProvidersSupportedModelsList: supportedModelsList,
      },
    } as never);

    await repairManagedGooseModelSelection(
      { providerId: "databricks_v2", modelId: "goose-gpt-5-5" },
      "session",
    );
    notifyProviderModelInventoryInvalidated("databricks_v2");

    await expect(
      repairManagedGooseModelSelection(
        {
          providerId: "databricks_v2",
          modelId: "newly-available-model",
        },
        "session",
      ),
    ).resolves.toEqual({
      providerId: "databricks_v2",
      modelId: "newly-available-model",
    });
    expect(supportedModelsList).toHaveBeenCalledTimes(2);
  });

  it("does not reuse or cache an inventory request started before invalidation", async () => {
    let resolveOldInventory!: (value: { models: string[] }) => void;
    const oldInventory = new Promise<{ models: string[] }>((resolve) => {
      resolveOldInventory = resolve;
    });
    const supportedModelsList = vi
      .fn()
      .mockReturnValueOnce(oldInventory)
      .mockResolvedValueOnce({
        models: ["goose-gpt-5-5", "newly-available-model"],
      });
    vi.mocked(getClient).mockResolvedValue({
      goose: {
        GooseUnstableProvidersSupportedModelsList: supportedModelsList,
      },
    } as never);

    const oldRepair = repairManagedGooseModelSelection(
      { providerId: "databricks_v2", modelId: "old-model" },
      "session",
    );
    await vi.waitFor(() =>
      expect(supportedModelsList).toHaveBeenCalledTimes(1),
    );

    notifyProviderModelInventoryInvalidated("databricks_v2");
    const newRepair = repairManagedGooseModelSelection(
      { providerId: "databricks_v2", modelId: "newly-available-model" },
      "session",
    );
    await expect(newRepair).resolves.toEqual({
      providerId: "databricks_v2",
      modelId: "newly-available-model",
    });

    resolveOldInventory({ models: ["goose-gpt-5-5"] });
    await expect(oldRepair).resolves.toEqual({
      providerId: "databricks_v2",
      modelId: "goose-gpt-5-5",
    });

    await expect(
      repairManagedGooseModelSelection(
        {
          providerId: "databricks_v2",
          modelId: "newly-available-model",
        },
        "session",
      ),
    ).resolves.toEqual({
      providerId: "databricks_v2",
      modelId: "newly-available-model",
    });
    expect(supportedModelsList).toHaveBeenCalledTimes(2);
  });

  it("releases same-provider proof after stalled client acquisition", async () => {
    vi.useFakeTimers();
    vi.mocked(getClient).mockReturnValue(new Promise(() => {}));

    const repair = repairManagedGooseModelSelection(
      { providerId: "databricks_v2", modelId: "future-model" },
      "session",
    );
    await vi.advanceTimersByTimeAsync(60_000);
    await expect(repair).resolves.toEqual({
      providerId: "databricks_v2",
      modelId: "future-model",
    });

    vi.mocked(getClient).mockResolvedValue({
      goose: {
        GooseUnstableProvidersSupportedModelsList: vi.fn().mockResolvedValue({
          models: ["future-model"],
        }),
      },
    } as never);
    await expect(
      repairManagedGooseModelSelection(
        { providerId: "databricks_v2", modelId: "future-model" },
        "session",
      ),
    ).resolves.toEqual({
      providerId: "databricks_v2",
      modelId: "future-model",
    });
  });

  it("releases same-provider proof after stalled inventory RPC", async () => {
    vi.useFakeTimers();
    const stalledInventory = new Promise<{ models: string[] }>(() => {});
    const supportedModelsList = vi
      .fn()
      .mockReturnValueOnce(stalledInventory)
      .mockResolvedValueOnce({ models: ["future-model"] });
    vi.mocked(getClient).mockResolvedValue({
      goose: { GooseUnstableProvidersSupportedModelsList: supportedModelsList },
    } as never);

    const repair = repairManagedGooseModelSelection(
      { providerId: "databricks_v2", modelId: "future-model" },
      "session",
    );
    await vi.advanceTimersByTimeAsync(60_000);
    await expect(repair).resolves.toEqual({
      providerId: "databricks_v2",
      modelId: "future-model",
    });
    await expect(
      repairManagedGooseModelSelection(
        { providerId: "databricks_v2", modelId: "future-model" },
        "session",
      ),
    ).resolves.toEqual({
      providerId: "databricks_v2",
      modelId: "future-model",
    });
    expect(supportedModelsList).toHaveBeenCalledTimes(2);
  });
  it("preserves the selected model when live inventory cannot be read", async () => {
    vi.mocked(getClient).mockRejectedValue(new Error("offline"));

    await expect(
      repairManagedGooseModelSelection(
        { providerId: "databricks_v2", modelId: "future-model" },
        "session",
      ),
    ).resolves.toEqual({
      providerId: "databricks_v2",
      modelId: "future-model",
    });
  });

  it("still resolves the built-in Goose harness through model-provider policy", async () => {
    vi.mocked(getClient).mockResolvedValue({
      goose: {
        GooseUnstableProvidersSupportedModelsList: vi.fn().mockResolvedValue({
          models: ["goose-gpt-5-5"],
        }),
      },
    } as never);

    await expect(
      repairManagedGooseModelSelection(
        { providerId: "goose", modelId: "missing-model" },
        "session",
      ),
    ).resolves.toEqual({
      providerId: "databricks_v2",
      modelId: "goose-gpt-5-5",
    });
  });

  it("leaves external agent harness targets outside Goose model-provider policy", async () => {
    await expect(
      repairManagedGooseModelSelection(
        { providerId: "claude-acp", modelId: "current" },
        "new_session",
      ),
    ).resolves.toEqual({ providerId: "claude-acp", modelId: "current" });
    expect(getClient).not.toHaveBeenCalled();
  });
});

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

  it("repairs a model excluded by the runtime prefix allowlist", async () => {
    const filteredConfig: RuntimeConfig = {
      ...managedConfig,
      goose: {
        ...managedConfig.goose,
        modelProviders: [
          {
            ...managedConfig.goose.modelProviders[0],
            allowedModelIdPrefixes: ["goose-", "team.approved."],
          },
        ],
      },
    };
    useRuntimeConfigStore.setState({
      config: filteredConfig,
      result: {
        status: "ready",
        source: "endpoint",
        config: filteredConfig,
      },
    });
    vi.mocked(getClient).mockResolvedValue({
      goose: {
        GooseUnstableProvidersSupportedModelsList: vi.fn().mockResolvedValue({
          models: ["goose-gpt-5-5", "other.schema.chat-model"],
        }),
      },
    } as never);

    await expect(
      repairManagedGooseModelSelection(
        {
          providerId: "databricks_v2",
          modelId: "other.schema.chat-model",
        },
        "session",
      ),
    ).resolves.toEqual({
      providerId: "databricks_v2",
      modelId: "goose-gpt-5-5",
    });
  });

  it("preserves a runtime-declared model outside the discovery allowlist", async () => {
    const configuredModelId = "curated.special.model";
    const filteredConfig: RuntimeConfig = {
      ...managedConfig,
      goose: {
        ...managedConfig.goose,
        modelProviders: [
          {
            ...managedConfig.goose.modelProviders[0],
            allowedModelIdPrefixes: ["goose-"],
            models: [
              ...managedConfig.goose.modelProviders[0].models,
              { id: configuredModelId, name: "Curated model" },
            ],
          },
        ],
      },
    };
    useRuntimeConfigStore.setState({ config: filteredConfig });
    vi.mocked(getClient).mockResolvedValue({
      goose: {
        GooseUnstableProvidersSupportedModelsList: vi.fn().mockResolvedValue({
          models: ["goose-gpt-5-5", configuredModelId],
        }),
      },
    } as never);

    await expect(
      repairManagedGooseModelSelection(
        { providerId: "databricks_v2", modelId: configuredModelId },
        "session",
      ),
    ).resolves.toEqual({
      providerId: "databricks_v2",
      modelId: configuredModelId,
    });
  });

  it("preserves an allowed selection when discovery is temporarily partial", async () => {
    const filteredConfig: RuntimeConfig = {
      ...managedConfig,
      goose: {
        ...managedConfig.goose,
        modelProviders: [
          {
            ...managedConfig.goose.modelProviders[0],
            allowedModelIdPrefixes: ["goose-", "team.approved."],
          },
        ],
      },
    };
    useRuntimeConfigStore.setState({ config: filteredConfig });
    vi.mocked(getClient).mockResolvedValue({
      goose: {
        GooseUnstableProvidersSupportedModelsList: vi.fn().mockResolvedValue({
          models: ["goose-gpt-5-5"],
        }),
      },
    } as never);

    await expect(
      repairManagedGooseModelSelection(
        {
          providerId: "databricks_v2",
          modelId: "team.approved.chat-model",
        },
        "session",
      ),
    ).resolves.toEqual({
      providerId: "databricks_v2",
      modelId: "team.approved.chat-model",
    });
  });

  it("applies the current prefix policy when config changes during discovery", async () => {
    let resolveInventory!: (value: { models: string[] }) => void;
    const inventory = new Promise<{ models: string[] }>((resolve) => {
      resolveInventory = resolve;
    });
    const initiallyAllowedConfig: RuntimeConfig = {
      ...managedConfig,
      goose: {
        ...managedConfig.goose,
        modelProviders: [
          {
            ...managedConfig.goose.modelProviders[0],
            allowedModelIdPrefixes: ["team."],
          },
        ],
      },
    };
    useRuntimeConfigStore.setState({ config: initiallyAllowedConfig });
    vi.mocked(getClient).mockResolvedValue({
      goose: {
        GooseUnstableProvidersSupportedModelsList: vi
          .fn()
          .mockReturnValue(inventory),
      },
    } as never);

    const repair = repairManagedGooseModelSelection(
      { providerId: "databricks_v2", modelId: "team.chat-model" },
      "session",
    );
    useRuntimeConfigStore.setState({
      config: {
        ...initiallyAllowedConfig,
        goose: {
          ...initiallyAllowedConfig.goose,
          modelProviders: [
            {
              ...initiallyAllowedConfig.goose.modelProviders[0],
              allowedModelIdPrefixes: ["goose-"],
            },
          ],
        },
      },
    });
    resolveInventory({ models: ["goose-gpt-5-5", "team.chat-model"] });

    await expect(repair).resolves.toEqual({
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

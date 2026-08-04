import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ProviderConfigStatusDto } from "@aaif/goose-sdk";
import {
  saveDefaultProviderSelection,
  saveDefaultProviderSelectionFromConfiguredProvider,
} from "./defaultProviderConfig";
import { setStoredModelPreference } from "@/features/chat/lib/modelPreferences";
import { getClient } from "@/shared/api/acpConnection";
import { useProviderModelCacheStore } from "./stores/providerModelCacheStore";
import { useDefaultProviderReadinessStore } from "./stores/defaultProviderReadinessStore";
import { useProviderCatalogStore } from "./stores/providerCatalogStore";
import { useRuntimeConfigStore } from "@/shared/runtime-config/runtimeConfigStore";
import { DEFAULT_RUNTIME_CONFIG } from "@/shared/runtime-config/schema";

vi.mock("@/shared/api/acpConnection", () => ({
  getClient: vi.fn(),
}));

vi.mock("@/features/chat/lib/modelPreferences", () => ({
  setStoredModelPreference: vi.fn(),
}));

function status(
  providerId: string,
  isConfigured: boolean,
): ProviderConfigStatusDto {
  return { providerId, isConfigured } as ProviderConfigStatusDto;
}

const mockGetClient = vi.mocked(getClient);
const mockSetStoredModelPreference = vi.mocked(setStoredModelPreference);

const defaultsSave = vi.fn();

describe("saveDefaultProviderSelection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetClient.mockResolvedValue({
      goose: {
        GooseUnstableDefaultsSave: defaultsSave,
        GooseUnstableDefaultsRead: vi
          .fn()
          .mockResolvedValue({ providerId: "openai", modelId: "gpt-4o" }),
        GooseUnstableProvidersConfigStatus: vi.fn().mockResolvedValue({
          statuses: [{ providerId: "openai", isConfigured: true }],
        }),
      },
    } as never);
    useProviderModelCacheStore.setState({ providers: new Map() });
    useDefaultProviderReadinessStore.setState({
      readiness: null,
    });
  });

  it("saves backend defaults, local goose preference, and readiness", async () => {
    const refreshProviderModels = vi.fn().mockImplementation((providerId) => {
      useProviderModelCacheStore.setState({
        providers: new Map([
          [
            providerId,
            {
              providerId,
              fetchedAt: Date.now(),
              models: [{ id: "gpt-4o", name: "gpt-4o", recommended: true }],
            },
          ],
        ]),
      });
    });
    useProviderModelCacheStore.setState({ refreshProviderModels });

    await expect(saveDefaultProviderSelection("openai")).resolves.toEqual({
      providerId: "openai",
      modelId: "gpt-4o",
      modelName: "gpt-4o",
    });

    expect(defaultsSave).toHaveBeenCalledWith({
      providerId: "openai",
      modelId: "gpt-4o",
    });
    expect(mockSetStoredModelPreference).toHaveBeenCalledWith("goose", {
      providerId: "openai",
      modelId: "gpt-4o",
      modelName: "gpt-4o",
    });
    expect(useDefaultProviderReadinessStore.getState().readiness).toEqual({
      status: "ready",
      providerId: "openai",
      modelId: "gpt-4o",
    });
  });
});

describe("saveDefaultProviderSelectionFromConfiguredProvider", () => {
  function secret(provider: string) {
    return {
      id: `secret_store:${provider}:KEY`,
      provider,
      providerDisplayName: provider,
      name: "KEY",
      storage: "secret_store",
      status: "unknown",
      configured: true,
      hasSecret: true,
      canDelete: true,
      canConfigure: false,
    };
  }

  function mockClientWithStatuses(
    statuses: ProviderConfigStatusDto[],
    secrets: unknown[] = [],
  ) {
    mockGetClient.mockResolvedValue({
      goose: {
        GooseUnstableDefaultsSave: defaultsSave,
        GooseUnstableDefaultsRead: vi
          .fn()
          .mockResolvedValue({ providerId: "openai", modelId: "gpt-4o" }),
        GooseUnstableProvidersConfigStatus: vi
          .fn()
          .mockResolvedValue({ statuses }),
        GooseUnstableProvidersSecretsList: vi
          .fn()
          .mockResolvedValue({ secrets }),
      },
    } as never);
  }

  beforeEach(() => {
    vi.clearAllMocks();
    useRuntimeConfigStore.setState({
      loaded: true,
      config: DEFAULT_RUNTIME_CONFIG,
      result: {
        status: "ready",
        source: "appDefault",
        config: DEFAULT_RUNTIME_CONFIG,
      },
    });
    useProviderCatalogStore.getState().mergeEntries([
      {
        id: "openai",
        displayName: "OpenAI",
        category: "model",
        description: "OpenAI models",
        setupMethod: "single_api_key",
        group: "default",
        catalogSource: "setup",
        fields: [
          {
            key: "OPENAI_API_KEY",
            label: "API key",
            secret: true,
            required: true,
          },
        ],
      },
      {
        id: "databricks_v2",
        displayName: "Databricks AI Gateway",
        category: "model",
        description: "Managed Databricks models",
        setupMethod: "host_with_oauth_fallback",
        group: "default",
        catalogSource: "runtime",
      },
      {
        id: "lmstudio",
        displayName: "LM Studio",
        category: "model",
        description: "Local models",
        setupMethod: "config_fields",
        group: "additional",
        catalogSource: "setup",
        fields: [
          {
            key: "LMSTUDIO_HOST",
            label: "Host URL",
            secret: false,
            required: false,
            defaultValue: "http://localhost:1234",
          },
        ],
      },
    ]);
    const refreshProviderModels = vi.fn().mockImplementation((providerId) => {
      useProviderModelCacheStore.setState({
        providers: new Map([
          [
            providerId,
            {
              providerId,
              fetchedAt: Date.now(),
              models: [{ id: "gpt-4o", name: "gpt-4o", recommended: true }],
            },
          ],
        ]),
      });
    });
    useProviderModelCacheStore.setState({ refreshProviderModels });
  });

  it("restores a provider with a stored Goose credential and skips the rest", async () => {
    mockClientWithStatuses(
      [
        status("lmstudio", true),
        status("databricks_v2", true),
        status("openai", true),
      ],
      [secret("openai")],
    );

    await expect(
      saveDefaultProviderSelectionFromConfiguredProvider(),
    ).resolves.toEqual({
      providerId: "openai",
      modelId: "gpt-4o",
      modelName: "gpt-4o",
    });
    expect(defaultsSave).toHaveBeenCalledWith({
      providerId: "openai",
      modelId: "gpt-4o",
    });
  });

  it("does not recover a credentialless provider even with changed settings", async () => {
    mockClientWithStatuses([status("lmstudio", true)], []);

    await expect(
      saveDefaultProviderSelectionFromConfiguredProvider(),
    ).resolves.toBeNull();
    expect(defaultsSave).not.toHaveBeenCalled();
  });

  it("ignores stored credentials for providers Goose does not report configured", async () => {
    mockClientWithStatuses([status("lmstudio", true)], [secret("openai")]);

    await expect(
      saveDefaultProviderSelectionFromConfiguredProvider(),
    ).resolves.toBeNull();
    expect(defaultsSave).not.toHaveBeenCalled();
  });

  it("restores a configured runtime-managed provider when defaults were lost", async () => {
    mockClientWithStatuses(
      [status("lmstudio", true), status("databricks_v2", true)],
      [],
    );

    await expect(
      saveDefaultProviderSelectionFromConfiguredProvider(),
    ).resolves.toEqual({
      providerId: "databricks_v2",
      modelId: "gpt-4o",
      modelName: "gpt-4o",
    });
    expect(defaultsSave).toHaveBeenCalledWith({
      providerId: "databricks_v2",
      modelId: "gpt-4o",
    });
  });
});

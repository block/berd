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
  function mockClientWithStatuses(statuses: ProviderConfigStatusDto[]) {
    mockGetClient.mockResolvedValue({
      goose: {
        GooseUnstableDefaultsSave: defaultsSave,
        GooseUnstableDefaultsRead: vi
          .fn()
          .mockResolvedValue({ providerId: "openai", modelId: "gpt-4o" }),
        GooseUnstableProvidersConfigStatus: vi
          .fn()
          .mockResolvedValue({ statuses }),
      },
    } as never);
  }

  beforeEach(() => {
    vi.clearAllMocks();
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

  it("saves the first configured BYO key provider as the default", async () => {
    mockClientWithStatuses([
      status("databricks_v2", true),
      status("openai", true),
    ]);

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

  it("returns null when no BYO key provider is configured", async () => {
    mockClientWithStatuses([status("databricks_v2", true)]);

    await expect(
      saveDefaultProviderSelectionFromConfiguredProvider(),
    ).resolves.toBeNull();
    expect(defaultsSave).not.toHaveBeenCalled();
  });
});

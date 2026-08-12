import { beforeEach, describe, expect, it, vi } from "vitest";
import { readDefaultProviderReadiness } from "./defaultProviderReadiness";
import { checkAllProviderStatus } from "./api/credentials";
import { getClient } from "@/shared/api/acpConnection";

vi.mock("@/shared/api/acpConnection", () => ({
  getClient: vi.fn(),
}));

vi.mock("./api/credentials", () => ({
  checkAllProviderStatus: vi.fn(),
}));

const mockGetClient = vi.mocked(getClient);
const mockCheckAllProviderStatus = vi.mocked(checkAllProviderStatus);

function mockDefaults(defaults: {
  providerId: string | null;
  modelId: string | null;
}) {
  mockGetClient.mockResolvedValue({
    goose: {
      GooseUnstableDefaultsRead: vi.fn().mockResolvedValue(defaults),
    },
  } as never);
}

describe("readDefaultProviderReadiness", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCheckAllProviderStatus.mockResolvedValue([]);
  });

  it("requires setup when defaults are missing", async () => {
    mockDefaults({ providerId: null, modelId: null });

    await expect(readDefaultProviderReadiness()).resolves.toEqual({
      status: "needs_setup",
      reason: "missing_defaults",
    });
  });

  it("does not treat configured databricks_v2 as a ready Goose default fallback", async () => {
    mockDefaults({ providerId: null, modelId: null });
    mockCheckAllProviderStatus.mockResolvedValue([
      { providerId: "databricks_v2", isConfigured: true },
    ] as never);

    await expect(readDefaultProviderReadiness()).resolves.toEqual({
      status: "needs_setup",
      reason: "missing_defaults",
    });
  });

  it.each([
    ["missing", "openai", null],
    ["the Goose harness sentinel", "databricks_v2", "goose"],
  ])("requires setup when the default model is %s", async (_, providerId, modelId) => {
    mockDefaults({ providerId, modelId });

    await expect(readDefaultProviderReadiness()).resolves.toEqual({
      status: "needs_setup",
      reason: "model_missing",
      providerId,
    });
    expect(mockCheckAllProviderStatus).not.toHaveBeenCalled();
  });

  it("requires setup when the default provider is unconfigured", async () => {
    mockDefaults({ providerId: "openai", modelId: "gpt-4o" });
    mockCheckAllProviderStatus.mockResolvedValue([
      { providerId: "openai", isConfigured: false },
    ] as never);

    await expect(readDefaultProviderReadiness()).resolves.toEqual({
      status: "needs_setup",
      reason: "provider_unconfigured",
      providerId: "openai",
      modelId: "gpt-4o",
    });
  });

  it("is ready when the default provider is configured", async () => {
    mockDefaults({ providerId: "openai", modelId: "gpt-4o" });
    mockCheckAllProviderStatus.mockResolvedValue([
      { providerId: "openai", isConfigured: true },
    ] as never);

    await expect(readDefaultProviderReadiness()).resolves.toEqual({
      status: "ready",
      providerId: "openai",
      modelId: "gpt-4o",
    });
  });
});

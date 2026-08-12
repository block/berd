import { beforeEach, describe, expect, it, vi } from "vitest";

const mockGooseDefaultsRead = vi.fn();

vi.mock("@/shared/api/acpConnection", () => ({
  getClient: async () => ({
    goose: {
      GooseUnstableDefaultsRead: (...args: unknown[]) =>
        mockGooseDefaultsRead(...args),
    },
  }),
}));

describe("readDefaultModelStatus", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns modelMissing: false when both provider and model are set", async () => {
    mockGooseDefaultsRead.mockResolvedValue({
      providerId: "databricks",
      modelId: "compass-openai-gpt-5-5",
    });

    const { readDefaultModelStatus } = await import("./defaultModel");
    const status = await readDefaultModelStatus();

    expect(status).toEqual({
      providerId: "databricks",
      modelId: "compass-openai-gpt-5-5",
      modelMissing: false,
    });
  });

  it.each([
    ["an empty", "", "databricks"],
    ["a null", null, "databricks"],
    ["a whitespace-only", "   ", "databricks"],
    ["the Goose harness sentinel", "goose", "databricks_v2"],
  ])("treats %s model id as missing", async (_, modelId, providerId) => {
    mockGooseDefaultsRead.mockResolvedValue({ providerId, modelId });

    const { readDefaultModelStatus } = await import("./defaultModel");
    const status = await readDefaultModelStatus();

    expect(status).toEqual({
      providerId,
      modelId: undefined,
      modelMissing: true,
    });
  });

  it("does not flag modelMissing when the provider itself is unset", async () => {
    mockGooseDefaultsRead.mockResolvedValue({
      providerId: null,
      modelId: null,
    });

    const { readDefaultModelStatus } = await import("./defaultModel");
    const status = await readDefaultModelStatus();

    expect(status).toEqual({
      providerId: undefined,
      modelId: undefined,
      modelMissing: false,
    });
  });
});

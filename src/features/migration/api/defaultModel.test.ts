import { beforeEach, describe, expect, it, vi } from "vitest";

const mockGooseDefaultsRead = vi.fn();

vi.mock("@/shared/api/acpConnection", () => ({
  getClient: async () => ({
    goose: {
      GooseDefaultsRead: (...args: unknown[]) => mockGooseDefaultsRead(...args),
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

  it("treats an empty string model id as missing", async () => {
    mockGooseDefaultsRead.mockResolvedValue({
      providerId: "databricks",
      modelId: "",
    });

    const { readDefaultModelStatus } = await import("./defaultModel");
    const status = await readDefaultModelStatus();

    expect(status).toEqual({
      providerId: "databricks",
      modelId: undefined,
      modelMissing: true,
    });
  });

  it("treats a null model id as missing", async () => {
    mockGooseDefaultsRead.mockResolvedValue({
      providerId: "databricks",
      modelId: null,
    });

    const { readDefaultModelStatus } = await import("./defaultModel");
    const status = await readDefaultModelStatus();

    expect(status.modelMissing).toBe(true);
    expect(status.modelId).toBeUndefined();
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

  it("trims whitespace-only ids to undefined", async () => {
    mockGooseDefaultsRead.mockResolvedValue({
      providerId: "databricks",
      modelId: "   ",
    });

    const { readDefaultModelStatus } = await import("./defaultModel");
    const status = await readDefaultModelStatus();

    expect(status.modelMissing).toBe(true);
    expect(status.modelId).toBeUndefined();
  });
});

import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockReadDefaultModelStatus = vi.fn();
const mockGooseDefaultsSave = vi.fn();
const mockSetStoredModelPreference = vi.fn();

vi.mock("../api/defaultModel", () => ({
  readDefaultModelStatus: (...args: unknown[]) =>
    mockReadDefaultModelStatus(...args),
}));

vi.mock("@/shared/api/acpConnection", () => ({
  getClient: async () => ({
    goose: {
      GooseUnstableDefaultsSave: (...args: unknown[]) =>
        mockGooseDefaultsSave(...args),
    },
  }),
}));

vi.mock("@/features/chat/lib/modelPreferences", () => ({
  setStoredModelPreference: (...args: unknown[]) =>
    mockSetStoredModelPreference(...args),
}));

vi.mock("../lib/constants", () => ({
  DEFAULT_PROVIDER_ID: "databricks",
  DEFAULT_MODEL_ID: "compass-openai-gpt-5-5",
  DEFAULT_MODEL_NAME: "GPT-5.5",
}));

describe("useDefaultModelGate", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGooseDefaultsSave.mockResolvedValue(undefined);
  });

  it("stays loading until the migration gate is ready", async () => {
    mockReadDefaultModelStatus.mockResolvedValue({
      providerId: "databricks",
      modelId: "compass-openai-gpt-5-5",
      modelMissing: false,
    });

    const { useDefaultModelGate } = await import("./useDefaultModelGate");
    const { result } = renderHook(() => useDefaultModelGate(false));

    expect(result.current.status).toBe("loading");
    expect(mockReadDefaultModelStatus).not.toHaveBeenCalled();
  });

  it("resolves to ok without healing when the model is already set", async () => {
    mockReadDefaultModelStatus.mockResolvedValue({
      providerId: "databricks",
      modelId: "compass-openai-gpt-5-5",
      modelMissing: false,
    });

    const { useDefaultModelGate } = await import("./useDefaultModelGate");
    const { result } = renderHook(() => useDefaultModelGate(true));

    await waitFor(() => expect(result.current.status).toBe("ok"));
    expect(mockGooseDefaultsSave).not.toHaveBeenCalled();
    expect(mockSetStoredModelPreference).not.toHaveBeenCalled();
  });

  it("re-saves the default model when the broken state is detected", async () => {
    mockReadDefaultModelStatus.mockResolvedValue({
      providerId: "databricks",
      modelId: undefined,
      modelMissing: true,
    });

    const { useDefaultModelGate } = await import("./useDefaultModelGate");
    const { result } = renderHook(() => useDefaultModelGate(true));

    await waitFor(() => expect(result.current.status).toBe("ok"));

    expect(mockGooseDefaultsSave).toHaveBeenCalledWith({
      providerId: "databricks",
      modelId: "compass-openai-gpt-5-5",
    });
    expect(mockSetStoredModelPreference).toHaveBeenCalledWith("goose", {
      providerId: "databricks",
      modelId: "compass-openai-gpt-5-5",
      modelName: "GPT-5.5",
    });
  });

  it("does not heal when the broken provider is not the default", async () => {
    mockReadDefaultModelStatus.mockResolvedValue({
      providerId: "openai",
      modelId: undefined,
      modelMissing: true,
    });

    const { useDefaultModelGate } = await import("./useDefaultModelGate");
    const { result } = renderHook(() => useDefaultModelGate(true));

    await waitFor(() => expect(result.current.status).toBe("ok"));
    expect(mockGooseDefaultsSave).not.toHaveBeenCalled();
    expect(mockSetStoredModelPreference).not.toHaveBeenCalled();
  });

  it("surfaces a retryable error when the read fails", async () => {
    const readError = new Error("read failed");
    mockReadDefaultModelStatus.mockRejectedValueOnce(readError);

    const { useDefaultModelGate } = await import("./useDefaultModelGate");
    const { result } = renderHook(() => useDefaultModelGate(true));

    await waitFor(() => expect(result.current.status).toBe("error"));
    expect(result.current.error).toBe(readError);

    mockReadDefaultModelStatus.mockResolvedValueOnce({
      providerId: "databricks",
      modelId: "compass-openai-gpt-5-5",
      modelMissing: false,
    });

    await act(async () => {
      result.current.retry();
    });

    await waitFor(() => expect(result.current.status).toBe("ok"));
  });

  it("surfaces a retryable error when the heal save fails", async () => {
    mockReadDefaultModelStatus.mockResolvedValue({
      providerId: "databricks",
      modelId: undefined,
      modelMissing: true,
    });
    const saveError = new Error("save failed");
    mockGooseDefaultsSave.mockRejectedValueOnce(saveError);

    const { useDefaultModelGate } = await import("./useDefaultModelGate");
    const { result } = renderHook(() => useDefaultModelGate(true));

    await waitFor(() => expect(result.current.status).toBe("error"));
    expect(result.current.error).toBe(saveError);
    expect(mockSetStoredModelPreference).not.toHaveBeenCalled();
  });
});

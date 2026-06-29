import { renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockReadDefaultModelStatus = vi.fn();
const mockGooseDefaultsSave = vi.fn();
const mockGetStoredModelPreference = vi.fn();
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
  getStoredModelPreference: (...args: unknown[]) =>
    mockGetStoredModelPreference(...args),
  setStoredModelPreference: (...args: unknown[]) =>
    mockSetStoredModelPreference(...args),
}));

vi.mock("@/features/runtime-config/defaults", () => ({
  getDefaultGooseModelProviderId: () => "databricks_v2",
  getDefaultGooseModelId: () => "goose-gpt-5-5",
  getDefaultGooseModelName: () => "GPT-5.5",
}));

describe("useDefaultModelGate", () => {
  let consoleError: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockGetStoredModelPreference.mockReturnValue(null);
    mockGooseDefaultsSave.mockResolvedValue(undefined);
    consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    consoleError.mockRestore();
  });

  it("does not read defaults until the migration gate is ready", async () => {
    const { useDefaultModelGate } = await import("./useDefaultModelGate");

    renderHook(() => useDefaultModelGate(false));

    expect(mockReadDefaultModelStatus).not.toHaveBeenCalled();
  });

  it("re-saves the default model when the broken state is detected", async () => {
    mockReadDefaultModelStatus.mockResolvedValue({
      providerId: "databricks_v2",
      modelId: undefined,
      modelMissing: true,
    });

    const { useDefaultModelGate } = await import("./useDefaultModelGate");
    renderHook(() => useDefaultModelGate(true));

    await waitFor(() =>
      expect(mockGooseDefaultsSave).toHaveBeenCalledWith({
        providerId: "databricks_v2",
        modelId: "goose-gpt-5-5",
      }),
    );
    expect(mockSetStoredModelPreference).toHaveBeenCalledWith("goose", {
      providerId: "databricks_v2",
      modelId: "goose-gpt-5-5",
      modelName: "GPT-5.5",
    });
    expect(consoleError).not.toHaveBeenCalled();
  });

  it("does not overwrite an existing local preference after repair", async () => {
    mockReadDefaultModelStatus.mockResolvedValue({
      providerId: "databricks_v2",
      modelId: undefined,
      modelMissing: true,
    });
    mockGetStoredModelPreference.mockReturnValueOnce({
      providerId: "openai",
      modelId: "gpt-5.4",
      modelName: "GPT-5.4",
    });

    const { useDefaultModelGate } = await import("./useDefaultModelGate");
    renderHook(() => useDefaultModelGate(true));

    await waitFor(() =>
      expect(mockGooseDefaultsSave).toHaveBeenCalledWith({
        providerId: "databricks_v2",
        modelId: "goose-gpt-5-5",
      }),
    );
    expect(mockSetStoredModelPreference).not.toHaveBeenCalled();
  });

  it("does not repair when the broken provider is not the default", async () => {
    mockReadDefaultModelStatus.mockResolvedValue({
      providerId: "openai",
      modelId: undefined,
      modelMissing: true,
    });

    const { useDefaultModelGate } = await import("./useDefaultModelGate");
    renderHook(() => useDefaultModelGate(true));

    await waitFor(() =>
      expect(mockReadDefaultModelStatus).toHaveBeenCalledTimes(1),
    );
    expect(mockGooseDefaultsSave).not.toHaveBeenCalled();
    expect(mockSetStoredModelPreference).not.toHaveBeenCalled();
  });

  it("logs read failures without surfacing state", async () => {
    const readError = new Error("read failed");
    mockReadDefaultModelStatus.mockRejectedValueOnce(readError);

    const { useDefaultModelGate } = await import("./useDefaultModelGate");
    renderHook(() => useDefaultModelGate(true));

    await waitFor(() =>
      expect(consoleError).toHaveBeenCalledWith(
        "Failed to repair default model:",
        readError,
      ),
    );
    expect(mockGooseDefaultsSave).not.toHaveBeenCalled();
  });

  it("logs save failures without writing the local preference", async () => {
    mockReadDefaultModelStatus.mockResolvedValue({
      providerId: "databricks_v2",
      modelId: undefined,
      modelMissing: true,
    });
    const saveError = new Error("save failed");
    mockGooseDefaultsSave.mockRejectedValueOnce(saveError);

    const { useDefaultModelGate } = await import("./useDefaultModelGate");
    renderHook(() => useDefaultModelGate(true));

    await waitFor(() =>
      expect(consoleError).toHaveBeenCalledWith(
        "Failed to repair default model:",
        saveError,
      ),
    );
    expect(mockSetStoredModelPreference).not.toHaveBeenCalled();
  });
});

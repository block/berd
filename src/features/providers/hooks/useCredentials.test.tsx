import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useProviderModelCacheStore } from "../stores/providerModelCacheStore";
import { useDefaultProviderReadinessStore } from "../stores/defaultProviderReadinessStore";
import { saveDefaultProviderSelection } from "../defaultProviderConfig";
import { useCredentials } from "./useCredentials";

const mocks = vi.hoisted(() => ({
  checkAllProviderStatus: vi.fn(),
  deleteProviderConfig: vi.fn(),
  getProviderConfig: vi.fn(),
  saveProviderConfig: vi.fn(),
  refreshProviderModels: vi.fn(),
  invalidateProvider: vi.fn(),
  refreshDefaultProviderReadiness: vi.fn(),
}));

vi.mock("@/features/providers/api/credentials", () => ({
  checkAllProviderStatus: mocks.checkAllProviderStatus,
  deleteProviderConfig: mocks.deleteProviderConfig,
  getProviderConfig: mocks.getProviderConfig,
  saveProviderConfig: mocks.saveProviderConfig,
}));

vi.mock("../defaultProviderConfig", () => ({
  saveDefaultProviderSelection: vi.fn().mockResolvedValue({
    providerId: "anthropic",
    modelId: "claude-sonnet-4",
    modelName: "Claude Sonnet 4",
  }),
}));

describe("useCredentials", () => {
  const saveResponse = {
    status: {
      providerId: "anthropic",
      isConfigured: true,
    },
  };
  const deleteResponse = {
    status: {
      providerId: "anthropic",
      isConfigured: false,
    },
  };

  beforeEach(() => {
    vi.clearAllMocks();
    useProviderModelCacheStore.setState({
      providers: new Map(),
      refreshingProviderIds: new Set(),
      refreshProviderModels: mocks.refreshProviderModels,
      invalidateProvider: mocks.invalidateProvider,
    });
    mocks.checkAllProviderStatus.mockResolvedValue([
      {
        providerId: "anthropic",
        isConfigured: true,
      },
    ]);
    mocks.saveProviderConfig.mockResolvedValue(saveResponse);
    mocks.deleteProviderConfig.mockResolvedValue(deleteResponse);
    mocks.refreshProviderModels.mockResolvedValue(undefined);
    vi.mocked(saveDefaultProviderSelection).mockResolvedValue({
      providerId: "anthropic",
      modelId: "claude-sonnet-4",
      modelName: "Claude Sonnet 4",
    });
    mocks.refreshDefaultProviderReadiness.mockResolvedValue({
      status: "ready",
      providerId: "anthropic",
    });
    useDefaultProviderReadinessStore.setState({
      readiness: { status: "ready", providerId: "anthropic" },
      refresh: mocks.refreshDefaultProviderReadiness,
    });
  });

  it("saves secret fields through the credential API and refreshes provider models without requiring restart", async () => {
    const { result } = renderHook(() => useCredentials());
    await waitFor(() => expect(result.current.loading).toBe(false));

    await act(async () => {
      await result.current.save("anthropic", [
        {
          key: "ANTHROPIC_API_KEY",
          value: "sk-ant-test",
          isSecret: true,
        },
      ]);
    });

    expect(mocks.saveProviderConfig).toHaveBeenCalledWith("anthropic", [
      {
        key: "ANTHROPIC_API_KEY",
        value: "sk-ant-test",
      },
    ]);
    expect(mocks.invalidateProvider).toHaveBeenCalledWith("anthropic");
    await waitFor(() =>
      expect(mocks.refreshProviderModels).toHaveBeenCalledWith("anthropic", {
        force: true,
      }),
    );
    expect(result.current).not.toHaveProperty("needsRestart");
    expect(result.current).not.toHaveProperty("restart");
  });

  it("records refresh failure as a provider warning without rejecting the save", async () => {
    const refreshError = new Error("Internal error") as Error & {
      data: string;
    };
    refreshError.name = "RequestError";
    refreshError.data = "model list failed with provider detail";
    mocks.refreshProviderModels.mockRejectedValueOnce(refreshError);
    const { result } = renderHook(() => useCredentials());
    await waitFor(() => expect(result.current.loading).toBe(false));

    await act(async () => {
      await result.current.save("anthropic", [
        {
          key: "ANTHROPIC_API_KEY",
          value: "sk-ant-test",
          isSecret: true,
        },
      ]);
    });

    expect(mocks.saveProviderConfig).toHaveBeenCalled();
    await waitFor(() =>
      expect(result.current.modelWarnings.get("anthropic")).toContain(
        "model list failed with provider detail",
      ),
    );
  });

  it("uses a provider setup warning when model defaults cannot be saved", async () => {
    vi.mocked(saveDefaultProviderSelection).mockRejectedValueOnce(
      new Error("model list unavailable"),
    );
    useDefaultProviderReadinessStore.setState({
      readiness: { status: "needs_setup", reason: "missing_defaults" },
    });
    const { result } = renderHook(() => useCredentials());
    await waitFor(() => expect(result.current.loading).toBe(false));

    await act(async () => {
      await result.current.save("anthropic", [
        {
          key: "ANTHROPIC_API_KEY",
          value: "sk-ant-test",
          isSecret: true,
        },
      ]);
    });

    expect(mocks.saveProviderConfig).toHaveBeenCalled();
    expect(result.current.modelWarnings.get("anthropic")).toContain(
      "model list unavailable",
    );
  });

  it("refreshes default provider readiness after deleting provider config", async () => {
    const { result } = renderHook(() => useCredentials());
    await waitFor(() => expect(result.current.loading).toBe(false));

    await act(async () => {
      await result.current.remove("anthropic");
    });

    expect(mocks.deleteProviderConfig).toHaveBeenCalledWith("anthropic");
    expect(mocks.invalidateProvider).toHaveBeenCalledWith("anthropic");
    expect(mocks.refreshDefaultProviderReadiness).toHaveBeenCalledTimes(1);
  });

  it("suppresses stale refresh errors after deleting provider config", async () => {
    let rejectRefresh!: (error: Error) => void;
    const refreshPromise = new Promise<void>((_resolve, reject) => {
      rejectRefresh = reject;
    });
    mocks.refreshProviderModels.mockReturnValueOnce(refreshPromise);
    const { result } = renderHook(() => useCredentials());
    await waitFor(() => expect(result.current.loading).toBe(false));

    await act(async () => {
      await result.current.save("anthropic", [
        {
          key: "ANTHROPIC_API_KEY",
          value: "sk-ant-test",
          isSecret: true,
        },
      ]);
    });
    expect(result.current.syncingProviderIds.has("anthropic")).toBe(true);

    await act(async () => {
      await result.current.remove("anthropic");
    });
    await act(async () => {
      rejectRefresh(new Error("old refresh failure"));
      await refreshPromise.catch(() => undefined);
    });

    expect(mocks.invalidateProvider).toHaveBeenCalledWith("anthropic");
    expect(result.current.modelWarnings.has("anthropic")).toBe(false);
    expect(result.current.syncingProviderIds.has("anthropic")).toBe(false);
  });

  it("refreshes native OAuth status before refreshing provider models", async () => {
    mocks.checkAllProviderStatus
      .mockResolvedValueOnce([
        {
          providerId: "chatgpt_codex",
          isConfigured: false,
        },
      ])
      .mockResolvedValueOnce([
        {
          providerId: "chatgpt_codex",
          isConfigured: true,
        },
      ]);

    const { result } = renderHook(() => useCredentials());
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.configuredIds.has("chatgpt_codex")).toBe(false);

    await act(async () => {
      await result.current.completeNativeSetup("chatgpt_codex");
    });

    expect(mocks.checkAllProviderStatus).toHaveBeenCalledTimes(2);
    expect(mocks.invalidateProvider).toHaveBeenCalledWith("chatgpt_codex");
    expect(mocks.refreshProviderModels).toHaveBeenCalledWith("chatgpt_codex", {
      force: true,
    });
    expect(result.current.configuredIds.has("chatgpt_codex")).toBe(true);
  });

  it("uses native OAuth ACP result without an extra status refresh", async () => {
    mocks.checkAllProviderStatus.mockResolvedValueOnce([
      {
        providerId: "chatgpt_codex",
        isConfigured: false,
      },
    ]);

    const { result } = renderHook(() => useCredentials());
    await waitFor(() => expect(result.current.loading).toBe(false));

    await act(async () => {
      await result.current.completeNativeSetup("chatgpt_codex", {
        status: {
          providerId: "chatgpt_codex",
          isConfigured: true,
        },
      } as never);
    });

    expect(mocks.checkAllProviderStatus).toHaveBeenCalledTimes(1);
    expect(mocks.invalidateProvider).toHaveBeenCalledWith("chatgpt_codex");
    expect(mocks.refreshProviderModels).toHaveBeenCalledWith("chatgpt_codex", {
      force: true,
    });
    expect(result.current.configuredIds.has("chatgpt_codex")).toBe(true);
  });
});

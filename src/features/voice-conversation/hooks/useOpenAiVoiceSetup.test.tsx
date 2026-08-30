import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenAiVoiceStatus } from "../api/openAiVoice";
import { useOpenAiVoiceSetup } from "./useOpenAiVoiceSetup";

const mocks = vi.hoisted(() => ({
  getStatus: vi.fn<() => Promise<OpenAiVoiceStatus>>(),
  settingsChanged: null as (() => void) | null,
  finishListening: null as (() => void) | null,
  listenerError: null as Error | null,
}));

vi.mock("../api/openAiVoice", () => ({
  getOpenAiVoiceStatus: () => mocks.getStatus(),
  listenToOpenAiVoiceSettings: (listener: () => void) => {
    mocks.settingsChanged = listener;
    if (mocks.listenerError) return Promise.reject(mocks.listenerError);
    return new Promise<() => void>((resolve) => {
      mocks.finishListening = () => resolve(() => undefined);
    });
  },
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((next, fail) => {
    resolve = next;
    reject = fail;
  });
  return { promise, reject, resolve };
}

function status(configured: boolean): OpenAiVoiceStatus {
  return {
    sttConfigured: configured,
    ttsConfigured: configured,
    sttConfigurationSource: "default",
    ttsConfigurationSource: "default",
    sttUnavailableReason: null,
    ttsUnavailableReason: null,
    transcriptionModel: "gpt-live-transcribe",
    speechModel: "gpt-4o-mini-tts",
    speechVoice: "marin",
    playbackSpeed: 1,
    ttsAvailable: true,
    unavailableReason: configured ? null : "missingApiKey",
  };
}

describe("useOpenAiVoiceSetup", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.settingsChanged = null;
    mocks.finishListening = null;
    mocks.listenerError = null;
  });

  it("keeps the latest credential refresh when responses resolve out of order", async () => {
    const initial = deferred<OpenAiVoiceStatus>();
    const refreshed = deferred<OpenAiVoiceStatus>();
    mocks.getStatus
      .mockReturnValueOnce(initial.promise)
      .mockReturnValueOnce(refreshed.promise);
    const { result } = renderHook(() => useOpenAiVoiceSetup());
    await waitFor(() => expect(mocks.settingsChanged).not.toBeNull());
    act(() => mocks.finishListening?.());
    await waitFor(() => expect(mocks.getStatus).toHaveBeenCalledTimes(1));

    act(() => mocks.settingsChanged?.());
    refreshed.resolve(status(true));
    await waitFor(() =>
      expect(result.current.status?.sttConfigured).toBe(true),
    );

    initial.resolve(status(false));
    await act(async () => Promise.resolve());

    expect(result.current.status?.sttConfigured).toBe(true);
  });

  it("refreshes after listener registration captures credential changes", async () => {
    mocks.getStatus.mockResolvedValue(status(true));
    const { result } = renderHook(() => useOpenAiVoiceSetup());

    await waitFor(() => expect(mocks.finishListening).not.toBeNull());
    expect(mocks.getStatus).not.toHaveBeenCalled();

    act(() => mocks.finishListening?.());

    await waitFor(() =>
      expect(result.current.status?.sttConfigured).toBe(true),
    );
  });

  it("still loads status when listener registration fails", async () => {
    mocks.listenerError = new Error("listener unavailable");
    mocks.getStatus.mockResolvedValue(status(true));

    const { result } = renderHook(() => useOpenAiVoiceSetup());

    await waitFor(() =>
      expect(result.current.status?.sttConfigured).toBe(true),
    );
  });

  it("clears stale readiness when a credential refresh fails", async () => {
    const refresh = deferred<OpenAiVoiceStatus>();
    mocks.getStatus
      .mockResolvedValueOnce(status(true))
      .mockReturnValueOnce(refresh.promise);
    const { result } = renderHook(() => useOpenAiVoiceSetup());
    await waitFor(() => expect(mocks.finishListening).not.toBeNull());
    act(() => mocks.finishListening?.());
    await waitFor(() =>
      expect(result.current.status?.ttsConfigured).toBe(true),
    );

    act(() => mocks.settingsChanged?.());
    refresh.reject(new Error("Keychain unavailable"));

    await waitFor(() => expect(result.current.status).toBeNull());
    expect(result.current.error).toBe("Keychain unavailable");
  });

  it("does not expose cached readiness while disabled", async () => {
    mocks.listenerError = new Error("listener unavailable");
    mocks.getStatus.mockResolvedValue(status(true));
    const { result, rerender } = renderHook(
      ({ enabled }) => useOpenAiVoiceSetup(enabled),
      { initialProps: { enabled: true } },
    );
    await waitFor(() =>
      expect(result.current.status?.ttsConfigured).toBe(true),
    );

    rerender({ enabled: false });

    expect(result.current).toEqual({ status: null, error: null });
  });
});

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
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

function status(configured: boolean): OpenAiVoiceStatus {
  return {
    configured,
    speechModel: "gpt-4o-mini-tts",
    speechVoice: "marin",
    playbackSpeed: 1,
    ttsAvailable: true,
    unavailableReason: configured ? null : "Configure OpenAI.",
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
    await waitFor(() => expect(result.current.status?.configured).toBe(true));

    initial.resolve(status(false));
    await act(async () => Promise.resolve());

    expect(result.current.status?.configured).toBe(true);
  });

  it("refreshes after listener registration captures credential changes", async () => {
    mocks.getStatus.mockResolvedValue(status(true));
    const { result } = renderHook(() => useOpenAiVoiceSetup());

    await waitFor(() => expect(mocks.finishListening).not.toBeNull());
    expect(mocks.getStatus).not.toHaveBeenCalled();

    act(() => mocks.finishListening?.());

    await waitFor(() => expect(result.current.status?.configured).toBe(true));
  });

  it("still loads status when listener registration fails", async () => {
    mocks.listenerError = new Error("listener unavailable");
    mocks.getStatus.mockResolvedValue(status(true));

    const { result } = renderHook(() => useOpenAiVoiceSetup());

    await waitFor(() => expect(result.current.status?.configured).toBe(true));
  });
});

import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenAiVoiceStatus } from "../api/openAiVoice";
import { useOpenAiVoiceSetup } from "./useOpenAiVoiceSetup";

const mocks = vi.hoisted(() => ({
  getStatus: vi.fn<() => Promise<OpenAiVoiceStatus>>(),
  configChanged: null as ((providerId: string) => void) | null,
}));

vi.mock("../api/openAiVoice", () => ({
  getOpenAiVoiceStatus: () => mocks.getStatus(),
}));

vi.mock("@/features/providers/api/credentials", () => ({
  onProviderConfigChanged: (listener: (providerId: string) => void) => {
    mocks.configChanged = listener;
    return Promise.resolve(vi.fn());
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
    transcriptionModel: "gpt-live-transcribe",
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
    mocks.configChanged = null;
  });

  it("keeps the latest credential refresh when responses resolve out of order", async () => {
    const initial = deferred<OpenAiVoiceStatus>();
    const refreshed = deferred<OpenAiVoiceStatus>();
    mocks.getStatus
      .mockReturnValueOnce(initial.promise)
      .mockReturnValueOnce(refreshed.promise);
    const { result } = renderHook(() => useOpenAiVoiceSetup());
    await waitFor(() => expect(mocks.configChanged).not.toBeNull());

    act(() => mocks.configChanged?.("openai"));
    refreshed.resolve(status(true));
    await waitFor(() => expect(result.current.status?.configured).toBe(true));

    initial.resolve(status(false));
    await act(async () => Promise.resolve());

    expect(result.current.status?.configured).toBe(true);
  });
});

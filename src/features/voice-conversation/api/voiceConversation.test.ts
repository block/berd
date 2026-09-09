import { beforeEach, describe, expect, it, vi } from "vitest";
import preparedSpeechOutcomes from "../../../../tests/contracts/voice/prepare-assistant-speech-outcomes.json";

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  listen: vi.fn(),
  setMicrophoneMuted: vi.fn(),
  startMicrophone: vi.fn(),
  stopMicrophone: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: mocks.listen }));
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({ label: "main" }),
}));
vi.mock("@/shared/lib/rendererInstance", () => ({
  getRendererInstance: () =>
    Promise.resolve({ rendererId: "renderer-test", rendererEpoch: 7 }),
}));
vi.mock("../lib/nativeMicrophone", () => ({
  startNativeMicrophone: mocks.startMicrophone,
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

import {
  acknowledgeVoiceConversationTranscript,
  blockNativeVoiceConversationStarts,
  drainVoiceConversationTranscripts,
  FOREGROUND_SESSION_CLAIM_TIMEOUT_MS,
  getVoiceConversationStatus,
  listenToVoiceConversation,
  openVoiceConversationSession,
  prepareAssistantSpeechOutcomeSchema,
  prepareVoiceConversationAssistantSpeech,
  cancelVoiceConversationAssistantSpeech,
  reconcileVoiceConversationMicrophone,
  releaseNativeVoiceConversationStartBlock,
  resetVoiceConversationForegroundSessionForTest,
  setVoiceConversationAssistantSpeaking,
  setVoiceConversationControlsSuppressed,
  setVoiceConversationForegroundSession,
  setVoiceConversationMicrophoneMuted,
  startVoiceConversation,
  VoiceMicrophoneCaptureError,
  showVoiceConversationControls,
  stopActiveMicrophoneForTest,
  stopVoiceConversationFromBuddy,
  stopVoiceConversation,
  stopVoiceConversationForReplacement,
} from "./voiceConversation";

describe("voice conversation API", () => {
  beforeEach(() => {
    stopActiveMicrophoneForTest();
    resetVoiceConversationForegroundSessionForTest();
    mocks.invoke.mockReset();
    mocks.listen.mockReset();
    mocks.startMicrophone.mockReset().mockResolvedValue({
      setMuted: mocks.setMicrophoneMuted,
      stop: mocks.stopMicrophone,
    });
    mocks.setMicrophoneMuted.mockReset();
    mocks.stopMicrophone.mockReset();
  });

  it("shares the real prepared-speech wire contract and rejects drift", async () => {
    const outcomes = prepareAssistantSpeechOutcomeSchema
      .array()
      .parse(preparedSpeechOutcomes);
    expect(outcomes).toEqual(preparedSpeechOutcomes);

    mocks.invoke.mockResolvedValueOnce({
      outcome: "admitted",
      speech_id: 7,
    });
    await expect(
      prepareVoiceConversationAssistantSpeech("session-1", 1, "hello", null),
    ).rejects.toThrow();
  });

  it("prepares and cancels assistant speech through the active renderer", async () => {
    mocks.invoke
      .mockResolvedValueOnce({ outcome: "admitted", speechId: 9 })
      .mockResolvedValueOnce(true);
    const acknowledgement = {
      lifecycleId: "lifecycle-1",
      id: "utterance-1",
      revision: 4,
    };

    await expect(
      prepareVoiceConversationAssistantSpeech(
        "session-1",
        4,
        "hello",
        acknowledgement,
      ),
    ).resolves.toEqual({ outcome: "admitted", speechId: 9 });
    await expect(
      cancelVoiceConversationAssistantSpeech("session-1", 4, 9),
    ).resolves.toBe(true);

    expect(mocks.invoke).toHaveBeenNthCalledWith(
      1,
      "prepare_native_voice_assistant_speech",
      {
        request: {
          sessionId: "session-1",
          expectedRevision: 4,
          text: "hello",
          acknowledgement,
          rendererId: "renderer-test",
          rendererEpoch: 7,
        },
      },
    );
    expect(mocks.invoke).toHaveBeenNthCalledWith(
      2,
      "cancel_native_voice_assistant_speech",
      {
        request: {
          sessionId: "session-1",
          expectedRevision: 4,
          speechId: 9,
          rendererId: "renderer-test",
          rendererEpoch: 7,
        },
      },
    );
  });

  it("uses the typed native command surface", async () => {
    const status = {
      available: true,
      unavailableReason: null,
      lifecycle: "running",
      sessionId: "session-1",
      ownerWindowLabel: "main",
      microphoneMuted: false,
      revision: 3,
    } as const;
    const stoppedStatus = {
      ...status,
      lifecycle: "stopped" as const,
      sessionId: null,
      ownerWindowLabel: null,
      revision: 4,
    };
    mocks.invoke
      .mockResolvedValueOnce(status)
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce(status)
      .mockResolvedValueOnce(status)
      .mockResolvedValueOnce(stoppedStatus);

    await expect(getVoiceConversationStatus()).resolves.toEqual(status);
    await expect(
      drainVoiceConversationTranscripts("session-1"),
    ).resolves.toEqual([]);
    await expect(
      acknowledgeVoiceConversationTranscript({
        sessionId: "session-1",
        lifecycleId: "lifecycle-1",
        id: "7",
        text: "hello",
        revision: 2,
        deliveryAttempts: 0,
      }),
    ).resolves.toEqual(status);
    await expect(startVoiceConversation("session-1", "macos")).resolves.toEqual(
      status,
    );
    await expect(stopVoiceConversation(status)).resolves.toEqual(stoppedStatus);

    expect(mocks.invoke).toHaveBeenNthCalledWith(
      1,
      "get_native_voice_conversation_status",
    );
    expect(mocks.invoke).toHaveBeenNthCalledWith(
      2,
      "drain_native_voice_conversation_transcripts",
      { sessionId: "session-1" },
    );
    expect(mocks.invoke).toHaveBeenNthCalledWith(
      3,
      "acknowledge_native_voice_conversation_transcript",
      { sessionId: "session-1", id: "7", revision: 2 },
    );
    expect(mocks.invoke).toHaveBeenNthCalledWith(
      4,
      "start_native_voice_conversation",
      {
        sessionId: "session-1",
        inputBackend: "macos",
        rendererId: "renderer-test",
        rendererEpoch: 7,
        foregroundGeneration: 0,
      },
    );
    expect(mocks.stopMicrophone).toHaveBeenCalledOnce();
    expect(mocks.invoke).toHaveBeenNthCalledWith(
      5,
      "stop_native_voice_conversation",
      {
        rendererId: "renderer-test",
        rendererEpoch: 7,
        sessionId: "session-1",
        expectedRevision: 3,
      },
    );
  });

  it("reserves voice starts across native windows", async () => {
    mocks.invoke
      .mockResolvedValueOnce("archive-token")
      .mockResolvedValueOnce(undefined);

    await expect(blockNativeVoiceConversationStarts("session-1")).resolves.toBe(
      "archive-token",
    );
    await releaseNativeVoiceConversationStartBlock(
      "session-1",
      "archive-token",
    );

    expect(mocks.invoke).toHaveBeenNthCalledWith(
      1,
      "block_native_voice_conversation_starts",
      {
        sessionId: "session-1",
        rendererId: "renderer-test",
        rendererEpoch: 7,
      },
    );
    expect(mocks.invoke).toHaveBeenNthCalledWith(
      2,
      "release_native_voice_conversation_start_block",
      { sessionId: "session-1", token: "archive-token" },
    );
  });

  it("publishes ordered foreground-session claims for native authorization", async () => {
    mocks.invoke.mockResolvedValue(undefined);

    await setVoiceConversationForegroundSession("session-b");
    await setVoiceConversationForegroundSession("session-c");
    await setVoiceConversationForegroundSession(null);

    expect(mocks.invoke.mock.calls).toEqual([
      [
        "set_voice_renderer_foreground_session",
        {
          request: {
            rendererId: "renderer-test",
            rendererEpoch: 7,
            generation: 1,
            sessionId: "session-b",
          },
        },
      ],
      [
        "set_voice_renderer_foreground_session",
        {
          request: {
            rendererId: "renderer-test",
            rendererEpoch: 7,
            generation: 2,
            sessionId: "session-c",
          },
        },
      ],
      [
        "set_voice_renderer_foreground_session",
        {
          request: {
            rendererId: "renderer-test",
            rendererEpoch: 7,
            generation: 3,
            sessionId: null,
          },
        },
      ],
    ]);
  });

  it("serializes floating-control visibility updates", async () => {
    let releaseFirst: (() => void) | undefined;
    mocks.invoke
      .mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            releaseFirst = resolve;
          }),
      )
      .mockResolvedValue(undefined);

    const first = setVoiceConversationControlsSuppressed("session-1", 3, true);
    const second = setVoiceConversationControlsSuppressed(
      "session-1",
      3,
      false,
    );
    await vi.waitFor(() => expect(mocks.invoke).toHaveBeenCalledTimes(1));
    releaseFirst?.();
    await Promise.all([first, second]);

    expect(mocks.invoke.mock.calls).toEqual([
      [
        "set_voice_conversation_controls_suppressed",
        {
          request: {
            sessionId: "session-1",
            expectedRevision: 3,
            suppressed: true,
            rendererId: "renderer-test",
            rendererEpoch: 7,
          },
        },
      ],
      [
        "set_voice_conversation_controls_suppressed",
        {
          request: {
            sessionId: "session-1",
            expectedRevision: 3,
            suppressed: false,
            rendererId: "renderer-test",
            rendererEpoch: 7,
          },
        },
      ],
    ]);
  });

  it("exposes the buddy control commands", async () => {
    mocks.invoke.mockResolvedValue(undefined);
    const status = {
      available: true,
      unavailableReason: null,
      lifecycle: "running" as const,
      sessionId: "session-1",
      ownerWindowLabel: "main",
      microphoneMuted: false,
      revision: 3,
    };

    await openVoiceConversationSession();
    await showVoiceConversationControls("session-1", 3);
    await setVoiceConversationControlsSuppressed("session-1", 3, true);
    await setVoiceConversationAssistantSpeaking("session-1", 3, true);
    await stopVoiceConversationFromBuddy(status);

    expect(mocks.invoke.mock.calls).toEqual([
      ["open_voice_conversation_session"],
      [
        "show_voice_conversation_controls",
        { sessionId: "session-1", expectedRevision: 3 },
      ],
      [
        "set_voice_conversation_controls_suppressed",
        {
          request: {
            sessionId: "session-1",
            expectedRevision: 3,
            suppressed: true,
            rendererId: "renderer-test",
            rendererEpoch: 7,
          },
        },
      ],
      [
        "set_native_voice_assistant_speaking",
        {
          request: {
            sessionId: "session-1",
            expectedRevision: 3,
            speaking: true,
            rendererId: "renderer-test",
            rendererEpoch: 7,
          },
        },
      ],
      [
        "stop_voice_conversation_from_buddy",
        { sessionId: "session-1", expectedRevision: 3 },
      ],
    ]);
  });

  it("can stop only the browser microphone for deterministic development tests", async () => {
    const status = {
      available: true,
      unavailableReason: null,
      lifecycle: "running",
      sessionId: "session-1",
      ownerWindowLabel: "main",
      microphoneMuted: false,
      revision: 3,
    } as const;
    mocks.invoke.mockResolvedValue(status);

    await startVoiceConversation("session-1");
    stopActiveMicrophoneForTest();

    expect(mocks.stopMicrophone).toHaveBeenCalledOnce();
    expect(mocks.invoke).toHaveBeenCalledOnce();
  });

  it("rolls back the exact native lifecycle when browser capture cannot start", async () => {
    const runningStatus = {
      available: true,
      unavailableReason: null,
      lifecycle: "running",
      sessionId: "session-1",
      ownerWindowLabel: "main",
      microphoneMuted: false,
      revision: 3,
    } as const;
    mocks.invoke.mockResolvedValueOnce(runningStatus).mockResolvedValueOnce({
      ...runningStatus,
      lifecycle: "stopped",
      sessionId: null,
      ownerWindowLabel: null,
      revision: 4,
    });
    mocks.startMicrophone.mockRejectedValueOnce(new Error("capture failed"));

    const request = startVoiceConversation("session-1");
    await expect(request).rejects.toThrow("capture failed");
    await expect(request).rejects.toBeInstanceOf(VoiceMicrophoneCaptureError);

    expect(mocks.invoke).toHaveBeenNthCalledWith(
      2,
      "stop_native_voice_conversation",
      {
        rendererId: "renderer-test",
        rendererEpoch: 7,
        sessionId: "session-1",
        expectedRevision: 3,
      },
    );
  });

  it("keeps capture attached when a stale stop returns a running lifecycle", async () => {
    const initialStatus = {
      available: true,
      unavailableReason: null,
      lifecycle: "running",
      sessionId: "session-1",
      ownerWindowLabel: "main",
      microphoneMuted: false,
      revision: 3,
    } as const;
    const replacementStatus = {
      ...initialStatus,
      sessionId: "session-2",
      revision: 5,
    };
    await reconcileVoiceConversationMicrophone(initialStatus);
    mocks.invoke.mockResolvedValueOnce(replacementStatus);

    await expect(stopVoiceConversation(initialStatus)).resolves.toEqual(
      replacementStatus,
    );

    expect(mocks.startMicrophone).toHaveBeenCalledOnce();
    expect(mocks.stopMicrophone).not.toHaveBeenCalled();
  });

  it("requests an exact lifecycle stop when replacing from another window", async () => {
    const activeStatus = {
      available: true,
      unavailableReason: null,
      lifecycle: "running" as const,
      sessionId: "session-1",
      ownerWindowLabel: "session-window-a",
      microphoneMuted: false,
      revision: 3,
    };
    const stoppedStatus = {
      ...activeStatus,
      lifecycle: "stopped" as const,
      sessionId: null,
      ownerWindowLabel: null,
      revision: 4,
    };
    mocks.invoke.mockResolvedValueOnce(undefined);
    await setVoiceConversationForegroundSession("session-2");
    mocks.invoke.mockReset().mockResolvedValueOnce(stoppedStatus);

    await expect(
      stopVoiceConversationForReplacement(activeStatus, "session-2"),
    ).resolves.toEqual(stoppedStatus);
    expect(mocks.invoke).toHaveBeenCalledWith(
      "stop_native_voice_conversation_for_replacement",
      {
        rendererId: "renderer-test",
        rendererEpoch: 7,
        sessionId: "session-1",
        expectedRevision: 3,
        targetSessionId: "session-2",
      },
    );
  });

  it("waits for the target foreground claim before requesting replacement", async () => {
    const activeStatus = {
      available: true,
      unavailableReason: null,
      lifecycle: "running" as const,
      sessionId: "session-1",
      ownerWindowLabel: "session-window-a",
      microphoneMuted: false,
      revision: 3,
    };
    const stoppedStatus = {
      ...activeStatus,
      lifecycle: "stopped" as const,
      sessionId: null,
      ownerWindowLabel: null,
      revision: 4,
    };
    const claim = deferred<void>();
    mocks.invoke
      .mockReturnValueOnce(claim.promise)
      .mockResolvedValueOnce(stoppedStatus);

    const publish = setVoiceConversationForegroundSession("session-b");
    const replacement = stopVoiceConversationForReplacement(
      activeStatus,
      "session-b",
    );
    await vi.waitFor(() => expect(mocks.invoke).toHaveBeenCalledTimes(1));
    expect(mocks.invoke).toHaveBeenLastCalledWith(
      "set_voice_renderer_foreground_session",
      expect.anything(),
    );

    claim.resolve();
    await publish;
    await expect(replacement).resolves.toEqual(stoppedStatus);
    expect(mocks.invoke).toHaveBeenNthCalledWith(
      2,
      "stop_native_voice_conversation_for_replacement",
      expect.objectContaining({ targetSessionId: "session-b" }),
    );
  });

  it("follows a newer claim for the same foreground session", async () => {
    const activeStatus = {
      available: true,
      unavailableReason: null,
      lifecycle: "running" as const,
      sessionId: "session-1",
      ownerWindowLabel: "session-window-a",
      microphoneMuted: false,
      revision: 3,
    };
    const stoppedStatus = {
      ...activeStatus,
      lifecycle: "stopped" as const,
      sessionId: null,
      ownerWindowLabel: null,
      revision: 4,
    };
    const firstClaim = deferred<void>();
    const secondClaim = deferred<void>();
    mocks.invoke
      .mockReturnValueOnce(firstClaim.promise)
      .mockReturnValueOnce(secondClaim.promise)
      .mockResolvedValueOnce(stoppedStatus);

    void setVoiceConversationForegroundSession("session-b");
    const replacement = stopVoiceConversationForReplacement(
      activeStatus,
      "session-b",
    );
    const publishSecond = setVoiceConversationForegroundSession("session-b");
    await vi.waitFor(() => expect(mocks.invoke).toHaveBeenCalledTimes(2));

    secondClaim.resolve();
    await publishSecond;
    await expect(replacement).resolves.toEqual(stoppedStatus);
    expect(mocks.invoke).toHaveBeenNthCalledWith(
      3,
      "stop_native_voice_conversation_for_replacement",
      expect.objectContaining({ targetSessionId: "session-b" }),
    );
  });

  it("rejects a replacement after foreground navigation changes", async () => {
    const activeStatus = {
      available: true,
      unavailableReason: null,
      lifecycle: "running" as const,
      sessionId: "session-1",
      ownerWindowLabel: "session-window-a",
      microphoneMuted: false,
      revision: 3,
    };
    const sessionBClaim = deferred<void>();
    mocks.invoke
      .mockReturnValueOnce(sessionBClaim.promise)
      .mockResolvedValueOnce(undefined);
    void setVoiceConversationForegroundSession("session-b");
    const replacement = stopVoiceConversationForReplacement(
      activeStatus,
      "session-b",
    );
    await setVoiceConversationForegroundSession("session-c");

    await expect(replacement).rejects.toThrow("no longer in the foreground");
    expect(mocks.invoke).toHaveBeenCalledTimes(2);
    expect(mocks.invoke).not.toHaveBeenCalledWith(
      "stop_native_voice_conversation_for_replacement",
      expect.anything(),
    );
  });

  it("renews a timed-out foreground claim for the next replacement", async () => {
    vi.useFakeTimers();
    try {
      const activeStatus = {
        available: true,
        unavailableReason: null,
        lifecycle: "running" as const,
        sessionId: "session-1",
        ownerWindowLabel: "session-window-a",
        microphoneMuted: false,
        revision: 3,
      };
      const claim = deferred<void>();
      const stoppedStatus = {
        ...activeStatus,
        lifecycle: "stopped" as const,
        sessionId: null,
        ownerWindowLabel: null,
        revision: 4,
      };
      mocks.invoke
        .mockReturnValueOnce(claim.promise)
        .mockResolvedValueOnce(undefined)
        .mockResolvedValueOnce(stoppedStatus);
      void setVoiceConversationForegroundSession("session-b");

      const replacement = stopVoiceConversationForReplacement(
        activeStatus,
        "session-b",
      );
      const rejection = expect(replacement).rejects.toThrow(
        "Foreground voice session confirmation timed out.",
      );
      await vi.advanceTimersByTimeAsync(FOREGROUND_SESSION_CLAIM_TIMEOUT_MS);

      await rejection;
      expect(mocks.invoke).toHaveBeenCalledTimes(2);
      expect(mocks.invoke).not.toHaveBeenCalledWith(
        "stop_native_voice_conversation_for_replacement",
        expect.anything(),
      );

      await expect(
        stopVoiceConversationForReplacement(activeStatus, "session-b"),
      ).resolves.toEqual(stoppedStatus);
      expect(mocks.invoke).toHaveBeenNthCalledWith(
        3,
        "stop_native_voice_conversation_for_replacement",
        expect.objectContaining({ targetSessionId: "session-b" }),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps one timeout deadline across same-session claims", async () => {
    vi.useFakeTimers();
    try {
      const activeStatus = {
        available: true,
        unavailableReason: null,
        lifecycle: "running" as const,
        sessionId: "session-1",
        ownerWindowLabel: "session-window-a",
        microphoneMuted: false,
        revision: 3,
      };
      mocks.invoke
        .mockReturnValueOnce(deferred<void>().promise)
        .mockReturnValueOnce(deferred<void>().promise);
      void setVoiceConversationForegroundSession("session-b");
      const replacement = stopVoiceConversationForReplacement(
        activeStatus,
        "session-b",
      );
      const rejection = expect(replacement).rejects.toThrow(
        "Foreground voice session confirmation timed out.",
      );

      await vi.advanceTimersByTimeAsync(
        FOREGROUND_SESSION_CLAIM_TIMEOUT_MS - 1,
      );
      void setVoiceConversationForegroundSession("session-b");
      await vi.advanceTimersByTimeAsync(1);

      await rejection;
      expect(mocks.invoke).toHaveBeenCalledTimes(3);
      expect(mocks.invoke).not.toHaveBeenCalledWith(
        "stop_native_voice_conversation_for_replacement",
        expect.anything(),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("reattaches browser capture when a reloaded renderer finds a running session", async () => {
    const status = {
      available: true,
      unavailableReason: null,
      lifecycle: "running",
      sessionId: "session-1",
      ownerWindowLabel: "main",
      microphoneMuted: false,
      revision: 3,
    } as const;

    await reconcileVoiceConversationMicrophone(status);
    await reconcileVoiceConversationMicrophone(status);

    expect(mocks.startMicrophone).toHaveBeenCalledOnce();
    stopActiveMicrophoneForTest();
    expect(mocks.stopMicrophone).toHaveBeenCalledOnce();
  });

  it("does not attach browser capture in a non-owning window", async () => {
    const status = {
      available: true,
      unavailableReason: null,
      lifecycle: "running",
      sessionId: "session-1",
      ownerWindowLabel: "session-window",
      microphoneMuted: false,
      revision: 3,
    } as const;

    await reconcileVoiceConversationMicrophone(status);

    expect(mocks.startMicrophone).not.toHaveBeenCalled();
  });

  it("mutes and unmutes without reopening browser capture", async () => {
    const status = {
      available: true,
      unavailableReason: null,
      lifecycle: "running",
      sessionId: "session-1",
      ownerWindowLabel: "main",
      microphoneMuted: false,
      revision: 3,
    } as const;

    mocks.invoke.mockImplementation((_command, payload) =>
      Promise.resolve({
        ...status,
        microphoneMuted: (payload as { request: { muted: boolean } }).request
          .muted,
      }),
    );
    await reconcileVoiceConversationMicrophone(status);
    await setVoiceConversationMicrophoneMuted(true, status);
    await reconcileVoiceConversationMicrophone({
      ...status,
      microphoneMuted: true,
    });
    await setVoiceConversationMicrophoneMuted(false, status);

    expect(mocks.startMicrophone).toHaveBeenCalledOnce();
    expect(mocks.stopMicrophone).not.toHaveBeenCalled();
    expect(mocks.setMicrophoneMuted.mock.calls).toEqual([
      [false],
      [true],
      [true],
      [false],
    ]);
    expect(mocks.invoke.mock.calls).toEqual([
      [
        "set_native_voice_microphone_muted",
        {
          request: {
            sessionId: "session-1",
            expectedRevision: 3,
            muted: true,
            rendererId: "renderer-test",
            rendererEpoch: 7,
          },
        },
      ],
      [
        "set_native_voice_microphone_muted",
        {
          request: {
            sessionId: "session-1",
            expectedRevision: 3,
            muted: false,
            rendererId: "renderer-test",
            rendererEpoch: 7,
          },
        },
      ],
    ]);
    expect(mocks.setMicrophoneMuted.mock.invocationCallOrder[1]).toBeLessThan(
      mocks.invoke.mock.invocationCallOrder[0],
    );
  });

  it("serializes rapid mute changes so the final state wins", async () => {
    const status = {
      available: true,
      unavailableReason: null,
      lifecycle: "running",
      sessionId: "session-1",
      ownerWindowLabel: "main",
      microphoneMuted: false,
      revision: 3,
    } as const;
    let resolveFirst!: (value: unknown) => void;
    const firstResponse = new Promise<unknown>((resolve) => {
      resolveFirst = resolve;
    });
    mocks.invoke
      .mockReturnValueOnce(firstResponse)
      .mockResolvedValueOnce(status);

    const mute = setVoiceConversationMicrophoneMuted(true, status);
    const unmute = setVoiceConversationMicrophoneMuted(false, status);

    await vi.waitFor(() => expect(mocks.invoke).toHaveBeenCalledOnce());
    resolveFirst({ ...status, microphoneMuted: true });
    await expect(mute).resolves.toMatchObject({ microphoneMuted: true });
    await expect(unmute).resolves.toMatchObject({ microphoneMuted: false });

    expect(mocks.invoke.mock.calls).toEqual([
      [
        "set_native_voice_microphone_muted",
        {
          request: {
            sessionId: "session-1",
            expectedRevision: 3,
            muted: true,
            rendererId: "renderer-test",
            rendererEpoch: 7,
          },
        },
      ],
      [
        "set_native_voice_microphone_muted",
        {
          request: {
            sessionId: "session-1",
            expectedRevision: 3,
            muted: false,
            rendererId: "renderer-test",
            rendererEpoch: 7,
          },
        },
      ],
    ]);
    expect(mocks.setMicrophoneMuted).toHaveBeenLastCalledWith(false);
  });

  it("keeps a newer native mute event over a stale action response", async () => {
    const status = {
      available: true,
      unavailableReason: null,
      lifecycle: "running",
      sessionId: "session-1",
      ownerWindowLabel: "main",
      microphoneMuted: false,
      revision: 3,
    } as const;
    let resolveMute!: (value: unknown) => void;
    mocks.invoke.mockReturnValueOnce(
      new Promise<unknown>((resolve) => {
        resolveMute = resolve;
      }),
    );
    await reconcileVoiceConversationMicrophone(status);

    const muting = setVoiceConversationMicrophoneMuted(true, status);
    await vi.waitFor(() => expect(mocks.invoke).toHaveBeenCalledOnce());
    await reconcileVoiceConversationMicrophone(status);
    resolveMute({ ...status, microphoneMuted: true });
    await muting;

    expect(mocks.setMicrophoneMuted).toHaveBeenLastCalledWith(false);
  });

  it("restores the previous mute state when initial capture fails", async () => {
    const status = {
      available: true,
      unavailableReason: null,
      lifecycle: "running",
      sessionId: "session-1",
      ownerWindowLabel: "main",
      microphoneMuted: false,
      revision: 3,
    } as const;

    mocks.startMicrophone.mockRejectedValueOnce(new Error("capture failed"));

    await expect(
      setVoiceConversationMicrophoneMuted(true, status),
    ).rejects.toThrow("capture failed");
    expect(mocks.invoke).not.toHaveBeenCalled();
    mocks.startMicrophone.mockResolvedValueOnce({
      setMuted: mocks.setMicrophoneMuted,
      stop: mocks.stopMicrophone,
    });
    await reconcileVoiceConversationMicrophone(status);

    expect(mocks.startMicrophone).toHaveBeenCalledTimes(2);
    expect(mocks.setMicrophoneMuted).toHaveBeenLastCalledWith(false);
  });

  it("unwraps native voice events", async () => {
    const callback = vi.fn();
    const unlisten = vi.fn();
    mocks.listen.mockImplementation(async (_name, handler) => {
      handler({
        payload: {
          type: "user",
          sessionId: "session-1",
          lifecycleId: "lifecycle-1",
          id: "7",
          text: "hello",
          revision: 4,
          deliveryAttempts: 0,
        },
      });
      return unlisten;
    });

    await expect(listenToVoiceConversation(callback)).resolves.toBe(unlisten);
    expect(callback).toHaveBeenCalledWith({
      type: "user",
      sessionId: "session-1",
      lifecycleId: "lifecycle-1",
      id: "7",
      text: "hello",
      revision: 4,
      deliveryAttempts: 0,
    });
  });

  it("unwraps semantic activity events", async () => {
    const callback = vi.fn();
    mocks.listen.mockImplementation(async (_name, handler) => {
      handler({
        payload: {
          type: "activity",
          sessionId: "session-1",
          activity: "user-speaking",
          revision: 5,
        },
      });
      return vi.fn();
    });

    await listenToVoiceConversation(callback);
    expect(callback).toHaveBeenCalledWith({
      type: "activity",
      sessionId: "session-1",
      activity: "user-speaking",
      revision: 5,
    });
  });

  it("does not let a stale lifecycle stop replacement capture", async () => {
    const firstStatus = {
      available: true,
      unavailableReason: null,
      lifecycle: "running",
      sessionId: "session-1",
      ownerWindowLabel: "main",
      microphoneMuted: false,
      revision: 3,
    } as const;
    await reconcileVoiceConversationMicrophone(firstStatus);
    await reconcileVoiceConversationMicrophone({
      ...firstStatus,
      sessionId: "session-2",
      revision: 5,
    });
    await reconcileVoiceConversationMicrophone({
      ...firstStatus,
      lifecycle: "stopped",
      sessionId: null,
      ownerWindowLabel: null,
      revision: 4,
    });

    expect(mocks.stopMicrophone).not.toHaveBeenCalled();
  });
});

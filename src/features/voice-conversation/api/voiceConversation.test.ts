import { beforeEach, describe, expect, it, vi } from "vitest";

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

import {
  acknowledgeVoiceConversationTranscript,
  blockNativeVoiceConversationStarts,
  drainVoiceConversationTranscripts,
  getVoiceConversationStatus,
  listenToVoiceConversation,
  openVoiceConversationSession,
  reconcileVoiceConversationMicrophone,
  releaseNativeVoiceConversationStartBlock,
  setVoiceConversationAssistantSpeaking,
  setVoiceConversationControlsSuppressed,
  setVoiceConversationMicrophoneMuted,
  startVoiceConversation,
  showVoiceConversationControls,
  stopActiveMicrophoneForTest,
  stopVoiceConversationFromBuddy,
  stopVoiceConversation,
} from "./voiceConversation";

describe("voice conversation API", () => {
  beforeEach(() => {
    stopActiveMicrophoneForTest();
    mocks.invoke.mockReset();
    mocks.listen.mockReset();
    mocks.startMicrophone.mockReset().mockResolvedValue({
      setMuted: mocks.setMicrophoneMuted,
      stop: mocks.stopMicrophone,
    });
    mocks.setMicrophoneMuted.mockReset();
    mocks.stopMicrophone.mockReset();
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
    await expect(startVoiceConversation("session-1")).resolves.toEqual(status);
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
        rendererId: "renderer-test",
        rendererEpoch: 7,
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
      { sessionId: "session-1" },
    );
    expect(mocks.invoke).toHaveBeenNthCalledWith(
      2,
      "release_native_voice_conversation_start_block",
      { sessionId: "session-1", token: "archive-token" },
    );
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
        { sessionId: "session-1", expectedRevision: 3, suppressed: true },
      ],
      [
        "set_voice_conversation_controls_suppressed",
        { sessionId: "session-1", expectedRevision: 3, suppressed: false },
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
        { sessionId: "session-1", expectedRevision: 3, suppressed: true },
      ],
      [
        "set_native_voice_assistant_speaking",
        { sessionId: "session-1", expectedRevision: 3, speaking: true },
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

    await expect(startVoiceConversation("session-1")).rejects.toThrow(
      "capture failed",
    );

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
        microphoneMuted: (payload as { muted: boolean }).muted,
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
        { sessionId: "session-1", expectedRevision: 3, muted: true },
      ],
      [
        "set_native_voice_microphone_muted",
        { sessionId: "session-1", expectedRevision: 3, muted: false },
      ],
    ]);
    expect(mocks.setMicrophoneMuted.mock.invocationCallOrder[1]).toBeLessThan(
      mocks.invoke.mock.invocationCallOrder[0],
    );
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

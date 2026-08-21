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
  applyVoiceConversationMicrophoneMuteEvent,
  applyVoiceConversationTerminalEvent,
  drainVoiceConversationTranscripts,
  getVoiceConversationMicrophoneMuted,
  getVoiceConversationStatus,
  hydrateVoiceConversationMicrophone,
  listenToVoiceConversation,
  openVoiceConversationSession,
  reconcileVoiceConversationMicrophone,
  setVoiceConversationAssistantSpeaking,
  setVoiceConversationControlsSuppressed,
  setVoiceConversationMicrophoneMuted,
  startVoiceConversation,
  showVoiceConversationControls,
  stopActiveMicrophoneForTest,
  stopVoiceConversationFromBuddy,
  stopVoiceConversation,
} from "./voiceConversation";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, reject, resolve };
}

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
    mocks.invoke
      .mockResolvedValueOnce(status)
      .mockResolvedValueOnce([])
      .mockResolvedValue(status);

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
    await expect(stopVoiceConversation()).resolves.toEqual(status);

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
      },
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

    await openVoiceConversationSession();
    await showVoiceConversationControls("session-1", 3);
    await setVoiceConversationControlsSuppressed("session-1", 3, true);
    await setVoiceConversationAssistantSpeaking("session-1", 3, true);
    await stopVoiceConversationFromBuddy();

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
      ["stop_voice_conversation_from_buddy"],
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

  it("hydrates browser capture from the authoritative native mute state", async () => {
    const status = {
      available: true,
      unavailableReason: null,
      lifecycle: "running",
      sessionId: "session-1",
      ownerWindowLabel: "main",
      revision: 3,
      nativeMicrophoneMuteControl: true,
      nativeMicrophoneMuted: true,
    } as const;

    await hydrateVoiceConversationMicrophone(status);

    expect(getVoiceConversationMicrophoneMuted()).toBe(true);
    expect(mocks.startMicrophone).toHaveBeenCalledOnce();
    expect(mocks.setMicrophoneMuted).toHaveBeenLastCalledWith(true);
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
      ["set_native_voice_microphone_muted", { muted: true }],
      ["set_native_voice_microphone_muted", { muted: false }],
    ]);
    expect(mocks.setMicrophoneMuted.mock.invocationCallOrder[1]).toBeLessThan(
      mocks.invoke.mock.invocationCallOrder[0],
    );
  });

  it("routes UI mute through macOS while keeping browser capture in sync", async () => {
    const status = {
      available: true,
      unavailableReason: null,
      lifecycle: "running",
      sessionId: "session-1",
      ownerWindowLabel: "main",
      revision: 3,
      nativeMicrophoneMuteControl: true,
    } as const;
    mocks.invoke.mockResolvedValue(undefined);

    await reconcileVoiceConversationMicrophone(status);
    await setVoiceConversationMicrophoneMuted(true, status);

    expect(mocks.invoke).toHaveBeenCalledWith("set_native_voice_input_muted", {
      sessionId: "session-1",
      revision: 3,
      muted: true,
    });
    expect(mocks.setMicrophoneMuted).toHaveBeenLastCalledWith(true);
  });

  it("serializes opposite native mute intents so the latest command wins", async () => {
    const status = {
      available: true,
      unavailableReason: null,
      lifecycle: "running",
      sessionId: "session-1",
      ownerWindowLabel: "main",
      revision: 3,
      nativeMicrophoneMuteControl: true,
    } as const;
    const first = deferred<void>();
    const second = deferred<void>();
    mocks.invoke
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);

    await reconcileVoiceConversationMicrophone(status);
    const mute = setVoiceConversationMicrophoneMuted(true, status);
    await vi.waitFor(() => expect(mocks.invoke).toHaveBeenCalledOnce());
    expect(mocks.invoke).toHaveBeenLastCalledWith(
      "set_native_voice_input_muted",
      expect.objectContaining({ muted: true }),
    );
    const unmute = setVoiceConversationMicrophoneMuted(false, status);
    expect(mocks.setMicrophoneMuted).toHaveBeenLastCalledWith(false);
    first.resolve();
    await vi.waitFor(() => expect(mocks.invoke).toHaveBeenCalledTimes(2));
    expect(mocks.setMicrophoneMuted).toHaveBeenLastCalledWith(false);
    expect(mocks.invoke).toHaveBeenLastCalledWith(
      "set_native_voice_input_muted",
      expect.objectContaining({ muted: false }),
    );
    second.resolve();
    await Promise.all([mute, unmute]);

    expect(mocks.setMicrophoneMuted).toHaveBeenLastCalledWith(false);
  });

  it("rolls browser capture back to the last applied mute after a failure", async () => {
    const status = {
      available: true,
      unavailableReason: null,
      lifecycle: "running",
      sessionId: "session-1",
      ownerWindowLabel: "main",
      revision: 3,
      nativeMicrophoneMuteControl: true,
    } as const;
    mocks.invoke
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("mute unavailable"));

    await reconcileVoiceConversationMicrophone(status);
    await setVoiceConversationMicrophoneMuted(true, status);
    await expect(
      setVoiceConversationMicrophoneMuted(false, status),
    ).rejects.toThrow("mute unavailable");

    expect(mocks.setMicrophoneMuted).toHaveBeenLastCalledWith(true);
  });

  it("does not let a stale UI completion replace a newer stem state", async () => {
    const status = {
      available: true,
      unavailableReason: null,
      lifecycle: "running",
      sessionId: "session-1",
      ownerWindowLabel: "main",
      revision: 3,
      nativeMicrophoneMuteControl: true,
    } as const;
    const pending = deferred<void>();
    mocks.invoke
      .mockReturnValueOnce(pending.promise)
      .mockRejectedValueOnce(new Error("mute unavailable"));

    await reconcileVoiceConversationMicrophone(status);
    const staleMute = setVoiceConversationMicrophoneMuted(true, status);
    await vi.waitFor(() => expect(mocks.invoke).toHaveBeenCalledOnce());
    applyVoiceConversationMicrophoneMuteEvent(false);
    pending.resolve();
    await staleMute;

    await expect(
      setVoiceConversationMicrophoneMuted(true, status),
    ).rejects.toThrow("mute unavailable");
    expect(mocks.setMicrophoneMuted).toHaveBeenLastCalledWith(false);
  });

  it("does not run queued mute work after the conversation stops", async () => {
    const running = {
      available: true,
      unavailableReason: null,
      lifecycle: "running",
      sessionId: "session-1",
      ownerWindowLabel: "main",
      revision: 3,
      nativeMicrophoneMuteControl: true,
    } as const;
    const stopped = {
      ...running,
      lifecycle: "stopped" as const,
      sessionId: null,
      ownerWindowLabel: null,
      revision: 4,
    };
    const pending = deferred<void>();
    mocks.invoke.mockImplementation((command: string) => {
      if (command === "set_native_voice_input_muted") return pending.promise;
      if (command === "stop_native_voice_conversation") {
        return Promise.resolve(stopped);
      }
      return Promise.resolve(undefined);
    });

    await reconcileVoiceConversationMicrophone(running);
    const muting = setVoiceConversationMicrophoneMuted(true, running);
    await vi.waitFor(() =>
      expect(mocks.invoke).toHaveBeenCalledWith(
        "set_native_voice_input_muted",
        expect.any(Object),
      ),
    );
    const queuedUnmute = setVoiceConversationMicrophoneMuted(false, running);
    await stopVoiceConversation();
    pending.resolve();
    await Promise.all([muting, queuedUnmute]);

    expect(
      mocks.invoke.mock.calls.filter(
        ([command]) => command === "set_native_voice_input_muted",
      ),
    ).toHaveLength(1);
    expect(mocks.startMicrophone).toHaveBeenCalledOnce();
    expect(mocks.stopMicrophone).toHaveBeenCalledOnce();
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

  it("stops browser capture for a validated terminal event", async () => {
    mocks.invoke.mockResolvedValue({
      available: true,
      unavailableReason: null,
      lifecycle: "running",
      sessionId: "session-1",
      ownerWindowLabel: "main",
      revision: 3,
    });
    await startVoiceConversation("session-1");
    applyVoiceConversationTerminalEvent();

    expect(mocks.stopMicrophone).toHaveBeenCalledOnce();
  });
});

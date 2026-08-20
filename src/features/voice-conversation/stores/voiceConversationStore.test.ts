import { beforeEach, describe, expect, it, vi } from "vitest";

import type {
  VoiceConversationEvent,
  VoiceConversationStatus,
} from "../api/voiceConversation";

const mocks = vi.hoisted(() => ({
  applyMicrophoneMuteEvent: vi.fn(),
  applyTerminalEvent: vi.fn(),
  acknowledge: vi.fn(),
  drain: vi.fn(),
  getMicrophoneMuted: vi.fn(),
  getStatus: vi.fn(),
  hydrateMicrophone: vi.fn(),
  listen: vi.fn(),
  reconcileMicrophone: vi.fn(),
  reject: vi.fn(),
  setMicrophoneMuted: vi.fn(),
  start: vi.fn(),
  stop: vi.fn(),
}));

vi.mock("../api/voiceConversation", () => ({
  applyVoiceConversationMicrophoneMuteEvent: mocks.applyMicrophoneMuteEvent,
  applyVoiceConversationTerminalEvent: mocks.applyTerminalEvent,
  acknowledgeVoiceConversationTranscript: mocks.acknowledge,
  drainVoiceConversationTranscripts: mocks.drain,
  getVoiceConversationMicrophoneMuted: mocks.getMicrophoneMuted,
  getVoiceConversationStatus: mocks.getStatus,
  hydrateVoiceConversationMicrophone: mocks.hydrateMicrophone,
  listenToVoiceConversation: mocks.listen,
  reconcileVoiceConversationMicrophone: mocks.reconcileMicrophone,
  rejectVoiceConversationTranscript: mocks.reject,
  setVoiceConversationMicrophoneMuted: mocks.setMicrophoneMuted,
  startVoiceConversation: mocks.start,
  stopVoiceConversation: mocks.stop,
}));

function status(
  lifecycle: VoiceConversationStatus["lifecycle"],
  revision: number,
  sessionId: string | null = null,
): VoiceConversationStatus {
  return {
    available: true,
    unavailableReason: null,
    lifecycle,
    sessionId,
    ownerWindowLabel: lifecycle === "running" ? "main" : null,
    microphoneMuted: false,
    revision,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, reject, resolve };
}

describe("voice conversation store lifecycle ordering", () => {
  let emit: (event: VoiceConversationEvent) => void;

  beforeEach(() => {
    vi.resetModules();
    mocks.acknowledge.mockReset().mockResolvedValue(undefined);
    mocks.applyMicrophoneMuteEvent.mockReset();
    mocks.applyTerminalEvent.mockReset();
    mocks.drain.mockReset().mockResolvedValue([]);
    mocks.getMicrophoneMuted.mockReset().mockReturnValue(false);
    mocks.getStatus.mockReset().mockResolvedValue(status("stopped", 0));
    mocks.start.mockReset();
    mocks.stop.mockReset();
    mocks.listen.mockReset().mockImplementation(async (callback) => {
      emit = callback;
      return vi.fn();
    });
    mocks.hydrateMicrophone.mockReset().mockResolvedValue(undefined);
    mocks.reconcileMicrophone.mockReset().mockResolvedValue(undefined);
    mocks.reject
      .mockReset()
      .mockResolvedValue({ attempts: 1, terminal: false });
    mocks.setMicrophoneMuted.mockReset().mockResolvedValue(undefined);
  });

  async function loadStore() {
    const { useVoiceConversationStore } = await import(
      "./voiceConversationStore"
    );
    await useVoiceConversationStore.getState().init();
    return useVoiceConversationStore;
  }

  it("retries listener registration after an init failure", async () => {
    mocks.listen
      .mockRejectedValueOnce(new Error("listener unavailable"))
      .mockImplementationOnce(async (callback) => {
        emit = callback;
        return vi.fn();
      });

    const { useVoiceConversationStore } = await import(
      "./voiceConversationStore"
    );
    await useVoiceConversationStore.getState().init();
    await useVoiceConversationStore.getState().init();

    expect(mocks.listen).toHaveBeenCalledTimes(2);
    expect(useVoiceConversationStore.getState()).toMatchObject({
      hydrated: true,
    });
  });

  it("registers one native listener across concurrent init calls", async () => {
    const listenerReady = deferred<() => void>();
    mocks.listen.mockReturnValueOnce(listenerReady.promise);

    const { useVoiceConversationStore } = await import(
      "./voiceConversationStore"
    );
    const first = useVoiceConversationStore.getState().init();
    const second = useVoiceConversationStore.getState().init();

    expect(mocks.listen).toHaveBeenCalledOnce();
    listenerReady.resolve(vi.fn());
    await Promise.all([first, second]);
  });

  it("reconciles browser capture with the process-wide native lifecycle", async () => {
    const running = status("running", 2, "session-1");
    mocks.getStatus.mockResolvedValue(running);

    await loadStore();

    expect(mocks.hydrateMicrophone).toHaveBeenCalledWith(running);
  });

  it("hydrates an already-muted native lifecycle", async () => {
    const running = {
      ...status("running", 2, "session-1"),
      nativeMicrophoneMuteControl: true,
      nativeMicrophoneMuted: true,
    };
    mocks.getStatus.mockResolvedValue(running);

    const store = await loadStore();

    expect(mocks.hydrateMicrophone).toHaveBeenCalledWith(running);
    expect(store.getState().microphoneMuted).toBe(true);
  });

  it("refreshes mute state for the same running lifecycle", async () => {
    const unmuted = {
      ...status("running", 2, "session-1"),
      nativeMicrophoneMuteControl: true,
      nativeMicrophoneMuted: false,
    };
    const muted = { ...unmuted, nativeMicrophoneMuted: true };
    mocks.getStatus.mockResolvedValueOnce(unmuted).mockResolvedValueOnce(muted);
    const store = await loadStore();

    await store.getState().init();

    expect(mocks.hydrateMicrophone).toHaveBeenLastCalledWith(muted);
    expect(store.getState().microphoneMuted).toBe(true);
  });

  it("hydrates mute state when startup arrives before status", async () => {
    const response = deferred<VoiceConversationStatus>();
    mocks.getStatus.mockReturnValue(response.promise);
    const { useVoiceConversationStore } = await import(
      "./voiceConversationStore"
    );
    const initializing = useVoiceConversationStore.getState().init();
    await vi.waitFor(() => expect(mocks.getStatus).toHaveBeenCalledOnce());
    emit({
      type: "startup",
      sessionId: "session-1",
      ownerWindowLabel: "main",
      line: "type\tid\ttext",
      revision: 2,
      nativeMicrophoneMuteControl: true,
    });
    const muted = {
      ...status("running", 2, "session-1"),
      nativeMicrophoneMuteControl: true,
      nativeMicrophoneMuted: true,
    };
    response.resolve(muted);
    await initializing;

    expect(mocks.hydrateMicrophone).toHaveBeenCalledWith(muted);
    expect(useVoiceConversationStore.getState().microphoneMuted).toBe(true);
  });

  it("preserves a mute event that arrives while hydration is pending", async () => {
    const hydration = deferred<void>();
    const muted = {
      ...status("running", 2, "session-1"),
      nativeMicrophoneMuteControl: true,
      nativeMicrophoneMuted: true,
    };
    mocks.getStatus.mockResolvedValue(muted);
    mocks.hydrateMicrophone.mockReturnValue(hydration.promise);
    const { useVoiceConversationStore } = await import(
      "./voiceConversationStore"
    );

    const initializing = useVoiceConversationStore.getState().init();
    await vi.waitFor(() =>
      expect(mocks.hydrateMicrophone).toHaveBeenCalledWith(muted),
    );
    emit({
      type: "inputMute",
      sessionId: "session-1",
      muted: false,
      revision: 2,
    });
    hydration.resolve();
    await initializing;

    expect(useVoiceConversationStore.getState().microphoneMuted).toBe(false);
  });

  it("does not hydrate over a pending microphone mute request", async () => {
    const muteRequest = deferred<void>();
    const recoveryStatus = deferred<VoiceConversationStatus>();
    const running = {
      ...status("running", 2, "session-1"),
      nativeMicrophoneMuteControl: true,
      nativeMicrophoneMuted: false,
    };
    mocks.getStatus.mockResolvedValue(running);
    mocks.setMicrophoneMuted.mockReturnValue(muteRequest.promise);
    const { useVoiceConversationStore } = await import(
      "./voiceConversationStore"
    );
    await useVoiceConversationStore.getState().init();
    mocks.hydrateMicrophone.mockClear();
    mocks.reconcileMicrophone.mockClear();
    mocks.getStatus.mockReturnValueOnce(recoveryStatus.promise);

    const muting = useVoiceConversationStore
      .getState()
      .setMicrophoneMuted(true);
    await vi.waitFor(() =>
      expect(mocks.setMicrophoneMuted).toHaveBeenCalledWith(true, running),
    );
    const recovering = useVoiceConversationStore.getState().init();
    await vi.waitFor(() => expect(mocks.getStatus).toHaveBeenCalledTimes(2));

    muteRequest.resolve();
    await muting;
    recoveryStatus.resolve(running);
    await recovering;

    expect(mocks.hydrateMicrophone).not.toHaveBeenCalled();
    expect(mocks.reconcileMicrophone).toHaveBeenCalledWith(running);
    expect(useVoiceConversationStore.getState().microphoneMuted).toBe(true);
  });

  it("does not let stale status overwrite a newer mute event", async () => {
    const response = deferred<VoiceConversationStatus>();
    const current = {
      ...status("running", 3, "session-1"),
      nativeMicrophoneMuteControl: true,
      nativeMicrophoneMuted: false,
    };
    mocks.getStatus
      .mockReturnValueOnce(response.promise)
      .mockResolvedValueOnce(current);
    const { useVoiceConversationStore } = await import(
      "./voiceConversationStore"
    );

    const initializing = useVoiceConversationStore.getState().init();
    await vi.waitFor(() => expect(mocks.getStatus).toHaveBeenCalledOnce());
    emit({
      type: "inputMute",
      sessionId: "session-1",
      muted: false,
      revision: 3,
    });
    response.resolve({
      ...status("running", 2, "session-1"),
      nativeMicrophoneMuteControl: true,
      nativeMicrophoneMuted: true,
    });
    await initializing;

    expect(mocks.hydrateMicrophone).not.toHaveBeenCalled();
    expect(mocks.reconcileMicrophone).toHaveBeenCalledWith(current);
    expect(mocks.getStatus).toHaveBeenCalledTimes(2);
    expect(useVoiceConversationStore.getState().microphoneMuted).toBe(false);
    expect(useVoiceConversationStore.getState().status.revision).toBe(3);
  });

  it("refreshes availability when installation changes without a lifecycle revision", async () => {
    mocks.getStatus
      .mockResolvedValueOnce({
        ...status("stopped", 0),
        available: false,
        unavailableReason: "Download Pocket TTS.",
      })
      .mockResolvedValueOnce(status("stopped", 0));

    const { useVoiceConversationStore } = await import(
      "./voiceConversationStore"
    );
    await useVoiceConversationStore.getState().init();
    await useVoiceConversationStore.getState().init();

    expect(useVoiceConversationStore.getState().status).toMatchObject({
      available: true,
      unavailableReason: null,
      lifecycle: "stopped",
      revision: 0,
    });
  });

  it("does not redeliver a transcript when acknowledgement is retried", async () => {
    mocks.acknowledge
      .mockRejectedValueOnce(new Error("ack unavailable"))
      .mockResolvedValueOnce(undefined);
    const { subscribeToVoiceConversationEvents, useVoiceConversationStore } =
      await import("./voiceConversationStore");
    await useVoiceConversationStore.getState().init();
    const subscriber = vi.fn().mockResolvedValue(undefined);
    subscribeToVoiceConversationEvents(subscriber);
    const transcript = {
      type: "user" as const,
      sessionId: "session-1",
      lifecycleId: "lifecycle-1",
      id: "7",
      text: "do this once",
      revision: 3,
      deliveryAttempts: 0,
    };

    emit(transcript);
    await vi.waitFor(() => expect(mocks.acknowledge).toHaveBeenCalledTimes(1));
    emit(transcript);
    await vi.waitFor(() => expect(mocks.acknowledge).toHaveBeenCalledTimes(2));

    expect(subscriber).toHaveBeenCalledOnce();
  });

  it("does not consume a delivery attempt before a route subscribes", async () => {
    const { useVoiceConversationStore } = await import(
      "./voiceConversationStore"
    );
    await useVoiceConversationStore.getState().init();

    emit({
      type: "user",
      sessionId: "session-1",
      lifecycleId: "lifecycle-1",
      id: "waiting-for-route",
      text: "hold this",
      revision: 3,
      deliveryAttempts: 0,
    });
    await Promise.resolve();

    expect(mocks.reject).not.toHaveBeenCalled();
    expect(mocks.acknowledge).not.toHaveBeenCalled();
  });

  it("does not let a stale stop response overwrite clean shutdown", async () => {
    const store = await loadStore();
    store.setState({
      status: status("running", 2, "session-1"),
      uiState: "listening",
    });
    const response = deferred<VoiceConversationStatus>();
    mocks.stop.mockReturnValue(response.promise);

    const stopping = store.getState().stop();
    expect(store.getState().uiState).toBe("stopping");

    emit({ type: "cleanShutdown", sessionId: "session-1", revision: 4 });
    response.resolve(status("stopping", 3, "session-1"));
    await stopping;

    expect(store.getState()).toMatchObject({
      status: status("stopped", 4),
      uiState: "off",
      error: null,
    });
    expect(mocks.applyTerminalEvent).toHaveBeenCalledOnce();
  });

  it("does not tear down capture for a stale terminal event", async () => {
    const store = await loadStore();
    store.setState({
      status: status("running", 5, "session-2"),
      uiState: "listening",
    });

    emit({ type: "cleanShutdown", sessionId: "session-1", revision: 4 });

    expect(mocks.applyTerminalEvent).not.toHaveBeenCalled();
    expect(store.getState()).toMatchObject({
      status: status("running", 5, "session-2"),
      uiState: "listening",
    });
  });

  it("returns to off after a no-op stop with an unchanged revision", async () => {
    const store = await loadStore();
    mocks.stop.mockResolvedValue(status("stopped", 0));

    await store.getState().stop();

    expect(store.getState()).toMatchObject({
      status: status("stopped", 0),
      uiState: "off",
      error: null,
    });
  });

  it("coalesces concurrent lifecycle stop requests", async () => {
    const response = deferred<VoiceConversationStatus>();
    mocks.stop.mockReturnValue(response.promise);
    const store = await loadStore();
    store.setState({
      status: status("running", 1, "session-1"),
      uiState: "listening",
      requestedStartSessionId: "session-1",
    });

    const first = store.getState().stop();
    const second = store.getState().stop();

    expect(second).toBe(first);
    expect(mocks.stop).toHaveBeenCalledOnce();
    expect(store.getState().requestedStartSessionId).toBeNull();

    response.resolve(status("stopped", 2));
    await expect(first).resolves.toEqual(status("stopped", 2));
  });

  it("preserves native mute control when startup wins the response race", async () => {
    const store = await loadStore();
    const response = deferred<VoiceConversationStatus>();
    mocks.start.mockReturnValue(response.promise);

    const starting = store.getState().start("session-1");
    emit({
      type: "startup",
      sessionId: "session-1",
      ownerWindowLabel: "main",
      line: "type\tid\ttext",
      revision: 2,
      nativeMicrophoneMuteControl: true,
    });
    response.resolve({
      ...status("running", 2, "session-1"),
      nativeMicrophoneMuteControl: true,
    });
    await starting;

    expect(store.getState()).toMatchObject({
      status: status("running", 2, "session-1"),
      uiState: "listening",
      error: null,
    });
    expect(store.getState().status.nativeMicrophoneMuteControl).toBe(true);
  });

  it("preserves a stem mute observed immediately before startup", async () => {
    const store = await loadStore();

    emit({
      type: "inputMute",
      sessionId: "session-1",
      muted: true,
      revision: 2,
    });
    emit({
      type: "startup",
      sessionId: "session-1",
      ownerWindowLabel: "main",
      line: "type\tid\ttext",
      revision: 2,
      nativeMicrophoneMuteControl: true,
    });

    expect(mocks.applyMicrophoneMuteEvent).toHaveBeenCalledWith(true);
    expect(store.getState()).toMatchObject({
      status: status("running", 2, "session-1"),
      uiState: "listening",
      microphoneMuted: true,
    });
  });

  it("ignores an older start response after a newer startup event", async () => {
    const store = await loadStore();
    const response = deferred<VoiceConversationStatus>();
    mocks.start.mockReturnValue(response.promise);

    const starting = store.getState().start("session-1");
    emit({
      type: "startup",
      sessionId: "session-1",
      ownerWindowLabel: "main",
      line: "type\tid\ttext",
      revision: 2,
      nativeMicrophoneMuteControl: true,
    });
    response.resolve(status("starting", 1, "session-1"));
    await starting;

    expect(store.getState()).toMatchObject({
      status: status("running", 2, "session-1"),
      uiState: "listening",
      error: null,
    });
    expect(store.getState().status.nativeMicrophoneMuteControl).toBe(true);
  });

  it("reconciles status after a failed stop", async () => {
    const store = await loadStore();
    store.setState({
      status: status("running", 2, "session-1"),
      uiState: "listening",
    });
    mocks.stop.mockRejectedValue(new Error("kill failed"));
    mocks.getStatus.mockResolvedValue(status("stopped", 4));

    await expect(store.getState().stop()).rejects.toThrow("kill failed");

    expect(store.getState()).toMatchObject({
      status: status("stopped", 4),
      uiState: "error",
      error: "kill failed",
    });
  });

  it("never exposes an empty error message", async () => {
    const store = await loadStore();
    store.getState().setUiState("error");

    expect(store.getState()).toMatchObject({
      uiState: "error",
      error: "Voice conversation failed.",
    });
  });

  it("maps semantic activity events to voice UI states", async () => {
    const store = await loadStore();
    store.setState({
      status: status("running", 2, "session-1"),
      uiState: "listening",
    });

    emit({
      type: "activity",
      sessionId: "session-1",
      activity: "user-speaking",
      revision: 3,
    });
    expect(store.getState().uiState).toBe("user-speaking");

    emit({
      type: "activity",
      sessionId: "session-1",
      activity: "user-idle",
      revision: 4,
    });
    expect(store.getState().uiState).toBe("listening");

    emit({
      type: "activity",
      sessionId: "session-1",
      activity: "assistant-speaking",
      revision: 5,
    });
    expect(store.getState().uiState).toBe("agent-speaking");

    emit({
      type: "activity",
      sessionId: "session-1",
      activity: "assistant-idle",
      revision: 6,
    });
    expect(store.getState().uiState).toBe("listening");
  });

  it("mutes capture without stopping the voice lifecycle", async () => {
    const store = await loadStore();
    store.setState({
      status: status("running", 2, "session-1"),
      uiState: "user-speaking",
      userSpeaking: true,
    });

    await store.getState().setMicrophoneMuted(true);

    expect(mocks.setMicrophoneMuted).toHaveBeenCalledWith(
      true,
      status("running", 2, "session-1"),
    );
    expect(mocks.stop).not.toHaveBeenCalled();
    expect(store.getState()).toMatchObject({
      status: status("running", 2, "session-1"),
      microphoneMuted: true,
      userSpeaking: false,
      uiState: "listening",
    });
  });

  it("keeps the latest UI mute intent when requests settle out of order", async () => {
    const store = await loadStore();
    store.setState({
      status: status("running", 2, "session-1"),
      uiState: "listening",
    });
    const mute = deferred<void>();
    const unmute = deferred<void>();
    mocks.setMicrophoneMuted
      .mockReturnValueOnce(mute.promise)
      .mockReturnValueOnce(unmute.promise);

    const muting = store.getState().setMicrophoneMuted(true);
    const unmuting = store.getState().setMicrophoneMuted(false);
    expect(store.getState().microphoneMuted).toBe(false);

    unmute.resolve();
    await unmuting;
    mute.resolve();
    await muting;

    expect(store.getState().microphoneMuted).toBe(false);
  });

  it("rolls the latest failed intent back to the last successful mute", async () => {
    const store = await loadStore();
    store.setState({
      status: status("running", 2, "session-1"),
      uiState: "listening",
    });
    const mute = deferred<void>();
    const unmute = deferred<void>();
    mocks.setMicrophoneMuted
      .mockReturnValueOnce(mute.promise)
      .mockReturnValueOnce(unmute.promise);

    const muting = store.getState().setMicrophoneMuted(true);
    const unmuting = store.getState().setMicrophoneMuted(false);
    mute.resolve();
    await muting;
    mocks.getMicrophoneMuted.mockReturnValue(true);
    unmute.reject(new Error("mute unavailable"));
    await expect(unmuting).rejects.toThrow("mute unavailable");

    expect(store.getState()).toMatchObject({
      microphoneMuted: true,
      uiState: "error",
      error: "mute unavailable",
    });
  });

  it("keeps a newer stem state after a stale UI request settles", async () => {
    const store = await loadStore();
    store.setState({
      status: status("running", 2, "session-1"),
      uiState: "listening",
    });
    const pending = deferred<void>();
    mocks.setMicrophoneMuted.mockReturnValueOnce(pending.promise);

    const staleMute = store.getState().setMicrophoneMuted(true);
    emit({
      type: "inputMute",
      sessionId: "session-1",
      muted: false,
      revision: 3,
    });
    pending.resolve();
    await staleMute;
    mocks.getMicrophoneMuted.mockReturnValue(false);
    mocks.setMicrophoneMuted.mockRejectedValueOnce(
      new Error("mute unavailable"),
    );

    await expect(store.getState().setMicrophoneMuted(true)).rejects.toThrow(
      "mute unavailable",
    );
    expect(store.getState().microphoneMuted).toBe(false);
  });

  it("applies a current stem mute event to capture and UI", async () => {
    const store = await loadStore();
    store.setState({
      status: status("running", 2, "session-1"),
      uiState: "user-speaking",
      userSpeaking: true,
    });

    emit({
      type: "inputMute",
      sessionId: "session-1",
      muted: true,
      revision: 3,
    });

    expect(mocks.applyMicrophoneMuteEvent).toHaveBeenCalledWith(true);
    expect(store.getState()).toMatchObject({
      microphoneMuted: true,
      userSpeaking: false,
      uiState: "listening",
    });
  });

  it("ignores stale user-speaking activity while the microphone is muted", async () => {
    const store = await loadStore();
    store.setState({
      status: status("running", 2, "session-1"),
      uiState: "listening",
      microphoneMuted: true,
    });

    emit({
      type: "activity",
      sessionId: "session-1",
      activity: "user-speaking",
      revision: 3,
    });

    expect(store.getState()).toMatchObject({
      microphoneMuted: true,
      userSpeaking: false,
      uiState: "listening",
    });
  });

  it("surfaces an unmute failure without losing muted state", async () => {
    const store = await loadStore();
    store.setState({
      status: status("running", 2, "session-1"),
      uiState: "listening",
    });
    emit({
      type: "inputMute",
      sessionId: "session-1",
      muted: true,
      revision: 3,
    });
    mocks.getMicrophoneMuted.mockReturnValue(true);
    mocks.setMicrophoneMuted.mockRejectedValueOnce(
      new Error("microphone unavailable"),
    );

    await expect(store.getState().setMicrophoneMuted(false)).rejects.toThrow(
      "microphone unavailable",
    );

    expect(store.getState()).toMatchObject({
      microphoneMuted: true,
      uiState: "error",
      error: "microphone unavailable",
    });
  });

  it("clears active status after an unexpected terminal error", async () => {
    const store = await loadStore();
    store.setState({
      status: status("running", 2, "session-1"),
      uiState: "listening",
    });

    emit({
      type: "error",
      sessionId: "session-1",
      message: "Voice process crashed",
      revision: 3,
      terminal: true,
    });

    expect(store.getState()).toMatchObject({
      status: status("stopped", 3),
      uiState: "error",
      error: "Voice process crashed",
    });
  });
});

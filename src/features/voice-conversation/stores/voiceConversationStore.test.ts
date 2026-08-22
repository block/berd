import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type {
  VoiceConversationEvent,
  VoiceConversationStatus,
} from "../api/voiceConversation";

const mocks = vi.hoisted(() => ({
  acknowledge: vi.fn(),
  blockStarts: vi.fn(),
  drain: vi.fn(),
  getStatus: vi.fn(),
  listen: vi.fn(),
  reconcileMicrophone: vi.fn(),
  reject: vi.fn(),
  releaseStartBlock: vi.fn(),
  setMicrophoneMuted: vi.fn(),
  start: vi.fn(),
  stop: vi.fn(),
}));

vi.mock("../api/voiceConversation", () => ({
  acknowledgeVoiceConversationTranscript: mocks.acknowledge,
  blockNativeVoiceConversationStarts: mocks.blockStarts,
  drainVoiceConversationTranscripts: mocks.drain,
  getVoiceConversationStatus: mocks.getStatus,
  listenToVoiceConversation: mocks.listen,
  reconcileVoiceConversationMicrophone: mocks.reconcileMicrophone,
  rejectVoiceConversationTranscript: mocks.reject,
  releaseNativeVoiceConversationStartBlock: mocks.releaseStartBlock,
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
  const promise = new Promise<T>((resolver) => {
    resolve = resolver;
  });
  return { promise, resolve };
}

describe("voice conversation store lifecycle ordering", () => {
  let emit: (event: VoiceConversationEvent) => void;

  beforeEach(() => {
    vi.resetModules();
    mocks.acknowledge.mockReset().mockResolvedValue(undefined);
    mocks.blockStarts.mockReset().mockResolvedValue("archive-token");
    mocks.drain.mockReset().mockResolvedValue([]);
    mocks.getStatus.mockReset().mockResolvedValue(status("stopped", 0));
    mocks.start.mockReset();
    mocks.stop.mockReset();
    mocks.listen.mockReset().mockImplementation(async (callback) => {
      emit = callback;
      return vi.fn();
    });
    mocks.reconcileMicrophone.mockReset().mockResolvedValue(undefined);
    mocks.reject
      .mockReset()
      .mockResolvedValue({ attempts: 1, terminal: false });
    mocks.releaseStartBlock.mockReset().mockResolvedValue(undefined);
    mocks.setMicrophoneMuted
      .mockReset()
      .mockImplementation(async (muted, current) => ({
        ...current,
        microphoneMuted: muted,
      }));
  });

  afterEach(() => vi.useRealTimers());

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

  it("blocks new starts until an archive transition releases its lease", async () => {
    const { blockVoiceConversationStarts, useVoiceConversationStore } =
      await import("./voiceConversationStore");
    const release = await blockVoiceConversationStarts("session-1");

    await expect(
      useVoiceConversationStore.getState().start("session-1"),
    ).rejects.toThrow("being archived");
    expect(mocks.start).not.toHaveBeenCalled();

    await release();
    expect(mocks.releaseStartBlock).toHaveBeenCalledWith(
      "session-1",
      "archive-token",
    );
    mocks.start.mockResolvedValue(status("running", 1, "session-1"));
    await expect(
      useVoiceConversationStore.getState().start("session-1"),
    ).resolves.toMatchObject({ lifecycle: "running", sessionId: "session-1" });
  });

  it("waits for an existing start before granting an archive lease", async () => {
    const startRequest = deferred<VoiceConversationStatus>();
    mocks.start.mockReturnValue(startRequest.promise);
    const { blockVoiceConversationStarts, useVoiceConversationStore } =
      await import("./voiceConversationStore");
    const starting = useVoiceConversationStore.getState().start("session-1");
    let leaseGranted = false;
    const lease = blockVoiceConversationStarts("session-1").then((release) => {
      leaseGranted = true;
      return release;
    });

    await Promise.resolve();
    expect(leaseGranted).toBe(false);
    startRequest.resolve(status("running", 1, "session-1"));
    await starting;
    const release = await lease;

    expect(leaseGranted).toBe(true);
    await release();
  });

  it("retries native archive lease release before unblocking starts", async () => {
    vi.useFakeTimers();
    mocks.releaseStartBlock
      .mockRejectedValueOnce(new Error("bridge unavailable"))
      .mockResolvedValueOnce(undefined);
    const { blockVoiceConversationStarts, useVoiceConversationStore } =
      await import("./voiceConversationStore");
    const release = await blockVoiceConversationStarts("session-1");

    await release();
    await expect(
      useVoiceConversationStore.getState().start("session-1"),
    ).rejects.toThrow("being archived");
    await vi.advanceTimersByTimeAsync(1_000);

    mocks.start.mockResolvedValue(status("running", 1, "session-1"));
    await expect(
      useVoiceConversationStore.getState().start("session-1"),
    ).resolves.toMatchObject({ lifecycle: "running", sessionId: "session-1" });
    expect(mocks.releaseStartBlock).toHaveBeenCalledTimes(2);
  });

  it("reconciles browser capture with the process-wide native lifecycle", async () => {
    const running = status("running", 2, "session-1");
    mocks.getStatus.mockResolvedValue(running);

    await loadStore();

    expect(mocks.reconcileMicrophone).toHaveBeenCalledWith(running);
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
  });

  it("does not reconcile a delayed terminal event from an older lifecycle", async () => {
    const store = await loadStore();
    store.setState({
      status: status("running", 5, "session-2"),
      uiState: "listening",
    });
    mocks.reconcileMicrophone.mockClear();

    emit({ type: "cleanShutdown", sessionId: "session-1", revision: 4 });
    await Promise.resolve();

    expect(mocks.reconcileMicrophone).not.toHaveBeenCalled();
    expect(store.getState().status).toEqual(status("running", 5, "session-2"));
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
    expect(mocks.stop).toHaveBeenCalledWith(status("running", 1, "session-1"));
    expect(store.getState().requestedStartSessionId).toBeNull();

    response.resolve(status("stopped", 2));
    await expect(first).resolves.toEqual(status("stopped", 2));
  });

  it("does not let a stale start response regress a startup event", async () => {
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
    });
    response.resolve(status("starting", 1, "session-1"));
    await starting;

    expect(store.getState()).toMatchObject({
      status: status("running", 2, "session-1"),
      uiState: "listening",
      error: null,
    });
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

  it("reattaches capture when a failed stop leaves voice running", async () => {
    const store = await loadStore();
    const runningStatus = status("running", 4, "session-1");
    store.setState({
      status: status("running", 2, "session-1"),
      uiState: "listening",
    });
    mocks.stop.mockRejectedValue(new Error("kill failed"));
    mocks.getStatus.mockResolvedValue(runningStatus);

    await expect(store.getState().stop()).rejects.toThrow("kill failed");

    expect(mocks.reconcileMicrophone).toHaveBeenCalledWith(runningStatus);
    expect(store.getState()).toMatchObject({
      status: runningStatus,
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
      status: {
        ...status("running", 2, "session-1"),
        microphoneMuted: true,
      },
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
      microphoneMuted: true,
    });
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

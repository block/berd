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
  stopForReplacement: vi.fn(),
  trackStarted: vi.fn(),
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
  stopVoiceConversationForReplacement: mocks.stopForReplacement,
}));

vi.mock("../lib/voiceTelemetry", () => ({
  trackVoiceConversationStarted: mocks.trackStarted,
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
  const promise = new Promise<T>((resolver, rejecter) => {
    resolve = resolver;
    reject = rejecter;
  });
  return { promise, reject, resolve };
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
    mocks.stopForReplacement.mockReset();
    mocks.trackStarted.mockReset();
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

  it("records finalized STT before transcript delivery settles", async () => {
    const delivery = deferred<void>();
    const module = await import("./voiceConversationStore");
    const unsubscribe = module.subscribeToVoiceConversationEvents(
      () => delivery.promise,
    );
    await module.useVoiceConversationStore.getState().init();

    emit({
      type: "user",
      sessionId: "session-1",
      lifecycleId: "lifecycle-1",
      id: "utterance-1",
      text: "Hello",
      revision: 1,
      deliveryAttempts: 0,
    });

    expect(
      module.useVoiceConversationStore.getState().latestFinalizedTranscriptKey,
    ).toBe(["session-1", "lifecycle-1", "1", "utterance-1"].join("\0"));
    expect(mocks.acknowledge).not.toHaveBeenCalled();
    expect(mocks.reject).not.toHaveBeenCalled();

    delivery.resolve();
    await vi.waitFor(() => expect(mocks.acknowledge).toHaveBeenCalledOnce());
    unsubscribe();
  });

  it("retains finalized STT when transcript delivery rejects", async () => {
    const module = await import("./voiceConversationStore");
    const unsubscribe = module.subscribeToVoiceConversationEvents(() =>
      Promise.reject(new Error("chat unavailable")),
    );
    await module.useVoiceConversationStore.getState().init();

    emit({
      type: "user",
      sessionId: "session-1",
      lifecycleId: "lifecycle-1",
      id: "utterance-2",
      text: "Hello again",
      revision: 1,
      deliveryAttempts: 0,
    });

    expect(
      module.useVoiceConversationStore.getState().latestFinalizedTranscriptKey,
    ).toBe(["session-1", "lifecycle-1", "1", "utterance-2"].join("\0"));
    await vi.waitFor(() => expect(mocks.reject).toHaveBeenCalledOnce());
    expect(mocks.acknowledge).not.toHaveBeenCalled();
    expect(
      module.useVoiceConversationStore.getState().latestFinalizedTranscriptKey,
    ).toContain("utterance-2");
    unsubscribe();
  });

  it("defers a blocked transcript without spending its rejection budget", async () => {
    const transcript = {
      sessionId: "session-1",
      lifecycleId: "lifecycle-1",
      id: "deferred-utterance",
      text: "Wait for admission",
      revision: 1,
      deliveryAttempts: 2,
    };
    mocks.drain.mockResolvedValueOnce([transcript]);
    const module = await import("./voiceConversationStore");
    const unsubscribe = module.subscribeToVoiceConversationEvents(() =>
      Promise.reject(new module.VoiceTranscriptDeferredError("blocked")),
    );
    await module.useVoiceConversationStore.getState().init();

    await expect(
      module.useVoiceConversationStore
        .getState()
        .drainPendingTranscripts("session-1"),
    ).resolves.toBeUndefined();

    expect(mocks.reject).not.toHaveBeenCalled();
    expect(mocks.acknowledge).not.toHaveBeenCalled();
    unsubscribe();
  });

  it("restores prior causal state after terminal transcript rejection", async () => {
    mocks.reject.mockResolvedValueOnce({ attempts: 3, terminal: true });
    const module = await import("./voiceConversationStore");
    const unsubscribe = module.subscribeToVoiceConversationEvents(() =>
      Promise.reject(new Error("chat unavailable")),
    );
    await module.useVoiceConversationStore.getState().init();
    module.useVoiceConversationStore.setState({
      latestFinalizedTranscriptKey: "prior-transcript",
    });

    emit({
      type: "user",
      sessionId: "session-1",
      lifecycleId: "lifecycle-1",
      id: "terminal-rejection",
      text: "Cannot deliver",
      revision: 1,
      deliveryAttempts: 2,
    });

    await vi.waitFor(() => expect(mocks.reject).toHaveBeenCalledOnce());
    expect(
      module.useVoiceConversationStore.getState().latestFinalizedTranscriptKey,
    ).toBe("prior-transcript");
    unsubscribe();
  });

  it("removes terminally rejected transcripts from pending rollback chains", async () => {
    mocks.reject.mockResolvedValue({ attempts: 3, terminal: true });
    const firstDelivery = deferred<void>();
    const secondDelivery = deferred<void>();
    const module = await import("./voiceConversationStore");
    const unsubscribe = module.subscribeToVoiceConversationEvents((event) =>
      event.type === "user" && event.id === "first-rejection"
        ? firstDelivery.promise
        : secondDelivery.promise,
    );
    await module.useVoiceConversationStore.getState().init();
    module.useVoiceConversationStore.setState({
      latestFinalizedTranscriptKey: "prior-transcript",
    });

    emit({
      type: "user",
      sessionId: "session-1",
      lifecycleId: "lifecycle-1",
      id: "first-rejection",
      text: "First failure",
      revision: 1,
      deliveryAttempts: 2,
    });
    emit({
      type: "user",
      sessionId: "session-1",
      lifecycleId: "lifecycle-1",
      id: "second-rejection",
      text: "Second failure",
      revision: 2,
      deliveryAttempts: 2,
    });

    firstDelivery.reject(new Error("chat unavailable"));
    await vi.waitFor(() => expect(mocks.reject).toHaveBeenCalledOnce());
    secondDelivery.reject(new Error("chat unavailable"));
    await vi.waitFor(() => expect(mocks.reject).toHaveBeenCalledTimes(2));
    expect(
      module.useVoiceConversationStore.getState().latestFinalizedTranscriptKey,
    ).toBe("prior-transcript");
    unsubscribe();
  });

  it("records a recovered transcript before its subscriber settles", async () => {
    const delivery = deferred<void>();
    const transcript = {
      sessionId: "session-1",
      lifecycleId: "lifecycle-1",
      id: "recovered-k1",
      text: "Recovered",
      revision: 1,
      deliveryAttempts: 1,
    };
    mocks.drain.mockResolvedValueOnce([transcript]);
    const module = await import("./voiceConversationStore");
    module.subscribeToVoiceConversationEvents(() => delivery.promise);
    await module.useVoiceConversationStore.getState().init();

    const draining = module.useVoiceConversationStore
      .getState()
      .drainPendingTranscripts("session-1");
    await vi.waitFor(() => {
      expect(
        module.useVoiceConversationStore.getState()
          .latestFinalizedTranscriptKey,
      ).toBe(["session-1", "lifecycle-1", "1", "recovered-k1"].join("\0"));
    });
    expect(mocks.acknowledge).not.toHaveBeenCalled();

    delivery.resolve();
    await draining;
  });

  it("does not let an old retained transcript roll back a newer key", async () => {
    mocks.acknowledge
      .mockRejectedValueOnce(new Error("ack unavailable"))
      .mockResolvedValue(undefined);
    const module = await import("./voiceConversationStore");
    module.subscribeToVoiceConversationEvents(() => Promise.resolve());
    await module.useVoiceConversationStore.getState().init();
    const oldTranscript = {
      type: "user" as const,
      sessionId: "session-1",
      lifecycleId: "lifecycle-1",
      id: "old-k0",
      text: "Old",
      revision: 1,
      deliveryAttempts: 0,
    };
    emit(oldTranscript);
    await vi.waitFor(() => expect(mocks.acknowledge).toHaveBeenCalledOnce());

    emit({
      ...oldTranscript,
      id: "new-k1",
      text: "New",
    });
    await vi.waitFor(() => expect(mocks.acknowledge).toHaveBeenCalledTimes(2));
    const newerKey = ["session-1", "lifecycle-1", "1", "new-k1"].join("\0");
    expect(
      module.useVoiceConversationStore.getState().latestFinalizedTranscriptKey,
    ).toBe(newerKey);

    mocks.drain.mockResolvedValueOnce([
      { ...oldTranscript, deliveryAttempts: 1 },
    ]);
    await module.useVoiceConversationStore
      .getState()
      .drainPendingTranscripts("session-1");

    expect(
      module.useVoiceConversationStore.getState().latestFinalizedTranscriptKey,
    ).toBe(newerKey);
  });

  it("advances to an unseen retained transcript delivered after a live key", async () => {
    const module = await import("./voiceConversationStore");
    module.subscribeToVoiceConversationEvents(() => Promise.resolve());
    await module.useVoiceConversationStore.getState().init();
    emit({
      type: "user",
      sessionId: "session-1",
      lifecycleId: "lifecycle-1",
      id: "live-k1",
      text: "Live",
      revision: 1,
      deliveryAttempts: 0,
    });
    await vi.waitFor(() => expect(mocks.acknowledge).toHaveBeenCalledOnce());
    mocks.drain.mockResolvedValueOnce([
      {
        sessionId: "session-1",
        lifecycleId: "lifecycle-1",
        id: "unseen-retained-k0",
        text: "Retained",
        revision: 1,
        deliveryAttempts: 1,
      },
    ]);
    await module.useVoiceConversationStore
      .getState()
      .drainPendingTranscripts("session-1");

    expect(
      module.useVoiceConversationStore.getState().latestFinalizedTranscriptKey,
    ).toBe(["session-1", "lifecycle-1", "1", "unseen-retained-k0"].join("\0"));
  });

  it("restores a retried transcript after lifecycle state clears", async () => {
    mocks.acknowledge
      .mockRejectedValueOnce(new Error("ack unavailable"))
      .mockResolvedValue(undefined);
    const module = await import("./voiceConversationStore");
    module.subscribeToVoiceConversationEvents(() => Promise.resolve());
    await module.useVoiceConversationStore.getState().init();
    const transcript = {
      type: "user" as const,
      sessionId: "session-1",
      lifecycleId: "lifecycle-1",
      id: "retry-k1",
      text: "Retry",
      revision: 1,
      deliveryAttempts: 0,
    };
    emit(transcript);
    await vi.waitFor(() => expect(mocks.acknowledge).toHaveBeenCalledOnce());

    emit({
      type: "startup",
      sessionId: "session-1",
      ownerWindowLabel: "main",
      line: "started",
      revision: 2,
    });
    expect(
      module.useVoiceConversationStore.getState().latestFinalizedTranscriptKey,
    ).toBeNull();
    mocks.drain.mockResolvedValueOnce([{ ...transcript, deliveryAttempts: 1 }]);

    await module.useVoiceConversationStore
      .getState()
      .drainPendingTranscripts("session-1");

    expect(
      module.useVoiceConversationStore.getState().latestFinalizedTranscriptKey,
    ).toBe(["session-1", "lifecycle-1", "1", "retry-k1"].join("\0"));
  });

  it("does not rewind for a retained duplicate found in chat after reload", async () => {
    const module = await import("./voiceConversationStore");
    module.subscribeToVoiceConversationEvents(() => Promise.resolve());
    await module.useVoiceConversationStore.getState().init();
    const currentKey = ["session-1", "lifecycle-1", "1", "live-k1"].join("\0");
    module.useVoiceConversationStore.setState({
      latestFinalizedTranscriptKey: currentKey,
    });
    mocks.drain.mockResolvedValueOnce([
      {
        sessionId: "session-1",
        lifecycleId: "lifecycle-1",
        id: "retained-k0",
        text: "Already in chat",
        revision: 1,
        deliveryAttempts: 1,
      },
    ]);

    await module.useVoiceConversationStore
      .getState()
      .drainPendingTranscripts("session-1", () => true);

    expect(
      module.useVoiceConversationStore.getState().latestFinalizedTranscriptKey,
    ).toBe(currentKey);
  });

  it("clears finalized STT at lifecycle boundaries", async () => {
    const store = await loadStore();
    emit({
      type: "user",
      sessionId: "session-1",
      lifecycleId: "lifecycle-1",
      id: "utterance-1",
      text: "Hello",
      revision: 1,
      deliveryAttempts: 0,
    });
    expect(store.getState().latestFinalizedTranscriptKey).not.toBeNull();

    emit({
      type: "startup",
      sessionId: "session-2",
      ownerWindowLabel: "main",
      line: "started",
      revision: 2,
    });
    expect(store.getState().latestFinalizedTranscriptKey).toBeNull();

    store.setState({ latestFinalizedTranscriptKey: "stale" });
    emit({ type: "cleanShutdown", sessionId: "session-2", revision: 3 });
    expect(store.getState().latestFinalizedTranscriptKey).toBeNull();
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
    expect(mocks.trackStarted).toHaveBeenCalledOnce();
  });

  it("does not track voice usage when native startup fails", async () => {
    const store = await loadStore();
    mocks.start.mockRejectedValue(new Error("microphone unavailable"));

    await expect(store.getState().start("session-1")).rejects.toThrow(
      "microphone unavailable",
    );

    expect(mocks.trackStarted).not.toHaveBeenCalled();
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

  it("preserves a mute event that arrives while recovery is pending", async () => {
    const store = await loadStore();
    const running = {
      ...status("running", 2, "session-1"),
      microphoneMuted: true,
    };
    store.setState({
      status: running,
      microphoneMuted: true,
      uiState: "listening",
    });
    const recovery = deferred<VoiceConversationStatus>();
    const reconciliation = deferred<void>();
    mocks.getStatus.mockReturnValueOnce(recovery.promise);
    mocks.reconcileMicrophone.mockReturnValueOnce(reconciliation.promise);

    const recovering = store.getState().init();
    await vi.waitFor(() => expect(mocks.getStatus).toHaveBeenCalledTimes(2));
    recovery.resolve(running);
    await vi.waitFor(() =>
      expect(mocks.reconcileMicrophone).toHaveBeenLastCalledWith(running),
    );
    emit({
      type: "microphoneMute",
      sessionId: "session-1",
      muted: false,
      revision: 2,
    });
    reconciliation.resolve();
    await recovering;

    expect(store.getState().microphoneMuted).toBe(false);
    expect(store.getState().status.microphoneMuted).toBe(false);
    expect(mocks.reconcileMicrophone).toHaveBeenLastCalledWith({
      ...running,
      microphoneMuted: false,
    });
  });

  it("preserves a mute event that advances to the recovering lifecycle", async () => {
    const store = await loadStore();
    const running = {
      ...status("running", 2, "session-1"),
      microphoneMuted: true,
    };
    store.setState({
      status: status("running", 1, "session-1"),
      microphoneMuted: false,
      uiState: "listening",
    });
    const recovery = deferred<VoiceConversationStatus>();
    const reconciliation = deferred<void>();
    mocks.getStatus.mockReturnValueOnce(recovery.promise);
    mocks.reconcileMicrophone.mockReturnValueOnce(reconciliation.promise);

    const recovering = store.getState().init();
    recovery.resolve(running);
    await vi.waitFor(() =>
      expect(mocks.reconcileMicrophone).toHaveBeenLastCalledWith(running),
    );
    emit({
      type: "microphoneMute",
      sessionId: "session-1",
      muted: false,
      revision: 2,
    });
    reconciliation.resolve();
    await recovering;

    expect(store.getState().status).toMatchObject({
      lifecycle: "running",
      sessionId: "session-1",
      revision: 2,
      microphoneMuted: false,
    });
    expect(store.getState().microphoneMuted).toBe(false);
  });

  it("does not recover over a pending microphone mute request", async () => {
    const store = await loadStore();
    const running = status("running", 2, "session-1");
    store.setState({ status: running, uiState: "listening" });
    const muteRequest = deferred<VoiceConversationStatus>();
    const recovery = deferred<VoiceConversationStatus>();
    mocks.setMicrophoneMuted.mockReturnValueOnce(muteRequest.promise);
    mocks.getStatus.mockReturnValueOnce(recovery.promise);

    const muting = store.getState().setMicrophoneMuted(true);
    const recovering = store.getState().init();
    await vi.waitFor(() => expect(mocks.getStatus).toHaveBeenCalledTimes(2));
    recovery.resolve(running);
    await recovering;

    expect(store.getState().microphoneMuted).toBe(true);
    muteRequest.resolve({ ...running, microphoneMuted: true });
    await muting;
    expect(store.getState().microphoneMuted).toBe(true);
  });

  it("does not let a stale UI completion replace a newer mute event", async () => {
    const store = await loadStore();
    const running = status("running", 2, "session-1");
    store.setState({ status: running, uiState: "listening" });
    const muteRequest = deferred<VoiceConversationStatus>();
    mocks.setMicrophoneMuted.mockReturnValueOnce(muteRequest.promise);

    const muting = store.getState().setMicrophoneMuted(true);
    emit({
      type: "microphoneMute",
      sessionId: "session-1",
      muted: false,
      revision: 2,
    });
    muteRequest.resolve({ ...running, microphoneMuted: true });
    await muting;

    expect(store.getState().microphoneMuted).toBe(false);
    expect(store.getState().status.microphoneMuted).toBe(false);
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

  it("adopts the winner when a concurrent replacement already changed lifecycles", async () => {
    const store = await loadStore();
    const active = status("running", 2, "session-a");
    const winner = status("running", 4, "session-b");
    store.setState({ status: active, uiState: "listening" });
    mocks.stopForReplacement.mockResolvedValue(winner);

    await expect(
      store.getState().stopForReplacement(active, "session-c"),
    ).resolves.toEqual(winner);

    expect(store.getState()).toMatchObject({
      status: winner,
      uiState: "listening",
      error: null,
    });
    expect(mocks.stopForReplacement).toHaveBeenCalledWith(active, "session-c");
  });

  it.each([
    "resolves",
    "rejects",
  ] as const)("preserves a competing handoff winner when stale status refresh %s", async (refreshOutcome) => {
    const store = await loadStore();
    const active = status("running", 2, "session-a");
    const staleReplacement = deferred<VoiceConversationStatus>();
    const winner = status("running", 4, "session-c");
    const observedWinner =
      refreshOutcome === "resolves"
        ? { ...winner, microphoneMuted: true }
        : winner;
    store.setState({ status: active, uiState: "listening" });
    mocks.stopForReplacement.mockReturnValue(staleReplacement.promise);
    if (refreshOutcome === "resolves") {
      mocks.getStatus.mockResolvedValue(observedWinner);
    } else {
      mocks.getStatus.mockRejectedValue(new Error("status unavailable"));
    }

    const replacingWithB = store
      .getState()
      .stopForReplacement(active, "session-b");
    store.setState({
      status: winner,
      uiState: "agent-speaking",
      assistantSpeaking: true,
      error: "session C playback warning",
    });
    staleReplacement.reject(new Error("session B handoff failed"));

    await expect(replacingWithB).rejects.toThrow("session B handoff failed");
    expect(store.getState()).toMatchObject({
      status: observedWinner,
      uiState: "agent-speaking",
      error: "session C playback warning",
      microphoneMuted: observedWinner.microphoneMuted,
    });
  });

  it("does not let a delayed competing-handoff refresh regress a newer winner", async () => {
    const store = await loadStore();
    const active = status("running", 2, "session-a");
    const staleReplacement = deferred<VoiceConversationStatus>();
    const statusRefresh = deferred<VoiceConversationStatus>();
    const observedWinner = status("running", 4, "session-c");
    const newerWinner = status("running", 6, "session-d");
    store.setState({ status: active, uiState: "listening" });
    mocks.stopForReplacement.mockReturnValue(staleReplacement.promise);
    mocks.getStatus.mockReturnValue(statusRefresh.promise);

    const replacingWithB = store
      .getState()
      .stopForReplacement(active, "session-b");
    staleReplacement.reject(new Error("session B handoff failed"));
    await vi.waitFor(() => expect(mocks.getStatus).toHaveBeenCalledTimes(2));
    store.setState({
      status: newerWinner,
      uiState: "agent-speaking",
      error: "session D playback warning",
    });
    statusRefresh.resolve(observedWinner);

    await expect(replacingWithB).rejects.toThrow("session B handoff failed");
    expect(store.getState()).toMatchObject({
      status: newerWinner,
      uiState: "agent-speaking",
      error: "session D playback warning",
    });
  });

  it("refreshes a stale foreign renderer before choosing a call action", async () => {
    const store = await loadStore();
    store.setState({
      status: status("stopped", 1),
      uiState: "off",
      hydrated: true,
    });
    const active = status("running", 2, "session-a");
    mocks.getStatus.mockResolvedValue(active);

    await expect(store.getState().refreshStatus()).resolves.toEqual(active);

    expect(store.getState()).toMatchObject({
      status: active,
      uiState: "listening",
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

  it.each([
    ["starting", "starting"],
    ["running", "listening"],
    ["stopping", "stopping"],
  ] as const)("does not let a stale start failure mark a %s replacement as errored", async (lifecycle, uiState) => {
    const store = await loadStore();
    const startA = deferred<VoiceConversationStatus>();
    const replacementB = status(lifecycle, 4, "session-b");
    mocks.start.mockReturnValue(startA.promise);
    mocks.getStatus.mockResolvedValue(replacementB);

    const startingA = store.getState().start("session-a");
    store.setState({ status: replacementB, uiState, error: null });
    startA.reject(new Error("session A start tail failed"));

    await expect(startingA).rejects.toThrow("session A start tail failed");
    expect(store.getState()).toMatchObject({
      status: replacementB,
      uiState,
      error: null,
    });
  });

  it("preserves a local replacement when stale-start status refresh fails", async () => {
    const store = await loadStore();
    const startA = deferred<VoiceConversationStatus>();
    const startingB = status("starting", 4, "session-b");
    mocks.start.mockReturnValue(startA.promise);
    mocks.getStatus.mockRejectedValue(new Error("status unavailable"));

    const startingA = store.getState().start("session-a");
    store.setState({ status: startingB, uiState: "starting", error: null });
    startA.reject(new Error("session A start tail failed"));

    await expect(startingA).rejects.toThrow("session A start tail failed");
    expect(store.getState()).toMatchObject({
      status: startingB,
      uiState: "starting",
      error: null,
    });
  });

  it("preserves replacement activity while stale-start status refresh settles", async () => {
    const store = await loadStore();
    const startA = deferred<VoiceConversationStatus>();
    const statusRefresh = deferred<VoiceConversationStatus>();
    const runningB = status("running", 4, "session-b");
    mocks.start.mockReturnValue(startA.promise);
    mocks.getStatus.mockReturnValue(statusRefresh.promise);

    const startingA = store.getState().start("session-a");
    store.setState({ status: runningB, uiState: "listening", error: null });
    startA.reject(new Error("session A start tail failed"));
    await vi.waitFor(() => expect(mocks.getStatus).toHaveBeenCalledTimes(2));
    store.setState({
      status: runningB,
      uiState: "user-speaking",
      userSpeaking: true,
      error: "session B playback warning",
    });
    const mutedRunningB = { ...runningB, microphoneMuted: true };
    statusRefresh.resolve(mutedRunningB);

    await expect(startingA).rejects.toThrow("session A start tail failed");
    expect(store.getState()).toMatchObject({
      status: mutedRunningB,
      uiState: "listening",
      error: "session B playback warning",
      microphoneMuted: true,
      userSpeaking: false,
    });
    expect(mocks.reconcileMicrophone).toHaveBeenLastCalledWith(mutedRunningB);
  });

  it.each([
    ["stale start", "agent-speaking"],
    ["stale start", "error"],
    ["failed handoff", "agent-speaking"],
    ["failed handoff", "error"],
  ] as const)("preserves direct %s %s UI while applying authoritative mute", async (operation, uiState) => {
    const store = await loadStore();
    const active = status("running", 2, "session-a");
    const winner = {
      ...status("running", 4, "session-c"),
      microphoneMuted: true,
    };
    const request = deferred<VoiceConversationStatus>();
    mocks.getStatus.mockResolvedValue(winner);
    store.setState({ status: active, uiState: "listening" });

    let failing: Promise<VoiceConversationStatus>;
    if (operation === "stale start") {
      mocks.start.mockReturnValue(request.promise);
      failing = store.getState().start("session-b");
    } else {
      mocks.stopForReplacement.mockReturnValue(request.promise);
      failing = store.getState().stopForReplacement(active, "session-b");
    }
    store.setState({
      status: winner,
      uiState,
      error: uiState === "error" ? "session C warning" : null,
      assistantSpeaking: false,
      userSpeaking: false,
    });
    request.reject(new Error("stale operation failed"));

    await expect(failing).rejects.toThrow("stale operation failed");
    expect(store.getState()).toMatchObject({
      status: winner,
      uiState,
      error: uiState === "error" ? "session C warning" : null,
      microphoneMuted: true,
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

  it("preserves a terminal failure across same-revision clean shutdown", async () => {
    const store = await loadStore();
    store.setState({
      status: status("running", 2, "session-1"),
      uiState: "listening",
    });

    emit({
      type: "error",
      sessionId: "session-1",
      message: "Voice controls could not open",
      revision: 3,
      terminal: true,
    });
    emit({ type: "cleanShutdown", sessionId: "session-1", revision: 3 });

    expect(store.getState()).toMatchObject({
      status: status("stopped", 3),
      uiState: "error",
      error: "Voice controls could not open",
    });
  });

  it("keeps ordinary clean shutdown error-free", async () => {
    const store = await loadStore();
    store.setState({
      status: status("running", 2, "session-1"),
      uiState: "listening",
    });

    emit({ type: "cleanShutdown", sessionId: "session-1", revision: 3 });

    expect(store.getState()).toMatchObject({
      status: status("stopped", 3),
      uiState: "off",
      error: null,
    });
  });
});

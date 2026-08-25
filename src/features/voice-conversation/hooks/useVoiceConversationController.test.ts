import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import { useChatStore } from "@/features/chat/stores/chatStore";
import { useVoiceConversationStore } from "../stores/voiceConversationStore";
import { VoiceMicrophoneCaptureError } from "../api/voiceConversation";

const nativeAssistantSpeechMocks = vi.hoisted(() => ({
  capture: vi.fn(() => []),
  start: vi.fn(),
  stop: vi.fn(),
  takeNotices: vi.fn<() => string | null>(() => null),
}));
const tauriWindowMocks = vi.hoisted(() => ({ label: "main" }));
const voiceApiMocks = vi.hoisted(() => ({
  confirmForegroundSession: vi.fn<() => Promise<number>>(),
}));
const microphonePermissionMocks = vi.hoisted(() => ({
  getStatus: vi.fn<() => Promise<"authorized" | "denied">>(),
}));

vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({ label: tauriWindowMocks.label }),
}));

vi.mock("../lib/nativeAssistantSpeech", () => ({
  captureNativeAssistantSpeechHistory: nativeAssistantSpeechMocks.capture,
  startNativeAssistantSpeech: nativeAssistantSpeechMocks.start,
  stopNativeAssistantSpeech: nativeAssistantSpeechMocks.stop,
  takeVoicePlaybackNotices: nativeAssistantSpeechMocks.takeNotices,
}));

vi.mock("../api/voiceConversation", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api/voiceConversation")>()),
  confirmVoiceConversationForegroundSession:
    voiceApiMocks.confirmForegroundSession,
}));

vi.mock("../api/microphonePermission", () => ({
  getMicrophonePermissionStatus: microphonePermissionMocks.getStatus,
}));

import {
  canBindVoiceSendRoute,
  canReplaceActiveVoiceConversation,
  canClaimVoiceSendRoute,
  beginVoiceControlsVisibilityLease,
  createVoiceTranscriptDeliveryQueue,
  hasDeliveredVoiceTranscript,
  observeVoiceConversationControlVisibility,
  replaceActiveVoiceConversation,
  resetVoiceUiWhenRunSettles,
  resolveActiveVoiceButtonAction,
  resolveVoiceRouteMount,
  resolveVoiceToggleAction,
  shouldSuppressVoiceConversationControls,
  shouldShowVoiceConversationControl,
  shouldStartRequestedVoiceConversation,
  startPendingTranscriptRecovery,
  useVoiceConversationController,
  waitForVoiceDeliveryOpportunity,
} from "./useVoiceConversationController";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

describe("voice transcript delivery coordination", () => {
  it("suppresses floating controls only for the focused owner session", () => {
    const base = {
      activeSessionId: "session-1",
      currentSessionId: "session-1",
      ownerWindowLabel: "main",
      currentWindowLabel: "main",
      focused: true,
    };

    expect(shouldSuppressVoiceConversationControls(base)).toBe(true);
    expect(
      shouldSuppressVoiceConversationControls({
        ...base,
        currentSessionId: "session-2",
      }),
    ).toBe(false);
    expect(
      shouldSuppressVoiceConversationControls({ ...base, focused: false }),
    ).toBe(false);
    expect(
      shouldSuppressVoiceConversationControls({
        ...base,
        currentWindowLabel: "session-window",
      }),
    ).toBe(false);
  });

  it("observes focus before sampling and fails open when the owner unmounts", async () => {
    let focusListener: ((event: { payload: boolean }) => void) | undefined;
    let resolveFocused: ((focused: boolean) => void) | undefined;
    const focused = new Promise<boolean>((resolve) => {
      resolveFocused = resolve;
    });
    const reports: boolean[] = [];
    const stopPromise = observeVoiceConversationControlVisibility({
      activeSessionId: "session-1",
      currentSessionId: "session-1",
      ownerWindowLabel: "main",
      currentWindow: {
        label: "main",
        isFocused: () => focused,
        onFocusChanged: async (listener) => {
          focusListener = listener;
          return () => undefined;
        },
      },
      report: async (suppressed) => {
        reports.push(suppressed);
      },
      onError: vi.fn(),
    });

    await vi.waitFor(() => expect(focusListener).toBeDefined());
    focusListener?.({ payload: false });
    resolveFocused?.(true);
    const stop = await stopPromise;
    await vi.waitFor(() => expect(reports).toEqual([false]));

    stop();
    await vi.waitFor(() => expect(reports).toEqual([false, false]));
  });

  it("ignores a visibility observer that resolves after its replacement", async () => {
    const reports: string[] = [];
    const first = beginVoiceControlsVisibilityLease();
    await first.release(async () => {
      reports.push("first:cleanup");
    });
    const replacement = beginVoiceControlsVisibilityLease();

    await first.run(async () => {
      reports.push("first:late");
    });
    await replacement.run(async () => {
      reports.push("replacement:focused");
    });

    expect(reports).toEqual(["first:cleanup", "replacement:focused"]);
    replacement.invalidate();
  });

  it("recognizes a replayed transcript that was already delivered", () => {
    useChatStore.setState({
      messagesBySession: {
        "session-1": [
          {
            id: "user-1",
            role: "user",
            created: 1,
            content: [{ type: "text", text: "do this once" }],
            metadata: {
              origin: "voice_conversation",
              voiceUtteranceId: "7",
              voiceConversationLifecycleId: "lifecycle-1",
              voiceConversationRevision: 3,
            },
          },
        ],
      },
    });

    expect(
      hasDeliveredVoiceTranscript("session-1", "lifecycle-1", "7", 3),
    ).toBe(true);
    expect(
      hasDeliveredVoiceTranscript("session-1", "lifecycle-2", "7", 3),
    ).toBe(false);
  });

  it("keeps working state until an admitted run actually settles", async () => {
    useVoiceConversationStore.setState({
      status: {
        available: true,
        unavailableReason: null,
        lifecycle: "running",
        sessionId: "session-1",
        ownerWindowLabel: "main",
        microphoneMuted: false,
        revision: 3,
      },
      uiState: "agent-working",
      activityFallbackState: "agent-working",
    });

    resetVoiceUiWhenRunSettles("session-1", 3);
    await Promise.resolve();
    expect(useVoiceConversationStore.getState().uiState).toBe("agent-working");

    useChatStore.getState().setActiveRunId("session-1", "run-1");
    useChatStore.getState().setActiveRunId("session-1", null);

    expect(useVoiceConversationStore.getState().uiState).toBe("listening");
  });

  beforeEach(() => {
    tauriWindowMocks.label = "main";
    nativeAssistantSpeechMocks.capture.mockClear();
    nativeAssistantSpeechMocks.start.mockClear();
    nativeAssistantSpeechMocks.stop.mockClear();
    nativeAssistantSpeechMocks.takeNotices.mockClear();
    voiceApiMocks.confirmForegroundSession.mockReset();
    voiceApiMocks.confirmForegroundSession.mockResolvedValue(1);
    microphonePermissionMocks.getStatus.mockReset();
    microphonePermissionMocks.getStatus.mockResolvedValue("authorized");
    useChatStore.setState({ messagesBySession: {}, sessionStateById: {} });
  });
  it("serializes deliveries for the same session and re-evaluates in order", async () => {
    const enqueue = createVoiceTranscriptDeliveryQueue();
    const events: string[] = [];
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });

    const first = enqueue("session-1", async () => {
      events.push("first:start");
      await firstGate;
      events.push("first:end");
    });
    const second = enqueue("session-1", async () => {
      events.push("second:start");
      events.push("second:end");
    });

    await vi.waitFor(() => expect(events).toEqual(["first:start"]));
    releaseFirst();
    await Promise.all([first, second]);
    expect(events).toEqual([
      "first:start",
      "first:end",
      "second:start",
      "second:end",
    ]);
  });

  it("does not let a failed delivery poison the next queued delivery", async () => {
    const enqueue = createVoiceTranscriptDeliveryQueue();
    const next = vi.fn();
    const failed = enqueue("session-1", async () => {
      throw new Error("failed");
    });
    const recovered = enqueue("session-1", async () => {
      next();
    });

    await expect(failed).rejects.toThrow("failed");
    await expect(recovered).resolves.toBeUndefined();
    expect(next).toHaveBeenCalledOnce();
  });

  it("delivers a queued transcript after voice capture stops", async () => {
    useChatStore.getState().setChatState("session-1", "streaming");
    useVoiceConversationStore.setState({
      status: {
        available: true,
        unavailableReason: null,
        lifecycle: "stopped",
        sessionId: null,
        ownerWindowLabel: null,
        microphoneMuted: false,
        revision: 4,
      },
    });

    const opportunity = waitForVoiceDeliveryOpportunity("session-1");
    useChatStore.getState().setChatState("session-1", "idle");

    await expect(opportunity).resolves.toBe("send");
  });

  it("retries the durable native transcript queue without overlapping drains", async () => {
    vi.useFakeTimers();
    let release!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    const drain = vi
      .fn()
      .mockReturnValueOnce(pending)
      .mockResolvedValue(undefined);
    const onError = vi.fn();

    const stop = startPendingTranscriptRecovery(drain, onError, 500);
    expect(drain).toHaveBeenCalledOnce();

    await vi.advanceTimersByTimeAsync(1_500);
    expect(drain).toHaveBeenCalledOnce();

    release();
    await pending;
    await vi.advanceTimersByTimeAsync(500);
    expect(drain).toHaveBeenCalledTimes(2);

    stop();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(drain).toHaveBeenCalledTimes(2);
    expect(onError).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it("backs off repeated recovery failures and reports them once", async () => {
    vi.useFakeTimers();
    const drain = vi.fn().mockRejectedValue(new Error("rejected"));
    const onError = vi.fn();

    const stop = startPendingTranscriptRecovery(drain, onError, 100);
    await vi.runAllTicks();
    expect(drain).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledOnce();

    await vi.advanceTimersByTimeAsync(100);
    expect(drain).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(199);
    expect(drain).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(drain).toHaveBeenCalledTimes(3);
    expect(onError).toHaveBeenCalledOnce();

    stop();
    vi.useRealTimers();
  });

  it("binds routes only for enabled writable Goose sessions", () => {
    expect(
      canBindVoiceSendRoute({
        enabled: true,
        isGooseSession: true,
        readOnly: false,
        disabled: false,
      }),
    ).toBe(true);
    expect(
      canBindVoiceSendRoute({
        enabled: true,
        isGooseSession: false,
        readOnly: false,
        disabled: false,
      }),
    ).toBe(false);
    expect(
      canBindVoiceSendRoute({
        enabled: true,
        isGooseSession: true,
        readOnly: true,
        disabled: false,
      }),
    ).toBe(false);
    expect(
      canBindVoiceSendRoute({
        enabled: false,
        isGooseSession: true,
        readOnly: false,
        disabled: false,
      }),
    ).toBe(false);
  });

  it("starts a requested voice conversation only for its ready enabled Goose chat", () => {
    const readyRequest = {
      requestedStartSessionId: "session-1",
      sessionId: "session-1",
      hydrated: true,
      enabled: true,
      isGooseSession: true,
      pocketReady: true,
      routeReady: true,
    };

    expect(shouldStartRequestedVoiceConversation(readyRequest)).toBe(true);
    expect(
      shouldStartRequestedVoiceConversation({
        ...readyRequest,
        sessionId: "session-2",
      }),
    ).toBe(false);
    expect(
      shouldStartRequestedVoiceConversation({
        ...readyRequest,
        enabled: false,
      }),
    ).toBe(false);
    expect(
      shouldStartRequestedVoiceConversation({
        ...readyRequest,
        isGooseSession: false,
      }),
    ).toBe(false);
    expect(
      shouldStartRequestedVoiceConversation({
        ...readyRequest,
        pocketReady: false,
      }),
    ).toBe(false);
    expect(
      shouldStartRequestedVoiceConversation({
        ...readyRequest,
        routeReady: false,
      }),
    ).toBe(false);
  });

  it("starts a first-run request after Pocket installation refreshes availability", async () => {
    const init = vi.fn().mockResolvedValue(undefined);
    const refreshStatus = vi
      .fn()
      .mockImplementation(() =>
        Promise.resolve(useVoiceConversationStore.getState().status),
      );
    const start = vi.fn().mockResolvedValue({
      available: true,
      unavailableReason: null,
      lifecycle: "starting" as const,
      sessionId: "session-1",
      ownerWindowLabel: "main",
      microphoneMuted: false,
      revision: 1,
    });
    useVoiceConversationStore.setState({
      status: {
        available: false,
        unavailableReason: "Download Pocket TTS.",
        lifecycle: "unavailable",
        sessionId: null,
        ownerWindowLabel: null,
        microphoneMuted: false,
        revision: 0,
      },
      hydrated: true,
      init,
      refreshStatus,
      start,
      requestedStartSessionId: "session-1",
    });

    const options = {
      sessionId: "session-1",
      onSend: vi.fn().mockResolvedValue(true),
      enabled: true,
      isGooseSession: true,
      onPocketSetupRequired: vi.fn(),
    };
    const { rerender } = renderHook(
      ({ pocketReady }) =>
        useVoiceConversationController({ ...options, pocketReady }),
      { initialProps: { pocketReady: false } },
    );

    await waitFor(() => expect(init).toHaveBeenCalledTimes(1));
    rerender({ pocketReady: true });
    await waitFor(() => expect(init).toHaveBeenCalledTimes(2));

    act(() => {
      useVoiceConversationStore.setState((state) => ({
        status: {
          ...state.status,
          available: true,
          unavailableReason: null,
          lifecycle: "stopped",
        },
      }));
    });

    await waitFor(() =>
      expect(start).toHaveBeenCalledWith("session-1", "parakeet", 1),
    );
    expect(
      useVoiceConversationStore.getState().requestedStartSessionId,
    ).toBeNull();
  });

  it("does not let navigation steal an active voice session route", () => {
    expect(canClaimVoiceSendRoute("session-1", "session-1", "session-1")).toBe(
      true,
    );
    expect(canClaimVoiceSendRoute("session-1", "session-1", "session-2")).toBe(
      false,
    );
    expect(canClaimVoiceSendRoute(null, "session-1", "session-2")).toBe(false);
    expect(canClaimVoiceSendRoute(null, null, "session-2")).toBe(true);
  });

  it("replaces the active call when starting from another session", () => {
    expect(resolveActiveVoiceButtonAction("session-1", "session-2")).toBe(
      "replace",
    );
    expect(resolveActiveVoiceButtonAction("session-1", "session-1")).toBe(
      "stop",
    );
  });

  it("refreshes stale status before handing a foreign call to this session", async () => {
    const active = {
      available: true,
      unavailableReason: null,
      lifecycle: "running" as const,
      sessionId: "session-a",
      ownerWindowLabel: "session-window-a",
      microphoneMuted: false,
      revision: 2,
    };
    const stopped = {
      ...active,
      lifecycle: "stopped" as const,
      sessionId: null,
      ownerWindowLabel: null,
      revision: 3,
    };
    const stopRequest = deferred<typeof stopped>();
    const refreshStatus = vi.fn().mockResolvedValue(active);
    const stopForReplacement = vi.fn().mockReturnValue(stopRequest.promise);
    const start = vi.fn().mockResolvedValue({
      ...active,
      sessionId: "session-b",
      ownerWindowLabel: "session-window-b",
      revision: 4,
    });
    useVoiceConversationStore.setState({
      status: {
        ...stopped,
        revision: 1,
      },
      uiState: "off",
      hydrated: true,
      init: vi.fn().mockResolvedValue(undefined),
      refreshStatus,
      stopForReplacement,
      start,
    });
    const { result } = renderHook(() =>
      useVoiceConversationController({
        sessionId: "session-b",
        onSend: vi.fn().mockResolvedValue(true),
        enabled: true,
        isGooseSession: true,
        pocketReady: true,
        onPocketSetupRequired: vi.fn(),
      }),
    );

    let handoff: Promise<void> | undefined;
    act(() => {
      handoff = Promise.resolve(result.current.onToggle());
    });
    await vi.waitFor(() => expect(refreshStatus).toHaveBeenCalledOnce());
    await vi.waitFor(() =>
      expect(stopForReplacement).toHaveBeenCalledWith(active, "session-b"),
    );
    expect(start).not.toHaveBeenCalled();

    await act(async () => {
      stopRequest.resolve(stopped);
      await handoff;
    });
    expect(start).toHaveBeenCalledWith("session-b", "parakeet", 1);
  });

  it("does not start a replacement superseded after the active call stops", async () => {
    const active = {
      available: true,
      unavailableReason: null,
      lifecycle: "running" as const,
      sessionId: "session-a",
      ownerWindowLabel: "session-window-a",
      microphoneMuted: false,
      revision: 2,
    };
    const stopped = {
      ...active,
      lifecycle: "stopped" as const,
      sessionId: null,
      ownerWindowLabel: null,
      revision: 3,
    };
    const start = vi.fn();
    voiceApiMocks.confirmForegroundSession
      .mockResolvedValueOnce(1)
      .mockRejectedValueOnce(
        new Error("The target session is no longer in the foreground."),
      );
    useVoiceConversationStore.setState({
      status: active,
      uiState: "listening",
      hydrated: true,
      init: vi.fn().mockResolvedValue(undefined),
      refreshStatus: vi.fn().mockResolvedValue(active),
      stopForReplacement: vi.fn().mockResolvedValue(stopped),
      start,
    });
    const { result } = renderHook(() =>
      useVoiceConversationController({
        sessionId: "session-b",
        onSend: vi.fn().mockResolvedValue(true),
        enabled: true,
        isGooseSession: true,
        pocketReady: true,
        onPocketSetupRequired: vi.fn(),
      }),
    );

    await act(async () => {
      await result.current.onToggle();
    });

    expect(voiceApiMocks.confirmForegroundSession).toHaveBeenCalledTimes(2);
    expect(start).not.toHaveBeenCalled();
  });

  it("accepts a later toggle after a replacement attempt times out", async () => {
    const active = {
      available: true,
      unavailableReason: null,
      lifecycle: "running" as const,
      sessionId: "session-a",
      ownerWindowLabel: "session-window-a",
      microphoneMuted: false,
      revision: 2,
    };
    const refreshStatus = vi.fn().mockResolvedValue(active);
    const stopForReplacement = vi
      .fn()
      .mockRejectedValue(new Error("Foreground claim timed out"));
    useVoiceConversationStore.setState({
      status: active,
      uiState: "listening",
      hydrated: true,
      init: vi.fn().mockResolvedValue(undefined),
      refreshStatus,
      stopForReplacement,
      start: vi.fn(),
    });
    const { result } = renderHook(() =>
      useVoiceConversationController({
        sessionId: "session-b",
        onSend: vi.fn().mockResolvedValue(true),
        enabled: true,
        isGooseSession: true,
        pocketReady: true,
        onPocketSetupRequired: vi.fn(),
      }),
    );

    await act(async () => {
      await result.current.onToggle();
    });
    await act(async () => {
      await result.current.onToggle();
    });

    expect(refreshStatus).toHaveBeenCalledTimes(2);
    expect(stopForReplacement).toHaveBeenCalledTimes(2);
  });

  it("allows a new session to replace a running call while the prior start settles", async () => {
    const stopped = {
      available: true,
      unavailableReason: null,
      lifecycle: "stopped" as const,
      sessionId: null,
      ownerWindowLabel: null,
      microphoneMuted: false,
      revision: 1,
    };
    const runningA = {
      ...stopped,
      lifecycle: "running" as const,
      sessionId: "session-a",
      ownerWindowLabel: "main",
      revision: 2,
    };
    const stoppedA = {
      ...stopped,
      revision: 3,
    };
    const runningB = {
      ...runningA,
      sessionId: "session-b",
      revision: 4,
    };
    const startA = deferred<typeof runningA>();
    const refreshStatus = vi
      .fn()
      .mockImplementation(() =>
        Promise.resolve(useVoiceConversationStore.getState().status),
      );
    const start = vi
      .fn()
      .mockReturnValueOnce(startA.promise)
      .mockResolvedValueOnce(runningB);
    const stopForReplacement = vi.fn().mockResolvedValue(stoppedA);
    useVoiceConversationStore.setState({
      status: stopped,
      uiState: "off",
      hydrated: true,
      init: vi.fn().mockResolvedValue(undefined),
      refreshStatus,
      drainPendingTranscripts: vi.fn().mockResolvedValue(undefined),
      stopForReplacement,
      start,
    });
    const sessionA = renderHook(() =>
      useVoiceConversationController({
        sessionId: "session-a",
        onSend: vi.fn().mockResolvedValue(true),
        enabled: true,
        isGooseSession: true,
        pocketReady: true,
        onPocketSetupRequired: vi.fn(),
      }),
    );

    let startRequest!: Promise<void>;
    act(() => {
      startRequest = Promise.resolve(sessionA.result.current.onToggle());
    });
    await vi.waitFor(() => expect(start).toHaveBeenCalledOnce());
    sessionA.unmount();
    act(() => {
      useVoiceConversationStore.setState({
        status: runningA,
        uiState: "listening",
      });
    });

    const sessionB = renderHook(() =>
      useVoiceConversationController({
        sessionId: "session-b",
        onSend: vi.fn().mockResolvedValue(true),
        enabled: true,
        isGooseSession: true,
        pocketReady: true,
        onPocketSetupRequired: vi.fn(),
      }),
    );
    await act(async () => {
      await sessionB.result.current.onToggle();
    });

    act(() => {
      useVoiceConversationStore.setState({
        status: runningB,
        uiState: "listening",
        error: null,
      });
    });
    startA.reject(new Error("session A start tail failed"));
    await startRequest;
    expect(stopForReplacement).toHaveBeenCalledWith(runningA, "session-b");
    expect(start).toHaveBeenCalledTimes(2);
    expect(nativeAssistantSpeechMocks.stop).not.toHaveBeenCalled();
    expect(useVoiceConversationStore.getState()).toMatchObject({
      status: runningB,
      uiState: "listening",
      error: null,
    });
  });

  it.each([
    ["session-b", "session-c"],
    ["session-c", "session-b"],
  ] as const)("serializes a %s handoff ahead of competing %s", async (winnerSessionId, loserSessionId) => {
    const active = {
      available: true,
      unavailableReason: null,
      lifecycle: "running" as const,
      sessionId: "session-a",
      ownerWindowLabel: "main",
      microphoneMuted: false,
      revision: 2,
    };
    const stopped = {
      ...active,
      lifecycle: "stopped" as const,
      sessionId: null,
      ownerWindowLabel: null,
      revision: 3,
    };
    const runningWinner = {
      ...active,
      sessionId: winnerSessionId,
      revision: 4,
    };
    const winnerRefresh = deferred<typeof active>();
    const loserRefresh = deferred<typeof active | typeof stopped>();
    const stopRequest = deferred<typeof stopped>();
    const startRequest = deferred<typeof runningWinner>();
    const refreshStatus = vi
      .fn()
      .mockReturnValueOnce(winnerRefresh.promise)
      .mockReturnValueOnce(loserRefresh.promise);
    const stopForReplacement = vi.fn().mockReturnValue(stopRequest.promise);
    const start = vi.fn().mockReturnValue(startRequest.promise);
    useVoiceConversationStore.setState({
      status: active,
      uiState: "listening",
      hydrated: true,
      init: vi.fn().mockResolvedValue(undefined),
      refreshStatus,
      drainPendingTranscripts: vi.fn().mockResolvedValue(undefined),
      stopForReplacement,
      start,
    });
    const controllers = new Map(
      ["session-b", "session-c"].map((candidateSessionId) => [
        candidateSessionId,
        renderHook(() =>
          useVoiceConversationController({
            sessionId: candidateSessionId,
            onSend: vi.fn().mockResolvedValue(true),
            enabled: true,
            isGooseSession: true,
            pocketReady: true,
            onPocketSetupRequired: vi.fn(),
          }),
        ),
      ]),
    );

    let winnerToggle!: Promise<void>;
    let loserToggle!: Promise<void>;
    act(() => {
      winnerToggle = Promise.resolve(
        controllers.get(winnerSessionId)?.result.current.onToggle(),
      );
      loserToggle = Promise.resolve(
        controllers.get(loserSessionId)?.result.current.onToggle(),
      );
    });
    winnerRefresh.resolve(active);
    await vi.waitFor(() => expect(stopForReplacement).toHaveBeenCalledOnce());
    loserRefresh.resolve(stopped);
    await loserToggle;
    expect(stopForReplacement).toHaveBeenCalledWith(active, winnerSessionId);
    expect(start).not.toHaveBeenCalled();

    stopRequest.resolve(stopped);
    await vi.waitFor(() => expect(start).toHaveBeenCalledOnce());
    act(() => {
      useVoiceConversationStore.setState({
        status: runningWinner,
        uiState: "listening",
      });
    });
    expect(nativeAssistantSpeechMocks.start).not.toHaveBeenCalled();
    startRequest.resolve(runningWinner);
    await winnerToggle;

    expect(start).toHaveBeenCalledWith(winnerSessionId, "parakeet", 1);
    expect(nativeAssistantSpeechMocks.start).toHaveBeenLastCalledWith(
      winnerSessionId,
      expect.any(Function),
      [],
    );
    expect(nativeAssistantSpeechMocks.stop).not.toHaveBeenCalled();
  });

  it("does not disturb assistant speech when the current session fails to start", async () => {
    const stopped = {
      available: true,
      unavailableReason: null,
      lifecycle: "stopped" as const,
      sessionId: null,
      ownerWindowLabel: null,
      microphoneMuted: false,
      revision: 1,
    };
    const starting = {
      ...stopped,
      lifecycle: "starting" as const,
      sessionId: "session-a",
      ownerWindowLabel: "main",
      revision: 2,
    };
    const startRequest = deferred<typeof starting>();
    const start = vi.fn().mockReturnValue(startRequest.promise);
    useVoiceConversationStore.setState({
      status: stopped,
      uiState: "off",
      hydrated: true,
      init: vi.fn().mockResolvedValue(undefined),
      refreshStatus: vi.fn().mockResolvedValue(stopped),
      drainPendingTranscripts: vi.fn().mockResolvedValue(undefined),
      start,
    });
    const { result } = renderHook(() =>
      useVoiceConversationController({
        sessionId: "session-a",
        onSend: vi.fn().mockResolvedValue(true),
        enabled: true,
        isGooseSession: true,
        pocketReady: true,
        onPocketSetupRequired: vi.fn(),
      }),
    );

    let toggling!: Promise<void>;
    act(() => {
      toggling = Promise.resolve(result.current.onToggle());
    });
    await vi.waitFor(() => expect(start).toHaveBeenCalledOnce());
    act(() => {
      useVoiceConversationStore.setState({
        status: starting,
        uiState: "starting",
      });
    });
    startRequest.reject(new Error("start failed"));
    await toggling;

    expect(nativeAssistantSpeechMocks.capture).toHaveBeenCalledWith(
      "session-a",
    );
    expect(nativeAssistantSpeechMocks.start).not.toHaveBeenCalled();
    expect(nativeAssistantSpeechMocks.stop).not.toHaveBeenCalled();
  });

  it("activates captured speech history when a rejected start is already running", async () => {
    const stopped = {
      available: true,
      unavailableReason: null,
      lifecycle: "stopped" as const,
      sessionId: null,
      ownerWindowLabel: null,
      microphoneMuted: false,
      revision: 1,
    };
    const running = {
      ...stopped,
      lifecycle: "running" as const,
      sessionId: "session-a",
      ownerWindowLabel: "main",
      revision: 2,
    };
    const startRequest = deferred<typeof running>();
    const start = vi.fn().mockReturnValue(startRequest.promise);
    const refreshStatus = vi
      .fn()
      .mockResolvedValueOnce(stopped)
      .mockImplementationOnce(async () => {
        useVoiceConversationStore.setState({
          status: running,
          uiState: "listening",
          error: null,
        });
        return running;
      });
    useVoiceConversationStore.setState({
      status: stopped,
      uiState: "off",
      hydrated: true,
      init: vi.fn().mockResolvedValue(undefined),
      refreshStatus,
      drainPendingTranscripts: vi.fn().mockResolvedValue(undefined),
      start,
    });
    const { result } = renderHook(() =>
      useVoiceConversationController({
        sessionId: "session-a",
        onSend: vi.fn().mockResolvedValue(true),
        enabled: true,
        isGooseSession: true,
        pocketReady: true,
        onPocketSetupRequired: vi.fn(),
      }),
    );

    let toggling!: Promise<void>;
    act(() => {
      toggling = Promise.resolve(result.current.onToggle());
    });
    await vi.waitFor(() => expect(start).toHaveBeenCalledOnce());
    act(() => {
      useVoiceConversationStore.setState({
        status: running,
        uiState: "error",
        error: "renderer reconciliation failed",
      });
    });
    expect(nativeAssistantSpeechMocks.start).not.toHaveBeenCalled();
    await act(async () => {
      startRequest.reject(new Error("renderer reconciliation failed"));
      await toggling;
    });

    expect(nativeAssistantSpeechMocks.start).toHaveBeenCalledOnce();
    expect(nativeAssistantSpeechMocks.start).toHaveBeenCalledWith(
      "session-a",
      expect.any(Function),
      [],
    );
    expect(nativeAssistantSpeechMocks.stop).not.toHaveBeenCalled();
    expect(useVoiceConversationStore.getState()).toMatchObject({
      status: running,
      uiState: "listening",
      error: null,
    });
    expect(
      useChatStore.getState().messagesBySession["session-a"],
    ).toBeUndefined();
    expect(refreshStatus).toHaveBeenCalledTimes(2);
  });

  it("surfaces a rejected start when owner microphone reconciliation still fails", async () => {
    const stopped = {
      available: true,
      unavailableReason: null,
      lifecycle: "stopped" as const,
      sessionId: null,
      ownerWindowLabel: null,
      microphoneMuted: false,
      revision: 1,
    };
    const running = {
      ...stopped,
      lifecycle: "running" as const,
      sessionId: "session-a",
      ownerWindowLabel: "main",
      revision: 2,
    };
    const startRequest = deferred<typeof running>();
    const start = vi.fn().mockReturnValue(startRequest.promise);
    useVoiceConversationStore.setState({
      status: stopped,
      uiState: "off",
      hydrated: true,
      init: vi.fn().mockResolvedValue(undefined),
      refreshStatus: vi
        .fn()
        .mockResolvedValueOnce(stopped)
        .mockRejectedValueOnce(new Error("microphone unavailable")),
      drainPendingTranscripts: vi.fn().mockResolvedValue(undefined),
      start,
    });
    const { result } = renderHook(() =>
      useVoiceConversationController({
        sessionId: "session-a",
        onSend: vi.fn().mockResolvedValue(true),
        enabled: true,
        isGooseSession: true,
        pocketReady: true,
        onPocketSetupRequired: vi.fn(),
      }),
    );

    let toggling!: Promise<void>;
    act(() => {
      toggling = Promise.resolve(result.current.onToggle());
    });
    await vi.waitFor(() => expect(start).toHaveBeenCalledOnce());
    act(() => {
      useVoiceConversationStore.setState({
        status: running,
        uiState: "error",
        error: "renderer reconciliation failed",
      });
    });
    startRequest.reject(new Error("renderer reconciliation failed"));
    await toggling;

    expect(nativeAssistantSpeechMocks.start).not.toHaveBeenCalled();
    expect(useChatStore.getState().messagesBySession["session-a"]).toHaveLength(
      1,
    );
  });

  it("opens Voice settings without starting when microphone access is denied", async () => {
    const stopped = {
      available: true,
      unavailableReason: null,
      lifecycle: "stopped" as const,
      sessionId: null,
      ownerWindowLabel: null,
      microphoneMuted: false,
      revision: 1,
    };
    const start = vi.fn();
    const onVoiceSetupRequired = vi.fn();
    microphonePermissionMocks.getStatus.mockResolvedValue("denied");
    useVoiceConversationStore.setState({
      status: stopped,
      uiState: "off",
      hydrated: true,
      init: vi.fn().mockResolvedValue(undefined),
      refreshStatus: vi.fn().mockResolvedValue(stopped),
      drainPendingTranscripts: vi.fn().mockResolvedValue(undefined),
      start,
    });
    const { result } = renderHook(() =>
      useVoiceConversationController({
        sessionId: "session-a",
        onSend: vi.fn().mockResolvedValue(true),
        enabled: true,
        isGooseSession: true,
        pocketReady: true,
        onPocketSetupRequired: onVoiceSetupRequired,
      }),
    );

    await act(async () => {
      await result.current.onToggle();
    });

    expect(start).not.toHaveBeenCalled();
    expect(onVoiceSetupRequired).toHaveBeenCalledOnce();
  });

  it("opens Voice settings when microphone capture cannot start", async () => {
    const stopped = {
      available: true,
      unavailableReason: null,
      lifecycle: "stopped" as const,
      sessionId: null,
      ownerWindowLabel: null,
      microphoneMuted: false,
      revision: 1,
    };
    const running = {
      ...stopped,
      lifecycle: "running" as const,
      sessionId: "session-a",
      ownerWindowLabel: "main",
      revision: 2,
    };
    const onVoiceSetupRequired = vi.fn();
    const stop = vi.fn().mockImplementation(async () => {
      useVoiceConversationStore.setState({
        status: stopped,
        uiState: "error",
        error: "The backend already stopped",
      });
      throw new Error("The backend already stopped");
    });
    useVoiceConversationStore.setState({
      status: stopped,
      uiState: "off",
      hydrated: true,
      init: vi.fn().mockResolvedValue(undefined),
      refreshStatus: vi.fn().mockResolvedValue(stopped),
      drainPendingTranscripts: vi.fn().mockResolvedValue(undefined),
      start: vi.fn().mockImplementation(async () => {
        useVoiceConversationStore.setState({
          status: running,
          uiState: "error",
          error: "Permission denied",
        });
        throw new VoiceMicrophoneCaptureError(
          new DOMException("Permission denied", "NotAllowedError"),
        );
      }),
      stop,
    });
    const { result } = renderHook(() =>
      useVoiceConversationController({
        sessionId: "session-a",
        onSend: vi.fn().mockResolvedValue(true),
        enabled: true,
        isGooseSession: true,
        pocketReady: true,
        onPocketSetupRequired: onVoiceSetupRequired,
      }),
    );

    await act(async () => {
      await result.current.onToggle();
    });

    expect(stop).toHaveBeenCalledOnce();
    expect(onVoiceSetupRequired).toHaveBeenCalledOnce();
    expect(useVoiceConversationStore.getState()).toMatchObject({
      status: stopped,
      uiState: "off",
      error: null,
    });
  });

  it("does not activate speech when a non-owner mounts an already-running session", () => {
    const running = {
      available: true,
      unavailableReason: null,
      lifecycle: "running" as const,
      sessionId: "session-a",
      ownerWindowLabel: "session-window-owner",
      microphoneMuted: false,
      revision: 2,
    };
    tauriWindowMocks.label = "session-window-mirror";
    useVoiceConversationStore.setState({
      status: running,
      uiState: "listening",
      hydrated: true,
      init: vi.fn().mockResolvedValue(undefined),
      drainPendingTranscripts: vi.fn().mockResolvedValue(undefined),
    });

    renderHook(() =>
      useVoiceConversationController({
        sessionId: "session-a",
        onSend: vi.fn().mockResolvedValue(true),
        enabled: true,
        isGooseSession: true,
        pocketReady: true,
        onPocketSetupRequired: vi.fn(),
      }),
    );

    expect(nativeAssistantSpeechMocks.start).not.toHaveBeenCalled();
    expect(nativeAssistantSpeechMocks.stop).not.toHaveBeenCalled();
  });

  it("does not activate speech for another window's same-session lifecycle", async () => {
    const stopped = {
      available: true,
      unavailableReason: null,
      lifecycle: "stopped" as const,
      sessionId: null,
      ownerWindowLabel: null,
      microphoneMuted: false,
      revision: 1,
    };
    const winner = {
      ...stopped,
      lifecycle: "running" as const,
      sessionId: "session-a",
      ownerWindowLabel: "session-window-winner",
      revision: 2,
    };
    const startRequest = deferred<typeof winner>();
    const start = vi.fn().mockReturnValue(startRequest.promise);
    tauriWindowMocks.label = "session-window-loser";
    useVoiceConversationStore.setState({
      status: stopped,
      uiState: "off",
      hydrated: true,
      init: vi.fn().mockResolvedValue(undefined),
      refreshStatus: vi.fn().mockResolvedValue(stopped),
      drainPendingTranscripts: vi.fn().mockResolvedValue(undefined),
      start,
    });
    const { result } = renderHook(() =>
      useVoiceConversationController({
        sessionId: "session-a",
        onSend: vi.fn().mockResolvedValue(true),
        enabled: true,
        isGooseSession: true,
        pocketReady: true,
        onPocketSetupRequired: vi.fn(),
      }),
    );

    let toggling!: Promise<void>;
    act(() => {
      toggling = Promise.resolve(result.current.onToggle());
    });
    await vi.waitFor(() => expect(start).toHaveBeenCalledOnce());
    act(() => {
      useVoiceConversationStore.setState({
        status: winner,
        uiState: "listening",
      });
    });
    startRequest.reject(new Error("lost same-session start"));
    await toggling;

    expect(nativeAssistantSpeechMocks.start).not.toHaveBeenCalled();
    expect(nativeAssistantSpeechMocks.stop).not.toHaveBeenCalled();
  });

  it("deduplicates concurrent controls for the same session", async () => {
    const stopped = {
      available: true,
      unavailableReason: null,
      lifecycle: "stopped" as const,
      sessionId: null,
      ownerWindowLabel: null,
      microphoneMuted: false,
      revision: 1,
    };
    const running = {
      ...stopped,
      lifecycle: "running" as const,
      sessionId: "session-a",
      ownerWindowLabel: "main",
      revision: 2,
    };
    const startRequest = deferred<typeof running>();
    const refreshStatus = vi.fn().mockResolvedValue(stopped);
    const start = vi.fn().mockReturnValue(startRequest.promise);
    useVoiceConversationStore.setState({
      status: stopped,
      uiState: "off",
      hydrated: true,
      init: vi.fn().mockResolvedValue(undefined),
      refreshStatus,
      start,
    });
    const options = {
      sessionId: "session-a",
      onSend: vi.fn().mockResolvedValue(true),
      enabled: true,
      isGooseSession: true,
      pocketReady: true,
      onPocketSetupRequired: vi.fn(),
    };
    const firstControl = renderHook(() =>
      useVoiceConversationController(options),
    );
    const secondControl = renderHook(() =>
      useVoiceConversationController(options),
    );

    let firstToggle!: Promise<void>;
    act(() => {
      firstToggle = Promise.resolve(firstControl.result.current.onToggle());
    });
    await vi.waitFor(() => expect(start).toHaveBeenCalledOnce());
    await act(async () => {
      await secondControl.result.current.onToggle();
    });

    expect(refreshStatus).toHaveBeenCalledOnce();
    expect(start).toHaveBeenCalledOnce();
    startRequest.resolve(running);
    await firstToggle;
  });

  it("keeps an ineligible foreign session from controlling the active call", () => {
    expect(
      canReplaceActiveVoiceConversation({
        canToggle: false,
        hydrated: true,
        pocketReady: true,
      }),
    ).toBe(false);
    expect(
      canReplaceActiveVoiceConversation({
        canToggle: true,
        hydrated: false,
        pocketReady: true,
      }),
    ).toBe(false);
    expect(
      canReplaceActiveVoiceConversation({
        canToggle: true,
        hydrated: true,
        pocketReady: false,
      }),
    ).toBe(false);
    expect(
      shouldShowVoiceConversationControl({
        activeConversation: true,
        controlEnabled: false,
        voiceEnabled: true,
        isGooseSession: true,
      }),
    ).toBe(false);
    expect(
      shouldShowVoiceConversationControl({
        activeConversation: true,
        controlEnabled: true,
        voiceEnabled: true,
        isGooseSession: true,
      }),
    ).toBe(true);
  });

  it("starts the replacement only after the active call fully stops", async () => {
    let finishStop:
      | ((status: { lifecycle: string; sessionId: null }) => void)
      | undefined;
    const stop = vi.fn(
      () =>
        new Promise<{ lifecycle: string; sessionId: null }>((resolve) => {
          finishStop = resolve;
        }),
    );
    const start = vi.fn().mockResolvedValue(undefined);

    const replacement = replaceActiveVoiceConversation({ stop, start });
    await Promise.resolve();
    expect(start).not.toHaveBeenCalled();

    finishStop?.({ lifecycle: "stopped", sessionId: null });
    await expect(replacement).resolves.toBe(true);
    expect(start).toHaveBeenCalledOnce();
  });

  it("reconfirms the target after stopping and before starting", async () => {
    const order: string[] = [];
    const stop = vi.fn(async () => {
      order.push("stop");
      return { lifecycle: "stopped", sessionId: null };
    });
    const confirmTarget = vi.fn(async () => {
      order.push("confirm");
    });
    const start = vi.fn(async () => {
      order.push("start");
    });

    await expect(
      replaceActiveVoiceConversation({ stop, confirmTarget, start }),
    ).resolves.toBe(true);
    expect(order).toEqual(["stop", "confirm", "start"]);
  });

  it("does not start when the target changes after stopping", async () => {
    const start = vi.fn().mockResolvedValue(undefined);

    await expect(
      replaceActiveVoiceConversation({
        stop: vi.fn().mockResolvedValue({
          lifecycle: "stopped",
          sessionId: null,
        }),
        confirmTarget: vi
          .fn()
          .mockRejectedValue(
            new Error("The target session is no longer in the foreground."),
          ),
        start,
      }),
    ).rejects.toThrow("no longer in the foreground");
    expect(start).not.toHaveBeenCalled();
  });

  it("does not start a replacement when the active call remains running", async () => {
    const start = vi.fn().mockResolvedValue(undefined);

    await expect(
      replaceActiveVoiceConversation({
        stop: vi.fn().mockResolvedValue({
          lifecycle: "running",
          sessionId: "session-1",
        }),
        start,
      }),
    ).resolves.toBe(false);
    expect(start).not.toHaveBeenCalled();
  });

  it("does not start a replacement when stopping the active call fails", async () => {
    const start = vi.fn().mockResolvedValue(undefined);

    await expect(
      replaceActiveVoiceConversation({
        stop: vi.fn().mockRejectedValue(new Error("stop failed")),
        start,
      }),
    ).rejects.toThrow("stop failed");
    expect(start).not.toHaveBeenCalled();
  });

  it("drains retained transcripts without stealing a stopped session route", () => {
    expect(
      resolveVoiceRouteMount({
        routeIsValid: true,
        activeVoiceSessionId: null,
        boundRouteSessionId: "session-1",
        candidateSessionId: "session-2",
      }),
    ).toEqual({
      claimRoute: false,
      drainPending: true,
    });
  });

  it("does not drain without a route for the retained transcript", () => {
    expect(
      resolveVoiceRouteMount({
        routeIsValid: true,
        activeVoiceSessionId: "session-1",
        boundRouteSessionId: null,
        candidateSessionId: "session-2",
      }),
    ).toEqual({
      claimRoute: false,
      drainPending: false,
    });
  });

  it("opens setup instead of starting until Pocket is installed", () => {
    expect(
      resolveVoiceToggleAction({
        active: false,
        canToggle: true,
        pocketReady: false,
      }),
    ).toBe("setup");
    expect(
      resolveVoiceToggleAction({
        active: false,
        canToggle: true,
        pocketReady: true,
      }),
    ).toBe("start");
    expect(
      resolveVoiceToggleAction({
        active: true,
        canToggle: true,
        pocketReady: false,
      }),
    ).toBe("stop");
  });
});

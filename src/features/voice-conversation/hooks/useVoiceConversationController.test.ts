import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import { useChatStore } from "@/features/chat/stores/chatStore";
import { useVoiceConversationStore } from "../stores/voiceConversationStore";

const nativeAssistantSpeechMocks = vi.hoisted(() => ({
  start: vi.fn(),
  stop: vi.fn(),
  takeNotices: vi.fn<() => string | null>(() => null),
}));

vi.mock("../lib/nativeAssistantSpeech", () => ({
  startNativeAssistantSpeech: nativeAssistantSpeechMocks.start,
  stopNativeAssistantSpeech: nativeAssistantSpeechMocks.stop,
  takeVoicePlaybackNotices: nativeAssistantSpeechMocks.takeNotices,
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
    nativeAssistantSpeechMocks.start.mockClear();
    nativeAssistantSpeechMocks.stop.mockClear();
    nativeAssistantSpeechMocks.takeNotices.mockClear();
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

    await waitFor(() => expect(start).toHaveBeenCalledWith("session-1"));
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

import { beforeEach, describe, expect, it, vi } from "vitest";
import { useChatStore } from "@/features/chat/stores/chatStore";
import { useVoiceConversationStore } from "../stores/voiceConversationStore";

import {
  canBindVoiceSendRoute,
  canClaimVoiceSendRoute,
  createVoiceRouteMountRegistry,
  createVoiceTranscriptDeliveryQueue,
  hasDeliveredVoiceTranscript,
  resetVoiceUiWhenRunSettles,
  resolveVoiceRouteMount,
  resolveVoiceToggleAction,
  shouldStartRequestedVoiceConversation,
  shouldStopVoiceWhenRouteUnmounts,
  startPendingTranscriptRecovery,
  waitForVoiceDeliveryOpportunity,
} from "./useVoiceConversationController";

describe("voice transcript delivery coordination", () => {
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

  it("stops only after the final view for the bound chat unmounts", () => {
    const scheduled: Array<() => void> = [];
    const registry = createVoiceRouteMountRegistry((callback) =>
      scheduled.push(callback),
    );
    const onLastUnmount = vi.fn();
    const unregisterFirst = registry.register("session-1", onLastUnmount);
    const unregisterSecond = registry.register("session-1", onLastUnmount);

    unregisterFirst();
    scheduled.splice(0).forEach((callback) => {
      callback();
    });
    expect(onLastUnmount).not.toHaveBeenCalled();

    unregisterSecond();
    const remounted = registry.register("session-1", onLastUnmount);
    scheduled.splice(0).forEach((callback) => {
      callback();
    });
    expect(onLastUnmount).not.toHaveBeenCalled();

    remounted();
    scheduled.splice(0).forEach((callback) => {
      callback();
    });
    expect(onLastUnmount).toHaveBeenCalledOnce();
  });

  it("stops a starting or running voice lifecycle when its chat disappears", () => {
    expect(
      shouldStopVoiceWhenRouteUnmounts(
        {
          available: true,
          unavailableReason: null,
          lifecycle: "running",
          sessionId: "session-1",
          ownerWindowLabel: "main",
          revision: 3,
        },
        "session-1",
      ),
    ).toBe(true);
    expect(
      shouldStopVoiceWhenRouteUnmounts(
        {
          available: true,
          unavailableReason: null,
          lifecycle: "starting",
          sessionId: "session-1",
          ownerWindowLabel: "main",
          revision: 3,
        },
        "session-1",
      ),
    ).toBe(true);
    expect(
      shouldStopVoiceWhenRouteUnmounts(
        {
          available: true,
          unavailableReason: null,
          lifecycle: "running",
          sessionId: "session-1",
          ownerWindowLabel: "main",
          revision: 3,
        },
        "session-2",
      ),
    ).toBe(false);
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

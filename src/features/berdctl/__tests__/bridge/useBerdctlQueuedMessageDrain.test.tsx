import { act, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { SessionDispatchContentionError } from "@/features/chat/lib/sessionDispatchAcquisition";
import type { SessionDispatchReleaseWaiter } from "@/features/chat/lib/sessionTargetCoordinator";
import { QueuedMessageOwnershipLostError } from "@/features/chat/lib/preCommitSendRejection";
import { resetReclaimedQueueReconciliationForTesting } from "@/features/chat/lib/reclaimedQueueReconciliation";
import {
  type QueuedMessageRecord,
  useChatStore,
} from "@/features/chat/stores/chatStore";
import { useSessionWindowStore } from "@/features/chat/stores/sessionWindowStore";
import { useChatSessionStore } from "@/features/chat/stores/chatSessionStore";
import * as queuePersistence from "@/features/chat/stores/queuePersistence";
import { useBerdctlQueuedMessageDrain } from "@/features/berdctl/bridge/useBerdctlQueuedMessageDrain";
import { createUserMessage } from "@/shared/types/messages";

const mocks = vi.hoisted(() => ({
  sendPromptToExistingSessionInBackground: vi.fn(),
  sendQueuedPromptToExistingSessionInBackground: vi.fn(),
}));

vi.mock(
  "@/features/berdctl/commands/runtime/sessionSend",
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import("@/features/berdctl/commands/runtime/sessionSend")
      >();
    return {
      ...actual,
      sendPromptToExistingSessionInBackground: (...args: unknown[]) =>
        mocks.sendPromptToExistingSessionInBackground(...args),
      sendQueuedPromptToExistingSessionInBackground: (...args: unknown[]) =>
        mocks.sendQueuedPromptToExistingSessionInBackground(...args),
    };
  },
);

function DrainHarness({
  sessionId,
  ownerReady,
}: {
  sessionId?: string;
  ownerReady?: boolean;
}) {
  useBerdctlQueuedMessageDrain(sessionId, ownerReady);
  return null;
}

function contentionHarness() {
  let listener: (() => void) | undefined;
  const cancel = vi.fn(() => {
    listener = undefined;
  });
  const waiter: SessionDispatchReleaseWaiter = {
    wait: vi.fn((next) => {
      listener = next;
      return cancel;
    }),
    cancel,
  };
  return { waiter, release: () => listener?.(), cancel };
}

function resetChatStore(): void {
  useChatStore.setState({
    messagesBySession: {},
    sessionStateById: {},
    queuedMessageBySession: {},
    hasHydratedMessageQueues: true,
    draftsBySession: {},
    skillDraftsBySession: {},
    activeSessionId: null,
    isViewingActiveSession: false,
    isConnected: false,
    loadingSessionIds: new Set(),
    scrollTargetMessageBySession: {},
  });
}

describe("useBerdctlQueuedMessageDrain", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetReclaimedQueueReconciliationForTesting();
    mocks.sendPromptToExistingSessionInBackground.mockResolvedValue(undefined);
    mocks.sendQueuedPromptToExistingSessionInBackground.mockResolvedValue(
      undefined,
    );
    resetChatStore();
    useChatSessionStore.setState({
      sessions: [
        "session-1",
        "other-session",
        "main-session",
        "detached-session",
        "owned-session",
      ].map((id) => ({
        id,
        title: "Session",
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-01T00:00:00Z",
        messageCount: 0,
        executionTarget: { harnessId: "goose" },
      })),
      hasHydratedSessions: true,
    });
    useSessionWindowStore.setState({
      openSessions: {},
      handoffs: {},
      hasLoadedSnapshot: true,
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("drains a Berdctl exact head once when its session gains a target", async () => {
    useChatSessionStore.setState({
      sessions: [
        {
          id: "session-1",
          title: "Session",
          createdAt: "2026-01-01T00:00:00Z",
          updatedAt: "2026-01-01T00:00:00Z",
          messageCount: 0,
          executionTargetSource: "ui" as const,
        },
      ],
      hasHydratedSessions: true,
    });
    useChatStore.getState().enqueueTransportReadyMessage("session-1", {
      persona: { kind: "inherit" },
      text: "targetless",
      sendOptions: {
        userMessageMetadata: { origin: "berdctl_cross_session" as const },
      },
    });

    render(<DrainHarness />);
    expect(
      mocks.sendPromptToExistingSessionInBackground,
    ).not.toHaveBeenCalled();

    act(() =>
      useChatSessionStore
        .getState()
        .replaceSessionExecutionTarget("session-1", { harnessId: "goose" }),
    );

    await waitFor(() =>
      expect(
        mocks.sendPromptToExistingSessionInBackground,
      ).toHaveBeenCalledOnce(),
    );
  });

  it("drains a Berdctl exact head once after a source-less targetless state gains an ACP target", async () => {
    useChatSessionStore.setState({
      sessions: [
        {
          id: "session-1",
          title: "Session",
          createdAt: "2026-01-01T00:00:00Z",
          updatedAt: "2026-01-01T00:00:00Z",
          messageCount: 0,
        },
      ],
      hasHydratedSessions: true,
    });
    useChatStore.getState().enqueueTransportReadyMessage("session-1", {
      persona: { kind: "inherit" },
      text: "source-less targetless",
      sendOptions: {
        userMessageMetadata: { origin: "berdctl_cross_session" as const },
      },
    });

    render(<DrainHarness />);
    expect(
      mocks.sendPromptToExistingSessionInBackground,
    ).not.toHaveBeenCalled();

    act(() =>
      useChatSessionStore.setState((state) => ({
        sessions: state.sessions.map((session) =>
          session.id === "session-1"
            ? {
                ...session,
                executionTarget: { harnessId: "goose" },
                executionTargetSource: "acp" as const,
              }
            : session,
        ),
      })),
    );

    await waitFor(() =>
      expect(
        mocks.sendPromptToExistingSessionInBackground,
      ).toHaveBeenCalledOnce(),
    );
  });

  it("ignores unrelated session updates while a Berdctl head stays targetless", () => {
    useChatSessionStore.setState({
      sessions: [
        {
          id: "session-1",
          title: "Session",
          createdAt: "2026-01-01T00:00:00Z",
          updatedAt: "2026-01-01T00:00:00Z",
          messageCount: 0,
          executionTargetSource: "ui" as const,
        },
      ],
      hasHydratedSessions: true,
    });
    useChatStore.getState().enqueueTransportReadyMessage("session-1", {
      persona: { kind: "inherit" },
      text: "targetless",
      sendOptions: {
        userMessageMetadata: { origin: "berdctl_cross_session" as const },
      },
    });

    render(<DrainHarness />);
    act(() =>
      useChatSessionStore
        .getState()
        .patchSession("session-1", { title: "Renamed" }),
    );

    expect(
      mocks.sendPromptToExistingSessionInBackground,
    ).not.toHaveBeenCalled();
  });

  it("serializes a synchronous contention release after attempt settlement", async () => {
    useChatSessionStore.setState({
      sessions: [
        {
          id: "session-1",
          title: "Session",
          createdAt: "2026-01-01T00:00:00Z",
          updatedAt: "2026-01-01T00:00:00Z",
          messageCount: 0,
          executionTarget: { harnessId: "goose" },
        },
      ],
      hasHydratedSessions: true,
    });
    useChatStore.getState().enqueueTransportReadyMessage("session-1", {
      persona: { kind: "inherit" },
      text: "original",
      sendOptions: {
        userMessageMetadata: { origin: "berdctl_cross_session" as const },
      },
    });
    const cancel = vi.fn();
    const waiter: SessionDispatchReleaseWaiter = {
      wait: vi.fn((resume) => {
        resume();
        return cancel;
      }),
      cancel,
    };
    mocks.sendPromptToExistingSessionInBackground.mockRejectedValueOnce(
      new SessionDispatchContentionError(waiter),
    );

    render(<DrainHarness />);

    await waitFor(() =>
      expect(
        mocks.sendPromptToExistingSessionInBackground,
      ).toHaveBeenCalledTimes(2),
    );
    expect(waiter.wait).toHaveBeenCalledOnce();
  });

  it("resumes exactly once when contention releases after registration", async () => {
    useChatSessionStore.setState({
      sessions: [
        {
          id: "session-1",
          title: "Session",
          createdAt: "2026-01-01T00:00:00Z",
          updatedAt: "2026-01-01T00:00:00Z",
          messageCount: 0,
          executionTarget: { harnessId: "goose" },
        },
      ],
      hasHydratedSessions: true,
    });
    useChatStore.getState().enqueueTransportReadyMessage("session-1", {
      persona: { kind: "inherit" },
      text: "original",
      sendOptions: {
        userMessageMetadata: { origin: "berdctl_cross_session" as const },
      },
    });
    const contention = contentionHarness();
    mocks.sendPromptToExistingSessionInBackground.mockRejectedValueOnce(
      new SessionDispatchContentionError(contention.waiter),
    );

    render(<DrainHarness />);
    await waitFor(() => expect(contention.waiter.wait).toHaveBeenCalledOnce());
    act(() => {
      contention.release();
      contention.release();
    });

    await waitFor(() =>
      expect(
        mocks.sendPromptToExistingSessionInBackground,
      ).toHaveBeenCalledTimes(2),
    );
  });

  it("retains one contention waiter and cancels it for same-id replacement", async () => {
    useChatSessionStore.setState({
      sessions: [
        {
          id: "session-1",
          title: "Session",
          createdAt: "2026-01-01T00:00:00Z",
          updatedAt: "2026-01-01T00:00:00Z",
          messageCount: 0,
          executionTarget: { harnessId: "goose" },
        },
      ],
      hasHydratedSessions: true,
    });
    const chatStore = useChatStore.getState();
    chatStore.enqueueTransportReadyMessage("session-1", {
      persona: { kind: "inherit" },
      text: "original",
      sendOptions: {
        userMessageMetadata: { origin: "berdctl_cross_session" as const },
      },
    });
    const original =
      useChatStore.getState().queuedMessageBySession["session-1"]?.[0];
    const contention = contentionHarness();
    mocks.sendPromptToExistingSessionInBackground.mockRejectedValueOnce(
      new SessionDispatchContentionError(contention.waiter),
    );

    const owner = render(<DrainHarness />);
    await waitFor(() => expect(contention.waiter.wait).toHaveBeenCalledOnce());
    act(() => {
      useChatStore.setState((state) => ({
        queuedMessageBySession: {
          ...state.queuedMessageBySession,
          "session-1": original
            ? [
                {
                  ...original,
                  payload: { ...original.payload, text: "replacement" },
                },
              ]
            : [],
        },
      }));
    });
    expect(contention.cancel).toHaveBeenCalledOnce();
    act(() => contention.release());
    expect(
      mocks.sendPromptToExistingSessionInBackground,
    ).toHaveBeenCalledOnce();
    owner.unmount();
  });

  it("cancels contention without retry when the exact head is removed", async () => {
    useChatSessionStore.setState({
      sessions: [
        {
          id: "session-1",
          title: "Session",
          createdAt: "2026-01-01T00:00:00Z",
          updatedAt: "2026-01-01T00:00:00Z",
          messageCount: 0,
          executionTarget: { harnessId: "goose" },
        },
      ],
      hasHydratedSessions: true,
    });
    useChatStore.getState().enqueueTransportReadyMessage("session-1", {
      persona: { kind: "inherit" },
      text: "original",
      sendOptions: {
        userMessageMetadata: { origin: "berdctl_cross_session" as const },
      },
    });
    const contention = contentionHarness();
    mocks.sendPromptToExistingSessionInBackground.mockRejectedValueOnce(
      new SessionDispatchContentionError(contention.waiter),
    );

    render(<DrainHarness />);
    await waitFor(() => expect(contention.waiter.wait).toHaveBeenCalledOnce());
    act(() => {
      useChatStore.setState({ queuedMessageBySession: {} });
      contention.release();
    });

    expect(contention.cancel).toHaveBeenCalledOnce();
    expect(
      mocks.sendPromptToExistingSessionInBackground,
    ).toHaveBeenCalledOnce();
  });

  it("cancels a contention waiter on owner unmount", async () => {
    useChatSessionStore.setState({
      sessions: [
        {
          id: "session-1",
          title: "Session",
          createdAt: "2026-01-01T00:00:00Z",
          updatedAt: "2026-01-01T00:00:00Z",
          messageCount: 0,
          executionTarget: { harnessId: "goose" },
        },
      ],
      hasHydratedSessions: true,
    });
    useChatStore.getState().enqueueTransportReadyMessage("session-1", {
      persona: { kind: "inherit" },
      text: "original",
      sendOptions: {
        userMessageMetadata: { origin: "berdctl_cross_session" as const },
      },
    });
    const contention = contentionHarness();
    mocks.sendPromptToExistingSessionInBackground.mockRejectedValueOnce(
      new SessionDispatchContentionError(contention.waiter),
    );

    const owner = render(<DrainHarness />);
    await waitFor(() => expect(contention.waiter.wait).toHaveBeenCalledOnce());
    owner.unmount();

    expect(contention.cancel).toHaveBeenCalledOnce();
    act(() => contention.release());
    expect(
      mocks.sendPromptToExistingSessionInBackground,
    ).toHaveBeenCalledOnce();
  });

  it("waits for session-list hydration before draining restored berdctl queues", async () => {
    const chatStore = useChatStore.getState();
    chatStore.enqueueTransportReadyMessage("session-1", {
      persona: { kind: "inherit" },
      text: "restored prompt",
      sendOptions: {
        userMessageMetadata: { origin: "berdctl_cross_session" as const },
      },
    });
    useChatSessionStore.setState({ hasHydratedSessions: false });

    render(<DrainHarness />);
    expect(
      mocks.sendPromptToExistingSessionInBackground,
    ).not.toHaveBeenCalled();

    act(() => useChatSessionStore.setState({ hasHydratedSessions: true }));

    await waitFor(() => {
      expect(
        mocks.sendPromptToExistingSessionInBackground,
      ).toHaveBeenCalledWith(
        "session-1",
        "restored prompt",
        expect.any(Function),
        { returnOnDispatch: true },
      );
    });
  });

  it("drains a Berdctl record after editing finishes while idle", async () => {
    const chatStore = useChatStore.getState();
    chatStore.enqueueTransportReadyMessage("session-1", {
      persona: { kind: "inherit" },
      text: "original prompt",
      sendOptions: {
        userMessageMetadata: { origin: "berdctl_cross_session" as const },
      },
    });
    const recordId =
      useChatStore.getState().queuedMessageBySession["session-1"]?.[0]
        ?.recordId ?? "";
    chatStore.setQueuedMessageEditing("session-1", recordId, true);

    render(<DrainHarness />);
    expect(
      mocks.sendPromptToExistingSessionInBackground,
    ).not.toHaveBeenCalled();

    act(() => {
      useChatStore.getState().updateQueuedMessage("session-1", recordId, {
        persona: { kind: "inherit" },
        text: "edited prompt",
        sendOptions: {
          userMessageMetadata: {
            origin: "berdctl_cross_session" as const,
          },
        },
      });
    });

    await waitFor(() => {
      expect(
        mocks.sendPromptToExistingSessionInBackground,
      ).toHaveBeenCalledWith(
        "session-1",
        "edited prompt",
        expect.any(Function),
        { returnOnDispatch: true },
      );
    });
  });

  it("drains berdctl-origin queued messages when the target session becomes idle", async () => {
    const chatStore = useChatStore.getState();
    chatStore.setChatState("session-1", "streaming");
    chatStore.enqueueTransportReadyMessage("session-1", {
      persona: { kind: "inherit" },
      text: "queued prompt",
      sendOptions: {
        userMessageMetadata: { origin: "berdctl_cross_session" as const },
        acpGooseMetadata: { origin: "berdctl_cross_session" },
      },
    });
    render(<DrainHarness />);

    expect(
      mocks.sendPromptToExistingSessionInBackground,
    ).not.toHaveBeenCalled();

    act(() => {
      useChatStore.getState().setChatState("session-1", "idle");
    });

    await waitFor(() => {
      expect(
        mocks.sendPromptToExistingSessionInBackground,
      ).toHaveBeenCalledWith(
        "session-1",
        "queued prompt",
        expect.any(Function),
        { returnOnDispatch: true },
      );
    });
    expect(
      useChatStore.getState().queuedMessageBySession["session-1"],
    ).toBeUndefined();
  });

  it("preserves a queued delivery id without a sender label", async () => {
    const sendOptions = {
      userMessageMetadata: {
        origin: "berdctl_cross_session" as const,
        berdDeliveryId: "monitor-event-1",
      },
      acpGooseMetadata: {
        origin: "berdctl_cross_session" as const,
        berdDeliveryId: "monitor-event-1",
      },
    };
    const chatStore = useChatStore.getState();
    chatStore.setChatState("session-1", "streaming");
    chatStore.enqueueTransportReadyMessage("session-1", {
      persona: { kind: "inherit" },
      text: "queued delivery",
      sendOptions,
    });
    render(<DrainHarness />);

    act(() => {
      useChatStore.getState().setChatState("session-1", "idle");
    });

    await waitFor(() => {
      expect(
        mocks.sendPromptToExistingSessionInBackground,
      ).toHaveBeenCalledWith(
        "session-1",
        "queued delivery",
        expect.any(Function),
        {
          returnOnDispatch: true,
          sendOptions,
          validateHydratedTranscript: expect.any(Function),
        },
      );
    });
  });

  it("dismisses a stale queued delivery already accepted in the transcript", async () => {
    const accepted = createUserMessage("queued delivery");
    accepted.metadata = {
      origin: "berdctl_cross_session",
      berdDeliveryId: "monitor-event-1",
    };
    const chatStore = useChatStore.getState();
    chatStore.addMessage("session-1", accepted);
    chatStore.enqueueTransportReadyMessage("session-1", {
      persona: { kind: "inherit" },
      text: "queued delivery",
      sendOptions: {
        userMessageMetadata: {
          origin: "berdctl_cross_session" as const,
          berdDeliveryId: "monitor-event-1",
        },
      },
    });

    render(<DrainHarness />);

    await waitFor(() => {
      expect(
        useChatStore.getState().queuedMessageBySession["session-1"],
      ).toBeUndefined();
    });
    expect(
      mocks.sendPromptToExistingSessionInBackground,
    ).not.toHaveBeenCalled();
    expect(useChatStore.getState().messagesBySession["session-1"]).toHaveLength(
      1,
    );
  });

  it("dismisses a stale queued delivery accepted during cold hydration", async () => {
    mocks.sendPromptToExistingSessionInBackground.mockImplementationOnce(
      async (
        _sessionId: string,
        _prompt: string,
        _beforeUserMessageCommitted: () => void,
        options?: { validateHydratedTranscript?: () => void },
      ) => {
        const accepted = createUserMessage("queued delivery");
        accepted.metadata = {
          origin: "berdctl_cross_session",
          berdDeliveryId: "monitor-event-1",
        };
        useChatStore.getState().addMessage("session-1", accepted);
        options?.validateHydratedTranscript?.();
      },
    );
    useChatStore.getState().enqueueTransportReadyMessage("session-1", {
      persona: { kind: "inherit" },
      text: "queued delivery",
      sendOptions: {
        userMessageMetadata: {
          origin: "berdctl_cross_session" as const,
          berdDeliveryId: "monitor-event-1",
        },
      },
    });

    render(<DrainHarness />);

    await waitFor(() => {
      expect(
        useChatStore.getState().queuedMessageBySession["session-1"],
      ).toBeUndefined();
    });
    expect(
      mocks.sendPromptToExistingSessionInBackground,
    ).toHaveBeenCalledOnce();
    expect(useChatStore.getState().messagesBySession["session-1"]).toHaveLength(
      1,
    );
  });

  it("drains consecutive berdctl records in FIFO order while idle", async () => {
    const chatStore = useChatStore.getState();
    chatStore.enqueueTransportReadyMessage("session-1", {
      persona: { kind: "inherit" },
      text: "first prompt",
      sendOptions: {
        userMessageMetadata: { origin: "berdctl_cross_session" as const },
      },
    });
    chatStore.enqueueTransportReadyMessage("session-1", {
      persona: { kind: "inherit" },
      text: "second prompt",
      sendOptions: {
        userMessageMetadata: { origin: "berdctl_cross_session" as const },
      },
    });

    render(<DrainHarness />);

    await waitFor(() => {
      expect(mocks.sendPromptToExistingSessionInBackground.mock.calls).toEqual([
        [
          "session-1",
          "first prompt",
          expect.any(Function),
          { returnOnDispatch: true },
        ],
        [
          "session-1",
          "second prompt",
          expect.any(Function),
          { returnOnDispatch: true },
        ],
      ]);
    });
    expect(
      useChatStore.getState().queuedMessageBySession["session-1"],
    ).toBeUndefined();
  });

  it("waits for the active run to clear before draining an idle session", async () => {
    const chatStore = useChatStore.getState();
    chatStore.setActiveRunId("session-1", "run-1");
    chatStore.enqueueTransportReadyMessage("session-1", {
      persona: { kind: "inherit" },
      text: "queued prompt",
      sendOptions: {
        userMessageMetadata: { origin: "berdctl_cross_session" as const },
      },
    });
    render(<DrainHarness />);

    expect(
      mocks.sendPromptToExistingSessionInBackground,
    ).not.toHaveBeenCalled();

    act(() => {
      useChatStore.getState().setActiveRunId("session-1", null);
    });

    await waitFor(() => {
      expect(
        mocks.sendPromptToExistingSessionInBackground,
      ).toHaveBeenCalledWith(
        "session-1",
        "queued prompt",
        expect.any(Function),
        { returnOnDispatch: true },
      );
    });
  });

  it("waits for pending cancellation to clear before draining an idle session", async () => {
    const chatStore = useChatStore.getState();
    chatStore.setChatState("session-1", "streaming");
    chatStore.setRunCancellationPending("session-1", true);
    chatStore.enqueueTransportReadyMessage("session-1", {
      persona: { kind: "inherit" },
      text: "queued prompt",
      sendOptions: {
        userMessageMetadata: { origin: "berdctl_cross_session" as const },
        acpGooseMetadata: { origin: "berdctl_cross_session" },
      },
    });
    render(<DrainHarness />);

    act(() => {
      useChatStore.getState().setChatState("session-1", "idle");
    });
    expect(
      mocks.sendPromptToExistingSessionInBackground,
    ).not.toHaveBeenCalled();

    act(() => {
      useChatStore.getState().setRunCancellationPending("session-1", false);
    });

    await waitFor(() => {
      expect(
        mocks.sendPromptToExistingSessionInBackground,
      ).toHaveBeenCalledWith(
        "session-1",
        "queued prompt",
        expect.any(Function),
        { returnOnDispatch: true },
      );
    });
  });

  it("does not drain a queued prompt when a running session enters error", async () => {
    const chatStore = useChatStore.getState();
    chatStore.setChatState("session-1", "streaming");
    chatStore.enqueueTransportReadyMessage("session-1", {
      persona: { kind: "inherit" },
      text: "queued prompt",
      sendOptions: {
        userMessageMetadata: { origin: "berdctl_cross_session" as const },
        acpGooseMetadata: { origin: "berdctl_cross_session" },
      },
    });
    render(<DrainHarness />);

    act(() => {
      useChatStore.getState().setChatState("session-1", "error");
    });

    expect(
      mocks.sendPromptToExistingSessionInBackground,
    ).not.toHaveBeenCalled();
    expect(
      useChatStore.getState().queuedMessageBySession["session-1"],
    ).toBeDefined();
  });

  it("keeps berdctl-origin queued messages when the background send fails", async () => {
    const sendError = new Error("prepare failed");
    const consoleErrorSpy = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    mocks.sendPromptToExistingSessionInBackground.mockRejectedValueOnce(
      sendError,
    );
    const chatStore = useChatStore.getState();
    chatStore.setChatState("session-1", "streaming");
    chatStore.enqueueTransportReadyMessage("session-1", {
      persona: { kind: "inherit" },
      text: "queued prompt",
      sendOptions: {
        userMessageMetadata: { origin: "berdctl_cross_session" as const },
        acpGooseMetadata: { origin: "berdctl_cross_session" },
      },
    });
    render(<DrainHarness />);

    act(() => {
      useChatStore.getState().setChatState("session-1", "idle");
    });

    await waitFor(() => {
      expect(
        mocks.sendPromptToExistingSessionInBackground,
      ).toHaveBeenCalledWith(
        "session-1",
        "queued prompt",
        expect.any(Function),
        { returnOnDispatch: true },
      );
    });
    await waitFor(() => {
      expect(consoleErrorSpy).toHaveBeenCalledWith(
        "[berdctl-queue] failed to send queued prompt for session session-1",
        sendError,
      );
    });
    expect(
      useChatStore.getState().queuedMessageBySession["session-1"]?.[0]?.payload,
    ).toEqual({
      persona: { kind: "inherit" },
      text: "queued prompt",
      sendOptions: {
        userMessageMetadata: { origin: "berdctl_cross_session" as const },
        acpGooseMetadata: { origin: "berdctl_cross_session" },
      },
    });
  });

  it("leaves deferred records inert", () => {
    useChatStore.setState({
      queuedMessageBySession: {
        "session-1": [
          {
            kind: "deferred",
            recordId: "deferred-1",
            payload: {
              persona: { kind: "inherit" },
              text: "held prompt",
              sendOptions: {
                userMessageMetadata: {
                  origin: "berdctl_cross_session" as const,
                },
              },
            },
            state: { phase: "failed" },
          },
        ],
      },
      sessionStateById: {
        "session-1": {
          ...useChatStore.getState().getSessionRuntime("session-1"),
          chatState: "idle",
        },
      },
    });

    render(<DrainHarness />);

    expect(
      mocks.sendPromptToExistingSessionInBackground,
    ).not.toHaveBeenCalled();
    expect(
      useChatStore.getState().queuedMessageBySession["session-1"]?.[0]
        ?.recordId,
    ).toBe("deferred-1");
  });

  it("drains when a record becomes transport-ready while already idle", async () => {
    const deferred: QueuedMessageRecord = {
      kind: "deferred" as const,
      recordId: "record-1",
      payload: {
        persona: { kind: "inherit" },
        text: "held prompt",
        sendOptions: {
          userMessageMetadata: { origin: "berdctl_cross_session" as const },
        },
      },
      state: { phase: "creating" },
    };
    useChatStore.setState({
      queuedMessageBySession: { "session-1": [deferred] },
    });
    render(<DrainHarness />);

    act(() => {
      useChatStore.setState({
        queuedMessageBySession: {
          "session-1": [
            {
              kind: "transport-ready",
              recordId: deferred.recordId,
              payload: {
                ...deferred.payload,
              },
            },
          ],
        },
      });
    });

    await waitFor(() => {
      expect(
        mocks.sendPromptToExistingSessionInBackground,
      ).toHaveBeenCalledWith("session-1", "held prompt", expect.any(Function), {
        returnOnDispatch: true,
      });
    });
  });

  it("leaves released deferred records to the dedicated queue drain", () => {
    const released: QueuedMessageRecord = {
      kind: "transport-ready",
      recordId: "record-1",
      releasedFromDeferred: true,
      payload: {
        persona: { kind: "inherit" },
        text: "held prompt",
        sendOptions: {
          userMessageMetadata: { origin: "berdctl_cross_session" },
        },
      },
    };
    useChatStore.setState({
      queuedMessageBySession: { "session-1": [released] },
    });

    render(<DrainHarness />);

    expect(
      mocks.sendQueuedPromptToExistingSessionInBackground,
    ).not.toHaveBeenCalled();
    expect(
      mocks.sendPromptToExistingSessionInBackground,
    ).not.toHaveBeenCalled();
    expect(useChatStore.getState().queuedMessageBySession["session-1"]).toEqual(
      [released],
    );
  });

  it("waits for authoritative queue hydration before draining cached records", async () => {
    const cached: QueuedMessageRecord = {
      kind: "transport-ready",
      recordId: "cached-record",
      payload: {
        persona: { kind: "inherit" },
        text: "cached prompt",
        sendOptions: {
          userMessageMetadata: { origin: "berdctl_cross_session" as const },
        },
      },
    };
    useChatStore.setState({
      queuedMessageBySession: { "session-1": [cached] },
      hasHydratedMessageQueues: false,
    });

    render(<DrainHarness />);
    expect(
      mocks.sendPromptToExistingSessionInBackground,
    ).not.toHaveBeenCalled();

    act(() => {
      useChatStore.getState().replaceQueuedMessages({
        "session-1": [cached],
      });
    });

    await waitFor(() => {
      expect(
        mocks.sendPromptToExistingSessionInBackground,
      ).toHaveBeenCalledTimes(1);
    });
    expect(mocks.sendPromptToExistingSessionInBackground).toHaveBeenCalledWith(
      "session-1",
      "cached prompt",
      expect.any(Function),
      { returnOnDispatch: true },
    );
  });

  it("waits for the initial detached-window snapshot before global draining", async () => {
    const chatStore = useChatStore.getState();
    chatStore.enqueueTransportReadyMessage("detached-session", {
      persona: { kind: "inherit" },
      text: "owned elsewhere",
      sendOptions: {
        userMessageMetadata: { origin: "berdctl_cross_session" as const },
      },
    });
    useSessionWindowStore.setState({
      openSessions: {},
      handoffs: {},
      hasLoadedSnapshot: false,
    });

    render(<DrainHarness />);

    expect(
      mocks.sendPromptToExistingSessionInBackground,
    ).not.toHaveBeenCalled();

    act(() => {
      useSessionWindowStore.getState().setSnapshot([
        {
          sessionId: "detached-session",
          windowLabel: "session:detached-session",
        },
      ]);
    });

    await waitFor(() => {
      expect(useSessionWindowStore.getState().hasLoadedSnapshot).toBe(true);
    });
    expect(
      mocks.sendPromptToExistingSessionInBackground,
    ).not.toHaveBeenCalled();
    expect(
      useChatStore.getState().queuedMessageBySession["detached-session"]?.[0]
        ?.payload.text,
    ).toBe("owned elsewhere");
  });

  it("starts global draining after an empty initial window snapshot", async () => {
    const chatStore = useChatStore.getState();
    chatStore.enqueueTransportReadyMessage("main-session", {
      persona: { kind: "inherit" },
      text: "owned by main",
      sendOptions: {
        userMessageMetadata: { origin: "berdctl_cross_session" as const },
      },
    });
    useSessionWindowStore.setState({
      openSessions: {},
      handoffs: {},
      hasLoadedSnapshot: false,
    });

    render(<DrainHarness />);
    expect(
      mocks.sendPromptToExistingSessionInBackground,
    ).not.toHaveBeenCalled();

    act(() => {
      useSessionWindowStore.getState().setSnapshot([]);
    });

    await waitFor(() => {
      expect(
        mocks.sendPromptToExistingSessionInBackground,
      ).toHaveBeenCalledWith(
        "main-session",
        "owned by main",
        expect.any(Function),
        { returnOnDispatch: true },
      );
    });
  });

  it("leaves detached-window sessions for their scoped owner drain", () => {
    const chatStore = useChatStore.getState();
    chatStore.enqueueTransportReadyMessage("detached-session", {
      persona: { kind: "inherit" },
      text: "owned elsewhere",
      sendOptions: {
        userMessageMetadata: { origin: "berdctl_cross_session" as const },
      },
    });
    useSessionWindowStore.setState({
      openSessions: { "detached-session": "session:detached-session" },
    });

    render(<DrainHarness />);

    expect(
      mocks.sendPromptToExistingSessionInBackground,
    ).not.toHaveBeenCalled();
    expect(
      useChatStore.getState().queuedMessageBySession["detached-session"]?.[0]
        ?.payload.text,
    ).toBe("owned elsewhere");
  });

  it("refreshes a reclaimed detached session before draining it", async () => {
    const stale: QueuedMessageRecord = {
      kind: "transport-ready",
      recordId: "already-sent",
      payload: {
        persona: { kind: "inherit" },
        text: "stale prompt",
        sendOptions: {
          userMessageMetadata: { origin: "berdctl_cross_session" as const },
        },
      },
    };
    useChatStore.setState({
      queuedMessageBySession: { "detached-session": [stale] },
    });
    useSessionWindowStore.setState({
      openSessions: { "detached-session": "session:detached-session" },
      handoffs: {},
      hasLoadedSnapshot: true,
    });
    vi.spyOn(queuePersistence, "loadPersistedMessageQueues").mockResolvedValue(
      {},
    );
    render(<DrainHarness />);

    act(() => {
      useSessionWindowStore.getState().setSnapshot([]);
    });

    await waitFor(() => {
      expect(queuePersistence.loadPersistedMessageQueues).toHaveBeenCalled();
      expect(
        useChatStore.getState().queuedMessageBySession["detached-session"],
      ).toBeUndefined();
    });
    expect(
      mocks.sendPromptToExistingSessionInBackground,
    ).not.toHaveBeenCalled();
  });

  it("waits until a detached window owns the session before scoped draining", async () => {
    const chatStore = useChatStore.getState();
    chatStore.setChatState("owned-session", "streaming");
    chatStore.enqueueTransportReadyMessage("owned-session", {
      persona: { kind: "inherit" },
      text: "queued while source runs",
      sendOptions: {
        userMessageMetadata: { origin: "berdctl_cross_session" as const },
      },
    });
    const { rerender } = render(
      <DrainHarness sessionId="owned-session" ownerReady={false} />,
    );

    act(() => {
      useChatStore.setState({
        sessionStateById: {},
        hasHydratedMessageQueues: true,
      });
    });
    expect(
      mocks.sendPromptToExistingSessionInBackground,
    ).not.toHaveBeenCalled();

    rerender(<DrainHarness sessionId="owned-session" ownerReady />);

    await waitFor(() => {
      expect(
        mocks.sendPromptToExistingSessionInBackground,
      ).toHaveBeenCalledWith(
        "owned-session",
        "queued while source runs",
        expect.any(Function),
        { returnOnDispatch: true },
      );
    });
  });

  it("leaves released detached-window records to the dedicated owner drain", () => {
    const chatStore = useChatStore.getState();
    chatStore.enqueueTransportReadyMessage("owned-session", {
      persona: { kind: "inherit" },
      text: "owned released prompt",
    });
    chatStore.enqueueTransportReadyMessage("other-session", {
      persona: { kind: "inherit" },
      text: "other released prompt",
    });
    const owned =
      useChatStore.getState().queuedMessageBySession["owned-session"]?.[0];
    const other =
      useChatStore.getState().queuedMessageBySession["other-session"]?.[0];
    if (
      owned?.kind !== "transport-ready" ||
      other?.kind !== "transport-ready"
    ) {
      throw new Error("expected transport-ready fixtures");
    }
    useChatStore.setState({
      queuedMessageBySession: {
        "owned-session": [{ ...owned, releasedFromDeferred: true }],
        "other-session": [{ ...other, releasedFromDeferred: true }],
      },
    });

    render(<DrainHarness sessionId="owned-session" />);

    expect(
      mocks.sendQueuedPromptToExistingSessionInBackground,
    ).not.toHaveBeenCalled();
    expect(
      mocks.sendPromptToExistingSessionInBackground,
    ).not.toHaveBeenCalled();
    expect(
      useChatStore.getState().queuedMessageBySession["owned-session"]?.[0]
        ?.recordId,
    ).toBe(owned.recordId);
    expect(
      useChatStore.getState().queuedMessageBySession["other-session"]?.[0]
        ?.recordId,
    ).toBe(other.recordId);
  });

  it("retains and retries when a run starts during background preparation", async () => {
    mocks.sendPromptToExistingSessionInBackground
      .mockImplementationOnce(
        async (
          _sessionId: string,
          _prompt: string,
          beforeUserMessageCommitted: () => void,
        ) => {
          useChatStore.getState().setActiveRunId("session-1", "racing-run");
          beforeUserMessageCommitted();
        },
      )
      .mockResolvedValueOnce(undefined);
    useChatStore.getState().enqueueTransportReadyMessage("session-1", {
      persona: { kind: "inherit" },
      text: "race-safe prompt",
      sendOptions: {
        userMessageMetadata: { origin: "berdctl_cross_session" as const },
      },
    });

    render(<DrainHarness />);

    await waitFor(() => {
      expect(
        mocks.sendPromptToExistingSessionInBackground,
      ).toHaveBeenCalledTimes(1);
    });
    expect(
      useChatStore.getState().queuedMessageBySession["session-1"]?.[0]?.payload
        .text,
    ).toBe("race-safe prompt");

    act(() => {
      useChatStore.getState().setActiveRunId("session-1", null);
    });

    await waitFor(() => {
      expect(
        mocks.sendPromptToExistingSessionInBackground,
      ).toHaveBeenCalledTimes(2);
      expect(
        useChatStore.getState().queuedMessageBySession["session-1"],
      ).toBeUndefined();
    });
  });

  it("dismisses at acknowledged dispatch while the held turn fences a replacement", async () => {
    let settleTurn!: () => void;
    const heldSettlement = new Promise<void>((resolve) => {
      settleTurn = resolve;
    });
    mocks.sendPromptToExistingSessionInBackground.mockImplementation(
      async (
        _sessionId: string,
        _prompt: string,
        beforeUserMessageCommitted: () => void,
        options?: { returnOnDispatch?: boolean },
      ) => {
        expect(options).toEqual({ returnOnDispatch: true });
        beforeUserMessageCommitted();
        useChatStore.getState().setActiveRunId("session-1", "held-turn");
        // Match the real helper's split contract: queue ownership completes
        // now while the detached turn keeps the runtime blocked until settlement.
        void heldSettlement.then(() => {
          useChatStore.getState().setActiveRunId("session-1", null);
        });
      },
    );
    const chatStore = useChatStore.getState();
    chatStore.enqueueTransportReadyMessage("session-1", {
      persona: { kind: "inherit" },
      text: "original prompt",
      sendOptions: {
        userMessageMetadata: { origin: "berdctl_cross_session" as const },
      },
    });

    render(<DrainHarness />);

    await waitFor(() => {
      expect(
        useChatStore.getState().queuedMessageBySession["session-1"],
      ).toBeUndefined();
    });
    expect(mocks.sendPromptToExistingSessionInBackground).toHaveBeenCalledTimes(
      1,
    );

    act(() => {
      useChatStore.getState().enqueueTransportReadyMessage("session-1", {
        persona: { kind: "inherit" },
        text: "replacement prompt",
        sendOptions: {
          userMessageMetadata: { origin: "berdctl_cross_session" as const },
        },
      });
    });
    expect(mocks.sendPromptToExistingSessionInBackground).toHaveBeenCalledTimes(
      1,
    );
    expect(
      useChatStore.getState().queuedMessageBySession["session-1"]?.[0]?.payload
        .text,
    ).toBe("replacement prompt");

    act(() => {
      settleTurn();
    });

    await waitFor(() => {
      expect(
        mocks.sendPromptToExistingSessionInBackground,
      ).toHaveBeenCalledTimes(2);
      expect(
        mocks.sendPromptToExistingSessionInBackground,
      ).toHaveBeenLastCalledWith(
        "session-1",
        "replacement prompt",
        expect.any(Function),
        { returnOnDispatch: true },
      );
    });
  });

  it("retains an edited replacement when an older background send resolves", async () => {
    let resolveSend!: () => void;
    mocks.sendPromptToExistingSessionInBackground.mockReturnValueOnce(
      new Promise<void>((resolve) => {
        resolveSend = resolve;
      }),
    );
    const chatStore = useChatStore.getState();
    chatStore.enqueueTransportReadyMessage("session-1", {
      persona: { kind: "inherit" },
      text: "original prompt",
      sendOptions: {
        userMessageMetadata: { origin: "berdctl_cross_session" as const },
      },
    });
    const recordId =
      useChatStore.getState().queuedMessageBySession["session-1"]?.[0]
        ?.recordId;
    expect(recordId).toBeDefined();
    if (!recordId) throw new Error("expected queued record fixture");
    render(<DrainHarness />);
    await waitFor(() => {
      expect(
        mocks.sendPromptToExistingSessionInBackground,
      ).toHaveBeenCalledWith(
        "session-1",
        "original prompt",
        expect.any(Function),
        { returnOnDispatch: true },
      );
    });

    act(() => {
      expect(
        useChatStore
          .getState()
          .setQueuedMessageEditing("session-1", recordId, true),
      ).toBe(true);
      expect(
        useChatStore.getState().updateQueuedMessage("session-1", recordId, {
          persona: { kind: "inherit" },
          text: "replacement prompt",
          sendOptions: {
            userMessageMetadata: {
              origin: "berdctl_cross_session" as const,
            },
          },
        }),
      ).toBe(true);
      resolveSend();
    });

    await waitFor(() => {
      expect(
        useChatStore.getState().queuedMessageBySession["session-1"]?.[0]
          ?.payload.text,
      ).toBe("replacement prompt");
    });
  });

  it("retries a replacement after the stale Berdctl attempt loses ownership", async () => {
    let rejectStale!: (error: Error) => void;
    mocks.sendPromptToExistingSessionInBackground
      .mockReturnValueOnce(
        new Promise<void>((_resolve, reject) => {
          rejectStale = reject;
        }),
      )
      .mockResolvedValueOnce(undefined);
    const chatStore = useChatStore.getState();
    chatStore.enqueueTransportReadyMessage("session-1", {
      persona: { kind: "inherit" },
      text: "original prompt",
      sendOptions: {
        userMessageMetadata: { origin: "berdctl_cross_session" as const },
      },
    });
    const recordId =
      useChatStore.getState().queuedMessageBySession["session-1"]?.[0]
        ?.recordId;
    if (!recordId) throw new Error("expected queued record fixture");

    render(<DrainHarness />);
    await waitFor(() => {
      expect(
        mocks.sendPromptToExistingSessionInBackground,
      ).toHaveBeenCalledTimes(1);
    });

    act(() => {
      useChatStore.getState().updateQueuedMessage("session-1", recordId, {
        persona: { kind: "inherit" },
        text: "replacement prompt",
        sendOptions: {
          userMessageMetadata: { origin: "berdctl_cross_session" as const },
        },
      });
      rejectStale(new QueuedMessageOwnershipLostError());
    });

    await waitFor(() => {
      expect(
        mocks.sendPromptToExistingSessionInBackground,
      ).toHaveBeenCalledTimes(2);
      expect(
        mocks.sendPromptToExistingSessionInBackground,
      ).toHaveBeenLastCalledWith(
        "session-1",
        "replacement prompt",
        expect.any(Function),
        { returnOnDispatch: true },
      );
    });
  });

  it("holds a Berdctl head while its session is still being created", async () => {
    useChatSessionStore.setState({
      sessions: [
        {
          id: "draft-session",
          title: "New chat",
          createdAt: "2026-01-01T00:00:00Z",
          updatedAt: "2026-01-01T00:00:00Z",
          messageCount: 0,
          executionTarget: { harnessId: "goose" },
          clientSessionId: "draft-session",
          creationState: "pending" as const,
        },
      ],
      hasHydratedSessions: true,
    });
    useChatStore.getState().enqueueTransportReadyMessage("draft-session", {
      persona: { kind: "inherit" },
      text: "cross-session prompt",
      sendOptions: {
        userMessageMetadata: { origin: "berdctl_cross_session" as const },
      },
    });

    render(<DrainHarness />);
    expect(
      mocks.sendPromptToExistingSessionInBackground,
    ).not.toHaveBeenCalled();

    act(() => {
      useChatStore
        .getState()
        .promoteSessionId("draft-session", "backend-session");
      useChatSessionStore
        .getState()
        .promoteDraftSession("draft-session", "backend-session", {});
    });

    await waitFor(() =>
      expect(
        mocks.sendPromptToExistingSessionInBackground,
      ).toHaveBeenCalledOnce(),
    );
    expect(
      mocks.sendPromptToExistingSessionInBackground.mock.calls.map(
        (call) => call[0],
      ),
    ).toEqual(["backend-session"]);
  });

  it("leaves ordinary queued messages for ChatView-owned queue handling", async () => {
    const chatStore = useChatStore.getState();
    chatStore.setChatState("session-1", "streaming");
    chatStore.enqueueTransportReadyMessage("session-1", {
      persona: { kind: "inherit" },
      text: "user queued prompt",
    });
    render(<DrainHarness />);

    act(() => {
      useChatStore.getState().setChatState("session-1", "idle");
    });

    expect(
      mocks.sendPromptToExistingSessionInBackground,
    ).not.toHaveBeenCalled();
    expect(
      useChatStore.getState().queuedMessageBySession["session-1"]?.[0]?.payload,
    ).toEqual({
      persona: { kind: "inherit" },
      text: "user queued prompt",
    });
  });
});

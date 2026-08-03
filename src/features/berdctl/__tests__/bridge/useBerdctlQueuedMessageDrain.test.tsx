import { act, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  type QueuedMessageRecord,
  useChatStore,
} from "@/features/chat/stores/chatStore";
import { useSessionWindowStore } from "@/features/chat/stores/sessionWindowStore";
import { useChatSessionStore } from "@/features/chat/stores/chatSessionStore";
import * as queuePersistence from "@/features/chat/stores/queuePersistence";
import { useBerdctlQueuedMessageDrain } from "@/features/berdctl/bridge/useBerdctlQueuedMessageDrain";

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
    mocks.sendPromptToExistingSessionInBackground.mockResolvedValue(undefined);
    mocks.sendQueuedPromptToExistingSessionInBackground.mockResolvedValue(
      undefined,
    );
    resetChatStore();
    useChatSessionStore.setState({ hasHydratedSessions: true });
    useSessionWindowStore.setState({
      openSessions: {},
      handoffs: {},
      hasLoadedSnapshot: true,
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("waits for session-list hydration before draining restored berdctl queues", async () => {
    const chatStore = useChatStore.getState();
    chatStore.enqueueTransportReadyMessage("session-1", {
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
      );
    });
  });

  it("drains a Berdctl record after editing finishes while idle", async () => {
    const chatStore = useChatStore.getState();
    chatStore.enqueueTransportReadyMessage("session-1", {
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
      );
    });
  });

  it("drains berdctl-origin queued messages when the target session becomes idle", async () => {
    const chatStore = useChatStore.getState();
    chatStore.setChatState("session-1", "streaming");
    chatStore.enqueueTransportReadyMessage("session-1", {
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
      );
    });
    expect(
      useChatStore.getState().queuedMessageBySession["session-1"],
    ).toBeUndefined();
  });

  it("drains consecutive berdctl records in FIFO order while idle", async () => {
    const chatStore = useChatStore.getState();
    chatStore.enqueueTransportReadyMessage("session-1", {
      text: "first prompt",
      sendOptions: {
        userMessageMetadata: { origin: "berdctl_cross_session" as const },
      },
    });
    chatStore.enqueueTransportReadyMessage("session-1", {
      text: "second prompt",
      sendOptions: {
        userMessageMetadata: { origin: "berdctl_cross_session" as const },
      },
    });

    render(<DrainHarness />);

    await waitFor(() => {
      expect(mocks.sendPromptToExistingSessionInBackground.mock.calls).toEqual([
        ["session-1", "first prompt", expect.any(Function)],
        ["session-1", "second prompt", expect.any(Function)],
      ]);
    });
    expect(
      useChatStore.getState().queuedMessageBySession["session-1"],
    ).toBeUndefined();
  });

  it("waits for pending cancellation to clear before draining an idle session", async () => {
    const chatStore = useChatStore.getState();
    chatStore.setChatState("session-1", "streaming");
    chatStore.setRunCancellationPending("session-1", true);
    chatStore.enqueueTransportReadyMessage("session-1", {
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
      );
    });
  });

  it("does not drain a queued prompt when a running session enters error", async () => {
    const chatStore = useChatStore.getState();
    chatStore.setChatState("session-1", "streaming");
    chatStore.enqueueTransportReadyMessage("session-1", {
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
              payload: deferred.payload,
            },
          ],
        },
      });
    });

    await waitFor(() => {
      expect(
        mocks.sendPromptToExistingSessionInBackground,
      ).toHaveBeenCalledWith("session-1", "held prompt", expect.any(Function));
    });
  });

  it("leaves released deferred records to the dedicated queue drain", () => {
    const released: QueuedMessageRecord = {
      kind: "transport-ready",
      recordId: "record-1",
      releasedFromDeferred: true,
      payload: {
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
    );
  });

  it("waits for the initial detached-window snapshot before global draining", async () => {
    const chatStore = useChatStore.getState();
    chatStore.enqueueTransportReadyMessage("detached-session", {
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
      );
    });
  });

  it("leaves detached-window sessions for their scoped owner drain", () => {
    const chatStore = useChatStore.getState();
    chatStore.enqueueTransportReadyMessage("detached-session", {
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
      );
    });
  });

  it("leaves released detached-window records to the dedicated owner drain", () => {
    const chatStore = useChatStore.getState();
    chatStore.enqueueTransportReadyMessage("owned-session", {
      text: "owned released prompt",
    });
    chatStore.enqueueTransportReadyMessage("other-session", {
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

  it("retains an edited replacement when an older background send resolves", async () => {
    let resolveSend!: () => void;
    mocks.sendPromptToExistingSessionInBackground.mockReturnValueOnce(
      new Promise<void>((resolve) => {
        resolveSend = resolve;
      }),
    );
    const chatStore = useChatStore.getState();
    chatStore.enqueueTransportReadyMessage("session-1", {
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

  it("leaves ordinary queued messages for ChatView-owned queue handling", async () => {
    const chatStore = useChatStore.getState();
    chatStore.setChatState("session-1", "streaming");
    chatStore.enqueueTransportReadyMessage("session-1", {
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
    ).toEqual({ text: "user queued prompt" });
  });
});

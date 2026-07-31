import { act, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  type QueuedMessageRecord,
  useChatStore,
} from "@/features/chat/stores/chatStore";
import { useBerdctlQueuedMessageDrain } from "@/features/berdctl/bridge/useBerdctlQueuedMessageDrain";

const mocks = vi.hoisted(() => ({
  sendPromptToExistingSessionInBackground: vi.fn(),
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
    };
  },
);

function DrainHarness() {
  useBerdctlQueuedMessageDrain();
  return null;
}

function resetChatStore(): void {
  useChatStore.setState({
    messagesBySession: {},
    sessionStateById: {},
    queuedMessageBySession: {},
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
    resetChatStore();
  });

  afterEach(() => {
    vi.restoreAllMocks();
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
      useChatStore.getState().queuedMessageBySession["session-1"]?.payload,
    ).toEqual({
      text: "queued prompt",
      sendOptions: {
        userMessageMetadata: { origin: "berdctl_cross_session" as const },
        acpGooseMetadata: { origin: "berdctl_cross_session" },
      },
    });
  });

  it("leaves released berdctl records for the released-message drain", () => {
    useChatStore.setState({
      queuedMessageBySession: {
        "session-1": {
          kind: "transport-ready",
          recordId: "released-1",
          releasedFromDeferred: true,
          payload: {
            text: "released prompt",
            sendOptions: {
              userMessageMetadata: { origin: "berdctl_cross_session" as const },
            },
          },
        },
      },
    });

    render(<DrainHarness />);

    expect(
      mocks.sendPromptToExistingSessionInBackground,
    ).not.toHaveBeenCalled();
    expect(
      useChatStore.getState().queuedMessageBySession["session-1"]?.recordId,
    ).toBe("released-1");
  });

  it("leaves deferred records inert", () => {
    useChatStore.setState({
      queuedMessageBySession: {
        "session-1": {
          kind: "deferred",
          recordId: "deferred-1",
          payload: {
            text: "held prompt",
            sendOptions: {
              userMessageMetadata: { origin: "berdctl_cross_session" as const },
            },
          },
          state: { phase: "failed" },
        },
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
      useChatStore.getState().queuedMessageBySession["session-1"]?.recordId,
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
      queuedMessageBySession: { "session-1": deferred },
    });
    render(<DrainHarness />);

    act(() => {
      useChatStore.setState({
        queuedMessageBySession: {
          "session-1": {
            kind: "transport-ready",
            recordId: deferred.recordId,
            payload: deferred.payload,
          },
        },
      });
    });

    await waitFor(() => {
      expect(
        mocks.sendPromptToExistingSessionInBackground,
      ).toHaveBeenCalledWith("session-1", "held prompt", expect.any(Function));
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
      useChatStore.getState().queuedMessageBySession["session-1"]?.payload,
    ).toEqual({ text: "user queued prompt" });
  });
});

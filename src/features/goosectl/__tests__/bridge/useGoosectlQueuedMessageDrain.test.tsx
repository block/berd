import { act, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useChatStore } from "@/features/chat/stores/chatStore";
import { useGoosectlQueuedMessageDrain } from "@/features/goosectl/bridge/useGoosectlQueuedMessageDrain";

const mocks = vi.hoisted(() => ({
  sendPromptToExistingSessionInBackground: vi.fn(),
}));

vi.mock(
  "@/features/goosectl/commands/runtime/sessionSend",
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import("@/features/goosectl/commands/runtime/sessionSend")
      >();
    return {
      ...actual,
      sendPromptToExistingSessionInBackground: (...args: unknown[]) =>
        mocks.sendPromptToExistingSessionInBackground(...args),
    };
  },
);

function DrainHarness() {
  useGoosectlQueuedMessageDrain();
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

describe("useGoosectlQueuedMessageDrain", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.sendPromptToExistingSessionInBackground.mockResolvedValue(undefined);
    resetChatStore();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("drains goosectl-origin queued messages when the target session becomes idle", async () => {
    const chatStore = useChatStore.getState();
    chatStore.setChatState("session-1", "streaming");
    chatStore.enqueueMessage("session-1", {
      text: "queued prompt",
      sendOptions: {
        userMessageMetadata: { origin: "goosectl_cross_session" },
        acpGooseMetadata: { origin: "goosectl_cross_session" },
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
      ).toHaveBeenCalledWith("session-1", "queued prompt");
    });
    expect(
      useChatStore.getState().queuedMessageBySession["session-1"],
    ).toBeUndefined();
  });

  it("keeps goosectl-origin queued messages when the background send fails", async () => {
    const sendError = new Error("prepare failed");
    const consoleErrorSpy = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    mocks.sendPromptToExistingSessionInBackground.mockRejectedValueOnce(
      sendError,
    );
    const chatStore = useChatStore.getState();
    chatStore.setChatState("session-1", "streaming");
    chatStore.enqueueMessage("session-1", {
      text: "queued prompt",
      sendOptions: {
        userMessageMetadata: { origin: "goosectl_cross_session" },
        acpGooseMetadata: { origin: "goosectl_cross_session" },
      },
    });
    render(<DrainHarness />);

    act(() => {
      useChatStore.getState().setChatState("session-1", "idle");
    });

    await waitFor(() => {
      expect(
        mocks.sendPromptToExistingSessionInBackground,
      ).toHaveBeenCalledWith("session-1", "queued prompt");
    });
    await waitFor(() => {
      expect(consoleErrorSpy).toHaveBeenCalledWith(
        "[goosectl-queue] failed to send queued prompt for session session-1",
        sendError,
      );
    });
    expect(useChatStore.getState().queuedMessageBySession["session-1"]).toEqual(
      {
        text: "queued prompt",
        sendOptions: {
          userMessageMetadata: { origin: "goosectl_cross_session" },
          acpGooseMetadata: { origin: "goosectl_cross_session" },
        },
      },
    );
  });

  it("leaves ordinary queued messages for ChatView-owned queue handling", async () => {
    const chatStore = useChatStore.getState();
    chatStore.setChatState("session-1", "streaming");
    chatStore.enqueueMessage("session-1", { text: "user queued prompt" });
    render(<DrainHarness />);

    act(() => {
      useChatStore.getState().setChatState("session-1", "idle");
    });

    expect(
      mocks.sendPromptToExistingSessionInBackground,
    ).not.toHaveBeenCalled();
    expect(useChatStore.getState().queuedMessageBySession["session-1"]).toEqual(
      { text: "user queued prompt" },
    );
  });
});

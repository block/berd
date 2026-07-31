import { render, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { useChatStore } from "@/features/chat/stores/chatStore";
import type { QueuedMessageRecord } from "@/features/chat/stores/chatStore";
import { useReleasedQueuedMessageDrain } from "./useReleasedQueuedMessageDrain";

const mocks = vi.hoisted(() => ({
  sendQueuedPromptToExistingSessionInBackground: vi.fn(),
}));

vi.mock("@/features/chat/lib/queuedSessionSend", () => ({
  sendQueuedPromptToExistingSessionInBackground: (...args: unknown[]) =>
    mocks.sendQueuedPromptToExistingSessionInBackground(...args),
}));

function DrainHarness() {
  useReleasedQueuedMessageDrain();
  return null;
}

function releasedRecord(): QueuedMessageRecord & { kind: "transport-ready" } {
  return {
    kind: "transport-ready",
    recordId: "record-1",
    releasedFromDeferred: true,
    payload: {
      text: "held prompt",
      personaId: "persona-1",
      attachments: [
        {
          id: "attachment-1",
          kind: "file",
          name: "notes.txt",
          path: "/tmp/notes.txt",
        },
      ],
      sendOptions: {
        displayText: "Visible prompt",
        assistantPrompt: "Continue",
      },
    },
  };
}

describe("useReleasedQueuedMessageDrain", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.sendQueuedPromptToExistingSessionInBackground.mockResolvedValue(
      undefined,
    );
    useChatStore.setState({
      messagesBySession: {},
      sessionStateById: {},
      queuedMessageBySession: {},
      draftsBySession: {},
      activeSessionId: null,
      isConnected: false,
    });
  });

  it("drains a released deferred payload independently of the Berdctl bridge", async () => {
    const released = releasedRecord();
    useChatStore.setState({
      queuedMessageBySession: { "session-1": released },
    });

    render(<DrainHarness />);

    await waitFor(() => {
      expect(
        mocks.sendQueuedPromptToExistingSessionInBackground,
      ).toHaveBeenCalledWith(
        "session-1",
        released,
        expect.any(Function),
        expect.any(Function),
      );
    });
    expect(
      useChatStore.getState().queuedMessageBySession["session-1"],
    ).toBeUndefined();
  });

  it("retains the released payload when background preparation fails", async () => {
    const released = releasedRecord();
    mocks.sendQueuedPromptToExistingSessionInBackground.mockRejectedValueOnce(
      new Error("preparation rejected"),
    );
    useChatStore.setState({
      queuedMessageBySession: { "session-1": released },
    });

    render(<DrainHarness />);

    await waitFor(() => {
      expect(
        mocks.sendQueuedPromptToExistingSessionInBackground,
      ).toHaveBeenCalledWith(
        "session-1",
        released,
        expect.any(Function),
        expect.any(Function),
      );
    });
    expect(useChatStore.getState().queuedMessageBySession["session-1"]).toBe(
      released,
    );
  });

  it("ignores ordinary and Berdctl-origin transport-ready records", () => {
    useChatStore.setState({
      queuedMessageBySession: {
        ordinary: {
          kind: "transport-ready",
          recordId: "ordinary-record",
          payload: { text: "ordinary" },
        },
        berdctl: {
          kind: "transport-ready",
          recordId: "berdctl-record",
          payload: {
            text: "berdctl",
            sendOptions: {
              userMessageMetadata: { origin: "berdctl_cross_session" },
            },
          },
        },
      },
    });

    render(<DrainHarness />);

    expect(
      mocks.sendQueuedPromptToExistingSessionInBackground,
    ).not.toHaveBeenCalled();
  });
});

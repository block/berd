import { render, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { useChatStore } from "@/features/chat/stores/chatStore";
import { useSessionWindowStore } from "@/features/chat/stores/sessionWindowStore";
import type { QueuedMessageRecord } from "@/features/chat/stores/chatStore";
import { useReleasedQueuedMessageDrain } from "./useReleasedQueuedMessageDrain";

const mocks = vi.hoisted(() => ({
  sendQueuedPromptToExistingSessionInBackground: vi.fn(),
}));

vi.mock("@/features/chat/lib/queuedSessionSend", () => ({
  sendQueuedPromptToExistingSessionInBackground: (...args: unknown[]) =>
    mocks.sendQueuedPromptToExistingSessionInBackground(...args),
}));

function DrainHarness({
  sessionId,
  ownerReady,
}: {
  sessionId?: string;
  ownerReady?: boolean;
} = {}) {
  useReleasedQueuedMessageDrain(sessionId, ownerReady);
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
    useSessionWindowStore.setState({
      openSessions: {},
      handoffs: {},
      hasLoadedSnapshot: true,
    });
  });

  it("drains a released deferred payload independently of the Berdctl bridge", async () => {
    const released = releasedRecord();
    useChatStore.setState({
      queuedMessageBySession: { "session-1": [released] },
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
      queuedMessageBySession: { "session-1": [released] },
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
    expect(useChatStore.getState().queuedMessageBySession["session-1"]).toEqual(
      [released],
    );
  });

  it("scopes released draining to the renderer that owns each session", async () => {
    const detached = releasedRecord();
    const main = { ...releasedRecord(), recordId: "main-record" };
    useChatStore.setState({
      queuedMessageBySession: {
        "detached-session": [detached],
        "main-session": [main],
      },
    });
    useSessionWindowStore.setState({
      openSessions: { "detached-session": "session:detached-session" },
    });

    render(<DrainHarness />);

    await waitFor(() => {
      expect(
        mocks.sendQueuedPromptToExistingSessionInBackground,
      ).toHaveBeenCalledWith(
        "main-session",
        main,
        expect.any(Function),
        expect.any(Function),
      );
    });
    expect(
      mocks.sendQueuedPromptToExistingSessionInBackground,
    ).not.toHaveBeenCalledWith(
      "detached-session",
      expect.anything(),
      expect.anything(),
      expect.anything(),
    );

    render(<DrainHarness sessionId="detached-session" />);
    await waitFor(() => {
      expect(
        mocks.sendQueuedPromptToExistingSessionInBackground,
      ).toHaveBeenCalledWith(
        "detached-session",
        detached,
        expect.any(Function),
        expect.any(Function),
      );
    });
  });

  it("waits for the authoritative window snapshot before global draining", async () => {
    const released = releasedRecord();
    useChatStore.setState({
      queuedMessageBySession: { "session-1": [released] },
    });
    useSessionWindowStore.setState({ hasLoadedSnapshot: false });

    render(<DrainHarness />);
    expect(
      mocks.sendQueuedPromptToExistingSessionInBackground,
    ).not.toHaveBeenCalled();

    useSessionWindowStore.getState().setSnapshot([]);
    await waitFor(() => {
      expect(
        mocks.sendQueuedPromptToExistingSessionInBackground,
      ).toHaveBeenCalledTimes(1);
    });
  });

  it("ignores ordinary and Berdctl-origin transport-ready records", () => {
    useChatStore.setState({
      queuedMessageBySession: {
        ordinary: [
          {
            kind: "transport-ready",
            recordId: "ordinary-record",
            payload: { text: "ordinary" },
          },
        ],
        berdctl: [
          {
            kind: "transport-ready",
            recordId: "berdctl-record",
            payload: {
              text: "berdctl",
              sendOptions: {
                userMessageMetadata: { origin: "berdctl_cross_session" },
              },
            },
          },
        ],
      },
    });

    render(<DrainHarness />);

    expect(
      mocks.sendQueuedPromptToExistingSessionInBackground,
    ).not.toHaveBeenCalled();
  });
});

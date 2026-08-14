import { act, render, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { SessionDispatchContentionError } from "@/features/chat/lib/sessionDispatchAcquisition";
import type { SessionDispatchReleaseWaiter } from "@/features/chat/lib/sessionTargetCoordinator";
import { QueuedMessageOwnershipLostError } from "@/features/chat/lib/preCommitSendRejection";
import { QueuedSessionNotReadyError } from "@/features/chat/lib/queuedMessageReadiness";
import {
  registerForegroundQueueOwner,
  resetForegroundQueueOwnershipForTesting,
} from "@/features/chat/lib/foregroundQueueOwnership";
import { useChatSessionStore } from "@/features/chat/stores/chatSessionStore";
import { useChatStore } from "@/features/chat/stores/chatStore";
import { useSessionWindowStore } from "@/features/chat/stores/sessionWindowStore";
import type { QueuedMessageRecord } from "@/features/chat/stores/chatStore";
import { useBackgroundQueuedMessageDrain } from "./useBackgroundQueuedMessageDrain";

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
  useBackgroundQueuedMessageDrain(sessionId, ownerReady);
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

function releasedRecord(): QueuedMessageRecord & { kind: "transport-ready" } {
  return {
    kind: "transport-ready",
    recordId: "record-1",
    releasedFromDeferred: true,
    payload: {
      text: "held prompt",
      persona: { kind: "persona", id: "persona-1" },
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

function ordinaryRecord(): QueuedMessageRecord & { kind: "transport-ready" } {
  return {
    kind: "transport-ready",
    recordId: "ordinary-record",
    payload: {
      text: "ordinary prompt",
      persona: { kind: "inherit" },
    },
  };
}

describe("useBackgroundQueuedMessageDrain", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetForegroundQueueOwnershipForTesting();
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
        {
          id: "main-session",
          title: "Main",
          createdAt: "2026-01-01T00:00:00Z",
          updatedAt: "2026-01-01T00:00:00Z",
          messageCount: 0,
          executionTarget: { harnessId: "goose" },
        },
        {
          id: "detached-session",
          title: "Detached",
          createdAt: "2026-01-01T00:00:00Z",
          updatedAt: "2026-01-01T00:00:00Z",
          messageCount: 0,
          executionTarget: { harnessId: "goose" },
        },
      ],
      hasHydratedSessions: true,
    });
    useSessionWindowStore.setState({
      openSessions: {},
      handoffs: {},
      hasLoadedSnapshot: true,
    });
  });

  it("drains a released exact head once when its session gains a target", async () => {
    const released = releasedRecord();
    useChatSessionStore
      .getState()
      .replaceSessionExecutionTarget("session-1", undefined);
    useChatStore.setState({
      queuedMessageBySession: { "session-1": [released] },
    });

    render(<DrainHarness />);
    expect(
      mocks.sendQueuedPromptToExistingSessionInBackground,
    ).not.toHaveBeenCalled();

    act(() =>
      useChatSessionStore
        .getState()
        .replaceSessionExecutionTarget("session-1", { harnessId: "goose" }),
    );

    await waitFor(() =>
      expect(
        mocks.sendQueuedPromptToExistingSessionInBackground,
      ).toHaveBeenCalledOnce(),
    );
  });

  it("drains a released exact head once when a pinned placeholder hydrates with an ACP target", async () => {
    const released = releasedRecord();
    useChatSessionStore.setState({ sessions: [] });
    useChatSessionStore.getState().ensurePinnedSessionPlaceholder("session-1");
    useChatStore.setState({
      queuedMessageBySession: { "session-1": [released] },
    });

    render(<DrainHarness />);
    expect(
      mocks.sendQueuedPromptToExistingSessionInBackground,
    ).not.toHaveBeenCalled();

    act(() =>
      useChatSessionStore
        .getState()
        .patchSession("session-1", { pinnedLoadState: undefined }),
    );
    expect(
      mocks.sendQueuedPromptToExistingSessionInBackground,
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
        mocks.sendQueuedPromptToExistingSessionInBackground,
      ).toHaveBeenCalledOnce(),
    );
  });

  it("ignores unrelated session updates while a released head stays targetless", () => {
    const released = releasedRecord();
    useChatSessionStore
      .getState()
      .replaceSessionExecutionTarget("session-1", undefined);
    useChatStore.setState({
      queuedMessageBySession: { "session-1": [released] },
    });

    render(<DrainHarness />);
    act(() =>
      useChatSessionStore
        .getState()
        .patchSession("session-1", { title: "Renamed" }),
    );

    expect(
      mocks.sendQueuedPromptToExistingSessionInBackground,
    ).not.toHaveBeenCalled();
  });

  it("waits for session hydration before draining a persisted released head", async () => {
    const released = releasedRecord();
    useChatStore.setState({
      queuedMessageBySession: { "session-1": [released] },
    });
    useChatSessionStore.setState({ sessions: [], hasHydratedSessions: false });

    render(<DrainHarness />);
    expect(
      mocks.sendQueuedPromptToExistingSessionInBackground,
    ).not.toHaveBeenCalled();
    expect(
      useChatStore.getState().queuedMessageBySession["session-1"]?.[0],
    ).toBe(released);

    act(() => {
      useChatSessionStore.setState({
        sessions: [
          {
            id: "session-1",
            title: "Hydrated session",
            createdAt: "2026-01-01T00:00:00Z",
            updatedAt: "2026-01-01T00:00:00Z",
            messageCount: 0,
            executionTarget: { harnessId: "goose" },
          },
        ],
        hasHydratedSessions: true,
      });
    });

    await waitFor(() => {
      expect(
        mocks.sendQueuedPromptToExistingSessionInBackground,
      ).toHaveBeenCalledOnce();
    });
    expect(
      mocks.sendQueuedPromptToExistingSessionInBackground,
    ).toHaveBeenCalledWith(
      "session-1",
      released,
      expect.any(Function),
      expect.any(Function),
    );
  });

  it("keeps a persisted released head when hydration proves the session missing", () => {
    const released = releasedRecord();
    useChatStore.setState({
      queuedMessageBySession: { "session-1": [released] },
    });
    useChatSessionStore.setState({ sessions: [], hasHydratedSessions: false });

    render(<DrainHarness />);
    act(() => {
      useChatSessionStore.setState({ sessions: [], hasHydratedSessions: true });
    });

    expect(
      mocks.sendQueuedPromptToExistingSessionInBackground,
    ).not.toHaveBeenCalled();
    expect(
      useChatStore.getState().queuedMessageBySession["session-1"]?.[0],
    ).toBe(released);
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

  it("waits for an active run to settle before draining a released payload", async () => {
    const released = releasedRecord();
    useChatStore.setState({
      queuedMessageBySession: { "session-1": [released] },
    });
    useChatStore.getState().setActiveRunId("session-1", "run-1");

    render(<DrainHarness />);

    expect(
      mocks.sendQueuedPromptToExistingSessionInBackground,
    ).not.toHaveBeenCalled();

    act(() => useChatStore.getState().setActiveRunId("session-1", null));

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
  });

  it("retains and retries a released head when readiness changes before commit", async () => {
    const released = releasedRecord();
    mocks.sendQueuedPromptToExistingSessionInBackground
      .mockImplementationOnce(
        async (
          _sessionId: string,
          _record: QueuedMessageRecord,
          beforeUserMessageCommitted: () => void,
        ) => {
          useChatStore.getState().setActiveRunId("session-1", "racing-run");
          expect(() => beforeUserMessageCommitted()).toThrow(
            QueuedSessionNotReadyError,
          );
          throw new QueuedSessionNotReadyError();
        },
      )
      .mockResolvedValueOnce(undefined);
    useChatStore.setState({
      queuedMessageBySession: { "session-1": [released] },
    });

    render(<DrainHarness />);

    await waitFor(() => {
      expect(
        mocks.sendQueuedPromptToExistingSessionInBackground,
      ).toHaveBeenCalledTimes(1);
    });
    expect(
      useChatStore.getState().queuedMessageBySession["session-1"]?.[0],
    ).toBe(released);

    act(() => useChatStore.getState().setActiveRunId("session-1", null));

    await waitFor(() => {
      expect(
        mocks.sendQueuedPromptToExistingSessionInBackground,
      ).toHaveBeenCalledTimes(2);
      expect(
        useChatStore.getState().queuedMessageBySession["session-1"],
      ).toBeUndefined();
    });
  });

  it("does not drain a released deferred record while its editor owns it", async () => {
    const deferred = useChatStore.getState().enqueueDeferredMessage(
      "session-1",
      {
        text: "held prompt",
        persona: { kind: "persona", id: "persona-1" },
      },
      { type: "workspace-first-send", status: "held" },
    );
    if (!deferred) throw new Error("expected deferred record");
    const recordId = deferred.recordId;
    useChatStore
      .getState()
      .setQueuedMessageEditing("session-1", recordId, true);
    useChatStore.getState().releaseDeferredMessage("session-1", recordId);

    render(<DrainHarness />);

    expect(
      mocks.sendQueuedPromptToExistingSessionInBackground,
    ).not.toHaveBeenCalled();

    const editedPayload = {
      text: "edited prompt",
      persona: { kind: "persona" as const, id: "persona-2" },
      executionTarget: { harnessId: "goose" },
    };
    act(() => {
      useChatStore
        .getState()
        .updateQueuedMessage("session-1", recordId, editedPayload);
    });

    await waitFor(() => {
      expect(
        mocks.sendQueuedPromptToExistingSessionInBackground,
      ).toHaveBeenCalledWith(
        "session-1",
        expect.objectContaining({ payload: editedPayload }),
        expect.any(Function),
        expect.any(Function),
      );
    });
  });

  it("commits only the submitted replacement when editing starts during preparation", async () => {
    const released = releasedRecord();
    const committedPayloads: QueuedMessageRecord["payload"][] = [];
    mocks.sendQueuedPromptToExistingSessionInBackground
      .mockImplementationOnce(
        async (
          _sessionId: string,
          _record: QueuedMessageRecord,
          beforeUserMessageCommitted: () => void,
        ) => {
          useChatStore
            .getState()
            .setQueuedMessageEditing("session-1", released.recordId, true);
          beforeUserMessageCommitted();
          committedPayloads.push(released.payload);
        },
      )
      .mockImplementationOnce(
        async (
          _sessionId: string,
          record: QueuedMessageRecord,
          beforeUserMessageCommitted: () => void,
        ) => {
          beforeUserMessageCommitted();
          committedPayloads.push(record.payload);
        },
      );
    useChatStore.setState({
      queuedMessageBySession: { "session-1": [released] },
    });

    render(<DrainHarness />);

    await waitFor(() => {
      expect(
        mocks.sendQueuedPromptToExistingSessionInBackground,
      ).toHaveBeenCalledTimes(1);
    });
    expect(committedPayloads).toEqual([]);

    const replacementPayload = {
      ...released.payload,
      text: "submitted replacement",
    };
    act(() => {
      useChatStore
        .getState()
        .updateQueuedMessage(
          "session-1",
          released.recordId,
          replacementPayload,
        );
    });

    await waitFor(() => {
      expect(committedPayloads).toEqual([replacementPayload]);
    });
  });

  it("retries an edited replacement after the stale attempt loses ownership", async () => {
    let rejectStale!: (error: Error) => void;
    mocks.sendQueuedPromptToExistingSessionInBackground
      .mockReturnValueOnce(
        new Promise<void>((_resolve, reject) => {
          rejectStale = reject;
        }),
      )
      .mockResolvedValueOnce(undefined);
    const released = releasedRecord();
    useChatStore.setState({
      queuedMessageBySession: { "session-1": [released] },
    });

    render(<DrainHarness />);
    await waitFor(() => {
      expect(
        mocks.sendQueuedPromptToExistingSessionInBackground,
      ).toHaveBeenCalledTimes(1);
    });

    const replacementPayload = {
      ...released.payload,
      text: "submitted replacement",
    };
    act(() => {
      useChatStore
        .getState()
        .updateQueuedMessage(
          "session-1",
          released.recordId,
          replacementPayload,
        );
      rejectStale(new QueuedMessageOwnershipLostError());
    });

    await waitFor(() => {
      expect(
        mocks.sendQueuedPromptToExistingSessionInBackground,
      ).toHaveBeenCalledTimes(2);
      expect(
        mocks.sendQueuedPromptToExistingSessionInBackground,
      ).toHaveBeenLastCalledWith(
        "session-1",
        expect.objectContaining({ payload: replacementPayload }),
        expect.any(Function),
        expect.any(Function),
      );
    });
  });

  it("serializes a synchronous contention release after attempt settlement", async () => {
    const released = releasedRecord();
    const cancel = vi.fn();
    const waiter: SessionDispatchReleaseWaiter = {
      wait: vi.fn((resume) => {
        resume();
        return cancel;
      }),
      cancel,
    };
    mocks.sendQueuedPromptToExistingSessionInBackground.mockRejectedValueOnce(
      new SessionDispatchContentionError(waiter),
    );
    useChatStore.setState({
      queuedMessageBySession: { "session-1": [released] },
    });

    render(<DrainHarness />);

    await waitFor(() =>
      expect(
        mocks.sendQueuedPromptToExistingSessionInBackground,
      ).toHaveBeenCalledTimes(2),
    );
    expect(waiter.wait).toHaveBeenCalledOnce();
  });

  it("resumes exactly once when contention releases after registration", async () => {
    const contention = contentionHarness();
    const released = releasedRecord();
    mocks.sendQueuedPromptToExistingSessionInBackground.mockRejectedValueOnce(
      new SessionDispatchContentionError(contention.waiter),
    );
    useChatStore.setState({
      queuedMessageBySession: { "session-1": [released] },
    });

    render(<DrainHarness />);
    await waitFor(() => expect(contention.waiter.wait).toHaveBeenCalledOnce());
    act(() => {
      contention.release();
      contention.release();
    });

    await waitFor(() =>
      expect(
        mocks.sendQueuedPromptToExistingSessionInBackground,
      ).toHaveBeenCalledTimes(2),
    );
  });

  it("retains one contention waiter and cancels it for same-id replacement", async () => {
    const contention = contentionHarness();
    const released = releasedRecord();
    mocks.sendQueuedPromptToExistingSessionInBackground.mockRejectedValueOnce(
      new SessionDispatchContentionError(contention.waiter),
    );
    useChatStore.setState({
      queuedMessageBySession: { "session-1": [released] },
    });

    render(<DrainHarness />);
    await waitFor(() => expect(contention.waiter.wait).toHaveBeenCalledOnce());
    act(() => {
      useChatStore.setState((state) => ({
        queuedMessageBySession: {
          ...state.queuedMessageBySession,
          "session-1": [
            {
              ...released,
              payload: { ...released.payload, text: "replacement" },
            },
          ],
        },
      }));
    });
    expect(contention.cancel).toHaveBeenCalledOnce();
    await waitFor(() =>
      expect(
        mocks.sendQueuedPromptToExistingSessionInBackground,
      ).toHaveBeenCalledTimes(2),
    );
    act(() => contention.release());
    expect(
      mocks.sendQueuedPromptToExistingSessionInBackground,
    ).toHaveBeenCalledTimes(2);
  });

  it("cancels contention without retry when the exact head is removed", async () => {
    const contention = contentionHarness();
    const released = releasedRecord();
    mocks.sendQueuedPromptToExistingSessionInBackground.mockRejectedValueOnce(
      new SessionDispatchContentionError(contention.waiter),
    );
    useChatStore.setState({
      queuedMessageBySession: { "session-1": [released] },
    });

    render(<DrainHarness />);
    await waitFor(() => expect(contention.waiter.wait).toHaveBeenCalledOnce());
    act(() => {
      useChatStore.setState({ queuedMessageBySession: {} });
      contention.release();
    });

    expect(contention.cancel).toHaveBeenCalledOnce();
    expect(
      mocks.sendQueuedPromptToExistingSessionInBackground,
    ).toHaveBeenCalledOnce();
  });

  it("cancels a global contention waiter on unmount", async () => {
    const contention = contentionHarness();
    const released = releasedRecord();
    mocks.sendQueuedPromptToExistingSessionInBackground.mockRejectedValueOnce(
      new SessionDispatchContentionError(contention.waiter),
    );
    useChatStore.setState({
      queuedMessageBySession: { "session-1": [released] },
    });

    const owner = render(<DrainHarness />);
    await waitFor(() => expect(contention.waiter.wait).toHaveBeenCalledOnce());
    owner.unmount();
    expect(contention.cancel).toHaveBeenCalledOnce();
  });

  it("parks a failed released payload in a visible terminal state", async () => {
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
    await waitFor(() => {
      expect(
        useChatStore.getState().queuedMessageBySession["session-1"]?.[0],
      ).toMatchObject({
        kind: "deferred",
        recordId: released.recordId,
        payload: released.payload,
        state: {
          type: "workspace-first-send",
          status: "failed",
          error: expect.any(String),
        },
      });
    });
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

  it("ignores Berdctl-origin transport-ready records", () => {
    useChatStore.setState({
      queuedMessageBySession: {
        "session-1": [
          {
            kind: "transport-ready",
            recordId: "berdctl-record",
            payload: {
              persona: { kind: "inherit" },
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

  it("drains an ordinary queued head when no foreground chat owns the session", async () => {
    useChatStore.setState({
      queuedMessageBySession: { "session-1": [ordinaryRecord()] },
    });

    render(<DrainHarness />);

    await waitFor(() =>
      expect(
        mocks.sendQueuedPromptToExistingSessionInBackground,
      ).toHaveBeenCalledOnce(),
    );
  });

  it("defers an ordinary queued head to a mounted foreground owner", () => {
    const releaseOwner = registerForegroundQueueOwner("session-1");
    useChatStore.setState({
      queuedMessageBySession: { "session-1": [ordinaryRecord()] },
    });

    render(<DrainHarness />);

    expect(
      mocks.sendQueuedPromptToExistingSessionInBackground,
    ).not.toHaveBeenCalled();
    releaseOwner();
  });

  it("does not drain an ordinary head restored from persistence", () => {
    useChatStore.setState({
      queuedMessageBySession: {
        "session-1": [{ ...ordinaryRecord(), restored: true }],
      },
    });

    render(<DrainHarness />);

    expect(
      mocks.sendQueuedPromptToExistingSessionInBackground,
    ).not.toHaveBeenCalled();
  });

  it("drains an ordinary queued head after the foreground owner unmounts", async () => {
    const releaseOwner = registerForegroundQueueOwner("session-1");
    useChatStore.setState({
      queuedMessageBySession: { "session-1": [ordinaryRecord()] },
    });

    render(<DrainHarness />);
    expect(
      mocks.sendQueuedPromptToExistingSessionInBackground,
    ).not.toHaveBeenCalled();

    act(() => releaseOwner());

    await waitFor(() =>
      expect(
        mocks.sendQueuedPromptToExistingSessionInBackground,
      ).toHaveBeenCalledOnce(),
    );
  });

  it("keeps deferring while any foreground owner remains registered", async () => {
    const releaseFirst = registerForegroundQueueOwner("session-1");
    const releaseSecond = registerForegroundQueueOwner("session-1");
    useChatStore.setState({
      queuedMessageBySession: { "session-1": [ordinaryRecord()] },
    });

    render(<DrainHarness />);
    act(() => releaseFirst());
    expect(
      mocks.sendQueuedPromptToExistingSessionInBackground,
    ).not.toHaveBeenCalled();

    act(() => releaseSecond());
    await waitFor(() =>
      expect(
        mocks.sendQueuedPromptToExistingSessionInBackground,
      ).toHaveBeenCalledOnce(),
    );
  });

  it("waits for an unowned ordinary head's active run to settle before draining", async () => {
    useChatStore.setState({
      queuedMessageBySession: { "session-1": [ordinaryRecord()] },
    });
    useChatStore.getState().setActiveRunId("session-1", "run-1");

    render(<DrainHarness />);
    expect(
      mocks.sendQueuedPromptToExistingSessionInBackground,
    ).not.toHaveBeenCalled();

    act(() => useChatStore.getState().setActiveRunId("session-1", null));

    await waitFor(() =>
      expect(
        mocks.sendQueuedPromptToExistingSessionInBackground,
      ).toHaveBeenCalledOnce(),
    );
  });
});

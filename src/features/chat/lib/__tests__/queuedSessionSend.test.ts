import { beforeEach, describe, expect, it, vi } from "vitest";

import { PreCommitSendRejectedError } from "@/features/chat/lib/preCommitSendRejection";
import {
  acquireExistingSessionForBackgroundSend,
  sendQueuedPromptToExistingSessionInBackground,
} from "@/features/chat/lib/queuedSessionSend";
import { SessionDispatchCreationIncompleteError } from "@/features/chat/lib/sessionDispatchAcquisition";
import {
  acquireSessionDispatchTarget,
  resetSessionTargetCoordinatorsForTests,
} from "@/features/chat/lib/sessionTargetCoordinator";
import { useChatSessionStore } from "@/features/chat/stores/chatSessionStore";
import type { QueuedMessageRecord } from "@/features/chat/stores/chatStore";
import { useChatStore } from "@/features/chat/stores/chatStore";

const mocks = vi.hoisted(() => ({
  loadSessionMessages: vi.fn(),
}));

vi.mock("@/features/chat/lib/sessionActivation", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@/features/chat/lib/sessionActivation")
  >()),
  loadSessionMessages: (...args: unknown[]) =>
    mocks.loadSessionMessages(...args),
}));

const SESSION_ID = "draft-session";

function seedSession(creationState?: "pending" | "failed"): void {
  useChatSessionStore.setState({
    sessions: [
      {
        id: SESSION_ID,
        title: "New chat",
        createdAt: "2026-08-17T00:00:00.000Z",
        updatedAt: "2026-08-17T00:00:00.000Z",
        messageCount: 0,
        executionTarget: { harnessId: "goose" },
        clientSessionId: SESSION_ID,
        ...(creationState ? { creationState } : {}),
      },
    ],
    hasHydratedSessions: true,
  });
}

function agentBuilderRecord(): QueuedMessageRecord & {
  kind: "transport-ready";
} {
  return {
    kind: "transport-ready",
    recordId: "builder-record",
    payload: {
      text: "make a reviewer",
      persona: { kind: "inherit" },
      sendOptions: { chips: [{ label: "agent-builder", type: "skill" }] },
    },
  };
}

function queuedRecord(): QueuedMessageRecord & { kind: "transport-ready" } {
  return {
    kind: "transport-ready",
    recordId: "record-1",
    payload: { text: "first prompt", persona: { kind: "inherit" } },
  };
}

describe("acquireExistingSessionForBackgroundSend", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetSessionTargetCoordinatorsForTests();
    mocks.loadSessionMessages.mockResolvedValue(true);
    useChatStore.setState({
      messagesBySession: {},
      sessionStateById: {},
      queuedMessageBySession: {},
      draftsBySession: {},
      activeSessionId: null,
    });
  });

  it.each([
    "pending",
    "failed",
  ] as const)("holds a %s draft session instead of hydrating it", async (creationState) => {
    seedSession(creationState);

    await expect(
      acquireExistingSessionForBackgroundSend(SESSION_ID),
    ).resolves.toEqual({ status: "creation-incomplete", creationState });
    expect(mocks.loadSessionMessages).not.toHaveBeenCalled();
  });

  it("acquires a dispatch target once creation has completed", async () => {
    seedSession();

    await expect(
      acquireExistingSessionForBackgroundSend(SESSION_ID),
    ).resolves.toMatchObject({ status: "acquired" });
    expect(mocks.loadSessionMessages).toHaveBeenCalledWith(SESSION_ID);
  });

  it("holds the dispatch target across hydration so no other sender dispatches into the load", async () => {
    seedSession();
    let resolveHydration!: (loaded: boolean) => void;
    mocks.loadSessionMessages.mockReturnValue(
      new Promise<boolean>((resolve) => {
        resolveHydration = resolve;
      }),
    );

    const acquisition = acquireExistingSessionForBackgroundSend(SESSION_ID);

    // Notifications arriving during `session/load` are treated as replay, so a
    // second sender must see this window as contended rather than free.
    expect(mocks.loadSessionMessages).toHaveBeenCalledWith(SESSION_ID);
    expect(acquireSessionDispatchTarget(SESSION_ID).status).toBe("contended");

    resolveHydration(true);
    await expect(acquisition).resolves.toMatchObject({ status: "acquired" });
  });

  it("releases the dispatch target when hydration fails", async () => {
    seedSession();
    mocks.loadSessionMessages.mockResolvedValue(false);

    await expect(
      acquireExistingSessionForBackgroundSend(SESSION_ID),
    ).rejects.toThrow(/load the target session/);

    // A leaked lease would make every later send look like a running dispatch.
    const retry = acquireSessionDispatchTarget(SESSION_ID);
    expect(retry.status).toBe("acquired");
    retry.release?.();
  });

  it("hydrates first and leases the replayed target when the session has none yet", async () => {
    seedSession();
    useChatSessionStore.setState((state) => ({
      sessions: state.sessions.map((session) => ({
        ...session,
        executionTarget: undefined,
      })),
    }));
    // berdctl can address a session this renderer has never activated; its
    // execution target arrives with the `session/load` replay itself.
    mocks.loadSessionMessages.mockImplementation(async () => {
      useChatSessionStore.setState((state) => ({
        sessions: state.sessions.map((session) => ({
          ...session,
          executionTarget: { harnessId: "goose" },
        })),
      }));
      return true;
    });

    const acquisition =
      await acquireExistingSessionForBackgroundSend(SESSION_ID);

    expect(acquisition).toMatchObject({
      status: "acquired",
      target: { harnessId: "goose" },
    });
    expect(mocks.loadSessionMessages).toHaveBeenCalledWith(SESSION_ID);
    if (acquisition.status === "acquired") acquisition.release();
  });

  it("reports unresolved only after hydration had its chance to supply a target", async () => {
    seedSession();
    useChatSessionStore.setState((state) => ({
      sessions: state.sessions.map((session) => ({
        ...session,
        executionTarget: undefined,
      })),
    }));

    await expect(
      acquireExistingSessionForBackgroundSend(SESSION_ID),
    ).resolves.toEqual({ status: "unresolved" });
    expect(mocks.loadSessionMessages).toHaveBeenCalledWith(SESSION_ID);
  });

  it("releases the dispatch target when the session disappears during hydration", async () => {
    seedSession();
    mocks.loadSessionMessages.mockImplementation(async () => {
      useChatSessionStore.setState({ sessions: [] });
      return true;
    });

    await expect(
      acquireExistingSessionForBackgroundSend(SESSION_ID),
    ).resolves.toEqual({ status: "session-missing" });

    seedSession();
    const retry = acquireSessionDispatchTarget(SESSION_ID);
    expect(retry.status).toBe("acquired");
    retry.release?.();
  });
});

describe("sendQueuedPromptToExistingSessionInBackground", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetSessionTargetCoordinatorsForTests();
    mocks.loadSessionMessages.mockResolvedValue(true);
  });

  it("rejects an Agent Builder send until the session owns a prepared draft target", async () => {
    seedSession();
    useChatSessionStore.setState((state) => ({
      sessions: state.sessions.map((session) => ({
        ...session,
        intent: "build-agent" as const,
        agentBuilderOpen: true,
      })),
    }));
    const beforeUserMessageCommitted = vi.fn();

    const error = await sendQueuedPromptToExistingSessionInBackground(
      SESSION_ID,
      agentBuilderRecord(),
      beforeUserMessageCommitted,
    ).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(PreCommitSendRejectedError);
    expect(mocks.loadSessionMessages).not.toHaveBeenCalled();
    expect(beforeUserMessageCommitted).not.toHaveBeenCalled();
  });

  it("rejects a send to a creating session without committing anything", async () => {
    seedSession("pending");
    const beforeUserMessageCommitted = vi.fn();

    const error = await sendQueuedPromptToExistingSessionInBackground(
      SESSION_ID,
      queuedRecord(),
      beforeUserMessageCommitted,
    ).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(SessionDispatchCreationIncompleteError);
    // The drains swallow pre-commit rejections instead of parking the head as
    // a failed record and toasting, which is what keeps the message queued.
    expect(error).toBeInstanceOf(PreCommitSendRejectedError);
    expect(mocks.loadSessionMessages).not.toHaveBeenCalled();
    expect(beforeUserMessageCommitted).not.toHaveBeenCalled();
  });
});

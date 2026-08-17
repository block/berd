import { beforeEach, describe, expect, it, vi } from "vitest";

import { PreCommitSendRejectedError } from "@/features/chat/lib/preCommitSendRejection";
import {
  acquireExistingSessionForBackgroundSend,
  sendQueuedPromptToExistingSessionInBackground,
} from "@/features/chat/lib/queuedSessionSend";
import { SessionDispatchCreationIncompleteError } from "@/features/chat/lib/sessionDispatchAcquisition";
import { resetSessionTargetCoordinatorsForTests } from "@/features/chat/lib/sessionTargetCoordinator";
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
});

describe("sendQueuedPromptToExistingSessionInBackground", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetSessionTargetCoordinatorsForTests();
    mocks.loadSessionMessages.mockResolvedValue(true);
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

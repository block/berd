// Regression coverage for the `berd_chat` `is_first_message` read: the
// post-commit transcript read only counts as evidence once the session's
// history has landed, so a send into a just-opened old session whose replay is
// still in flight is never reported as the session's first message.
import { beforeEach, describe, expect, it } from "vitest";

import {
  type ChatSession,
  useChatSessionStore,
} from "@/features/chat/stores/chatSessionStore";
import { useChatStore } from "@/features/chat/stores/chatStore";
import {
  createSystemNotificationMessage,
  createUserMessage,
} from "@/shared/types/messages";

import { isFirstCommittedUserMessage } from "./chatFirstMessage";

const SESSION_ID = "session-1";

function sessionFixture(overrides: Partial<ChatSession> = {}): ChatSession {
  return {
    id: SESSION_ID,
    title: "Chat",
    createdAt: "2026-08-13T00:00:00.000Z",
    updatedAt: "2026-08-13T00:00:00.000Z",
    messageCount: 0,
    ...overrides,
  };
}

/** Mimics sendCore's commit: the user message lands in the transcript. */
function commitUserMessage(text = "hello") {
  useChatStore.getState().addMessage(SESSION_ID, createUserMessage(text));
}

describe("isFirstCommittedUserMessage", () => {
  beforeEach(() => {
    useChatStore.setState({
      messagesBySession: {},
      sessionStateById: {},
      loadingSessionIds: new Set(),
      activeSessionId: null,
    });
    useChatSessionStore.setState({
      sessions: [sessionFixture()],
      activeSessionId: null,
      hasHydratedSessions: true,
    });
  });

  it("reports the committed message as first for a settled empty session", () => {
    commitUserMessage();

    expect(isFirstCommittedUserMessage(SESSION_ID)).toBe(true);
  });

  // The L1 race: replayed history accumulates in the replay buffer and only
  // reaches the store when the load finishes, so an old session under replay
  // looks exactly like a brand-new one.
  it("reports not-first while the session's history is still replaying", () => {
    useChatStore.getState().setSessionLoading(SESSION_ID, true);
    commitUserMessage();

    expect(isFirstCommittedUserMessage(SESSION_ID)).toBe(false);
  });

  // Same race after the load settles without landing history — a failed load
  // leaves the transcript empty (its error notice is a system message), and
  // the session's backend message count is the only surviving evidence.
  it("reports not-first when the session record counts backend messages", () => {
    useChatSessionStore.setState({
      sessions: [sessionFixture({ messageCount: 12 })],
    });
    useChatStore
      .getState()
      .addMessage(
        SESSION_ID,
        createSystemNotificationMessage("Failed to load session", "error"),
      );
    commitUserMessage();

    expect(isFirstCommittedUserMessage(SESSION_ID)).toBe(false);
  });

  it("reports not-first once replayed history is in the transcript", () => {
    useChatStore
      .getState()
      .addMessage(SESSION_ID, createUserMessage("an earlier turn"));
    commitUserMessage();

    expect(isFirstCommittedUserMessage(SESSION_ID)).toBe(false);
  });

  it("reports not-first for a session with no record to vouch for it", () => {
    useChatSessionStore.setState({ sessions: [] });
    commitUserMessage();

    expect(isFirstCommittedUserMessage(SESSION_ID)).toBe(false);
  });

  // A pinned Home widget inserts a placeholder record for a session missing
  // from the list, so its zero message count is a default rather than the
  // backend's; "failed" means the hydration never resolved.
  it("reports not-first for a pinned record still hydrating", () => {
    useChatSessionStore.setState({
      sessions: [sessionFixture({ pinnedLoadState: "loading" })],
    });
    commitUserMessage();

    expect(isFirstCommittedUserMessage(SESSION_ID)).toBe(false);
  });

  it("reports not-first for a pinned record whose hydration failed", () => {
    useChatSessionStore.setState({
      sessions: [sessionFixture({ pinnedLoadState: "failed" })],
    });
    commitUserMessage();

    expect(isFirstCommittedUserMessage(SESSION_ID)).toBe(false);
  });

  it("ignores system notifications when counting the session's user messages", () => {
    useChatStore
      .getState()
      .addMessage(
        SESSION_ID,
        createSystemNotificationMessage("Working directory missing", "warning"),
      );
    commitUserMessage();

    expect(isFirstCommittedUserMessage(SESSION_ID)).toBe(true);
  });

  it("reports not-first before any message has committed", () => {
    expect(isFirstCommittedUserMessage(SESSION_ID)).toBe(false);
  });
});

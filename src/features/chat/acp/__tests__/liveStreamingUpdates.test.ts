import { beforeEach, describe, expect, it } from "vitest";
import {
  clearLiveSubtitleUpdate,
  flushLiveSubtitleUpdate,
  scheduleLiveSubtitleUpdate,
} from "../liveStreamingUpdates";
import {
  type ChatSession,
  useChatSessionStore,
} from "@/features/chat/stores/chatSessionStore";

const sessionId = "acp-session";

function seedSession(): ChatSession {
  return {
    id: sessionId,
    title: "Test Session",
    createdAt: "2026-04-01T00:00:00.000Z",
    updatedAt: "2026-04-01T00:00:00.000Z",
    messageCount: 0,
  };
}

describe("liveStreamingUpdates", () => {
  beforeEach(() => {
    clearLiveSubtitleUpdate(sessionId);
    useChatSessionStore.setState({
      sessions: [seedSession()],
      activeSessionId: null,
      isLoading: false,
      hasHydratedSessions: true,
      isRightRailOpen: false,
      activeWorkspaceBySession: {},
      modelSelectionIntentBySession: {},
    });
  });

  it("does not republish a previous turn subtitle after subtitle state is cleared", () => {
    scheduleLiveSubtitleUpdate(sessionId, "old assistant subtitle");
    expect(useChatSessionStore.getState().getSession(sessionId)?.subtitle).toBe(
      "old assistant subtitle",
    );

    clearLiveSubtitleUpdate(sessionId);
    useChatSessionStore
      .getState()
      .updateSessionSubtitleFromText(sessionId, "new user prompt");

    flushLiveSubtitleUpdate(sessionId);

    expect(useChatSessionStore.getState().getSession(sessionId)?.subtitle).toBe(
      "new user prompt",
    );
  });

  it("consumes pending subtitle state when flushing a completed turn", () => {
    scheduleLiveSubtitleUpdate(sessionId, "completed assistant subtitle");
    flushLiveSubtitleUpdate(sessionId);
    expect(useChatSessionStore.getState().getSession(sessionId)?.subtitle).toBe(
      "completed assistant subtitle",
    );

    useChatSessionStore
      .getState()
      .updateSessionSubtitleFromText(sessionId, "next user prompt");

    flushLiveSubtitleUpdate(sessionId);

    expect(useChatSessionStore.getState().getSession(sessionId)?.subtitle).toBe(
      "next user prompt",
    );
  });
});

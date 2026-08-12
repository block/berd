import { beforeEach, describe, expect, it } from "vitest";
import { getVisibleSessions, useChatSessionStore } from "../chatSessionStore";

function resetStore() {
  useChatSessionStore.setState({
    sessions: [],
    activeSessionId: null,
    isLoading: false,
    isLoadingMoreSessions: false,
    hasHydratedSessions: false,
    sessionPageCursor: null,
    hasMoreSessions: false,
    isRightRailOpen: false,
    activeWorkspaceBySession: {},
  });
}

describe("chat session builder metadata", () => {
  beforeEach(() => {
    resetStore();
  });

  it("defaults builder metadata to null on a fresh session", () => {
    const created = useChatSessionStore.getState().createDraftSession({
      title: "Untitled",
      workingDir: "/tmp",
    });

    const session = useChatSessionStore.getState().getSession(created.id);

    expect(session?.intent ?? null).toBeNull();
    expect(session?.targetAgentPath ?? null).toBeNull();
    expect(session?.targetAgentSlug ?? null).toBeNull();
    expect(session?.targetAgentDraftState ?? null).toBeNull();
    expect(session?.targetAgentDraftSaved).toBe(false);
  });

  it("treats saved builder drafts as visible recent chats", () => {
    const builderSession = {
      id: "builder-session",
      title: "New agent",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      messageCount: 0,
      intent: "build-agent" as const,
      targetAgentDraftSaved: true,
    };
    const emptyChat = {
      id: "empty-chat",
      title: "New chat",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      messageCount: 0,
    };

    expect(getVisibleSessions([builderSession, emptyChat], {})).toEqual([
      builderSession,
    ]);
  });

  it("keeps unsaved empty builder drafts hidden from recent chats", () => {
    const builderSession = {
      id: "builder-session",
      title: "New agent",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      messageCount: 0,
      intent: "build-agent" as const,
      targetAgentDraftSaved: false,
    };

    expect(getVisibleSessions([builderSession], {})).toEqual([]);
  });

  it("patchSession accepts builder fields", () => {
    const created = useChatSessionStore.getState().createDraftSession({
      title: "Untitled",
      workingDir: "/tmp",
    });

    useChatSessionStore.getState().patchSession(created.id, {
      intent: "build-agent",
      targetAgentPath: "/Users/x/.agents/agents/draft-abc.md",
      targetAgentSlug: "draft-abc",
      targetAgentDraftState: null,
      targetAgentDraftSaved: true,
    });

    const session = useChatSessionStore.getState().getSession(created.id);
    expect(session?.intent).toBe("build-agent");
    expect(session?.targetAgentPath).toMatch(/draft-abc\.md$/);
    expect(session?.targetAgentSlug).toBe("draft-abc");
    expect(session?.targetAgentDraftState).toBeNull();
    expect(session?.targetAgentDraftSaved).toBe(true);
  });
});

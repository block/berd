import { beforeEach, describe, expect, it } from "vitest";
import { useChatSessionStore } from "../chatSessionStore";

function resetStore() {
  useChatSessionStore.setState({
    sessions: [],
    activeSessionId: null,
    isLoading: false,
    isLoadingMoreSessions: false,
    hasHydratedSessions: false,
    sessionPageCursor: null,
    hasMoreSessions: false,
    isContextPanelOpen: false,
    activeWorkspaceBySession: {},
    modelSelectionIntentBySession: {},
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
    });

    const session = useChatSessionStore.getState().getSession(created.id);
    expect(session?.intent).toBe("build-agent");
    expect(session?.targetAgentPath).toMatch(/draft-abc\.md$/);
    expect(session?.targetAgentSlug).toBe("draft-abc");
  });
});

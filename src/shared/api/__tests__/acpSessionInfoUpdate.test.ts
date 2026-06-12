import { beforeEach, describe, expect, it } from "vitest";
import { useChatStore } from "@/features/chat/stores/chatStore";
import { useChatSessionStore } from "@/features/chat/stores/chatSessionStore";
import { handleSessionNotification } from "../acpNotificationHandler";

describe("ACP session info updates", () => {
  beforeEach(() => {
    useChatStore.setState({
      messagesBySession: {},
      sessionStateById: {},
      queuedMessageBySession: {},
      draftsBySession: {},
      activeSessionId: null,
      isConnected: false,
      loadingSessionIds: new Set<string>(),
      scrollTargetMessageBySession: {},
    });
    useChatSessionStore.setState({
      sessions: [],
      activeSessionId: null,
      isLoading: false,
      hasHydratedSessions: false,
      isContextPanelOpen: false,
      activeWorkspaceBySession: {},
    });
  });

  it("applies generated session info updates to non-user-named sessions", async () => {
    useChatSessionStore.getState().addSession({
      id: "goose-session-title",
      title: "New Chat",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      messageCount: 0,
      userSetName: false,
    });

    await handleSessionNotification({
      sessionId: "goose-session-title",
      update: {
        sessionUpdate: "session_info_update",
        title: "Generated Test Title",
        updatedAt: "2026-01-01T00:01:00.000Z",
        _meta: {
          messageCount: 1,
          userSetName: false,
        },
      },
    } as never);

    expect(
      useChatSessionStore.getState().getSession("goose-session-title"),
    ).toMatchObject({
      title: "Generated Test Title",
      updatedAt: "2026-01-01T00:01:00.000Z",
      messageCount: 1,
      userSetName: false,
    });
  });

  it("ignores generated titles for user-named sessions", async () => {
    useChatSessionStore.getState().addSession({
      id: "goose-session-user-title",
      title: "My Custom Title",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      messageCount: 0,
      userSetName: true,
    });

    await handleSessionNotification({
      sessionId: "goose-session-user-title",
      update: {
        sessionUpdate: "session_info_update",
        title: "Generated Test Title",
        updatedAt: "2026-01-01T00:01:00.000Z",
        _meta: {
          messageCount: 1,
          userSetName: true,
        },
      },
    } as never);

    expect(
      useChatSessionStore.getState().getSession("goose-session-user-title"),
    ).toMatchObject({
      title: "My Custom Title",
      updatedAt: "2026-01-01T00:01:00.000Z",
      messageCount: 1,
      userSetName: true,
    });
  });

  it("stores the active run id from Goose session metadata", async () => {
    await handleSessionNotification({
      sessionId: "goose-session-active-run",
      update: {
        sessionUpdate: "session_info_update",
        _meta: {
          goose: {
            activeRunId: "run-123",
          },
        },
      },
    } as never);

    expect(
      useChatStore.getState().getSessionRuntime("goose-session-active-run")
        .activeRunId,
    ).toBe("run-123");

    await handleSessionNotification({
      sessionId: "goose-session-active-run",
      update: {
        sessionUpdate: "session_info_update",
        _meta: {
          goose: {
            activeRunId: null,
          },
        },
      },
    } as never);

    expect(
      useChatStore.getState().getSessionRuntime("goose-session-active-run")
        .activeRunId,
    ).toBeNull();
  });

  it("stores the active run id from alternate ACP meta field shape", async () => {
    await handleSessionNotification({
      sessionId: "goose-session-active-run",
      update: {
        sessionUpdate: "session_info_update",
        meta: {
          goose: {
            activeRunId: "run-from-meta",
          },
        },
      },
    } as never);

    expect(
      useChatStore.getState().getSessionRuntime("goose-session-active-run")
        .activeRunId,
    ).toBe("run-from-meta");
  });
});

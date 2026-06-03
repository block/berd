import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useChatStore } from "@/features/chat/stores/chatStore";
import { useChatSessionStore } from "@/features/chat/stores/chatSessionStore";
import { ChatPinWidget } from "./ChatPinWidget";
import type { WidgetInstance } from "./types";

vi.mock("@/shared/i18n", () => ({
  useLocaleFormatting: () => ({
    formatRelativeTimeToNow: () => "just now",
  }),
}));

function resetStores(): void {
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
  useChatStore.setState({
    messagesBySession: {},
    loadingSessionIds: new Set(),
  });
}

function instance(sessionId: string): WidgetInstance {
  return {
    id: "chat-pin-1",
    type: "chatPin",
    x: 0,
    y: 0,
    z: 1,
    state: { sessionId },
  };
}

describe("ChatPinWidget", () => {
  beforeEach(() => {
    resetStores();
  });

  it("does not fall back to another session when the pinned id is missing", () => {
    useChatSessionStore.getState().addSession({
      id: "session-other",
      title: "Other chat",
      createdAt: "2026-04-01T00:00:00.000Z",
      updatedAt: "2026-04-01T00:00:00.000Z",
      messageCount: 3,
    });

    render(
      <ChatPinWidget
        instance={instance("session-pinned")}
        onUpdateState={vi.fn()}
        onSelectSession={vi.fn()}
      />,
    );

    expect(screen.queryByText("Other chat")).not.toBeInTheDocument();
    expect(screen.getByText("No recent chat")).toBeInTheDocument();
    expect(screen.getByText("Loading pinned chat...")).toBeInTheDocument();
  });

  it("selects an unavailable pinned session so it can retry loading", async () => {
    const user = userEvent.setup();
    const onSelectSession = vi.fn();
    useChatSessionStore.getState().addSession({
      id: "session-pinned",
      title: "Pinned chat",
      createdAt: "2026-04-01T00:00:00.000Z",
      updatedAt: "2026-04-01T00:00:00.000Z",
      messageCount: 1,
      pinnedLoadState: "failed",
    });

    render(
      <ChatPinWidget
        instance={instance("session-pinned")}
        onUpdateState={vi.fn()}
        onSelectSession={onSelectSession}
      />,
    );

    await user.click(screen.getByRole("button"));

    expect(onSelectSession).toHaveBeenCalledWith("session-pinned");
  });
});

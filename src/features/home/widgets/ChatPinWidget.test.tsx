import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useChatStore } from "@/features/chat/stores/chatStore";
import { useChatSessionStore } from "@/features/chat/stores/chatSessionStore";
import { ChatPinWidget } from "./ChatPinWidget";
import type { WidgetInstance } from "./types";

const { mockUseExperiment } = vi.hoisted(() => ({
  mockUseExperiment: vi.fn(() => ({ enabled: false })),
}));

vi.mock("@/features/experiments/experimentPreferences", () => ({
  useExperiment: mockUseExperiment,
  subscribeToExperimentChanges: () => () => {},
}));

vi.mock("./ChatCanvasCard", () => ({
  ChatCanvasCard: ({
    isFocused,
    onFocus,
    onCollapse,
    onOpenFullChat,
  }: {
    isFocused: boolean;
    onFocus?: () => void;
    onCollapse: () => void;
    onOpenFullChat: () => void;
  }) => (
    <div data-focused={String(isFocused)}>
      <button type="button" onClick={onFocus}>
        Focus
      </button>
      <button type="button" onClick={onCollapse}>
        Collapse
      </button>
      <button type="button" onClick={onOpenFullChat}>
        Open full chat
      </button>
    </div>
  ),
}));

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
    isRightRailOpen: false,
    activeWorkspaceBySession: {},
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
    mockUseExperiment.mockReturnValue({ enabled: false });
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

  it("expands in place instead of navigating when the experiment is enabled", async () => {
    const user = userEvent.setup();
    const onUpdateState = vi.fn();
    const onSelectSession = vi.fn();
    mockUseExperiment.mockReturnValue({ enabled: true });
    useChatSessionStore.getState().addSession({
      id: "session-pinned",
      title: "Pinned chat",
      createdAt: "2026-04-01T00:00:00.000Z",
      updatedAt: "2026-04-01T00:00:00.000Z",
      messageCount: 1,
    });

    render(
      <ChatPinWidget
        instance={instance("session-pinned")}
        onUpdateState={onUpdateState}
        onSelectSession={onSelectSession}
      />,
    );
    await user.click(screen.getByRole("button"));

    expect(onUpdateState).toHaveBeenCalledWith({ presentation: "expanded" });
    expect(onSelectSession).not.toHaveBeenCalled();
  });

  it("restores an expanded card and exposes collapse and full-chat actions", async () => {
    const user = userEvent.setup();
    const onUpdateState = vi.fn();
    const onSelectSession = vi.fn();
    mockUseExperiment.mockReturnValue({ enabled: true });
    useChatSessionStore.getState().addSession({
      id: "session-pinned",
      title: "Pinned chat",
      createdAt: "2026-04-01T00:00:00.000Z",
      updatedAt: "2026-04-01T00:00:00.000Z",
      messageCount: 1,
    });
    const expanded = {
      ...instance("session-pinned"),
      state: { sessionId: "session-pinned", presentation: "expanded" },
    };

    render(
      <ChatPinWidget
        instance={expanded}
        onUpdateState={onUpdateState}
        onSelectSession={onSelectSession}
      />,
    );
    await user.click(screen.getByRole("button", { name: "Collapse" }));
    await user.click(screen.getByRole("button", { name: "Open full chat" }));

    expect(onUpdateState).toHaveBeenCalledWith({ presentation: "collapsed" });
    expect(onSelectSession).toHaveBeenCalledWith("session-pinned");
  });

  it("clears ephemeral focus when collapsing without persisting it", async () => {
    const user = userEvent.setup();
    const onUpdateState = vi.fn();
    const onClearCanvasChatFocus = vi.fn();
    mockUseExperiment.mockReturnValue({ enabled: true });
    useChatSessionStore.getState().addSession({
      id: "session-pinned",
      title: "Pinned chat",
      createdAt: "2026-04-01T00:00:00.000Z",
      updatedAt: "2026-04-01T00:00:00.000Z",
      messageCount: 1,
    });

    render(
      <ChatPinWidget
        instance={{
          ...instance("session-pinned"),
          state: { sessionId: "session-pinned", presentation: "expanded" },
        }}
        onUpdateState={onUpdateState}
        isCanvasChatFocused
        onClearCanvasChatFocus={onClearCanvasChatFocus}
      />,
    );
    await user.click(screen.getByRole("button", { name: "Collapse" }));

    expect(onClearCanvasChatFocus).toHaveBeenCalledTimes(1);
    expect(onUpdateState).toHaveBeenCalledWith({ presentation: "collapsed" });
  });

  it("signals unavailable on temporary failure and again on remount", () => {
    const onAvailabilityChange = vi.fn();
    mockUseExperiment.mockReturnValue({ enabled: true });
    useChatSessionStore.getState().addSession({
      id: "session-pinned",
      title: "Pinned chat",
      createdAt: "2026-04-01T00:00:00.000Z",
      updatedAt: "2026-04-01T00:00:00.000Z",
      messageCount: 1,
    });
    const expanded = {
      ...instance("session-pinned"),
      state: { sessionId: "session-pinned", presentation: "expanded" },
    };
    const { unmount } = render(
      <ChatPinWidget
        instance={expanded}
        onUpdateState={vi.fn()}
        onCanvasChatAvailabilityChange={onAvailabilityChange}
      />,
    );

    expect(onAvailabilityChange).toHaveBeenLastCalledWith("chat-pin-1", true);
    unmount();
    expect(onAvailabilityChange).toHaveBeenLastCalledWith("chat-pin-1", false);
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

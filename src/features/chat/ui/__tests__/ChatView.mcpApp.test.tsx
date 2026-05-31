import type { ReactNode } from "react";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  TopBarActionsProvider,
  useTopBarActions,
} from "@/app/contexts/TopBarActionsContext";
import type { ChatSession } from "../../stores/chatSessionStore";
import { ChatView } from "../ChatView";

const mocks = vi.hoisted(() => ({
  messageTimelineSpy: vi.fn(),
  chatInputSpy: vi.fn(),
  chatRightRailSpy: vi.fn(),
  handleSend: vi.fn(() => true),
  pinToHome: vi.fn(),
  unpinFromHome: vi.fn(),
  t: vi.fn((key: string) => key),
  useChatSessionController: vi.fn(),
  usePinToHomeWidget: vi.fn(),
  isContextPanelOpen: false,
  activeWorkspaceBySession: {} as Record<
    string,
    { path: string; branch: string | null }
  >,
  gitState: {
    data: { isGitRepo: false },
    isFetching: false,
    isLoading: false,
  },
}));

vi.mock("motion/react", () => ({
  AnimatePresence: ({ children }: { children: ReactNode }) => children,
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: mocks.t }),
}));

vi.mock("../MessageTimeline", () => ({
  MessageTimeline: (props: {
    messages: unknown[];
    footer?: ReactNode;
    placeholder?: ReactNode;
    showPlaceholder?: boolean;
  }) => {
    mocks.messageTimelineSpy(props);
    const showPlaceholder =
      props.showPlaceholder || props.messages.length === 0;
    return (
      <div data-testid="message-timeline">
        {showPlaceholder ? props.placeholder : null}
        {props.footer}
      </div>
    );
  },
}));

vi.mock("../ChatInput", () => ({
  ChatInput: (props: unknown) => {
    mocks.chatInputSpy(props);
    return <div data-testid="chat-input" />;
  },
}));

vi.mock("../LoadingGoose", () => ({
  LoadingGoose: () => null,
}));

vi.mock("../ChatLoadingSkeleton", () => ({
  ChatLoadingSkeleton: () => <div data-testid="chat-loading-skeleton" />,
}));

vi.mock("../ChatRightRail", () => ({
  ChatRightRail: (props: {
    onToggleTerminal?: () => void;
    terminalOpen?: boolean;
  }) => {
    mocks.chatRightRailSpy(props);
    return (
      <div data-testid="chat-right-rail">
        <button
          type="button"
          data-terminal-open={props.terminalOpen ? "true" : "false"}
          onClick={props.onToggleTerminal}
        >
          toggle terminal
        </button>
      </div>
    );
  },
}));

vi.mock("@/features/terminal/ui/TerminalPanel", () => ({
  TerminalPanel: (props: {
    cwd: string;
    collapsed?: boolean;
    onClose?: () => void;
    onCollapse?: () => void;
    onExpand?: () => void;
  }) => (
    <div
      data-testid="terminal-panel"
      data-cwd={props.cwd}
      data-collapsed={String(props.collapsed)}
    >
      <span>{props.cwd}</span>
      <button type="button" onClick={props.onCollapse}>
        collapse terminal
      </button>
      <button type="button" onClick={props.onExpand}>
        expand terminal
      </button>
      <button type="button" onClick={props.onClose}>
        close terminal
      </button>
    </div>
  ),
}));

vi.mock("../../hooks/ArtifactPolicyContext", () => ({
  ArtifactPolicyProvider: ({ children }: { children: ReactNode }) => children,
}));

vi.mock("../../hooks/useChatSessionController", () => ({
  useChatSessionController: mocks.useChatSessionController,
}));

vi.mock("@/features/home/hooks/usePinToHomeWidget", () => ({
  usePinToHomeWidget: mocks.usePinToHomeWidget,
}));

vi.mock("../../stores/chatSessionStore", () => ({
  useChatSessionStore: (selector: (state: unknown) => unknown) =>
    selector({
      activeWorkspaceBySession: mocks.activeWorkspaceBySession,
      isContextPanelOpen: mocks.isContextPanelOpen,
      setContextPanelOpen: vi.fn(),
    }),
}));

vi.mock("@/shared/hooks/useGitState", () => ({
  useGitState: () => mocks.gitState,
}));

vi.mock("@/features/projects/lib/chatProjectContext", () => ({
  defaultGlobalArtifactRoot: vi.fn().mockResolvedValue(null),
}));

vi.mock("@/shared/lib/perfLog", () => ({
  perfLog: vi.fn(),
}));

function TopBarActionsHost() {
  const actions = useTopBarActions();
  return <div data-testid="topbar-actions">{actions}</div>;
}

function mockMatchMedia(matches: boolean) {
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches,
      media: query,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })),
  });
}

describe("ChatView MCP app messaging", () => {
  beforeEach(() => {
    mocks.messageTimelineSpy.mockClear();
    mocks.chatInputSpy.mockClear();
    mocks.chatRightRailSpy.mockClear();
    mocks.handleSend.mockClear();
    mocks.pinToHome.mockClear();
    mocks.unpinFromHome.mockClear();
    mocks.isContextPanelOpen = false;
    mocks.activeWorkspaceBySession = {};
    mocks.gitState = {
      data: { isGitRepo: false },
      isFetching: false,
      isLoading: false,
    };
    window.localStorage.clear();
    mockMatchMedia(false);
    mocks.usePinToHomeWidget.mockReturnValue({
      isPinned: false,
      isPinning: false,
      pinToHome: mocks.pinToHome,
      unpinFromHome: mocks.unpinFromHome,
    });
    mocks.useChatSessionController.mockReturnValue({
      messages: [
        {
          id: "user-1",
          role: "user",
          created: Date.now(),
          content: [
            {
              type: "text",
              text: "Hello",
            },
          ],
        },
      ],
      streamingMessageId: null,
      scrollTarget: null,
      handleScrollTargetHandled: vi.fn(),
      handleSend: mocks.handleSend,
      isLoadingHistory: false,
      chatState: "idle",
      stopStreaming: vi.fn(),
      projectMetadataPending: false,
      isCompactingContext: false,
      queue: { queuedMessage: null, dismiss: vi.fn() },
      draftValue: "",
      handleDraftChange: vi.fn(),
      personas: [],
      selectedPersonaId: null,
      handlePersonaChange: vi.fn(),
      handleCreatePersona: vi.fn(),
      pickerAgents: [],
      providersLoading: false,
      selectedProvider: "goose",
      handleProviderChange: vi.fn(),
      currentModelId: null,
      currentModelName: null,
      availableModels: [],
      modelsLoading: false,
      modelStatusMessage: null,
      handleModelChange: vi.fn(),
      selectedProjectId: null,
      availableProjects: [],
      handleProjectChange: vi.fn(),
      tokenState: { accumulatedTotal: 0, contextLimit: 0 },
      isContextUsageReady: false,
      compactConversation: vi.fn(),
      canCompactContext: false,
      supportsCompactionControls: false,
      sessionArtifactCwd: null,
      project: null,
    });
  });

  it("passes handleSend through to MessageTimeline for MCP app messages", () => {
    render(<ChatView sessionId="session-1" />);

    expect(mocks.messageTimelineSpy).toHaveBeenCalled();
    const timelineProps = mocks.messageTimelineSpy.mock.calls.at(-1)?.[0] as {
      onSendMcpAppMessage?: unknown;
    };

    expect(timelineProps.onSendMcpAppMessage).toBe(mocks.handleSend);
    const chatInputProps = mocks.chatInputSpy.mock.calls.at(-1)?.[0] as {
      className?: string;
    };
    expect(chatInputProps.className).toBeUndefined();
  });

  it("shows the empty-state placeholder while keeping the composer mounted for a fresh chat", () => {
    mocks.useChatSessionController.mockReturnValue({
      ...mocks.useChatSessionController(),
      messages: [],
    });

    render(<ChatView sessionId="session-1" />);

    // The composer lives inside the timeline, so it stays mounted between states.
    expect(mocks.messageTimelineSpy).toHaveBeenCalled();
    expect(screen.getByText("emptyState.startAConversation")).toBeTruthy();
    expect(mocks.chatInputSpy).toHaveBeenCalled();

    const timelineProps = mocks.messageTimelineSpy.mock.calls.at(-1)?.[0] as {
      footer?: unknown;
      showPlaceholder?: boolean;
    };
    expect(timelineProps.footer).toBeTruthy();
    expect(timelineProps.showPlaceholder).toBe(false);
  });

  it("forces the loading skeleton placeholder while history loads", () => {
    mocks.useChatSessionController.mockReturnValue({
      ...mocks.useChatSessionController(),
      isLoadingHistory: true,
    });

    render(<ChatView sessionId="session-1" />);

    expect(mocks.messageTimelineSpy).toHaveBeenCalled();
    expect(screen.getByTestId("chat-loading-skeleton")).toBeTruthy();
    // Composer is still mounted underneath the skeleton.
    expect(mocks.chatInputSpy).toHaveBeenCalled();

    const timelineProps = mocks.messageTimelineSpy.mock.calls.at(-1)?.[0] as {
      showPlaceholder?: boolean;
    };
    expect(timelineProps.showPlaceholder).toBe(true);
  });

  it("surfaces pin-to-home as a chat top-bar action", async () => {
    const user = userEvent.setup();

    render(
      <TopBarActionsProvider>
        <ChatView sessionId="session-1" />
        <TopBarActionsHost />
      </TopBarActionsProvider>,
    );

    await user.click(screen.getByRole("button", { name: "pinToHome.action" }));

    expect(mocks.pinToHome).toHaveBeenCalled();
  });

  it("surfaces unpin-from-home as a chat top-bar action", async () => {
    const user = userEvent.setup();
    mocks.usePinToHomeWidget.mockReturnValue({
      isPinned: true,
      isPinning: false,
      pinToHome: mocks.pinToHome,
      unpinFromHome: mocks.unpinFromHome,
    });

    render(
      <TopBarActionsProvider>
        <ChatView sessionId="session-1" />
        <TopBarActionsHost />
      </TopBarActionsProvider>,
    );

    await user.click(screen.getByRole("button", { name: "pinToHome.unpin" }));

    expect(mocks.unpinFromHome).toHaveBeenCalled();
    expect(mocks.pinToHome).not.toHaveBeenCalled();
  });

  it("reserves the builder rail from the active session before controller hydration", () => {
    const activeSession = {
      id: "session-1",
      title: "Build agent",
      createdAt: "2026-05-27T00:00:00.000Z",
      updatedAt: "2026-05-27T00:00:00.000Z",
      messageCount: 0,
      intent: "build-agent",
      targetAgentPath: "/Users/test/.agents/agents/draft.md",
      targetAgentSlug: "draft",
    } satisfies ChatSession;

    render(<ChatView sessionId="session-1" activeSession={activeSession} />);

    const railProps = mocks.chatRightRailSpy.mock.calls.at(-1)?.[0] as {
      builderColumnClassName?: string;
      session?: ChatSession | null;
    };
    expect(railProps.session).toBe(activeSession);
    expect(railProps.builderColumnClassName).toBe("agent-builder-column-enter");

    const chatInputProps = mocks.chatInputSpy.mock.calls.at(-1)?.[0] as {
      controls?: unknown;
    };
    expect(chatInputProps.controls).toEqual({
      agentModelPicker: false,
      projectPicker: false,
    });
    expect(document.querySelector(".agent-builder-column-enter")).toBeTruthy();
  });

  it("uses an inline rail gap only while the context panel takes layout space", () => {
    mocks.isContextPanelOpen = true;
    mockMatchMedia(false);
    const activeSession = {
      id: "session-1",
      title: "Chat",
      createdAt: "2026-05-27T00:00:00.000Z",
      updatedAt: "2026-05-27T00:00:00.000Z",
      messageCount: 0,
      intent: null,
    } satisfies ChatSession;

    const { unmount } = render(
      <ChatView sessionId="session-1" activeSession={activeSession} />,
    );

    expect(document.querySelector(".page-transition")).toHaveClass(
      "gap-[var(--spacing-app-panel-gutter-inline)]",
    );

    unmount();
    mockMatchMedia(true);
    render(<ChatView sessionId="session-1" activeSession={activeSession} />);

    expect(document.querySelector(".page-transition")).not.toHaveClass(
      "gap-[var(--spacing-app-panel-gutter-inline)]",
    );
  });

  it("uses agent-building copy for empty builder sessions", () => {
    const activeSession = {
      id: "session-1",
      title: "Build agent",
      createdAt: "2026-05-27T00:00:00.000Z",
      updatedAt: "2026-05-27T00:00:00.000Z",
      messageCount: 0,
      intent: "build-agent",
      targetAgentPath: "/Users/test/.agents/agents/draft.md",
      targetAgentSlug: "draft",
    } satisfies ChatSession;
    mocks.useChatSessionController.mockReturnValue({
      ...mocks.useChatSessionController(),
      messages: [],
    });

    render(<ChatView sessionId="session-1" activeSession={activeSession} />);

    expect(screen.getByText("emptyState.buildAgentPrompt")).toBeTruthy();
    const chatInputProps = mocks.chatInputSpy.mock.calls.at(-1)?.[0] as {
      placeholder?: string;
    };
    expect(chatInputProps.placeholder).toBe("input.agentBuilderPlaceholder");
  });

  it("persists terminal workspaces for the chat session", async () => {
    const user = userEvent.setup();
    mocks.gitState = {
      data: { isGitRepo: true },
      isFetching: false,
      isLoading: false,
    };
    const activeSession = {
      id: "session-1",
      title: "Chat",
      workingDir: "/Users/test/repo",
      createdAt: "2026-05-27T00:00:00.000Z",
      updatedAt: "2026-05-27T00:00:00.000Z",
      messageCount: 0,
      intent: null,
    } satisfies ChatSession;

    const { unmount } = render(
      <ChatView sessionId="session-1" activeSession={activeSession} />,
    );

    await user.click(screen.getByRole("button", { name: "toggle terminal" }));
    expect(await screen.findByTestId("terminal-panel")).toHaveAttribute(
      "data-collapsed",
      "false",
    );
    expect(screen.getByTestId("terminal-panel")).toHaveAttribute(
      "data-cwd",
      "/Users/test/repo",
    );

    unmount();
    const { unmount: unmountRestored } = render(
      <ChatView sessionId="session-1" activeSession={activeSession} />,
    );

    expect(await screen.findByTestId("terminal-panel")).toHaveAttribute(
      "data-collapsed",
      "false",
    );

    await user.click(screen.getByRole("button", { name: "close terminal" }));
    expect(screen.queryByTestId("terminal-panel")).not.toBeInTheDocument();

    unmountRestored();
    render(<ChatView sessionId="session-1" activeSession={activeSession} />);

    expect(screen.queryByTestId("terminal-panel")).not.toBeInTheDocument();
  });

  it("does not start a new terminal when the active workspace changes", async () => {
    const user = userEvent.setup();
    mocks.gitState = {
      data: { isGitRepo: true },
      isFetching: false,
      isLoading: false,
    };
    const activeSession = {
      id: "session-1",
      title: "Chat",
      workingDir: "/Users/test/repo-a",
      createdAt: "2026-05-27T00:00:00.000Z",
      updatedAt: "2026-05-27T00:00:00.000Z",
      messageCount: 0,
      intent: null,
    } satisfies ChatSession;

    const { rerender } = render(
      <ChatView sessionId="session-1" activeSession={activeSession} />,
    );

    await user.click(screen.getByRole("button", { name: "toggle terminal" }));
    expect(await screen.findByTestId("terminal-panel")).toHaveAttribute(
      "data-cwd",
      "/Users/test/repo-a",
    );

    mocks.activeWorkspaceBySession = {
      "session-1": { path: "/Users/test/repo-b", branch: "repo-b" },
    };
    rerender(<ChatView sessionId="session-1" activeSession={activeSession} />);

    const panelsAfterSwitch = screen.getAllByTestId("terminal-panel");
    expect(panelsAfterSwitch).toHaveLength(1);
    expect(panelsAfterSwitch[0]).toHaveAttribute(
      "data-cwd",
      "/Users/test/repo-a",
    );
    expect(panelsAfterSwitch[0]).toHaveAttribute("data-collapsed", "true");

    await user.click(screen.getByRole("button", { name: "toggle terminal" }));

    const panelsAfterOpeningSecond = screen.getAllByTestId("terminal-panel");
    expect(panelsAfterOpeningSecond).toHaveLength(2);
    expect(panelsAfterOpeningSecond[0]).toHaveAttribute(
      "data-cwd",
      "/Users/test/repo-b",
    );
    expect(panelsAfterOpeningSecond[0]).toHaveAttribute(
      "data-collapsed",
      "false",
    );
    expect(panelsAfterOpeningSecond[1]).toHaveAttribute(
      "data-cwd",
      "/Users/test/repo-a",
    );
    expect(panelsAfterOpeningSecond[1]).toHaveAttribute(
      "data-collapsed",
      "true",
    );
  });

  it("expands only one terminal workspace at a time", async () => {
    const user = userEvent.setup();
    mocks.gitState = {
      data: { isGitRepo: true },
      isFetching: false,
      isLoading: false,
    };
    const activeSession = {
      id: "session-1",
      title: "Chat",
      workingDir: "/Users/test/repo-a",
      createdAt: "2026-05-27T00:00:00.000Z",
      updatedAt: "2026-05-27T00:00:00.000Z",
      messageCount: 0,
      intent: null,
    } satisfies ChatSession;

    const { rerender } = render(
      <ChatView sessionId="session-1" activeSession={activeSession} />,
    );

    await user.click(screen.getByRole("button", { name: "toggle terminal" }));
    mocks.activeWorkspaceBySession = {
      "session-1": { path: "/Users/test/repo-b", branch: "repo-b" },
    };
    rerender(<ChatView sessionId="session-1" activeSession={activeSession} />);
    await user.click(screen.getByRole("button", { name: "toggle terminal" }));

    await user.click(
      screen.getAllByRole("button", { name: "expand terminal" })[1],
    );

    const panels = screen.getAllByTestId("terminal-panel");
    expect(panels[0]).toHaveAttribute("data-cwd", "/Users/test/repo-b");
    expect(panels[0]).toHaveAttribute("data-collapsed", "true");
    expect(panels[1]).toHaveAttribute("data-cwd", "/Users/test/repo-a");
    expect(panels[1]).toHaveAttribute("data-collapsed", "false");
  });
});

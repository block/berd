import type { ReactNode, Ref } from "react";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  TopBarActionsProvider,
  useTopBarActions,
} from "@/app/contexts/TopBarActionsContext";
import { TERMINAL_FALLBACK_CWD_STORAGE_KEY } from "@/features/terminal/lib/terminalCwdPreference";
import type { ChatSession } from "../../stores/chatSessionStore";
import { ChatView } from "../ChatView";

const mocks = vi.hoisted(() => ({
  messageTimelineSpy: vi.fn(),
  chatInputSpy: vi.fn(),
  chatRightRailSpy: vi.fn(),
  handleSend: vi.fn(() => true),
  handleDraftChange: vi.fn(),
  queueTerminalCommand: vi.fn(),
  restartTerminalSession: vi.fn(),
  runCommandInTerminalSession: vi.fn(),
  stopTerminalSession: vi.fn(),
  terminalStatusListeners: new Map<
    string,
    Set<
      (change: {
        key: string;
        status: "starting" | "running" | "exited" | "error";
        previousStatus: "starting" | "running" | "exited" | "error";
        source: "backend-exit" | "client-stop" | "start" | "error";
      }) => void
    >
  >(),
  pinToHome: vi.fn(),
  unpinFromHome: vi.fn(),
  t: vi.fn((key: string, _options?: Record<string, unknown>) => key),
  useChatSessionController: vi.fn(),
  usePinToHomeWidget: vi.fn(),
  isContextPanelOpen: false,
  activeWorkspaceBySession: {} as Record<
    string,
    { path: string; branch: string | null }
  >,
}));

vi.mock("motion/react", () => ({
  AnimatePresence: ({ children }: { children: ReactNode }) => children,
  motion: new Proxy(
    {},
    {
      get: () => (props: { children?: ReactNode }) => (
        <div>{props.children}</div>
      ),
    },
  ),
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: mocks.t }),
}));

// Deterministic find-shortcut modifier across dev machines and CI.
vi.mock("@/shared/lib/platform", () => ({
  getPlatform: () => "linux",
}));

vi.mock("@/app/lib/scheduleAfterNextPaint", () => ({
  scheduleAfterNextPaint: (callback: () => void) => {
    callback();
    return vi.fn();
  },
}));

vi.mock("../VirtualMessageTimelineGate", () => ({
  VirtualMessageTimelineGate: (props: {
    messages: Array<{
      id: string;
      content: Array<{ type: string; text?: string }>;
    }>;
    searchContentRef?: Ref<HTMLDivElement>;
    footer?: ReactNode;
    placeholder?: ReactNode;
    showPlaceholder?: boolean;
  }) => {
    mocks.messageTimelineSpy(props);
    const showPlaceholder =
      props.showPlaceholder || props.messages.length === 0;
    return (
      <div data-testid="message-timeline">
        <div ref={props.searchContentRef}>
          {props.messages.map((message) => (
            <p key={message.id}>
              {message.content
                .filter((block) => block.type === "text")
                .map((block) => block.text)
                .join(" ")}
            </p>
          ))}
        </div>
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

vi.mock("../ConversationEmptyAvatar", () => ({
  ConversationEmptyAvatar: (props: { persona: { id: string } }) => (
    <div
      data-testid="conversation-empty-avatar"
      data-persona-id={props.persona.id}
    />
  ),
}));

vi.mock("../ChatRightRail", () => ({
  ChatRightRail: (props: {
    session?: ChatSession | null;
    onToggleTerminal?: () => void;
    terminalOpen?: boolean;
  }) => {
    mocks.chatRightRailSpy(props);
    if (!props.session) {
      return null;
    }
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

vi.mock("@/features/terminal/lib/terminalSessionManager", () => ({
  queueTerminalCommand: mocks.queueTerminalCommand,
  restartTerminalSession: mocks.restartTerminalSession,
  runCommandInTerminalSession: mocks.runCommandInTerminalSession,
  stopTerminalSession: mocks.stopTerminalSession,
  subscribeTerminalSessionStatus: vi.fn((sessionKey, listener) => {
    const listeners =
      mocks.terminalStatusListeners.get(sessionKey) ?? new Set();
    listeners.add(listener);
    mocks.terminalStatusListeners.set(sessionKey, listeners);
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) {
        mocks.terminalStatusListeners.delete(sessionKey);
      }
    };
  }),
}));

vi.mock("@/features/terminal/ui/TerminalPanel", () => ({
  TerminalPanel: (props: {
    sessionKey: string;
    cwd: string;
    collapsed?: boolean;
    showHeader?: boolean;
  }) => (
    <div
      data-testid="terminal-panel"
      data-session-key={props.sessionKey}
      data-cwd={props.cwd}
      data-collapsed={String(props.collapsed)}
      data-show-header={String(props.showHeader)}
    >
      <span>{props.cwd}</span>
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

const terminalStorageKey = "goose:chat-terminal-workspaces:session-1";

interface PersistedTerminalTab {
  id: string;
  cwd: string;
}

function readPersistedTerminalTabs(): PersistedTerminalTab[] {
  const rawState = window.localStorage.getItem(terminalStorageKey);
  if (!rawState) {
    return [];
  }

  const parsedState = JSON.parse(rawState) as {
    tabs?: PersistedTerminalTab[];
  };
  return parsedState.tabs ?? [];
}

function emitTerminalStatus(
  sessionKey: string,
  source: "backend-exit" | "client-stop" | "start" | "error" = "backend-exit",
) {
  const listeners = mocks.terminalStatusListeners.get(sessionKey);
  for (const listener of listeners ?? []) {
    listener({
      key: sessionKey,
      status: "exited",
      previousStatus: "running",
      source,
    });
  }
}

function chatSessionWithWorkingDir(workingDir: string): ChatSession {
  return {
    id: "session-1",
    title: "Chat",
    workingDir,
    createdAt: "2026-05-27T00:00:00.000Z",
    updatedAt: "2026-05-27T00:00:00.000Z",
    messageCount: 0,
    intent: null,
  };
}

describe("ChatView MCP app messaging", () => {
  beforeEach(() => {
    mocks.messageTimelineSpy.mockClear();
    mocks.chatInputSpy.mockClear();
    mocks.chatRightRailSpy.mockClear();
    mocks.handleSend.mockClear();
    mocks.handleDraftChange.mockClear();
    mocks.queueTerminalCommand.mockClear();
    mocks.restartTerminalSession.mockClear();
    mocks.runCommandInTerminalSession.mockClear();
    mocks.runCommandInTerminalSession.mockReturnValue(false);
    mocks.stopTerminalSession.mockClear();
    mocks.terminalStatusListeners.clear();
    mocks.pinToHome.mockClear();
    mocks.unpinFromHome.mockClear();
    mocks.isContextPanelOpen = false;
    mocks.activeWorkspaceBySession = {};
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
      handleDraftChange: mocks.handleDraftChange,
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
    expect(
      (timelineProps as { onRunShellCommand?: unknown }).onRunShellCommand,
    ).toBeUndefined();
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

  it("renders the selected persona's avatar above the empty-state text for a fresh chat", () => {
    const persona = {
      id: "gloopy",
      displayName: "Gloopy",
      avatar: "app-avatar:gloopy-1",
      systemPrompt: "",
    };
    mocks.useChatSessionController.mockReturnValue({
      ...mocks.useChatSessionController(),
      messages: [],
      selectedPersona: persona,
    });

    render(<ChatView sessionId="session-1" />);

    const avatar = screen.getByTestId("conversation-empty-avatar");
    expect(avatar).toHaveAttribute("data-persona-id", "gloopy");
    expect(screen.getByText("emptyState.startAConversation")).toBeTruthy();
  });

  it("does not render the persona avatar once messages exist", () => {
    const persona = {
      id: "gloopy",
      displayName: "Gloopy",
      avatar: "app-avatar:gloopy-1",
      systemPrompt: "",
    };
    mocks.useChatSessionController.mockReturnValue({
      ...mocks.useChatSessionController(),
      selectedPersona: persona,
    });

    render(<ChatView sessionId="session-1" />);

    expect(screen.queryByTestId("conversation-empty-avatar")).toBeNull();
  });

  it("does not render the persona avatar in an empty agent-builder session", () => {
    const persona = {
      id: "gloopy",
      displayName: "Gloopy",
      avatar: "app-avatar:gloopy-1",
      systemPrompt: "",
    };
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
      selectedPersona: persona,
    });

    render(<ChatView sessionId="session-1" activeSession={activeSession} />);

    expect(screen.queryByTestId("conversation-empty-avatar")).toBeNull();
    expect(screen.getByText("emptyState.buildAgentPrompt")).toBeTruthy();
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

  it("opens and focuses chat search from the top-bar action", async () => {
    const user = userEvent.setup();

    render(
      <TopBarActionsProvider>
        <ChatView sessionId="session-1" />
        <TopBarActionsHost />
      </TopBarActionsProvider>,
    );

    await user.click(screen.getByRole("button", { name: "search.action" }));

    const input = screen.getByRole("searchbox", {
      name: "search.inputLabel",
    });
    await waitFor(() => expect(input).toHaveFocus());
  });

  it("opens chat search with the platform find shortcut", async () => {
    render(<ChatView sessionId="session-1" />);

    fireEvent.keyDown(window, { key: "f", ctrlKey: true });
    await waitFor(() =>
      expect(
        screen.getByRole("searchbox", { name: "search.inputLabel" }),
      ).toHaveFocus(),
    );
  });

  it("does not open chat search on the slash chord (reserved for the shortcuts reference)", () => {
    render(<ChatView sessionId="session-1" />);

    fireEvent.keyDown(window, { key: "/", code: "Slash", ctrlKey: true });

    expect(
      screen.queryByRole("searchbox", { name: "search.inputLabel" }),
    ).not.toBeInTheDocument();
  });

  it("ignores the find shortcut with the wrong platform modifier", () => {
    render(<ChatView sessionId="session-1" />);

    // Mocked platform is linux, so Meta+F must pass through untouched.
    fireEvent.keyDown(window, { key: "f", metaKey: true });

    expect(
      screen.queryByRole("searchbox", { name: "search.inputLabel" }),
    ).not.toBeInTheDocument();
  });

  it("does not open search while a dialog or alert dialog is open", () => {
    render(
      <>
        <ChatView sessionId="session-1" />
        <div role="dialog">
          <button type="button">dialog button</button>
        </div>
        <div role="alertdialog">
          <button type="button">alert button</button>
        </div>
      </>,
    );

    // fireEvent returns false when preventDefault was called — the event
    // must pass through unprevented so the dialog keeps its own handling.
    expect(
      fireEvent.keyDown(screen.getByRole("button", { name: "dialog button" }), {
        key: "f",
        ctrlKey: true,
      }),
    ).toBe(true);
    // The guard is presence-based: a mounted layer stands the shortcut down
    // even when focus sits outside it.
    expect(
      fireEvent.keyDown(window, {
        key: "f",
        ctrlKey: true,
      }),
    ).toBe(true);

    expect(
      screen.queryByRole("searchbox", { name: "search.inputLabel" }),
    ).not.toBeInTheDocument();
  });

  it("advances rendered search matches from the search input", async () => {
    const lastMatchCount = () =>
      mocks.t.mock.calls
        .filter((call) => call[0] === "search.matchCount")
        .at(-1)?.[1] as { current: number; total: number } | undefined;
    const user = userEvent.setup();
    mocks.useChatSessionController.mockReturnValue({
      ...mocks.useChatSessionController(),
      messages: [
        {
          id: "user-1",
          role: "user",
          created: Date.now(),
          content: [{ type: "text", text: "foo once" }],
        },
        {
          id: "assistant-1",
          role: "assistant",
          created: Date.now(),
          content: [{ type: "text", text: "foo twice foo" }],
        },
      ],
    });

    render(<ChatView sessionId="session-1" />);
    fireEvent.keyDown(window, { key: "f", ctrlKey: true });
    const input = await screen.findByRole("searchbox", {
      name: "search.inputLabel",
    });
    await user.type(input, "foo");

    // Typing selects the first rendered match; Enter advances. The full
    // navigation matrix (arrows, Ctrl+N/P, wrap-around) is covered with real
    // status text in ChatSearch.integration.test.tsx.
    await waitFor(() =>
      expect(lastMatchCount()).toEqual({ current: 1, total: 3 }),
    );
    await user.keyboard("{Enter}");
    await waitFor(() =>
      expect(lastMatchCount()).toEqual({ current: 2, total: 3 }),
    );
  });

  it("closes chat search with Escape and restores focus", async () => {
    const user = userEvent.setup();
    render(
      <TopBarActionsProvider>
        <ChatView sessionId="session-1" />
        <TopBarActionsHost />
      </TopBarActionsProvider>,
    );

    const openButton = screen.getByRole("button", { name: "search.action" });
    await user.click(openButton);
    const input = screen.getByRole("searchbox", {
      name: "search.inputLabel",
    });
    await waitFor(() => expect(input).toHaveFocus());
    await user.keyboard("{Escape}");

    expect(input).not.toBeInTheDocument();
    expect(openButton).toHaveFocus();
  });

  it("closes chat search when the session id changes in place", async () => {
    const { rerender } = render(<ChatView sessionId="session-1" />);

    fireEvent.keyDown(window, { key: "f", ctrlKey: true });
    await screen.findByRole("searchbox", { name: "search.inputLabel" });

    rerender(<ChatView sessionId="session-2" />);

    await waitFor(() =>
      expect(
        screen.queryByRole("searchbox", { name: "search.inputLabel" }),
      ).not.toBeInTheDocument(),
    );
  });

  it("leaves the composer draft unchanged when invoking chat search", async () => {
    mocks.useChatSessionController.mockReturnValue({
      ...mocks.useChatSessionController(),
      draftValue: "draft stays put",
    });

    render(<ChatView sessionId="session-1" />);

    fireEvent.keyDown(window, { key: "f", ctrlKey: true });
    await screen.findByRole("searchbox", { name: "search.inputLabel" });
    fireEvent.keyDown(window, { key: "n", ctrlKey: true });

    expect(mocks.handleDraftChange).not.toHaveBeenCalled();
    expect(mocks.handleSend).not.toHaveBeenCalled();
    expect(
      (mocks.chatInputSpy.mock.calls.at(-1)?.[0] as { initialValue?: string })
        .initialValue,
    ).toBe("draft stays put");
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

  it("uses failed draft copy when an agent builder draft target fails", () => {
    const activeSession = {
      id: "session-1",
      title: "Build agent",
      createdAt: "2026-05-27T00:00:00.000Z",
      updatedAt: "2026-05-27T00:00:00.000Z",
      messageCount: 0,
      intent: "build-agent",
      targetAgentPath: null,
      targetAgentSlug: null,
      targetAgentDraftState: "failed",
    } satisfies ChatSession;

    render(<ChatView sessionId="session-1" activeSession={activeSession} />);

    const chatInputProps = mocks.chatInputSpy.mock.calls.at(-1)?.[0] as {
      composerActions?: {
        sendDisabled?: boolean;
        sendDisabledReason?: string;
      };
    };
    expect(chatInputProps.composerActions?.sendDisabled).toBe(true);
    expect(chatInputProps.composerActions?.sendDisabledReason).toBe(
      "toolbar.agentBuilderPrepareFailed",
    );
  });

  it("uses an inline rail gap while the desktop context panel takes layout space", () => {
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

    render(<ChatView sessionId="session-1" activeSession={activeSession} />);

    expect(document.querySelector(".page-transition")).toHaveClass(
      "gap-[var(--spacing-app-panel-gutter-inline)]",
    );
    const timelineProps = mocks.messageTimelineSpy.mock.calls.at(-1)?.[0] as {
      sidePanel?: ReactNode;
    };
    expect(timelineProps.sidePanel).toBeUndefined();
    expect(screen.getByTestId("chat-right-rail")).toBeInTheDocument();
    expect(screen.getByTestId("message-timeline")).not.toContainElement(
      screen.getByTestId("chat-right-rail"),
    );
  });

  it("keeps the context panel mounted without a rail gap in compact overlay mode", () => {
    mocks.isContextPanelOpen = true;
    mockMatchMedia(true);
    const activeSession = {
      id: "session-1",
      title: "Chat",
      createdAt: "2026-05-27T00:00:00.000Z",
      updatedAt: "2026-05-27T00:00:00.000Z",
      messageCount: 0,
      intent: null,
    } satisfies ChatSession;

    render(<ChatView sessionId="session-1" activeSession={activeSession} />);

    expect(document.querySelector(".page-transition")).not.toHaveClass(
      "gap-[var(--spacing-app-panel-gutter-inline)]",
    );
    expect(screen.getByTestId("chat-right-rail")).toBeInTheDocument();
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

  it("passes runnable shell commands through to the terminal runner for a non-git working dir", () => {
    const activeSession = chatSessionWithWorkingDir("/Users/test/not-a-repo");

    render(<ChatView sessionId="session-1" activeSession={activeSession} />);

    const timelineProps = mocks.messageTimelineSpy.mock.calls.at(-1)?.[0] as {
      onRunShellCommand?: (command: string) => void;
    };
    expect(timelineProps.onRunShellCommand).toBeTypeOf("function");

    act(() => timelineProps.onRunShellCommand?.("pnpm test"));

    const terminalPanel = screen.getByTestId("terminal-panel");
    const sessionKey = terminalPanel.getAttribute("data-session-key");
    expect(mocks.runCommandInTerminalSession).toHaveBeenCalledWith(
      sessionKey,
      "pnpm test",
    );
    expect(mocks.queueTerminalCommand).toHaveBeenCalledWith(
      sessionKey,
      "pnpm test",
    );
    expect(sessionKey).toEqual(expect.stringMatching(/^session-1:tab-/));
    expect(terminalPanel).toHaveAttribute("data-cwd", "/Users/test/not-a-repo");
    expect(terminalPanel).toHaveAttribute("data-collapsed", "false");
    expect(terminalPanel).toHaveAttribute("data-show-header", "false");
  });

  it("routes repeated shell commands in one render tick to the same default tab", async () => {
    const activeSession = chatSessionWithWorkingDir("/Users/test/repo");

    render(<ChatView sessionId="session-1" activeSession={activeSession} />);

    const timelineProps = mocks.messageTimelineSpy.mock.calls.at(-1)?.[0] as {
      onRunShellCommand?: (command: string) => void;
    };

    act(() => {
      timelineProps.onRunShellCommand?.("pnpm test");
      timelineProps.onRunShellCommand?.("pnpm lint");
    });

    await waitFor(() => expect(readPersistedTerminalTabs()).toHaveLength(1));
    const tabs = readPersistedTerminalTabs();
    expect(tabs).toHaveLength(1);
    const sessionKey = `session-1:${tabs[0]?.id}`;
    expect(mocks.queueTerminalCommand).toHaveBeenNthCalledWith(
      1,
      sessionKey,
      "pnpm test",
    );
    expect(mocks.queueTerminalCommand).toHaveBeenNthCalledWith(
      2,
      sessionKey,
      "pnpm lint",
    );
    expect(screen.getByTestId("terminal-panel")).toHaveAttribute(
      "data-session-key",
      sessionKey,
    );
  });

  it("uses the configured terminal fallback folder when no workspace is selected", () => {
    localStorage.setItem(TERMINAL_FALLBACK_CWD_STORAGE_KEY, "/Users/test");
    const activeSession = {
      id: "session-1",
      title: "Chat",
      createdAt: "2026-05-27T00:00:00.000Z",
      updatedAt: "2026-05-27T00:00:00.000Z",
      messageCount: 0,
      intent: null,
    } satisfies ChatSession;

    render(<ChatView sessionId="session-1" activeSession={activeSession} />);

    const timelineProps = mocks.messageTimelineSpy.mock.calls.at(-1)?.[0] as {
      onRunShellCommand?: (command: string) => void;
    };
    expect(timelineProps.onRunShellCommand).toBeTypeOf("function");

    act(() => timelineProps.onRunShellCommand?.("pwd"));

    const sessionKey = screen
      .getByTestId("terminal-panel")
      .getAttribute("data-session-key");
    expect(mocks.runCommandInTerminalSession).toHaveBeenCalledWith(
      sessionKey,
      "pwd",
    );
    expect(mocks.queueTerminalCommand).toHaveBeenCalledWith(sessionKey, "pwd");
    expect(screen.getByTestId("terminal-panel")).toHaveAttribute(
      "data-cwd",
      "/Users/test",
    );
  });

  it("does not double queue runnable shell commands for existing terminal sessions", () => {
    mocks.runCommandInTerminalSession.mockReturnValue(true);
    const activeSession = chatSessionWithWorkingDir("/Users/test/repo");

    render(<ChatView sessionId="session-1" activeSession={activeSession} />);

    const timelineProps = mocks.messageTimelineSpy.mock.calls.at(-1)?.[0] as {
      onRunShellCommand?: (command: string) => void;
    };

    act(() => timelineProps.onRunShellCommand?.("pnpm test"));

    const sessionKey = screen
      .getByTestId("terminal-panel")
      .getAttribute("data-session-key");
    expect(mocks.runCommandInTerminalSession).toHaveBeenCalledWith(
      sessionKey,
      "pnpm test",
    );
    expect(mocks.queueTerminalCommand).not.toHaveBeenCalled();
    expect(screen.getByTestId("terminal-panel")).toHaveAttribute(
      "data-cwd",
      "/Users/test/repo",
    );
  });

  it("persists terminal tabs for the chat session", async () => {
    const user = userEvent.setup();
    const activeSession = chatSessionWithWorkingDir("/Users/test/repo");

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
    expect(readPersistedTerminalTabs()).toMatchObject([
      { cwd: "/Users/test/repo" },
    ]);

    unmount();
    const { unmount: unmountRestored } = render(
      <ChatView sessionId="session-1" activeSession={activeSession} />,
    );

    expect(await screen.findByTestId("terminal-panel")).toHaveAttribute(
      "data-collapsed",
      "false",
    );

    await user.click(
      screen.getByRole("button", { name: "terminal.stopAndCloseTab" }),
    );
    await user.click(screen.getByRole("button", { name: "terminal.stop" }));
    expect(screen.queryByTestId("terminal-panel")).not.toBeInTheDocument();
    expect(mocks.stopTerminalSession).toHaveBeenCalledWith(
      expect.stringMatching(/^session-1:tab-/),
      { writeStopped: true },
    );

    unmountRestored();
    render(<ChatView sessionId="session-1" activeSession={activeSession} />);

    expect(screen.queryByTestId("terminal-panel")).not.toBeInTheDocument();
  });

  it("migrates legacy terminal workspace state into tabs", async () => {
    window.localStorage.setItem(
      terminalStorageKey,
      JSON.stringify({
        paths: ["/Users/test/repo-a", "/Users/test/repo-b"],
        expandedPath: "/Users/test/repo-b",
      }),
    );
    const activeSession = chatSessionWithWorkingDir("/Users/test/repo-a");

    render(<ChatView sessionId="session-1" activeSession={activeSession} />);

    expect(await screen.findByText("~/test/repo-a")).toBeInTheDocument();
    expect(screen.getByText("~/test/repo-b")).toBeInTheDocument();
    expect(screen.getByTestId("terminal-panel")).toHaveAttribute(
      "data-cwd",
      "/Users/test/repo-b",
    );
    expect(
      screen.getByTestId("terminal-panel").getAttribute("data-session-key"),
    ).toEqual(expect.stringMatching(/^session-1:legacy-1-/));

    await waitFor(() => expect(readPersistedTerminalTabs()).toHaveLength(2));
  });

  it("opens, selects, and collapses the current workspace default tab", async () => {
    const user = userEvent.setup();
    const activeSession = chatSessionWithWorkingDir("/Users/test/repo-a");

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

    await user.click(screen.getByRole("button", { name: "toggle terminal" }));

    expect(screen.getByTestId("terminal-panel")).toHaveAttribute(
      "data-cwd",
      "/Users/test/repo-b",
    );
    expect(screen.getByText("~/test/repo-a")).toBeInTheDocument();
    expect(screen.getByText("~/test/repo-b")).toBeInTheDocument();

    mocks.activeWorkspaceBySession = {};
    rerender(<ChatView sessionId="session-1" activeSession={activeSession} />);
    await user.click(screen.getByRole("button", { name: "toggle terminal" }));

    expect(screen.getByTestId("terminal-panel")).toHaveAttribute(
      "data-cwd",
      "/Users/test/repo-a",
    );
    expect(screen.getByTestId("terminal-panel")).toHaveAttribute(
      "data-collapsed",
      "false",
    );

    await user.click(screen.getByRole("button", { name: "toggle terminal" }));

    expect(screen.queryByTestId("terminal-panel")).toBeNull();
    expect(
      screen.getByRole("button", { name: "terminal.expand" }),
    ).toBeInTheDocument();
  });

  it("creates duplicate cwd tabs with distinct labels", async () => {
    const user = userEvent.setup();
    const activeSession = chatSessionWithWorkingDir("/Users/test/repo");

    render(<ChatView sessionId="session-1" activeSession={activeSession} />);

    await user.click(screen.getByRole("button", { name: "toggle terminal" }));
    await user.click(screen.getByRole("button", { name: "terminal.newTab" }));

    expect(screen.getByText("~/test/repo (1)")).toBeInTheDocument();
    expect(screen.getByText("~/test/repo (2)")).toBeInTheDocument();
    expect(readPersistedTerminalTabs()).toMatchObject([
      { cwd: "/Users/test/repo" },
      { cwd: "/Users/test/repo" },
    ]);

    const secondTab = screen
      .getByText("~/test/repo (2)")
      .closest('[role="tab"]');
    if (!secondTab) {
      throw new Error("expected duplicate terminal tab");
    }
    expect(secondTab).toHaveAttribute("aria-selected", "true");
  });

  it("restarts the active terminal tab from the tab bar", async () => {
    const user = userEvent.setup();
    const activeSession = chatSessionWithWorkingDir("/Users/test/repo");

    render(<ChatView sessionId="session-1" activeSession={activeSession} />);

    await user.click(screen.getByRole("button", { name: "toggle terminal" }));
    const sessionKey = screen
      .getByTestId("terminal-panel")
      .getAttribute("data-session-key");
    if (!sessionKey) {
      throw new Error("expected active terminal session key");
    }

    await user.click(screen.getByRole("button", { name: "terminal.restart" }));

    expect(mocks.restartTerminalSession).toHaveBeenCalledWith(sessionKey);
  });

  it("wires terminal tabs to tabpanels with roving focus state", async () => {
    const user = userEvent.setup();
    const activeSession = chatSessionWithWorkingDir("/Users/test/repo");

    render(<ChatView sessionId="session-1" activeSession={activeSession} />);

    await user.click(screen.getByRole("button", { name: "toggle terminal" }));
    await user.click(screen.getByRole("button", { name: "terminal.newTab" }));

    expect(screen.getByRole("tablist", { name: "terminal.tabs" })).toBeTruthy();
    const tabs = screen.getAllByRole("tab", { name: "terminal.selectTab" });
    const panels = screen.getAllByRole("tabpanel", { hidden: true });
    expect(tabs).toHaveLength(2);
    expect(panels).toHaveLength(2);

    expect(tabs[0]).toHaveAttribute("tabindex", "-1");
    expect(tabs[1]).toHaveAttribute("tabindex", "0");
    for (const tab of tabs) {
      const panelId = tab.getAttribute("aria-controls");
      expect(panelId).toBeTruthy();
      const panel = document.getElementById(panelId ?? "");
      expect(panel).toHaveAttribute("role", "tabpanel");
      expect(panel).toHaveAttribute("aria-labelledby", tab.id);
    }
  });

  it("moves terminal tab selection with arrow, home, and end keys", async () => {
    const user = userEvent.setup();
    const activeSession = chatSessionWithWorkingDir("/Users/test/repo");

    render(<ChatView sessionId="session-1" activeSession={activeSession} />);

    await user.click(screen.getByRole("button", { name: "toggle terminal" }));
    await user.click(screen.getByRole("button", { name: "terminal.newTab" }));
    let tabs = screen.getAllByRole("tab", { name: "terminal.selectTab" });
    expect(tabs[1]).toHaveAttribute("aria-selected", "true");

    tabs[1].focus();
    await user.keyboard("{ArrowLeft}");
    tabs = screen.getAllByRole("tab", { name: "terminal.selectTab" });
    expect(tabs[0]).toHaveAttribute("aria-selected", "true");
    await waitFor(() => expect(tabs[0]).toHaveFocus());

    await user.keyboard("{ArrowRight}");
    tabs = screen.getAllByRole("tab", { name: "terminal.selectTab" });
    expect(tabs[1]).toHaveAttribute("aria-selected", "true");
    await waitFor(() => expect(tabs[1]).toHaveFocus());

    await user.keyboard("{Home}");
    tabs = screen.getAllByRole("tab", { name: "terminal.selectTab" });
    expect(tabs[0]).toHaveAttribute("aria-selected", "true");

    await user.keyboard("{End}");
    tabs = screen.getAllByRole("tab", { name: "terminal.selectTab" });
    expect(tabs[1]).toHaveAttribute("aria-selected", "true");
  });

  it("opens a new terminal tab with the platform new-tab shortcut", async () => {
    const user = userEvent.setup();
    const activeSession = chatSessionWithWorkingDir("/Users/test/repo");

    render(<ChatView sessionId="session-1" activeSession={activeSession} />);

    // Mocked platform is linux, so the binding resolves to Ctrl+T.
    await user.click(screen.getByRole("button", { name: "toggle terminal" }));
    await user.keyboard("{Control>}t{/Control}");

    expect(screen.queryByText("~/test/repo (1)")).not.toBeInTheDocument();

    screen.getByRole("tab", { name: "terminal.selectTab" }).focus();
    await user.keyboard("{Control>}t{/Control}");

    expect(screen.getByText("~/test/repo (1)")).toBeInTheDocument();
    expect(screen.getByText("~/test/repo (2)")).toBeInTheDocument();
  });

  it("ignores the new-tab shortcut with the wrong platform modifier", async () => {
    const user = userEvent.setup();
    const activeSession = chatSessionWithWorkingDir("/Users/test/repo");

    render(<ChatView sessionId="session-1" activeSession={activeSession} />);

    await user.click(screen.getByRole("button", { name: "toggle terminal" }));
    screen.getByRole("tab", { name: "terminal.selectTab" }).focus();
    // Mocked platform is linux, so Meta+T must pass through untouched.
    await user.keyboard("{Meta>}t{/Meta}");

    expect(screen.queryByText("~/test/repo (1)")).not.toBeInTheDocument();
  });

  it("ignores terminal shortcuts while a key event is composing", async () => {
    const user = userEvent.setup();
    const activeSession = chatSessionWithWorkingDir("/Users/test/repo");

    render(<ChatView sessionId="session-1" activeSession={activeSession} />);

    await user.click(screen.getByRole("button", { name: "toggle terminal" }));
    screen.getByRole("tab", { name: "terminal.selectTab" }).focus();

    fireEvent.keyDown(window, {
      key: "t",
      ctrlKey: true,
      isComposing: true,
    });

    expect(screen.queryByText("~/test/repo (1)")).not.toBeInTheDocument();
  });

  it("selects the nearest tab after closing the active tab", async () => {
    const user = userEvent.setup();
    const activeSession = chatSessionWithWorkingDir("/Users/test/repo-a");

    const { rerender } = render(
      <ChatView sessionId="session-1" activeSession={activeSession} />,
    );

    await user.click(screen.getByRole("button", { name: "toggle terminal" }));
    mocks.activeWorkspaceBySession = {
      "session-1": { path: "/Users/test/repo-b", branch: "repo-b" },
    };
    rerender(<ChatView sessionId="session-1" activeSession={activeSession} />);
    await user.click(screen.getByRole("button", { name: "toggle terminal" }));
    mocks.activeWorkspaceBySession = {
      "session-1": { path: "/Users/test/repo-c", branch: "repo-c" },
    };
    rerender(<ChatView sessionId="session-1" activeSession={activeSession} />);
    await user.click(screen.getByRole("button", { name: "toggle terminal" }));

    expect(screen.getByTestId("terminal-panel")).toHaveAttribute(
      "data-cwd",
      "/Users/test/repo-c",
    );

    await user.click(
      screen.getAllByRole("button", { name: "terminal.stopAndCloseTab" })[2],
    );
    await user.click(screen.getByRole("button", { name: "terminal.stop" }));

    expect(screen.getByTestId("terminal-panel")).toHaveAttribute(
      "data-cwd",
      "/Users/test/repo-b",
    );
    expect(mocks.stopTerminalSession).toHaveBeenCalledWith(expect.any(String), {
      writeStopped: true,
    });

    await user.click(
      screen.getAllByRole("button", { name: "terminal.stopAndCloseTab" })[1],
    );
    await user.click(screen.getByRole("button", { name: "terminal.stop" }));

    expect(screen.getByTestId("terminal-panel")).toHaveAttribute(
      "data-cwd",
      "/Users/test/repo-a",
    );

    await user.click(
      screen.getByRole("button", { name: "terminal.stopAndCloseTab" }),
    );
    await user.click(screen.getByRole("button", { name: "terminal.stop" }));

    expect(screen.queryByTestId("terminal-panel")).not.toBeInTheDocument();
  });

  it("wires the edit-project handler through to the message timeline", () => {
    const onOpenProjectSettings = vi.fn();
    const activeSession = {
      id: "session-1",
      title: "Chat",
      createdAt: "2026-05-27T00:00:00.000Z",
      updatedAt: "2026-05-27T00:00:00.000Z",
      messageCount: 0,
      intent: null,
      creationState: "failed",
      creationError: "missing folder",
    } satisfies ChatSession;

    render(
      <ChatView
        sessionId="session-1"
        activeSession={activeSession}
        onOpenProjectSettings={onOpenProjectSettings}
      />,
    );

    const timelineProps = mocks.messageTimelineSpy.mock.calls.at(-1)?.[0] as {
      onEditProject?: (projectId: string) => void;
    };
    expect(timelineProps.onEditProject).toBeTypeOf("function");

    act(() => timelineProps.onEditProject?.("project-7"));
    expect(onOpenProjectSettings).toHaveBeenCalledWith("project-7");
  });

  it("removes the tab when the terminal shell exits", async () => {
    const user = userEvent.setup();
    const activeSession = chatSessionWithWorkingDir("/Users/test/repo-a");

    const { rerender } = render(
      <ChatView sessionId="session-1" activeSession={activeSession} />,
    );

    await user.click(screen.getByRole("button", { name: "toggle terminal" }));
    mocks.activeWorkspaceBySession = {
      "session-1": { path: "/Users/test/repo-b", branch: "repo-b" },
    };
    rerender(<ChatView sessionId="session-1" activeSession={activeSession} />);
    await user.click(screen.getByRole("button", { name: "toggle terminal" }));

    const exitedSessionKey = screen
      .getByTestId("terminal-panel")
      .getAttribute("data-session-key");
    if (!exitedSessionKey) {
      throw new Error("expected active terminal session key");
    }

    act(() => emitTerminalStatus(exitedSessionKey));

    expect(screen.getByTestId("terminal-panel")).toHaveAttribute(
      "data-cwd",
      "/Users/test/repo-a",
    );
    expect(mocks.stopTerminalSession).toHaveBeenCalledWith(exitedSessionKey);
  });

  it("routes chat commands to the default tab for the cwd", async () => {
    const user = userEvent.setup();
    const activeSession = chatSessionWithWorkingDir("/Users/test/repo");

    render(<ChatView sessionId="session-1" activeSession={activeSession} />);

    await user.click(screen.getByRole("button", { name: "toggle terminal" }));
    await user.click(screen.getByRole("button", { name: "terminal.newTab" }));
    await waitFor(() => expect(readPersistedTerminalTabs()).toHaveLength(2));
    const [defaultTab, activeDuplicateTab] = readPersistedTerminalTabs();
    if (!defaultTab || !activeDuplicateTab) {
      throw new Error("expected duplicate terminal tabs");
    }
    expect(screen.getByTestId("terminal-panel")).toHaveAttribute(
      "data-session-key",
      `session-1:${activeDuplicateTab.id}`,
    );

    const timelineProps = mocks.messageTimelineSpy.mock.calls.at(-1)?.[0] as {
      onRunShellCommand?: (command: string) => void;
    };

    act(() => timelineProps.onRunShellCommand?.("pnpm test"));

    expect(mocks.runCommandInTerminalSession).toHaveBeenLastCalledWith(
      `session-1:${defaultTab.id}`,
      "pnpm test",
    );
    expect(mocks.queueTerminalCommand).toHaveBeenLastCalledWith(
      `session-1:${defaultTab.id}`,
      "pnpm test",
    );
    expect(screen.getByTestId("terminal-panel")).toHaveAttribute(
      "data-session-key",
      `session-1:${defaultTab.id}`,
    );
  });
});

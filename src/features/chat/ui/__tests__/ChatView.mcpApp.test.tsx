import type { ReactNode, Ref } from "react";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  TopBarActionsProvider,
  useTopBarActions,
} from "@/app/contexts/TopBarActionsContext";
import { TERMINAL_FALLBACK_CWD_STORAGE_KEY } from "@/features/terminal/lib/terminalCwdPreference";
import type { ChatSession } from "../../stores/chatSessionStore";
import { useSecurityConfirmationStore } from "@/features/security/stores/securityConfirmationStore";
import { DEFAULT_RUNTIME_CONFIG } from "@/shared/runtime-config/schema";
import { useRuntimeConfigStore } from "@/shared/runtime-config/runtimeConfigStore";
import { ChatView } from "../ChatView";

const mocks = vi.hoisted(() => ({
  messageTimelineSpy: vi.fn(),
  chatInputSpy: vi.fn(),
  chatRightRailSpy: vi.fn(),
  voiceControllerSpy: vi.fn(),
  sessionFeedbackSurveyHook: vi.fn((_options: unknown) => null),
  setRightRailOpen: vi.fn(),
  patchSession: vi.fn(),
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
  t: vi.fn((key: string, _options?: Record<string, unknown>) => key),
  useChatSessionController: vi.fn(),
  isRightRailOpen: false,
  activeWorkspaceBySession: {} as Record<
    string,
    { path: string; branch: string | null }
  >,
  afterNextPaintCallbacks: [] as Array<() => void>,
  autoFlushAfterNextPaint: true,
}));

vi.mock("motion/react", () => {
  const componentCache = new Map<
    string | symbol,
    (props: Record<string, unknown>) => ReactNode
  >();

  return {
    AnimatePresence: ({ children }: { children: ReactNode }) => children,
    useReducedMotion: () => false,
    motion: new Proxy(
      {},
      {
        get: (_target, element) => {
          const cached = componentCache.get(element);
          if (cached) return cached;

          const MotionMock = ({
            children,
            layout: _layout,
            transition: _transition,
            initial: _initial,
            animate: _animate,
            exit: _exit,
            ...props
          }: Record<string, unknown>) => (
            <div {...props}>{children as ReactNode}</div>
          );
          componentCache.set(element, MotionMock);
          return MotionMock;
        },
      },
    ),
  };
});

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: mocks.t }),
}));

vi.mock(
  "@/features/voice-conversation/hooks/useVoiceConversationController",
  () => ({
    useVoiceConversationController: (options: unknown) => {
      mocks.voiceControllerSpy(options);
      return {
        lifecycle: "stopped",
        uiState: "off",
        microphoneMuted: false,
        start: vi.fn(),
        stop: vi.fn(),
        toggleMicrophone: vi.fn(),
      };
    },
  }),
);

vi.mock("@/shared/artifacts/useResolvedArtifactRoot", () => ({
  useResolvedArtifactRoot: () => null,
}));

vi.mock("@/features/chat/response-feedback/useSessionFeedbackSurvey", () => ({
  useSessionFeedbackSurvey: (options: unknown) =>
    mocks.sessionFeedbackSurveyHook(options),
}));

// Deterministic find-shortcut modifier across dev machines and CI.
vi.mock("@/shared/lib/platform", () => ({
  getPlatform: () => "linux",
}));

vi.mock("@/app/lib/scheduleAfterNextPaint", () => ({
  scheduleAfterNextPaint: (callback: () => void) => {
    if (mocks.autoFlushAfterNextPaint) {
      callback();
      return vi.fn();
    }
    mocks.afterNextPaintCallbacks.push(callback);
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
    onForkFromMessage?: (messageId: string) => void;
    placeholder?: ReactNode;
    showPlaceholder?: boolean;
  }) => {
    mocks.messageTimelineSpy(props);
    const showPlaceholder =
      props.showPlaceholder || props.messages.length === 0;
    return (
      <div data-testid="message-timeline">
        <button
          type="button"
          onClick={() => props.onForkFromMessage?.("user-1")}
        >
          Fork probe
        </button>
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
    return (
      <div data-testid="chat-input">
        {/* Mirror the real composer textarea so focus-return assertions work. */}
        <textarea data-testid="chat-composer" />
      </div>
    );
  },
}));

vi.mock("../LoadingBerd", () => ({
  LoadingBerd: () => null,
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
    contextVisible?: boolean;
    onAgentBuilderCompleted?: (agentId: string) => void;
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
    focusRequest?: number;
  }) => (
    <div
      data-testid="terminal-panel"
      data-session-key={props.sessionKey}
      data-cwd={props.cwd}
      data-collapsed={String(props.collapsed)}
      data-show-header={String(props.showHeader)}
      data-focus-request={String(props.focusRequest)}
    >
      <span>{props.cwd}</span>
    </div>
  ),
}));

vi.mock("../../hooks/ArtifactPolicyContext", () => ({
  ArtifactPolicyProvider: ({ children }: { children: ReactNode }) => children,
  useSessionArtifacts: () => [],
}));

vi.mock("../../hooks/useChatSessionController", () => ({
  useChatSessionController: mocks.useChatSessionController,
}));

vi.mock("../../stores/chatSessionStore", () => ({
  useChatSessionStore: (selector: (state: unknown) => unknown) =>
    selector({
      activeWorkspaceBySession: mocks.activeWorkspaceBySession,
      isRightRailOpen: mocks.isRightRailOpen,
      setRightRailOpen: mocks.setRightRailOpen,
      patchSession: mocks.patchSession,
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

function readPersistedTerminalState(): {
  tabs?: PersistedTerminalTab[];
  placement?: {
    kind?: string;
    region?: string;
    slot?: string;
    rect?: { x: number; y: number; width: number; height: number };
    size?: { height?: number };
  };
} {
  const rawState = window.localStorage.getItem(terminalStorageKey);
  if (!rawState) {
    return {};
  }

  return JSON.parse(rawState);
}

function readPersistedTerminalTabs(): PersistedTerminalTab[] {
  return readPersistedTerminalState().tabs ?? [];
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

function flushAfterNextPaintCallbacks() {
  const callbacks = mocks.afterNextPaintCallbacks.splice(0);
  for (const callback of callbacks) {
    callback();
  }
}

function createDomRect(rect: Partial<DOMRect>): DOMRect {
  const left = rect.left ?? rect.x ?? 0;
  const top = rect.top ?? rect.y ?? 0;
  const width = rect.width ?? 0;
  const height = rect.height ?? 0;
  return {
    left,
    top,
    width,
    height,
    right: rect.right ?? left + width,
    bottom: rect.bottom ?? top + height,
    x: rect.x ?? left,
    y: rect.y ?? top,
    toJSON: () => ({}),
  } as DOMRect;
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
  afterEach(() => {
    act(() => cleanup());
    vi.unstubAllEnvs();
  });

  beforeEach(() => {
    mocks.messageTimelineSpy.mockClear();
    mocks.chatInputSpy.mockClear();
    mocks.chatRightRailSpy.mockClear();
    mocks.voiceControllerSpy.mockClear();
    mocks.sessionFeedbackSurveyHook.mockClear();
    mocks.setRightRailOpen.mockClear();
    mocks.patchSession.mockClear();
    mocks.handleSend.mockClear();
    mocks.handleDraftChange.mockClear();
    mocks.queueTerminalCommand.mockClear();
    mocks.restartTerminalSession.mockClear();
    mocks.runCommandInTerminalSession.mockClear();
    mocks.runCommandInTerminalSession.mockReturnValue(false);
    mocks.stopTerminalSession.mockClear();
    mocks.terminalStatusListeners.clear();
    mocks.isRightRailOpen = false;
    mocks.activeWorkspaceBySession = {};
    mocks.afterNextPaintCallbacks = [];
    mocks.autoFlushAfterNextPaint = true;
    useSecurityConfirmationStore.setState({
      pendingBySessionId: {},
      mountedSurfaceCountBySessionId: {},
    });
    window.localStorage.clear();
    useRuntimeConfigStore.setState({ config: DEFAULT_RUNTIME_CONFIG });
    mockMatchMedia(false);
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
      workspaceSetupInProgress: false,
      workspaceContextReady: true,
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

  it("passes fork-from-message through to MessageTimeline with a timestamp cutoff", async () => {
    const user = userEvent.setup();
    const onForkChat = vi.fn();
    mocks.useChatSessionController.mockReturnValue({
      ...mocks.useChatSessionController(),
      messages: [
        {
          id: "user-1",
          role: "user",
          created: 1_700_000_000_250,
          content: [{ type: "text", text: "Hello" }],
          metadata: { userVisible: true },
        },
        {
          id: "assistant-1",
          role: "assistant",
          created: 1_700_000_003_100,
          content: [{ type: "text", text: "Hi" }],
          metadata: { userVisible: true },
        },
      ],
    });

    render(
      <ChatView
        sessionId="session-1"
        activeSession={chatSessionWithWorkingDir("/tmp/project")}
        onForkChat={onForkChat}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Fork probe" }));

    expect(onForkChat).toHaveBeenCalledWith("session-1", {
      conversationBefore: 1_700_000_003,
    });
  });

  it("gates session surveys through the dedicated build capability", () => {
    vi.stubEnv("VITE_FEEDBACK", "0");
    vi.stubEnv("VITE_FEEDBACK_SURVEYS", "1");
    useRuntimeConfigStore.setState({
      config: {
        ...DEFAULT_RUNTIME_CONFIG,
        feedback: {
          ...DEFAULT_RUNTIME_CONFIG.feedback,
          sessionSurveySamplingRateBasisPoints: 250,
        },
      },
    });

    render(<ChatView sessionId="session-1" />);

    expect(mocks.sessionFeedbackSurveyHook).toHaveBeenLastCalledWith(
      expect.objectContaining({ samplingRateBasisPoints: 250 }),
    );
  });

  it("keeps full chat automatic and passes the complete transcript", () => {
    const completeMessages = Array.from({ length: 12 }, (_, index) => ({
      id: `user-${index + 1}`,
      role: "user" as const,
      created: index,
      content: [{ type: "text" as const, text: `Question ${index + 1}` }],
      metadata: { userVisible: true },
    }));
    mocks.useChatSessionController.mockReturnValue({
      ...mocks.useChatSessionController(),
      messages: completeMessages,
    });

    render(<ChatView sessionId="session-1" />);

    const timelineProps = mocks.messageTimelineSpy.mock.calls.at(-1)?.[0] as {
      messages: typeof completeMessages;
      rendererPolicy?: string;
    };
    expect(timelineProps.messages).toBe(completeMessages);
    expect(timelineProps.messages).toHaveLength(12);
    expect(timelineProps.rendererPolicy).toBe("auto");
  });

  it("does not pass fork-from-message in read-only mode", () => {
    render(
      <ChatView
        sessionId="session-1"
        activeSession={chatSessionWithWorkingDir("/tmp/project")}
        onForkChat={vi.fn()}
        readOnlyStatus="Finishing current response..."
      />,
    );

    const timelineProps = mocks.messageTimelineSpy.mock.calls.at(-1)?.[0] as {
      onForkFromMessage?: unknown;
    };
    expect(timelineProps.onForkFromMessage).toBeUndefined();
  });

  it("wires the change-folder handler through to the message timeline", () => {
    render(
      <ChatView
        sessionId="session-1"
        activeSession={chatSessionWithWorkingDir("/tmp/project")}
      />,
    );

    const timelineProps = mocks.messageTimelineSpy.mock.calls.at(-1)?.[0] as {
      onChangeFolder?: unknown;
    };
    // Without this wiring, the missing-folder notice's "Change folder"
    // action silently falls back to only revealing the context panel
    // (BOT-1471).
    expect(timelineProps.onChangeFolder).toBeTypeOf("function");
  });

  it("does not pass change-folder in read-only mode", () => {
    render(
      <ChatView
        sessionId="session-1"
        activeSession={chatSessionWithWorkingDir("/tmp/project")}
        readOnlyStatus="Finishing current response..."
      />,
    );

    const timelineProps = mocks.messageTimelineSpy.mock.calls.at(-1)?.[0] as {
      onChangeFolder?: unknown;
    };
    expect(timelineProps.onChangeFolder).toBeUndefined();
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

  it("blocks and hides composer, queue, MCP, and voice delivery while security confirmation is pending", () => {
    const sendDeferredAnyway = vi.fn();
    mocks.useChatSessionController.mockReturnValue({
      ...mocks.useChatSessionController(),
      deferredWorkspaceRecord: {
        kind: "deferred",
        recordId: "deferred-1",
        payload: { text: "queued" },
        state: { status: "held", desired: [] },
      },
      queue: { queuedMessage: { text: "queued" }, dismiss: vi.fn() },
      sendDeferredAnyway,
    });
    useSecurityConfirmationStore.setState({
      pendingBySessionId: {
        "session-1": [
          {
            request: { sessionId: "session-1" } as never,
            title: "Security",
            command: null,
            alertText: "Alert",
            resolve: () => undefined,
            inferredExplanation: { status: "idle" },
          },
        ],
      },
    });

    render(<ChatView sessionId="session-1" />);

    const chatInputProps = mocks.chatInputSpy.mock.calls.at(-1)?.[0] as {
      className?: string;
      composerActions: {
        onSend: (text: string) => boolean;
        onSendQueue?: () => boolean;
        onSteerMessage?: unknown;
        onSteerQueuedMessage?: unknown;
      };
    };
    expect(chatInputProps.className).toBe("hidden");
    expect(chatInputProps.composerActions.onSend("blocked")).toBe(false);
    expect(chatInputProps.composerActions.onSendQueue).toBeUndefined();
    expect(chatInputProps.composerActions.onSteerMessage).toBeUndefined();
    expect(chatInputProps.composerActions.onSteerQueuedMessage).toBeUndefined();
    expect(mocks.handleSend).not.toHaveBeenCalled();
    expect(sendDeferredAnyway).not.toHaveBeenCalled();

    const timelineProps = mocks.messageTimelineSpy.mock.calls.at(-1)?.[0] as {
      onSendMcpAppMessage?: unknown;
    };
    expect(timelineProps.onSendMcpAppMessage).toBeUndefined();

    const voiceOptions = mocks.voiceControllerSpy.mock.calls.at(-1)?.[0] as {
      onSend: (text: string) => boolean;
      disabled: boolean;
      routeBlocked: boolean;
      routeUnavailable: boolean;
    };
    expect(voiceOptions.disabled).toBe(true);
    expect(voiceOptions.routeBlocked).toBe(true);
    expect(voiceOptions.routeUnavailable).toBe(false);
    expect(voiceOptions.onSend("blocked voice")).toBe(false);
    expect(mocks.handleSend).not.toHaveBeenCalled();
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

  it("keeps Send available while a blank draft session is pending", () => {
    mocks.useChatSessionController.mockReturnValue({
      ...mocks.useChatSessionController(),
      messages: [],
    });

    render(
      <ChatView
        sessionId="draft-session"
        activeSession={{
          ...chatSessionWithWorkingDir("~/goose artifacts"),
          id: "draft-session",
          creationState: "pending",
        }}
      />,
    );

    const chatInputProps = mocks.chatInputSpy.mock.calls.at(-1)?.[0] as {
      composerActions?: {
        onSend?: unknown;
        sendDisabled?: boolean;
        sendDisabledReason?: string;
      };
    };
    expect(chatInputProps.composerActions?.onSend).toBe(mocks.handleSend);
    expect(chatInputProps.composerActions?.sendDisabled).toBe(false);
    expect(chatInputProps.composerActions?.sendDisabledReason).toBeUndefined();
  });

  it("keeps the empty-state placeholder visible while a blank draft session is pending", () => {
    mocks.useChatSessionController.mockReturnValue({
      ...mocks.useChatSessionController(),
      messages: [],
    });

    render(
      <ChatView
        sessionId="draft-session"
        activeSession={{
          ...chatSessionWithWorkingDir("~/goose artifacts"),
          id: "draft-session",
          creationState: "pending",
        }}
      />,
    );

    expect(screen.getByText("emptyState.startAConversation")).toBeTruthy();

    const timelineProps = mocks.messageTimelineSpy.mock.calls.at(-1)?.[0] as {
      footer?: unknown;
      showPlaceholder?: boolean;
    };
    expect(timelineProps.footer).toBeTruthy();
    expect(timelineProps.showPlaceholder).toBe(false);
  });

  it("measures a static composer handoff target without page-enter motion", () => {
    const rect = {
      left: 10,
      top: 20,
      width: 300,
      height: 64,
      right: 310,
      bottom: 84,
      x: 10,
      y: 20,
      toJSON: () => ({}),
    } as DOMRect;
    const requestAnimationFrameSpy = vi
      .spyOn(window, "requestAnimationFrame")
      .mockImplementation((callback) => {
        callback(0);
        return 1;
      });
    const getBoundingClientRectSpy = vi
      .spyOn(HTMLElement.prototype, "getBoundingClientRect")
      .mockReturnValue(rect);
    const onComposerHandoffTarget = vi.fn();

    try {
      render(
        <ChatView
          sessionId="created-session"
          activeSession={{
            ...chatSessionWithWorkingDir("~/goose artifacts"),
            id: "created-session",
            clientSessionId: "draft-session",
          }}
          composerHandoffActive
          composerHandoffInProgress
          composerHandoffRequest={1}
          composerHandoffSessionId="draft-session"
          onComposerHandoffTarget={onComposerHandoffTarget}
        />,
      );

      expect(document.querySelector(".page-transition")).toBeNull();
      expect(onComposerHandoffTarget).toHaveBeenCalledTimes(1);
      expect(onComposerHandoffTarget).toHaveBeenCalledWith({
        left: 10,
        top: 20,
        width: 300,
        height: 64,
      });
      const chatInputProps = mocks.chatInputSpy.mock.calls.at(-1)?.[0] as {
        controls?: { autoFocus?: boolean };
      };
      expect(chatInputProps.controls?.autoFocus).toBe(false);
    } finally {
      requestAnimationFrameSpy.mockRestore();
      getBoundingClientRectSpy.mockRestore();
    }
  });

  it("ignores composer handoff target measurements from non-destination chats", () => {
    const requestAnimationFrameSpy = vi
      .spyOn(window, "requestAnimationFrame")
      .mockImplementation((callback) => {
        callback(0);
        return 1;
      });
    const getBoundingClientRectSpy = vi.spyOn(
      HTMLElement.prototype,
      "getBoundingClientRect",
    );
    const onComposerHandoffTarget = vi.fn();

    try {
      render(
        <ChatView
          sessionId="session-1"
          activeSession={chatSessionWithWorkingDir("~/goose artifacts")}
          composerHandoffActive
          composerHandoffInProgress
          composerHandoffRequest={1}
          composerHandoffSessionId="session-2"
          onComposerHandoffTarget={onComposerHandoffTarget}
        />,
      );

      expect(requestAnimationFrameSpy).not.toHaveBeenCalled();
      expect(getBoundingClientRectSpy).not.toHaveBeenCalled();
      expect(onComposerHandoffTarget).not.toHaveBeenCalled();
    } finally {
      requestAnimationFrameSpy.mockRestore();
      getBoundingClientRectSpy.mockRestore();
    }
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

  it("forwards agent builder completion to the app shell", () => {
    const onAgentBuilderCompleted = vi.fn();
    const activeSession = {
      id: "session-1",
      title: "Build agent",
      createdAt: "2026-05-27T00:00:00.000Z",
      updatedAt: "2026-05-27T00:00:00.000Z",
      messageCount: 0,
      intent: "build-agent",
      agentBuilderOpen: true,
      targetAgentPath: "/Users/test/.agents/agents/draft.md",
      targetAgentSlug: "draft",
    } satisfies ChatSession;

    render(
      <ChatView
        sessionId="session-1"
        activeSession={activeSession}
        onAgentBuilderCompleted={onAgentBuilderCompleted}
      />,
    );

    const railProps = mocks.chatRightRailSpy.mock.calls.at(-1)?.[0] as {
      onAgentBuilderCompleted?: (agentId: string) => void;
    };
    railProps.onAgentBuilderCompleted?.("/saved-agent.md");

    expect(onAgentBuilderCompleted).toHaveBeenCalledWith("/saved-agent.md");
  });

  it("keeps the canonical empty conversation presentation when Agent Builder is open", () => {
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
      agentBuilderOpen: true,
      targetAgentPath: "/Users/test/.agents/agents/draft.md",
      targetAgentSlug: "draft",
    } satisfies ChatSession;
    mocks.useChatSessionController.mockReturnValue({
      ...mocks.useChatSessionController(),
      messages: [],
      selectedPersona: persona,
    });

    render(<ChatView sessionId="session-1" activeSession={activeSession} />);

    expect(screen.getByTestId("conversation-empty-avatar")).toHaveAttribute(
      "data-persona-id",
      "gloopy",
    );
    expect(screen.getByText("emptyState.startAConversation")).toBeTruthy();
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

  it("defers cached transcript rendering for one frame while keeping the terminal mounted", () => {
    mocks.autoFlushAfterNextPaint = false;
    window.localStorage.setItem(
      terminalStorageKey,
      JSON.stringify({
        tabs: [{ id: "tab-1", cwd: "/Users/test/app" }],
        activeTabId: "tab-1",
        expanded: true,
      }),
    );

    render(
      <ChatView
        sessionId="session-1"
        activeSession={chatSessionWithWorkingDir("/Users/test/app")}
      />,
    );

    expect(screen.getByTestId("chat-loading-skeleton")).toBeTruthy();
    expect(screen.queryByText("Hello")).toBeNull();
    expect(screen.getByTestId("terminal-panel")).toHaveAttribute(
      "data-cwd",
      "/Users/test/app",
    );

    let timelineProps = mocks.messageTimelineSpy.mock.calls.at(-1)?.[0] as {
      messages?: unknown[];
      showPlaceholder?: boolean;
    };
    expect(timelineProps.messages).toEqual([]);
    expect(timelineProps.showPlaceholder).toBe(true);

    act(() => {
      flushAfterNextPaintCallbacks();
    });

    expect(screen.getByText("Hello")).toBeTruthy();
    timelineProps = mocks.messageTimelineSpy.mock.calls.at(-1)?.[0] as {
      messages?: unknown[];
      showPlaceholder?: boolean;
    };
    expect(timelineProps.messages).toHaveLength(1);
    expect(timelineProps.showPlaceholder).toBe(false);
  });

  it("does not surface chat-scoped top-bar actions", () => {
    render(
      <TopBarActionsProvider>
        <ChatView sessionId="session-1" />
        <TopBarActionsHost />
      </TopBarActionsProvider>,
    );

    expect(
      screen.queryByRole("button", { name: "pinToHome.action" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "pinToHome.unpin" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "search.action" }),
    ).not.toBeInTheDocument();
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
        <button type="button">Focus anchor</button>
        <ChatView sessionId="session-1" />
        <TopBarActionsHost />
      </TopBarActionsProvider>,
    );

    const focusTarget = screen.getByRole("button", { name: "Focus anchor" });
    focusTarget.focus();
    fireEvent.keyDown(window, { key: "f", ctrlKey: true });
    const input = screen.getByRole("searchbox", {
      name: "search.inputLabel",
    });
    await waitFor(() => expect(input).toHaveFocus());
    await user.keyboard("{Escape}");

    expect(input).not.toBeInTheDocument();
    expect(focusTarget).toHaveFocus();
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

  it("closes Context once when Agent Builder opens", () => {
    mocks.isRightRailOpen = true;
    const activeSession = {
      id: "session-1",
      title: "Build agent",
      createdAt: "2026-05-27T00:00:00.000Z",
      updatedAt: "2026-05-27T00:00:00.000Z",
      messageCount: 0,
      intent: "build-agent",
      agentBuilderOpen: true,
      targetAgentPath: "/Users/test/.agents/agents/draft.md",
      targetAgentSlug: "draft",
    } satisfies ChatSession;

    const firstMount = render(
      <ChatView sessionId="session-1" activeSession={activeSession} />,
    );

    const firstRailProps = mocks.chatRightRailSpy.mock.calls.at(-1)?.[0] as {
      contextVisible?: boolean;
    };
    expect(firstRailProps.contextVisible).toBe(false);
    expect(mocks.patchSession).toHaveBeenCalledTimes(1);
    expect(mocks.patchSession).toHaveBeenCalledWith("session-1", {
      agentBuilderContextState: "autoClosed",
    });
    expect(mocks.setRightRailOpen).not.toHaveBeenCalledWith(false);

    firstMount.unmount();
    mocks.chatRightRailSpy.mockClear();

    render(
      <ChatView
        sessionId="session-1"
        activeSession={{
          ...activeSession,
          agentBuilderContextState: "userOpened",
        }}
      />,
    );

    const remountedRailProps = mocks.chatRightRailSpy.mock.calls.at(
      -1,
    )?.[0] as {
      contextVisible?: boolean;
    };
    expect(remountedRailProps.contextVisible).toBe(true);
    expect(mocks.patchSession).toHaveBeenCalledTimes(1);
  });

  it("reserves the builder rail without changing the canonical composer", () => {
    const activeSession = {
      id: "session-1",
      title: "Build agent",
      createdAt: "2026-05-27T00:00:00.000Z",
      updatedAt: "2026-05-27T00:00:00.000Z",
      messageCount: 0,
      intent: "build-agent",
      agentBuilderOpen: true,
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
      placeholder?: string;
    };
    expect(chatInputProps.controls).toEqual({ skills: false });
    expect(chatInputProps.placeholder).toBeUndefined();
    expect(document.querySelector(".agent-builder-column-enter")).toBeTruthy();
  });

  it("keeps Send available while an agent builder draft target is preparing", () => {
    const activeSession = {
      id: "session-1",
      title: "Build agent",
      createdAt: "2026-05-27T00:00:00.000Z",
      updatedAt: "2026-05-27T00:00:00.000Z",
      messageCount: 0,
      intent: "build-agent",
      agentBuilderOpen: true,
      targetAgentPath: null,
      targetAgentSlug: null,
      targetAgentDraftState: "preparing",
    } satisfies ChatSession;

    render(<ChatView sessionId="session-1" activeSession={activeSession} />);

    const chatInputProps = mocks.chatInputSpy.mock.calls.at(-1)?.[0] as {
      composerActions?: {
        sendDisabled?: boolean;
        sendDisabledReason?: string;
      };
    };
    expect(chatInputProps.composerActions?.sendDisabled).toBe(false);
    expect(chatInputProps.composerActions?.sendDisabledReason).toBeUndefined();
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

  it("blocks ordinary, deferred, and voice delivery when the execution target fails", () => {
    const sendDeferredAnyway = vi.fn();
    mocks.useChatSessionController.mockReturnValue({
      ...mocks.useChatSessionController(),
      deferredWorkspaceRecord: {
        kind: "deferred",
        recordId: "deferred-1",
        payload: { text: "queued" },
        state: { status: "held", desired: [] },
      },
      queue: { queuedMessage: { text: "queued" }, dismiss: vi.fn() },
      sendDeferredAnyway,
    });
    const activeSession = {
      id: "session-1",
      title: "Build agent",
      createdAt: "2026-05-27T00:00:00.000Z",
      updatedAt: "2026-05-27T00:00:00.000Z",
      messageCount: 0,
      intent: "build-agent",
      targetAgentDraftState: "failed",
    } satisfies ChatSession;

    render(<ChatView sessionId="session-1" activeSession={activeSession} />);

    const chatInputProps = mocks.chatInputSpy.mock.calls.at(-1)?.[0] as {
      composerActions: {
        onSend: (text: string) => boolean;
        onSendQueue?: () => boolean;
        disabled?: boolean;
      };
    };
    expect(chatInputProps.composerActions.disabled).toBe(true);
    expect(chatInputProps.composerActions.onSendQueue).toBeUndefined();
    expect(chatInputProps.composerActions.onSend("blocked")).toBe(false);
    expect(mocks.handleSend).not.toHaveBeenCalled();
    expect(sendDeferredAnyway).not.toHaveBeenCalled();

    const voiceOptions = mocks.voiceControllerSpy.mock.calls.at(-1)?.[0] as {
      onSend: (text: string) => boolean;
      disabled: boolean;
      routeBlocked: boolean;
      routeUnavailable: boolean;
    };
    expect(voiceOptions.disabled).toBe(true);
    expect(voiceOptions.routeBlocked).toBe(false);
    expect(voiceOptions.routeUnavailable).toBe(true);
    expect(voiceOptions.onSend("blocked voice")).toBe(false);
    expect(mocks.handleSend).not.toHaveBeenCalled();
  });

  it("keeps the canonical composer enabled when a pending builder is closed", () => {
    const activeSession = {
      id: "session-1",
      title: "Build agent",
      createdAt: "2026-05-27T00:00:00.000Z",
      updatedAt: "2026-05-27T00:00:00.000Z",
      messageCount: 0,
      intent: "build-agent",
      agentBuilderOpen: false,
      targetAgentPath: null,
      targetAgentSlug: null,
      targetAgentDraftState: "preparing",
    } satisfies ChatSession;

    render(<ChatView sessionId="session-1" activeSession={activeSession} />);

    const chatInputProps = mocks.chatInputSpy.mock.calls.at(-1)?.[0] as {
      composerActions?: {
        sendDisabled?: boolean;
        sendDisabledReason?: string;
      };
    };
    expect(chatInputProps.composerActions?.sendDisabled).toBe(false);
    expect(chatInputProps.composerActions?.sendDisabledReason).toBeUndefined();
  });

  it("accounts for Agent Builder when deciding if Context should overlay", () => {
    const queriedMedia = vi.fn();
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      value: vi.fn().mockImplementation((query: string) => {
        queriedMedia(query);
        return {
          matches: false,
          media: query,
          addEventListener: vi.fn(),
          removeEventListener: vi.fn(),
        };
      }),
    });
    const activeSession = {
      id: "session-1",
      title: "Build agent",
      createdAt: "2026-05-27T00:00:00.000Z",
      updatedAt: "2026-05-27T00:00:00.000Z",
      messageCount: 0,
      intent: "build-agent",
      agentBuilderOpen: true,
      targetAgentPath: "/Users/test/.agents/agents/draft.md",
      targetAgentSlug: "draft",
    } satisfies ChatSession;

    render(
      <ChatView
        sessionId="session-1"
        activeSession={activeSession}
        leftViewportOcclusionPx={100}
      />,
    );

    expect(queriedMedia).toHaveBeenCalledWith("(max-width: 1150px)");
  });

  it("uses an inline rail gap while the desktop context panel takes layout space", () => {
    mocks.isRightRailOpen = true;
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
    mocks.isRightRailOpen = true;
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

  it("uses canonical copy and composer controls while Agent Builder is open", () => {
    const activeSession = {
      id: "session-1",
      title: "Build agent",
      createdAt: "2026-05-27T00:00:00.000Z",
      updatedAt: "2026-05-27T00:00:00.000Z",
      messageCount: 0,
      intent: "build-agent",
      agentBuilderOpen: true,
      targetAgentPath: "/Users/test/.agents/agents/draft.md",
      targetAgentSlug: "draft",
    } satisfies ChatSession;
    mocks.useChatSessionController.mockReturnValue({
      ...mocks.useChatSessionController(),
      messages: [],
    });

    render(<ChatView sessionId="session-1" activeSession={activeSession} />);

    expect(screen.getByText("emptyState.startAConversation")).toBeTruthy();
    const chatInputProps = mocks.chatInputSpy.mock.calls.at(-1)?.[0] as {
      placeholder?: string;
      controls?: unknown;
    };
    expect(chatInputProps.placeholder).toBeUndefined();
    expect(chatInputProps.controls).toEqual({ skills: false });
  });

  it("passes runnable shell commands through to the terminal runner for a non-git working dir", async () => {
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
    // The docked terminal opens collapsed for one entering frame, then
    // settles expanded once the open animation starts.
    await waitFor(() =>
      expect(terminalPanel).toHaveAttribute("data-collapsed", "false"),
    );
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

  it("opens a closed right rail when activating a terminal docked there", async () => {
    window.localStorage.setItem(
      terminalStorageKey,
      JSON.stringify({
        tabs: [{ id: "tab-1", cwd: "/Users/test/repo" }],
        activeTabId: "tab-1",
        expanded: false,
        placement: {
          kind: "docked",
          region: "rightRail",
          slot: "belowContext",
          size: { height: 300 },
        },
      }),
    );
    const activeSession = chatSessionWithWorkingDir("/Users/test/repo");
    render(<ChatView sessionId="session-1" activeSession={activeSession} />);

    await userEvent.click(
      screen.getByRole("button", { name: "toggle terminal" }),
    );

    expect(mocks.setRightRailOpen).toHaveBeenCalledWith(true);
    expect(readPersistedTerminalState().placement).toMatchObject({
      kind: "docked",
      region: "rightRail",
    });
  });

  it("persists terminal tabs for the chat session", async () => {
    const user = userEvent.setup();
    const activeSession = chatSessionWithWorkingDir("/Users/test/repo");

    const { unmount } = render(
      <ChatView sessionId="session-1" activeSession={activeSession} />,
    );

    await user.click(screen.getByRole("button", { name: "toggle terminal" }));
    await screen.findByTestId("terminal-panel");
    await waitFor(() =>
      expect(screen.getByTestId("terminal-panel")).toHaveAttribute(
        "data-collapsed",
        "false",
      ),
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

    await screen.findByTestId("terminal-panel");
    await waitFor(() =>
      expect(screen.getByTestId("terminal-panel")).toHaveAttribute(
        "data-collapsed",
        "false",
      ),
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

  it("does not auto-focus the terminal when restoring an already-open one", async () => {
    window.localStorage.setItem(
      terminalStorageKey,
      JSON.stringify({
        tabs: [{ id: "tab-1", cwd: "/Users/test/repo" }],
        activeTabId: "tab-1",
        expanded: true,
      }),
    );
    const activeSession = chatSessionWithWorkingDir("/Users/test/repo");

    render(<ChatView sessionId="session-1" activeSession={activeSession} />);

    // focusRequest stays at its initial 0 so reload does not steal focus.
    expect(await screen.findByTestId("terminal-panel")).toHaveAttribute(
      "data-focus-request",
      "0",
    );
  });

  it("requests terminal focus when opening the terminal", async () => {
    const user = userEvent.setup();
    const activeSession = chatSessionWithWorkingDir("/Users/test/repo");

    render(<ChatView sessionId="session-1" activeSession={activeSession} />);

    await user.click(screen.getByRole("button", { name: "toggle terminal" }));

    const panel = await screen.findByTestId("terminal-panel");
    // The docked terminal opens collapsed for one entering frame, then
    // settles expanded once the open animation starts.
    await waitFor(() =>
      expect(panel).toHaveAttribute("data-collapsed", "false"),
    );
    // A user-initiated open bumps focusRequest above its initial 0.
    expect(panel.getAttribute("data-focus-request")).not.toBe("0");
  });

  it("returns focus to the chat composer when collapsing the terminal", async () => {
    const user = userEvent.setup();
    const activeSession = chatSessionWithWorkingDir("/Users/test/repo");

    render(<ChatView sessionId="session-1" activeSession={activeSession} />);

    await user.click(screen.getByRole("button", { name: "toggle terminal" }));
    expect(await screen.findByTestId("terminal-panel")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "terminal.collapse" }));

    expect(screen.getByTestId("chat-composer")).toHaveFocus();
  });

  it("returns focus to the chat composer when closing the last terminal tab", async () => {
    const user = userEvent.setup();
    const activeSession = chatSessionWithWorkingDir("/Users/test/repo");

    render(<ChatView sessionId="session-1" activeSession={activeSession} />);

    await user.click(screen.getByRole("button", { name: "toggle terminal" }));
    expect(await screen.findByTestId("terminal-panel")).toBeInTheDocument();

    await user.click(
      screen.getByRole("button", { name: "terminal.stopAndCloseTab" }),
    );
    await user.click(screen.getByRole("button", { name: "terminal.stop" }));

    expect(screen.queryByTestId("terminal-panel")).not.toBeInTheDocument();
    expect(screen.getByTestId("chat-composer")).toHaveFocus();
  });

  it("does not steal focus when the last terminal exits on its own", async () => {
    const user = userEvent.setup();
    const activeSession = chatSessionWithWorkingDir("/Users/test/repo");

    render(<ChatView sessionId="session-1" activeSession={activeSession} />);

    await user.click(screen.getByRole("button", { name: "toggle terminal" }));
    const sessionKey = (
      await screen.findByTestId("terminal-panel")
    ).getAttribute("data-session-key");
    if (!sessionKey) {
      throw new Error("expected active terminal session key");
    }

    // Move focus somewhere other than the composer, then let the shell exit
    // on its own (backend-exit, not a user close).
    const toggleButton = screen.getByRole("button", {
      name: "toggle terminal",
    });
    toggleButton.focus();

    act(() => emitTerminalStatus(sessionKey));

    expect(screen.queryByTestId("terminal-panel")).not.toBeInTheDocument();
    // A background exit must not yank focus to the composer.
    expect(screen.getByTestId("chat-composer")).not.toHaveFocus();
    expect(toggleButton).toHaveFocus();
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

  it("pops the terminal out and docks it back without changing the running tab", async () => {
    const user = userEvent.setup();
    const activeSession = chatSessionWithWorkingDir("/Users/test/repo");

    render(<ChatView sessionId="session-1" activeSession={activeSession} />);

    await user.click(screen.getByRole("button", { name: "toggle terminal" }));
    const sessionKey = screen
      .getByTestId("terminal-panel")
      .getAttribute("data-session-key");

    await user.click(screen.getByRole("button", { name: "terminal.popOut" }));

    expect(screen.getByTestId("terminal-panel")).toHaveAttribute(
      "data-session-key",
      sessionKey,
    );
    expect(
      screen.getByRole("button", { name: "terminal.dockToBottom" }),
    ).toBeInTheDocument();
    expect(readPersistedTerminalState()).toMatchObject({
      placement: { kind: "floating" },
    });

    await user.click(
      screen.getByRole("button", { name: "terminal.dockToBottom" }),
    );

    expect(screen.getByTestId("terminal-panel")).toHaveAttribute(
      "data-session-key",
      sessionKey,
    );
    expect(
      screen.getByRole("button", { name: "terminal.popOut" }),
    ).toBeInTheDocument();
    expect(readPersistedTerminalState()).toMatchObject({
      placement: { kind: "docked" },
    });
  });

  it("pops the docked terminal out when dragging the header upward", async () => {
    const user = userEvent.setup();
    const activeSession = chatSessionWithWorkingDir("/Users/test/repo");

    render(<ChatView sessionId="session-1" activeSession={activeSession} />);

    await user.click(screen.getByRole("button", { name: "toggle terminal" }));
    const sessionKey = screen
      .getByTestId("terminal-panel")
      .getAttribute("data-session-key");
    const header = screen.getByRole("toolbar", { name: "terminal.title" });

    fireEvent(
      header,
      new MouseEvent("pointerdown", {
        bubbles: true,
        button: 0,
        clientX: 100,
        clientY: 500,
      }),
    );
    fireEvent(
      window,
      new MouseEvent("pointermove", {
        bubbles: true,
        clientX: 120,
        clientY: 450,
      }),
    );
    fireEvent(window, new MouseEvent("pointerup", { bubbles: true }));

    await waitFor(() =>
      expect(readPersistedTerminalState()).toMatchObject({
        placement: { kind: "floating" },
      }),
    );
    expect(screen.getByTestId("terminal-panel")).toHaveAttribute(
      "data-session-key",
      sessionKey,
    );
  });

  it("docks the floating terminal when dragging the header to the dock zone", async () => {
    const user = userEvent.setup();
    const activeSession = chatSessionWithWorkingDir("/Users/test/repo");
    const getBoundingClientRectSpy = vi
      .spyOn(HTMLElement.prototype, "getBoundingClientRect")
      .mockImplementation(function (this: HTMLElement) {
        if (this.hasAttribute("data-chat-column")) {
          return createDomRect({ left: 0, top: 0, width: 640, height: 800 });
        }
        return createDomRect({ left: 0, top: 0, width: 300, height: 300 });
      });

    render(<ChatView sessionId="session-1" activeSession={activeSession} />);

    await user.click(screen.getByRole("button", { name: "toggle terminal" }));
    await user.click(screen.getByRole("button", { name: "terminal.popOut" }));
    expect(readPersistedTerminalState()).toMatchObject({
      placement: { kind: "floating" },
    });

    const header = screen.getByRole("toolbar", { name: "terminal.title" });
    const dockY = window.innerHeight - 8;
    fireEvent(
      header,
      new MouseEvent("pointerdown", {
        bubbles: true,
        button: 0,
        clientX: 100,
        clientY: 100,
      }),
    );
    fireEvent(
      window,
      new MouseEvent("pointermove", {
        bubbles: true,
        clientX: 100,
        clientY: dockY,
      }),
    );
    expect(document.querySelector("[data-terminal-dock-preview]")).toBeTruthy();
    fireEvent(
      window,
      new MouseEvent("pointerup", { bubbles: true, clientY: dockY }),
    );

    await waitFor(() =>
      expect(readPersistedTerminalState()).toMatchObject({
        placement: { kind: "docked" },
      }),
    );
    expect(
      document.querySelector("[data-terminal-dock-preview]"),
    ).not.toBeInTheDocument();
    getBoundingClientRectSpy.mockRestore();
  });

  it("does not preview the bottom dock when dragging outside the chat column", async () => {
    const user = userEvent.setup();
    const activeSession = chatSessionWithWorkingDir("/Users/test/repo");
    const getBoundingClientRectSpy = vi
      .spyOn(HTMLElement.prototype, "getBoundingClientRect")
      .mockImplementation(function (this: HTMLElement) {
        if (this.hasAttribute("data-chat-column")) {
          return createDomRect({ left: 0, top: 0, width: 640, height: 800 });
        }
        return createDomRect({ left: 0, top: 0, width: 300, height: 300 });
      });

    render(<ChatView sessionId="session-1" activeSession={activeSession} />);

    await user.click(screen.getByRole("button", { name: "toggle terminal" }));
    await user.click(screen.getByRole("button", { name: "terminal.popOut" }));

    const header = screen.getByRole("toolbar", { name: "terminal.title" });
    const dockY = window.innerHeight - 8;
    fireEvent(
      header,
      new MouseEvent("pointerdown", {
        bubbles: true,
        button: 0,
        clientX: 100,
        clientY: 100,
      }),
    );
    fireEvent(
      window,
      new MouseEvent("pointermove", {
        bubbles: true,
        clientX: 700,
        clientY: dockY,
      }),
    );

    expect(
      document.querySelector("[data-terminal-dock-preview]"),
    ).not.toBeInTheDocument();
    fireEvent(
      window,
      new MouseEvent("pointerup", {
        bubbles: true,
        clientX: 700,
        clientY: dockY,
      }),
    );
    expect(readPersistedTerminalState()).toMatchObject({
      placement: { kind: "floating" },
    });
    getBoundingClientRectSpy.mockRestore();
  });

  it("resizes the docked terminal height from the top edge", async () => {
    const user = userEvent.setup();
    const activeSession = chatSessionWithWorkingDir("/Users/test/repo");

    render(<ChatView sessionId="session-1" activeSession={activeSession} />);

    await user.click(screen.getByRole("button", { name: "toggle terminal" }));
    const resizeHandle = document.querySelector<HTMLElement>(
      '[data-terminal-resize-edge="top"]',
    );
    if (!resizeHandle) {
      throw new Error("expected docked terminal resize handle");
    }

    const initialHeight = readPersistedTerminalState().placement?.size?.height;
    fireEvent(
      resizeHandle,
      new MouseEvent("pointerdown", {
        bubbles: true,
        button: 0,
        clientY: 300,
      }),
    );
    fireEvent(
      window,
      new MouseEvent("pointermove", {
        bubbles: true,
        clientY: 260,
      }),
    );
    fireEvent(window, new MouseEvent("pointerup", { bubbles: true }));

    await waitFor(() =>
      expect(readPersistedTerminalState().placement?.size?.height).toBe(
        (initialHeight ?? 300) + 40,
      ),
    );
  });

  it("renders resize handles when the terminal is floating", async () => {
    const user = userEvent.setup();
    const activeSession = chatSessionWithWorkingDir("/Users/test/repo");

    render(<ChatView sessionId="session-1" activeSession={activeSession} />);

    await user.click(screen.getByRole("button", { name: "toggle terminal" }));
    await user.click(screen.getByRole("button", { name: "terminal.popOut" }));

    expect(readPersistedTerminalState().placement?.rect).toMatchObject({
      height: expect.any(Number),
      width: expect.any(Number),
      x: expect.any(Number),
      y: expect.any(Number),
    });
    expect(
      screen.getAllByRole("button", { name: "terminal.resize" }),
    ).toHaveLength(8);
    expect(
      document.querySelector('[data-terminal-resize-edge="bottom-right"]'),
    ).toBeTruthy();
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

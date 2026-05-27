import type { ReactNode } from "react";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  TopBarActionsProvider,
  useTopBarActions,
} from "@/app/contexts/TopBarActionsContext";
import { ChatView } from "../ChatView";

const mocks = vi.hoisted(() => ({
  messageTimelineSpy: vi.fn(),
  chatInputSpy: vi.fn(),
  handleSend: vi.fn(() => true),
  pinToHome: vi.fn(),
  unpinFromHome: vi.fn(),
  t: vi.fn((key: string) => key),
  useChatSessionController: vi.fn(),
  usePinToHomeWidget: vi.fn(),
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
  ChatRightRail: () => null,
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
      isContextPanelOpen: false,
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

describe("ChatView MCP app messaging", () => {
  beforeEach(() => {
    mocks.messageTimelineSpy.mockClear();
    mocks.chatInputSpy.mockClear();
    mocks.handleSend.mockClear();
    mocks.pinToHome.mockClear();
    mocks.unpinFromHome.mockClear();
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

    // The composer lives inside the timeline as a sticky footer, so the
    // timeline always renders and the composer never remounts between states.
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
});

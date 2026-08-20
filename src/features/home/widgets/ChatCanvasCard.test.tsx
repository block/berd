import { fireEvent, render, screen } from "@testing-library/react";
import { useEffect, type ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useChatStore } from "@/features/chat/stores/chatStore";
import { useProjectStore } from "@/features/projects/stores/projectStore";
import type { Message } from "@/shared/types/messages";
import { ChatCanvasCard } from "./ChatCanvasCard";

const mocks = vi.hoisted(() => ({
  bind: vi.fn(() => ({ binding: true })),
  composer: vi.fn(() => (
    <textarea data-testid="canvas-composer" aria-label="Message" />
  )),
  chatState: "idle" as "idle" | "streaming",
  messages: [] as Message[],
  isLoadingHistory: false,
  transcriptMounts: 0,
  transcriptUnmounts: 0,
  transcriptProps: undefined as undefined | Record<string, unknown>,
}));

vi.mock("@/features/chat/capabilities/ConversationComposerCapability", () => ({
  useConversationComposerBinding: mocks.bind,
  ConversationComposerCapability: mocks.composer,
}));

vi.mock("@/features/chat/hooks/useChatTranscriptReadModel", () => ({
  useChatTranscriptReadModel: () => ({
    messages: mocks.messages,
    isLoadingHistory: mocks.isLoadingHistory,
    selectedPersona: undefined,
    sessionArtifactCwd: undefined,
    runtime: { chatState: mocks.chatState, streamingMessageId: null },
  }),
}));

vi.mock("@/features/chat/ui/ChatTranscriptSurface", () => ({
  ChatTranscriptSurface: (props: Record<string, unknown>) => {
    mocks.transcriptProps = props;
    useEffect(() => {
      mocks.transcriptMounts += 1;
      return () => {
        mocks.transcriptUnmounts += 1;
      };
    }, []);
    return (
      <div data-testid="transcript" className="min-h-0 flex-1 overflow-y-auto">
        {props.startContent as ReactNode}
      </div>
    );
  },
}));

const session = {
  id: "canvas-session",
  title: "Canvas chat",
  createdAt: "2026-08-20T00:00:00.000Z",
  updatedAt: "2026-08-20T00:00:00.000Z",
  messageCount: 1,
};

function renderCard(
  isFocused: boolean,
  onFocus = vi.fn(),
  onOpenFullChat = vi.fn(),
) {
  return render(
    <ChatCanvasCard
      session={session}
      isFocused={isFocused}
      onFocus={onFocus}
      onCollapse={vi.fn()}
      onOpenFullChat={onOpenFullChat}
    />,
  );
}

describe("ChatCanvasCard focus", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.chatState = "idle";
    mocks.messages = [];
    mocks.isLoadingHistory = false;
    mocks.transcriptMounts = 0;
    mocks.transcriptUnmounts = 0;
    mocks.transcriptProps = undefined;
    useChatStore.setState({ sessionStateById: {} });
    useProjectStore.setState({ projects: [] });
  });

  it("keeps focus behavioral without adding a visible outline", () => {
    renderCard(true);

    const card = screen.getByRole("region", { name: "Canvas chat" });
    expect(card).toHaveAttribute("data-canvas-chat-focused", "true");
    expect(card).toHaveClass("cursor-default");
    expect(card).not.toHaveClass("ring-2", "ring-ring", "ring-inset");
    expect(
      card.querySelector("[data-home-widget-drag-handle='true']"),
    ).toHaveClass("cursor-grab", "active:cursor-grabbing");
    expect(screen.getByTestId("transcript").parentElement).toHaveClass(
      "cursor-text",
    );
  });

  it("keeps the mounted transcript while history and live messages update", () => {
    const { rerender } = renderCard(false);
    const transcript = screen.getByTestId("transcript");

    mocks.messages = [
      {
        id: "hydrated-message",
        role: "user",
        created: 1,
        content: [{ type: "text", text: "Hydrated" }],
      },
    ];
    mocks.isLoadingHistory = true;
    rerender(
      <ChatCanvasCard
        session={session}
        isFocused
        onCollapse={vi.fn()}
        onOpenFullChat={vi.fn()}
      />,
    );

    expect(screen.getByTestId("transcript")).toBe(transcript);
    expect(mocks.transcriptMounts).toBe(1);
    expect(mocks.transcriptUnmounts).toBe(0);
  });

  it("keeps compact chat layout variables local without a density cascade", () => {
    renderCard(false);
    const card = screen.getByRole("region", { name: "Canvas chat" });

    expect(card).not.toHaveClass("canvas-chat-density");
    expect(card).not.toHaveAttribute("data-canvas-chat-density");
    expect(card).toHaveClass(
      "[--chat-transcript-inline-padding:0.75rem]",
      "[--chat-transcript-max-width:100%]",
      "[--chat-transcript-container-max-width:100%]",
      "[--chat-user-message-max-width:85%]",
      "[--chat-composer-max-width:100%]",
    );
  });

  it("keeps the transcript footerless and owns one always-visible composer sibling", () => {
    renderCard(false);

    const transcript = screen.getByTestId("transcript");
    const transcriptRegion = transcript.parentElement;
    const composerSurface = screen.getByTestId("canvas-composer").parentElement;

    expect(mocks.transcriptProps).not.toHaveProperty("footer");
    expect(mocks.transcriptProps).toMatchObject({
      rendererPolicy: "classic",
    });
    expect(
      screen.queryByTestId("message-timeline-footer"),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByTestId("message-timeline-surface"),
    ).not.toBeInTheDocument();
    expect(composerSurface).toBe(transcriptRegion?.nextElementSibling);
    expect(composerSurface).toHaveClass("shrink-0");
    expect(screen.getAllByTestId("canvas-composer")).toHaveLength(1);
  });

  it("shows the history boundary only when complete older exchanges are omitted", () => {
    mocks.messages = Array.from({ length: 11 }, (_, index) => [
      {
        id: `user-${index + 1}`,
        role: "user" as const,
        created: index * 2,
        content: [{ type: "text" as const, text: `Question ${index + 1}` }],
        metadata: { userVisible: true },
      },
      {
        id: `assistant-${index + 1}`,
        role: "assistant" as const,
        created: index * 2 + 1,
        content: [{ type: "text" as const, text: `Answer ${index + 1}` }],
        metadata: { userVisible: true },
      },
    ]).flat();

    renderCard(false);

    expect(
      screen.getByText("Earlier messages are available in full chat"),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Open full chat" }),
    ).toBeVisible();
    expect(
      (mocks.transcriptProps?.messages as Message[]).filter(
        (message) => message.role === "user",
      ),
    ).toHaveLength(10);
  });

  it("uses the same session navigation for the boundary action", () => {
    const onOpenFullChat = vi.fn();
    mocks.messages = Array.from({ length: 11 }, (_, index) => [
      {
        id: `user-${index + 1}`,
        role: "user" as const,
        created: index * 2,
        content: [{ type: "text" as const, text: `Question ${index + 1}` }],
      },
      {
        id: `assistant-${index + 1}`,
        role: "assistant" as const,
        created: index * 2 + 1,
        content: [{ type: "text" as const, text: `Answer ${index + 1}` }],
      },
    ]).flat();
    renderCard(false, vi.fn(), onOpenFullChat);

    fireEvent.click(screen.getByRole("button", { name: "Open full chat" }));

    expect(onOpenFullChat).toHaveBeenCalledTimes(1);
  });

  it("does not show a history boundary when all exchanges fit", () => {
    mocks.messages = [
      {
        id: "user-1",
        role: "user",
        created: 1,
        content: [{ type: "text", text: "Question" }],
      },
    ];

    renderCard(false);

    expect(
      screen.queryByText("Earlier messages are available in full chat"),
    ).not.toBeInTheDocument();
  });

  it("keeps the unfocused transcript and composer visible without marking read", () => {
    useChatStore.getState().markSessionUnread(session.id);
    renderCard(false);

    expect(screen.getByTestId("transcript")).toBeInTheDocument();
    expect(screen.getByTestId("canvas-composer")).toBeInTheDocument();
    expect(
      useChatStore.getState().getSessionRuntime(session.id).hasUnread,
    ).toBe(true);
    expect(mocks.bind).toHaveBeenCalledTimes(1);
  });

  it("commits focus and read only from a classified transcript click", () => {
    const onFocus = vi.fn();
    useChatStore.getState().markSessionUnread(session.id);
    renderCard(false, onFocus);
    const region = screen.getByRole("region", { name: "Canvas chat" });
    const transcript = screen.getByTestId("transcript");

    fireEvent.mouseDown(region);
    fireEvent.pointerDown(transcript);
    expect(onFocus).not.toHaveBeenCalled();
    expect(
      useChatStore.getState().getSessionRuntime(session.id).hasUnread,
    ).toBe(true);

    fireEvent.click(transcript);

    expect(onFocus).toHaveBeenCalledTimes(1);
    expect(
      useChatStore.getState().getSessionRuntime(session.id).hasUnread,
    ).toBe(false);
  });

  it("does not focus or mark read after drag classification or cancellation", () => {
    const onFocus = vi.fn();
    const shouldIgnoreActivation = vi.fn(() => true);
    useChatStore.getState().markSessionUnread(session.id);
    render(
      <ChatCanvasCard
        session={session}
        isFocused={false}
        onFocus={onFocus}
        shouldIgnoreActivation={shouldIgnoreActivation}
        onCollapse={vi.fn()}
        onOpenFullChat={vi.fn()}
      />,
    );
    const transcript = screen.getByTestId("transcript");

    fireEvent.pointerDown(transcript, {
      pointerId: 1,
      clientX: 10,
      clientY: 10,
    });
    fireEvent.pointerMove(transcript, {
      pointerId: 1,
      clientX: 40,
      clientY: 40,
    });
    fireEvent.pointerCancel(transcript, { pointerId: 1 });
    fireEvent.click(transcript);

    expect(shouldIgnoreActivation).toHaveBeenCalledTimes(1);
    expect(onFocus).not.toHaveBeenCalled();
    expect(
      useChatStore.getState().getSessionRuntime(session.id).hasUnread,
    ).toBe(true);
  });

  it("collapse and open-full-chat controls do not focus or mark read", () => {
    const onFocus = vi.fn();
    const onCollapse = vi.fn();
    const onOpenFullChat = vi.fn();
    useChatStore.getState().markSessionUnread(session.id);
    render(
      <ChatCanvasCard
        session={session}
        isFocused={false}
        onFocus={onFocus}
        onCollapse={onCollapse}
        onOpenFullChat={onOpenFullChat}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /collapse/i }));
    fireEvent.click(screen.getByRole("button", { name: /open/i }));

    expect(onCollapse).toHaveBeenCalledTimes(1);
    expect(onOpenFullChat).toHaveBeenCalledTimes(1);
    expect(onFocus).not.toHaveBeenCalled();
    expect(
      useChatStore.getState().getSessionRuntime(session.id).hasUnread,
    ).toBe(true);
  });

  it("keeps the shared existing-session composer mounted across focus changes", () => {
    const { rerender } = renderCard(true);

    const composer = screen.getByTestId("canvas-composer");
    expect(composer).toBeInTheDocument();
    expect(mocks.bind).toHaveBeenCalledWith(
      expect.objectContaining({
        target: expect.objectContaining({
          kind: "existingSession",
          sessionId: session.id,
          sessionSnapshot: session,
          readOnlyWhenOpenInAnotherWindow: true,
        }),
      }),
    );
    expect(mocks.composer).toHaveBeenCalledWith(
      expect.objectContaining({
        renderingPolicy: expect.objectContaining({
          allowedInteractions: {
            controls: expect.objectContaining({
              agentModelPicker: false,
              personaPicker: false,
              projectPicker: false,
            }),
          },
        }),
      }),
      undefined,
    );

    rerender(
      <ChatCanvasCard
        session={session}
        isFocused={false}
        onFocus={vi.fn()}
        onCollapse={vi.fn()}
        onOpenFullChat={vi.fn()}
      />,
    );
    expect(screen.getByTestId("canvas-composer")).toBe(composer);
  });

  it("focuses and marks read once when the unfocused composer is used by pointer", () => {
    const onFocus = vi.fn();
    useChatStore.getState().markSessionUnread(session.id);
    renderCard(false, onFocus);
    const composer = screen.getByTestId("canvas-composer");

    expect(onFocus).not.toHaveBeenCalled();
    expect(
      useChatStore.getState().getSessionRuntime(session.id).hasUnread,
    ).toBe(true);

    fireEvent.pointerDown(composer);
    fireEvent.focus(composer);
    fireEvent.click(composer);

    expect(onFocus).toHaveBeenCalledTimes(1);
    expect(
      useChatStore.getState().getSessionRuntime(session.id).hasUnread,
    ).toBe(false);
  });

  it("focuses and marks read when the composer receives keyboard focus", () => {
    const onFocus = vi.fn();
    useChatStore.getState().markSessionUnread(session.id);
    renderCard(false, onFocus);

    fireEvent.focus(screen.getByTestId("canvas-composer"));

    expect(onFocus).toHaveBeenCalledTimes(1);
    expect(
      useChatStore.getState().getSessionRuntime(session.id).hasUnread,
    ).toBe(false);
  });

  it("keeps transcript and composer interaction surfaces separate without adding a background", () => {
    renderCard(false);

    expect(screen.getByTestId("transcript")).toHaveClass("overflow-y-auto");
    expect(screen.getByTestId("transcript").parentElement).toHaveAttribute(
      "data-home-canvas-interactive",
      "true",
    );
    const composerSurface = screen.getByTestId("canvas-composer").parentElement;
    expect(composerSurface).toHaveAttribute(
      "data-home-canvas-interactive",
      "true",
    );
    expect(composerSurface).toHaveClass("shrink-0", "px-2", "pb-2");
    expect(composerSurface).not.toHaveClass(
      "rounded-sm",
      "bg-surface-chat-composer",
      "[backdrop-filter:var(--backdrop-composer-glass)]",
      "border-t",
    );
    expect(composerSurface?.parentElement).toBe(
      screen.getByRole("region", { name: "Canvas chat" }),
    );
  });

  it("renders the session project icon in the header", () => {
    useProjectStore.setState({
      projects: [
        {
          id: "project-1",
          path: "/projects/one",
          name: "Project one",
          description: "",
          prompt: "",
          icon: "tabler:brand-github",
          color: "#123456",
          projectWorkspaces: [],
          workingDirs: [],
          useWorktrees: false,
          order: 0,
          archivedAt: null,
        },
      ],
    });

    render(
      <ChatCanvasCard
        session={{ ...session, projectId: "project-1" }}
        isFocused={false}
        onCollapse={vi.fn()}
        onOpenFullChat={vi.fn()}
      />,
    );

    expect(
      screen
        .getByRole("region", { name: "Canvas chat" })
        .querySelector("header svg"),
    ).toBeInTheDocument();
  });
});

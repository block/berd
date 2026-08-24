import { screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderWithProviders } from "@/test/render";
import { TRANSCRIPT_VIRTUAL_RENDERER_EXPERIMENT_ID } from "@/features/experiments/experimentDefinitions";
import {
  EXPERIMENT_PREFERENCES_STORAGE_KEY,
  setExperimentEnabled,
} from "@/features/experiments/experimentPreferences";
import type { Message } from "@/shared/types/messages";
import { ChatCanvasCard } from "./ChatCanvasCard";

const assistantMessage: Message = {
  id: "assistant-1",
  role: "assistant",
  created: Date.UTC(2026, 7, 20, 12, 1, 0),
  content: [
    { type: "text", text: "I’ll inspect the canvas geometry first." },
    {
      type: "toolRequest",
      id: "tool-1",
      name: "Inspect canvas geometry",
      arguments: { surface: "canvas-card" },
      status: "completed",
    },
    {
      type: "toolResponse",
      id: "tool-1",
      name: "Inspect canvas geometry",
      result: "Transform found",
      isError: false,
    },
    { type: "text", text: "The assistant prose remains visible." },
  ],
  metadata: { userVisible: true },
};

const messages: Message[] = [
  {
    id: "user-1",
    role: "user",
    created: Date.UTC(2026, 7, 20, 12, 0, 0),
    content: [{ type: "text", text: "Why is prose disappearing?" }],
    metadata: { userVisible: true },
  },
  assistantMessage,
];

vi.mock("@/features/chat/capabilities/ConversationComposerCapability", () => ({
  useConversationComposerBinding: () => ({ binding: true }),
  ConversationComposerCapability: () => <textarea aria-label="Message" />,
}));

vi.mock("@/features/chat/hooks/useChatTranscriptReadModel", () => ({
  useChatTranscriptReadModel: () => ({
    messages,
    isLoadingHistory: false,
    selectedPersona: undefined,
    sessionArtifactCwd: undefined,
    runtime: { chatState: "streaming", streamingMessageId: "assistant-1" },
  }),
}));

const session = {
  id: "canvas-session",
  title: "Canvas chat",
  createdAt: "2026-08-20T00:00:00.000Z",
  updatedAt: "2026-08-20T00:00:00.000Z",
  messageCount: messages.length,
};

describe("ChatCanvasCard transcript renderer", () => {
  beforeEach(() => {
    localStorage.removeItem(EXPERIMENT_PREFERENCES_STORAGE_KEY);
    expect(
      setExperimentEnabled(TRANSCRIPT_VIRTUAL_RENDERER_EXPERIMENT_ID, true),
    ).toBe(true);

    class ResizeObserverMock {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
    vi.stubGlobal("ResizeObserver", ResizeObserverMock);
  });

  it("uses the classic transcript renderer inside the standard scaled widget path", async () => {
    renderWithProviders(
      <div style={{ transform: "scale(0.75)", height: 420, width: 480 }}>
        <ChatCanvasCard
          session={session}
          isFocused
          onCollapse={vi.fn()}
          onOpenFullChat={vi.fn()}
        />
      </div>,
    );

    await waitFor(() => {
      expect(
        screen.getByText("I’ll inspect the canvas geometry first."),
      ).toBeInTheDocument();
    });

    expect(
      screen.getByText("The assistant prose remains visible."),
    ).toBeInTheDocument();
    expect(screen.getByText("Inspect canvas geometry")).toBeInTheDocument();
    const timeline = screen.getByTestId("message-timeline-scroll");
    const composer = screen.getByLabelText("Message");

    expect(timeline).toBeInTheDocument();
    expect(
      screen.queryByTestId("message-timeline-footer"),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByTestId("message-timeline-surface"),
    ).not.toBeInTheDocument();
    expect(composer).toBeInTheDocument();
    expect(composer.closest("[data-home-canvas-interactive='true']")).toBe(
      timeline.closest("[data-canvas-chat-activation='transcript']")
        ?.nextElementSibling,
    );
  });
});

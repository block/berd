import { render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { Message } from "@/shared/types/messages";
import { ChatCanvasCard } from "./ChatCanvasCard";

const LONG_HISTORY_EXCHANGE_COUNT = 120;

function longHistory(sessionId: string): Message[] {
  return Array.from({ length: LONG_HISTORY_EXCHANGE_COUNT }, (_, index) => [
    {
      id: `${sessionId}-user-${index + 1}`,
      role: "user" as const,
      created: index * 2,
      content: [
        { type: "text" as const, text: `${sessionId} question ${index + 1}` },
      ],
      metadata: { userVisible: true },
    },
    {
      id: `${sessionId}-assistant-${index + 1}`,
      role: "assistant" as const,
      created: index * 2 + 1,
      content: [
        {
          type: "toolRequest" as const,
          id: `${sessionId}-tool-${index + 1}`,
          name: "Inspect",
          arguments: { index },
          status: "completed" as const,
        },
        {
          type: "toolResponse" as const,
          id: `${sessionId}-tool-${index + 1}`,
          name: "Inspect",
          result: "done",
          isError: false,
        },
        { type: "text" as const, text: `${sessionId} answer ${index + 1}` },
      ],
      metadata: { userVisible: true },
    },
  ]).flat();
}

const histories = {
  "canvas-a": longHistory("canvas-a"),
  "canvas-b": longHistory("canvas-b"),
};

vi.mock("@/features/chat/capabilities/ConversationComposerCapability", () => ({
  useConversationComposerBinding: ({
    target,
  }: {
    target: { sessionId: string };
  }) => target,
  ConversationComposerCapability: ({
    binding,
  }: {
    binding: { sessionId: string };
  }) => <textarea aria-label={`Message ${binding.sessionId}`} />,
}));

vi.mock("@/features/chat/hooks/useChatTranscriptReadModel", () => ({
  useChatTranscriptReadModel: (sessionId: keyof typeof histories) => ({
    messages: histories[sessionId],
    isLoadingHistory: false,
    selectedPersona: undefined,
    sessionArtifactCwd: undefined,
    runtime: { chatState: "idle", streamingMessageId: null },
  }),
}));

function session(id: keyof typeof histories) {
  return {
    id,
    title: id,
    createdAt: "2026-08-20T00:00:00.000Z",
    updatedAt: "2026-08-20T00:00:00.000Z",
    messageCount: histories[id].length,
  };
}

describe("ChatCanvasCard multi-card bounded mounting", () => {
  it("mounts only 10 exchanges per card from two independent long histories", async () => {
    render(
      <div>
        <ChatCanvasCard
          session={session("canvas-a")}
          isFocused={false}
          onCollapse={vi.fn()}
          onOpenFullChat={vi.fn()}
        />
        <ChatCanvasCard
          session={session("canvas-b")}
          isFocused={false}
          onCollapse={vi.fn()}
          onOpenFullChat={vi.fn()}
        />
      </div>,
    );

    const cardA = screen.getByRole("region", { name: "canvas-a" });
    const cardB = screen.getByRole("region", { name: "canvas-b" });

    await waitFor(() => {
      expect(within(cardA).getByText("canvas-a question 111")).toBeVisible();
      expect(within(cardB).getByText("canvas-b question 111")).toBeVisible();
    });

    for (const card of [cardA, cardB]) {
      const mountedMessageIds = new Set(
        [...card.querySelectorAll("[data-transcript-message-id]")]
          .map((node) => node.getAttribute("data-transcript-message-id"))
          .filter(Boolean),
      );
      expect(
        [...mountedMessageIds].filter((id) => id?.includes("-user-")),
      ).toHaveLength(10);
      // Tool-heavy assistant messages may project to several rows, but the
      // mounted input remains bounded by the 10 selected exchanges.
      expect(mountedMessageIds.size).toBeLessThanOrEqual(30);
      expect(
        within(card).getByText("Earlier messages are available in full chat"),
      ).toBeVisible();
    }

    expect(within(cardA).queryByText("canvas-a question 110")).toBeNull();
    expect(within(cardB).queryByText("canvas-b question 110")).toBeNull();
    expect(screen.getByLabelText("Message canvas-a")).toBeVisible();
    expect(screen.getByLabelText("Message canvas-b")).toBeVisible();
  });
});

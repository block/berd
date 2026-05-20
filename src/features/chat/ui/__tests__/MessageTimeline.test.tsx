import { fireEvent, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { renderWithProviders } from "@/test/render";
import { MessageTimeline } from "../MessageTimeline";
import type { Message } from "@/shared/types/messages";

vi.mock("../MessageBubble", () => ({
  MessageBubble: ({
    message,
    isStreaming,
    onMcpAppAutoScroll,
  }: {
    message: Message;
    isStreaming?: boolean;
    onMcpAppAutoScroll?: (element: HTMLElement | null) => void;
  }) => (
    <div
      data-testid={`message-${message.id}`}
      data-streaming={isStreaming ? "true" : "false"}
    >
      {message.content
        .filter((block) => block.type === "text")
        .map((block) => block.text)
        .join("\n")}
      {message.content
        .filter((block) => block.type === "mcpApp")
        .map((block) => (
          <div
            key={block.id}
            data-testid={`mcp-app-${block.id}`}
            ref={(element) => onMcpAppAutoScroll?.(element)}
          />
        ))}
    </div>
  ),
}));

function message(id: string, role: Message["role"], text: string): Message {
  return {
    id,
    role,
    created: Date.UTC(2026, 4, 20, 12, 0, 0),
    content: [{ type: "text", text }],
    metadata: { userVisible: true },
  };
}

function mcpAppMessage(id: string): Message {
  return {
    id,
    role: "assistant",
    created: Date.UTC(2026, 4, 20, 12, 0, 0),
    content: [
      {
        type: "mcpApp",
        id: "mcp-app-1",
        payload: {
          sessionId: "session-1",
          toolCallId: "tool-1",
          toolCallTitle: "Preview",
          source: "toolCallUpdateMeta",
          tool: {
            name: "preview",
            extensionName: "goose",
            resourceUri: "ui://preview",
          },
          resource: {
            result: null,
          },
        },
      },
    ],
    metadata: { userVisible: true },
  };
}

function setScrollMetrics(
  element: HTMLElement,
  {
    scrollTop,
    scrollHeight = 1000,
    clientHeight = 500,
  }: {
    scrollTop: number;
    scrollHeight?: number;
    clientHeight?: number;
  },
) {
  Object.defineProperty(element, "scrollTop", {
    configurable: true,
    writable: true,
    value: scrollTop,
  });
  Object.defineProperty(element, "scrollHeight", {
    configurable: true,
    value: scrollHeight,
  });
  Object.defineProperty(element, "clientHeight", {
    configurable: true,
    value: clientHeight,
  });
}

function attachScrollTo(element: HTMLElement) {
  const scrollTo = vi.fn((options: ScrollToOptions) => {
    if (typeof options.top === "number") {
      element.scrollTop = options.top;
    }
  });
  Object.defineProperty(element, "scrollTo", {
    configurable: true,
    value: scrollTo,
  });
  return scrollTo;
}

describe("MessageTimeline", () => {
  it("keeps following streaming content while the user is near the bottom", async () => {
    const messages = [
      message("user-1", "user", "Question"),
      message("assistant-1", "assistant", "First token"),
    ];
    const { rerender } = renderWithProviders(
      <MessageTimeline messages={messages} streamingMessageId="assistant-1" />,
    );
    const log = screen.getByRole("log", { name: "Chat messages" });
    setScrollMetrics(log, { scrollTop: 450 });
    const scrollTo = attachScrollTo(log);
    scrollTo.mockClear();

    rerender(
      <MessageTimeline
        messages={[
          messages[0],
          message("assistant-1", "assistant", "First token\nSecond token"),
        ]}
        streamingMessageId="assistant-1"
      />,
    );

    await waitFor(() =>
      expect(scrollTo).toHaveBeenCalledWith({
        top: 1000,
        behavior: "smooth",
      }),
    );
  });

  it("lets the user detach from auto-scroll during generation", async () => {
    const user = userEvent.setup();
    const messages = [
      message("user-1", "user", "Question"),
      message("assistant-1", "assistant", "First token"),
    ];
    const { rerender } = renderWithProviders(
      <MessageTimeline messages={messages} streamingMessageId="assistant-1" />,
    );
    const log = screen.getByRole("log", { name: "Chat messages" });
    setScrollMetrics(log, { scrollTop: 450 });
    const scrollTo = attachScrollTo(log);

    fireEvent.wheel(log, { deltaY: -120 });
    log.scrollTop = 100;
    fireEvent.scroll(log);

    expect(
      await screen.findByRole("button", { name: "Jump to latest" }),
    ).toBeInTheDocument();
    scrollTo.mockClear();

    rerender(
      <MessageTimeline
        messages={[
          messages[0],
          message("assistant-1", "assistant", "First token\nSecond token"),
        ]}
        streamingMessageId="assistant-1"
      />,
    );

    expect(scrollTo).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "Jump to latest" }));

    expect(scrollTo).toHaveBeenCalledWith({
      top: 1000,
      behavior: "smooth",
    });
  });

  it("detaches immediately when the user wheels upward near the bottom", async () => {
    const messages = [
      message("user-1", "user", "Question"),
      message("assistant-1", "assistant", "First token"),
    ];
    const { rerender } = renderWithProviders(
      <MessageTimeline messages={messages} streamingMessageId="assistant-1" />,
    );
    const log = screen.getByRole("log", { name: "Chat messages" });
    setScrollMetrics(log, { scrollTop: 450 });
    const scrollTo = attachScrollTo(log);

    fireEvent.wheel(log, { deltaY: -40 });

    expect(
      await screen.findByRole("button", { name: "Jump to latest" }),
    ).toBeInTheDocument();
    scrollTo.mockClear();

    rerender(
      <MessageTimeline
        messages={[
          messages[0],
          message("assistant-1", "assistant", "First token\nSecond token"),
        ]}
        streamingMessageId="assistant-1"
      />,
    );

    expect(scrollTo).not.toHaveBeenCalled();
  });

  it("does not run sticky MCP app auto-scroll while detached", async () => {
    const messages = [
      message("user-1", "user", "Question"),
      message("assistant-1", "assistant", "First token"),
    ];
    const { rerender } = renderWithProviders(
      <MessageTimeline messages={messages} streamingMessageId="assistant-1" />,
    );
    const log = screen.getByRole("log", { name: "Chat messages" });
    setScrollMetrics(log, { scrollTop: 450 });
    const scrollTo = attachScrollTo(log);

    fireEvent.wheel(log, { deltaY: -40 });

    expect(
      await screen.findByRole("button", { name: "Jump to latest" }),
    ).toBeInTheDocument();
    scrollTo.mockClear();

    rerender(
      <MessageTimeline
        messages={[messages[0], mcpAppMessage("assistant-1")]}
        streamingMessageId="assistant-1"
      />,
    );

    expect(scrollTo).not.toHaveBeenCalled();
  });

  it("resumes pinned behavior when a new user message becomes latest", async () => {
    const messages = [
      message("user-1", "user", "Question"),
      message("assistant-1", "assistant", "Answer"),
    ];
    const { rerender } = renderWithProviders(
      <MessageTimeline messages={messages} streamingMessageId="assistant-1" />,
    );
    const log = screen.getByRole("log", { name: "Chat messages" });
    setScrollMetrics(log, { scrollTop: 450 });
    const scrollTo = attachScrollTo(log);

    fireEvent.wheel(log, { deltaY: -120 });
    log.scrollTop = 100;
    fireEvent.scroll(log);

    expect(
      await screen.findByRole("button", { name: "Jump to latest" }),
    ).toBeInTheDocument();
    scrollTo.mockClear();

    rerender(
      <MessageTimeline
        messages={[...messages, message("user-2", "user", "Follow-up")]}
      />,
    );

    await waitFor(() =>
      expect(
        screen.queryByRole("button", { name: "Jump to latest" }),
      ).not.toBeInTheDocument(),
    );
    expect(scrollTo).toHaveBeenCalledWith({
      top: 1000,
      behavior: "auto",
    });
  });
});

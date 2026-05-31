import { fireEvent, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderWithProviders } from "@/test/render";
import { MessageTimeline } from "../MessageTimeline";
import type { Message } from "@/shared/types/messages";

const resizeObserverCallbacks: ResizeObserverCallback[] = [];

class ResizeObserverMock {
  constructor(callback: ResizeObserverCallback) {
    resizeObserverCallbacks.push(callback);
  }

  observe = vi.fn();
  unobserve = vi.fn();
  disconnect = vi.fn();
}

function triggerResizeObservers() {
  for (const callback of resizeObserverCallbacks) {
    callback([], {} as ResizeObserver);
  }
}

beforeEach(() => {
  resizeObserverCallbacks.length = 0;
  Object.defineProperty(globalThis, "ResizeObserver", {
    configurable: true,
    writable: true,
    value: ResizeObserverMock,
  });
});

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
            ref={(element) => {
              if (element) {
                Object.defineProperty(element, "getBoundingClientRect", {
                  configurable: true,
                  value: () => ({
                    bottom: 460,
                    height: 0,
                    left: 0,
                    right: 0,
                    top: 0,
                    width: 0,
                    x: 0,
                    y: 0,
                    toJSON: () => ({}),
                  }),
                });
              }
              onMcpAppAutoScroll?.(element);
            }}
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

function setElementRect(element: HTMLElement, rect: Partial<DOMRectReadOnly>) {
  Object.defineProperty(element, "getBoundingClientRect", {
    configurable: true,
    value: () => ({
      bottom: 0,
      height: 0,
      left: 0,
      right: 0,
      top: 0,
      width: 0,
      x: 0,
      y: 0,
      toJSON: () => ({}),
      ...rect,
    }),
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

function attachScrollBy(element: HTMLElement) {
  const scrollBy = vi.fn((options: ScrollToOptions) => {
    if (typeof options.top === "number") {
      element.scrollTop += options.top;
    }
  });
  Object.defineProperty(element, "scrollBy", {
    configurable: true,
    value: scrollBy,
  });
  return scrollBy;
}

function getTimelineScroller() {
  return screen.getByTestId("message-timeline-scroll");
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
    const scroller = getTimelineScroller();
    setScrollMetrics(scroller, { scrollTop: 450 });
    const scrollTo = attachScrollTo(scroller);
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
    const scroller = getTimelineScroller();
    setScrollMetrics(scroller, { scrollTop: 450 });
    const scrollTo = attachScrollTo(scroller);

    fireEvent.wheel(scroller, { deltaY: -120 });
    scroller.scrollTop = 100;
    fireEvent.scroll(scroller);

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
    const scroller = getTimelineScroller();
    setScrollMetrics(scroller, { scrollTop: 450 });
    const scrollTo = attachScrollTo(scroller);

    fireEvent.wheel(scroller, { deltaY: -40 });

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

  it("collapses Jump to latest to an icon button when footer status is visible", async () => {
    const messages = [
      message("user-1", "user", "Question"),
      message("assistant-1", "assistant", "First token"),
    ];
    renderWithProviders(
      <MessageTimeline
        messages={messages}
        streamingMessageId="assistant-1"
        footer={<div data-testid="composer-footer" />}
        footerStatus={<div>Responding...</div>}
      />,
    );
    const scroller = getTimelineScroller();
    setScrollMetrics(scroller, { scrollTop: 450 });

    fireEvent.wheel(scroller, { deltaY: -40 });

    expect(await screen.findByText("Responding...")).toBeInTheDocument();
    const jumpButton = await screen.findByRole("button", {
      name: "Jump to latest",
    });
    expect(jumpButton).toHaveClass("h-8", "w-8");
    expect(screen.queryByText("Jump to latest")).not.toBeInTheDocument();
  });

  it("does not run sticky MCP app auto-scroll while detached", async () => {
    const messages = [
      message("user-1", "user", "Question"),
      message("assistant-1", "assistant", "First token"),
    ];
    const { rerender } = renderWithProviders(
      <MessageTimeline messages={messages} streamingMessageId="assistant-1" />,
    );
    const scroller = getTimelineScroller();
    setScrollMetrics(scroller, { scrollTop: 450 });
    const scrollTo = attachScrollTo(scroller);

    fireEvent.wheel(scroller, { deltaY: -40 });

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
    const scroller = getTimelineScroller();
    setScrollMetrics(scroller, { scrollTop: 450 });
    const scrollTo = attachScrollTo(scroller);

    fireEvent.wheel(scroller, { deltaY: -120 });
    scroller.scrollTop = 100;
    fireEvent.scroll(scroller);

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

  it("keeps manual scroll position stable when the viewport gets shorter", () => {
    const messages = [
      message("user-1", "user", "Question"),
      message("assistant-1", "assistant", "Answer"),
    ];
    renderWithProviders(<MessageTimeline messages={messages} />);
    const scroller = getTimelineScroller();

    setScrollMetrics(scroller, {
      scrollTop: 260,
      scrollHeight: 1200,
      clientHeight: 500,
    });
    fireEvent.scroll(scroller);

    setScrollMetrics(scroller, {
      scrollTop: 260,
      scrollHeight: 1200,
      clientHeight: 300,
    });
    triggerResizeObservers();

    expect(scroller.scrollTop).toBe(260);
  });

  it("does not snap manual near-bottom scrolling to latest when footer controls collapse", async () => {
    const messages = [
      message("user-1", "user", "Question"),
      message("assistant-1", "assistant", "Answer"),
    ];
    renderWithProviders(
      <MessageTimeline
        messages={messages}
        footer={<div data-testid="composer-footer" />}
      />,
    );
    const scroller = getTimelineScroller();
    const scrollTo = attachScrollTo(scroller);

    fireEvent.wheel(scroller, { deltaY: -40 });
    setScrollMetrics(scroller, {
      scrollTop: 300,
      scrollHeight: 1000,
      clientHeight: 500,
    });
    fireEvent.scroll(scroller);

    expect(
      await screen.findByRole("button", { name: "Jump to latest" }),
    ).toBeInTheDocument();
    scrollTo.mockClear();

    fireEvent.wheel(scroller, { deltaY: 80 });
    setScrollMetrics(scroller, {
      scrollTop: 730,
      scrollHeight: 1000,
      clientHeight: 200,
    });
    fireEvent.scroll(scroller);

    await waitFor(() =>
      expect(
        screen.queryByRole("button", { name: "Jump to latest" }),
      ).not.toBeInTheDocument(),
    );
    triggerResizeObservers();

    expect(scrollTo).not.toHaveBeenCalled();
    expect(scroller.scrollTop).toBe(730);
  });

  it("keeps users pinned to latest when the viewport gets shorter", () => {
    const messages = [
      message("user-1", "user", "Question"),
      message("assistant-1", "assistant", "Answer"),
    ];
    renderWithProviders(<MessageTimeline messages={messages} />);
    const scroller = getTimelineScroller();
    const scrollTo = attachScrollTo(scroller);

    setScrollMetrics(scroller, {
      scrollTop: 500,
      scrollHeight: 1000,
      clientHeight: 500,
    });
    fireEvent.scroll(scroller);
    scrollTo.mockClear();

    setScrollMetrics(scroller, {
      scrollTop: 500,
      scrollHeight: 1000,
      clientHeight: 300,
    });
    triggerResizeObservers();

    expect(scrollTo).toHaveBeenCalledWith({
      top: 1000,
      behavior: "auto",
    });
  });

  it("keeps MCP app auto-scroll above the floating footer", async () => {
    const messages = [
      message("user-1", "user", "Question"),
      message("assistant-1", "assistant", "First token"),
    ];
    const { rerender } = renderWithProviders(
      <MessageTimeline
        messages={messages}
        footer={<div data-testid="composer-footer" />}
      />,
    );
    const scroller = getTimelineScroller();
    setScrollMetrics(scroller, { scrollTop: 450 });
    setElementRect(scroller, { bottom: 500 });
    setElementRect(screen.getByTestId("message-timeline-footer"), {
      top: 400,
    });
    const scrollBy = attachScrollBy(scroller);

    rerender(
      <MessageTimeline
        messages={[messages[0], mcpAppMessage("assistant-1")]}
        footer={<div data-testid="composer-footer" />}
      />,
    );

    await waitFor(() =>
      expect(scrollBy).toHaveBeenCalledWith({
        top: 76,
        behavior: "auto",
      }),
    );
  });

  it("keeps the floating footer outside the live message log", () => {
    renderWithProviders(
      <MessageTimeline
        messages={[message("user-1", "user", "Question")]}
        footer={<div data-testid="composer-footer" />}
      />,
    );

    const log = screen.getByRole("log", { name: "Chat messages" });

    expect(log).not.toContainElement(screen.getByTestId("composer-footer"));
  });
});

import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
  act(() => {
    for (const callback of resizeObserverCallbacks) {
      callback([], {} as ResizeObserver);
    }
  });
}

beforeEach(() => {
  resizeObserverCallbacks.length = 0;
  Object.defineProperty(globalThis, "ResizeObserver", {
    configurable: true,
    writable: true,
    value: ResizeObserverMock,
  });
});

afterEach(() => {
  vi.restoreAllMocks();
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

function attachNativeSmoothScrollTo(element: HTMLElement) {
  const scrollTo = vi.fn();
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

function mockRequestAnimationFrame() {
  const callbacks = new Map<number, FrameRequestCallback>();
  let nextFrameId = 1;
  vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
    const frameId = nextFrameId;
    nextFrameId += 1;
    callbacks.set(frameId, callback);
    return frameId;
  });
  const cancelSpy = vi
    .spyOn(window, "cancelAnimationFrame")
    .mockImplementation((frameId) => {
      callbacks.delete(frameId);
    });

  return {
    cancelSpy,
    pendingCount() {
      return callbacks.size;
    },
    run(now: number) {
      const nextCallback = callbacks.entries().next().value;
      expect(nextCallback).toBeDefined();
      if (!nextCallback) {
        return;
      }
      const [frameId, callback] = nextCallback;
      callbacks.delete(frameId);
      act(() => {
        callback(now);
      });
    },
    finish(start = 1000) {
      this.run(start);
      this.run(start + 180);
    },
  };
}

function getTimelineScroller() {
  return screen.getByTestId("message-timeline-scroll");
}

describe("MessageTimeline", () => {
  it("follows streaming content without treating native smooth-scroll progress as detachment", async () => {
    const messages = [
      message("user-1", "user", "Question"),
      message("assistant-1", "assistant", "First token"),
    ];
    const { rerender } = renderWithProviders(
      <MessageTimeline messages={messages} streamingMessageId="assistant-1" />,
    );
    const scroller = getTimelineScroller();
    setScrollMetrics(scroller, {
      scrollTop: 850,
      scrollHeight: 1000,
      clientHeight: 100,
    });
    fireEvent.scroll(scroller);
    const scrollTo = attachNativeSmoothScrollTo(scroller);

    setScrollMetrics(scroller, {
      scrollTop: 850,
      scrollHeight: 1400,
      clientHeight: 100,
    });
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
        top: 1300,
        behavior: "smooth",
      }),
    );

    scroller.scrollTop = 900;
    fireEvent.scroll(scroller);

    expect(
      screen.queryByRole("button", { name: "Jump to latest" }),
    ).not.toBeInTheDocument();
  });

  it("detaches during generation and jumps with controlled smooth scrolling", async () => {
    const user = userEvent.setup();
    const animationFrame = mockRequestAnimationFrame();
    const bottomScrollTop = 4500;
    const messages = [
      message("user-1", "user", "Question"),
      message("assistant-1", "assistant", "First token"),
    ];
    const { rerender } = renderWithProviders(
      <MessageTimeline messages={messages} streamingMessageId="assistant-1" />,
    );
    const scroller = getTimelineScroller();
    setScrollMetrics(scroller, {
      scrollTop: 100,
      scrollHeight: 5000,
      clientHeight: 500,
    });
    const scrollTo = attachScrollTo(scroller);

    fireEvent.wheel(scroller, { deltaY: -120 });
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

    expect(scrollTo).not.toHaveBeenCalled();

    animationFrame.run(1000);
    expect(scroller.scrollTop).toBe(100);

    animationFrame.run(1090);
    expect(scroller.scrollTop).toBeGreaterThan(100);
    expect(scroller.scrollTop).toBeLessThan(bottomScrollTop);

    animationFrame.run(1180);

    expect(scroller.scrollTop).toBe(bottomScrollTop);
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

  it("keeps MCP app auto-scroll above the footer and skips it while detached", async () => {
    const animationFrame = mockRequestAnimationFrame();
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
    animationFrame.run(1000);

    scrollBy.mockClear();
    fireEvent.wheel(scroller, { deltaY: -40 });

    rerender(
      <MessageTimeline
        messages={[messages[0], mcpAppMessage("assistant-2")]}
        footer={<div data-testid="composer-footer" />}
      />,
    );

    expect(
      await screen.findByRole("button", { name: "Jump to latest" }),
    ).toBeInTheDocument();
    expect(scrollBy).not.toHaveBeenCalled();
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
      top: 500,
      behavior: "auto",
    });
  });

  it("keeps manual position stable and shows Jump when resize leaves latest behind", () => {
    const animationFrame = mockRequestAnimationFrame();
    const messages = [
      message("user-1", "user", "Question"),
      message("assistant-1", "assistant", "Answer"),
    ];
    renderWithProviders(<MessageTimeline messages={messages} />);
    const scroller = getTimelineScroller();
    const scrollTo = attachScrollTo(scroller);

    setScrollMetrics(scroller, {
      scrollTop: 260,
      scrollHeight: 1200,
      clientHeight: 500,
    });
    fireEvent.scroll(scroller);
    expect(
      screen.queryByRole("button", { name: "Jump to latest" }),
    ).not.toBeInTheDocument();
    scrollTo.mockClear();

    setScrollMetrics(scroller, {
      scrollTop: 260,
      scrollHeight: 1200,
      clientHeight: 300,
    });
    triggerResizeObservers();
    animationFrame.run(1000);

    expect(scroller.scrollTop).toBe(260);
    expect(scrollTo).not.toHaveBeenCalled();
    expect(
      screen.getByRole("button", { name: "Jump to latest" }),
    ).toBeInTheDocument();
  });

  it("does not snap manual near-bottom scrolling to latest when footer controls collapse", async () => {
    const animationFrame = mockRequestAnimationFrame();
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

    setScrollMetrics(scroller, {
      scrollTop: 300,
      scrollHeight: 1000,
      clientHeight: 500,
    });
    fireEvent.wheel(scroller, { deltaY: -40 });
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
    animationFrame.run(1000);

    expect(scrollTo).not.toHaveBeenCalled();
    expect(scroller.scrollTop).toBe(730);
  });

  it("keeps pinned users attached across observer and window resizes", () => {
    const animationFrame = mockRequestAnimationFrame();
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
    animationFrame.run(1000);

    expect(scrollTo).toHaveBeenCalledWith({
      top: 700,
      behavior: "auto",
    });
    scrollTo.mockClear();

    setScrollMetrics(scroller, {
      scrollTop: 0,
      scrollHeight: 400,
      clientHeight: 500,
    });
    fireEvent.scroll(scroller);
    scrollTo.mockClear();

    setScrollMetrics(scroller, {
      scrollTop: 0,
      scrollHeight: 1000,
      clientHeight: 500,
    });
    fireEvent.resize(window);
    animationFrame.run(1000);

    expect(scrollTo).toHaveBeenCalledWith({
      top: 500,
      behavior: "auto",
    });
    expect(scroller.scrollTop).toBe(500);
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

  it("docks the floating footer in layout flow while overlapping the message surface", () => {
    renderWithProviders(
      <MessageTimeline
        messages={[message("user-1", "user", "Question")]}
        footer={<div data-testid="composer-footer" />}
      />,
    );

    const scroller = screen.getByTestId("message-timeline-scroll");
    const surface = screen.getByTestId("message-timeline-surface");
    const footerFrame = screen.getByTestId("message-timeline-footer");

    expect(surface).toHaveClass(
      "absolute",
      "bottom-[calc(var(--chat-surface-bottom-gap)*2)]",
      "rounded-chrome",
      "bg-card",
    );
    expect(scroller).toHaveClass("flex-1");
    expect(scroller).not.toHaveClass("bg-card");
    expect(footerFrame).toHaveClass(
      "relative",
      "mt-[calc(-1*var(--chat-composer-surface-overlap))]",
      "shrink-0",
      "pb-[var(--chat-surface-bottom-gap)]",
    );
    expect(footerFrame).not.toHaveClass("absolute", "bottom-4");
  });

  it("keeps Jump hidden or clears it when the transcript has no scrollable overflow", async () => {
    const animationFrame = mockRequestAnimationFrame();
    const messages = [
      message("user-1", "user", "Short question"),
      message("assistant-1", "assistant", "Short answer"),
    ];
    renderWithProviders(
      <MessageTimeline
        messages={messages}
        footer={<div data-testid="composer-footer" />}
      />,
    );
    const scroller = getTimelineScroller();

    setScrollMetrics(scroller, {
      scrollTop: 0,
      scrollHeight: 400,
      clientHeight: 500,
    });
    fireEvent.scroll(scroller);

    expect(
      screen.queryByRole("button", { name: "Jump to latest" }),
    ).not.toBeInTheDocument();

    setScrollMetrics(scroller, {
      scrollTop: 0,
      scrollHeight: 500,
      clientHeight: 500,
    });
    fireEvent.wheel(scroller, { deltaY: -40 });

    expect(
      screen.queryByRole("button", { name: "Jump to latest" }),
    ).not.toBeInTheDocument();

    setScrollMetrics(scroller, {
      scrollTop: 300,
      scrollHeight: 1000,
      clientHeight: 500,
    });
    fireEvent.wheel(scroller, { deltaY: -40 });
    fireEvent.scroll(scroller);

    expect(
      await screen.findByRole("button", { name: "Jump to latest" }),
    ).toBeInTheDocument();

    setScrollMetrics(scroller, {
      scrollTop: 0,
      scrollHeight: 500,
      clientHeight: 500,
    });
    fireEvent.scroll(scroller);

    expect(
      screen.queryByRole("button", { name: "Jump to latest" }),
    ).not.toBeInTheDocument();

    setScrollMetrics(scroller, {
      scrollTop: 450,
      scrollHeight: 1000,
      clientHeight: 500,
    });
    fireEvent.wheel(scroller, { deltaY: -40 });

    expect(
      await screen.findByRole("button", { name: "Jump to latest" }),
    ).toBeInTheDocument();

    setScrollMetrics(scroller, {
      scrollTop: 0,
      scrollHeight: 400,
      clientHeight: 500,
    });
    triggerResizeObservers();
    animationFrame.run(1000);

    await waitFor(() =>
      expect(
        screen.queryByRole("button", { name: "Jump to latest" }),
      ).not.toBeInTheDocument(),
    );
  });

  it("preserves detached state on resize until the user is pinned to latest", () => {
    const animationFrame = mockRequestAnimationFrame();
    const messages = [
      message("user-1", "user", "Short question"),
      message("assistant-1", "assistant", "Short answer"),
    ];
    renderWithProviders(<MessageTimeline messages={messages} />);
    const scroller = getTimelineScroller();

    // User scrolls up -> detached, button visible.
    setScrollMetrics(scroller, {
      scrollTop: 300,
      scrollHeight: 1000,
      clientHeight: 500,
    });
    fireEvent.wheel(scroller, { deltaY: -40 });
    fireEvent.scroll(scroller);
    expect(
      screen.getByRole("button", { name: "Jump to latest" }),
    ).toBeInTheDocument();

    // Near bottom is not enough to discard an explicit manual detachment.
    setScrollMetrics(scroller, {
      scrollTop: 300,
      scrollHeight: 1000,
      clientHeight: 650,
    });
    triggerResizeObservers();
    animationFrame.run(1000);

    expect(
      screen.getByRole("button", { name: "Jump to latest" }),
    ).toBeInTheDocument();

    setScrollMetrics(scroller, {
      scrollTop: 345,
      scrollHeight: 1000,
      clientHeight: 650,
    });
    triggerResizeObservers();
    animationFrame.run(1100);

    expect(
      screen.queryByRole("button", { name: "Jump to latest" }),
    ).not.toBeInTheDocument();
  });

  it("cancels pending resize reconciliation on unmount", () => {
    const animationFrame = mockRequestAnimationFrame();
    const messages = [
      message("user-1", "user", "Short question"),
      message("assistant-1", "assistant", "Short answer"),
    ];
    const { unmount } = renderWithProviders(
      <MessageTimeline messages={messages} />,
    );
    const scroller = getTimelineScroller();

    setScrollMetrics(scroller, {
      scrollTop: 0,
      scrollHeight: 1000,
      clientHeight: 500,
    });
    triggerResizeObservers();

    expect(animationFrame.pendingCount()).toBe(1);

    unmount();

    expect(animationFrame.cancelSpy).toHaveBeenCalledWith(1);
    expect(animationFrame.pendingCount()).toBe(0);
  });
});

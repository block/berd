import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderWithProviders } from "@/test/render";
import type { Message } from "@/shared/types/messages";
import { VirtualMessageTimeline } from "../VirtualMessageTimeline";
import {
  buildVirtualTimelineSnapshot,
  textMessage,
} from "@/features/chat/transcript/testing/virtualTimelineSnapshotFixture";

const timelineMocks = vi.hoisted(() => ({
  scrollToBottom: vi.fn(() => true),
  isSelectionViewportFrozen: vi.fn(() => false),
}));

vi.mock("../MessageBubble", () => ({
  MessageBubble: ({ message }: { message: Message }) => (
    <div data-testid={`bubble-${message.id}`}>
      {message.content
        .filter((block) => block.type === "text")
        .map((block) => block.text)
        .join("\n")}
    </div>
  ),
}));

vi.mock("../../transcript/virtual/react/useTranscriptVirtualTimeline", () => ({
  useTranscriptVirtualTimeline: ({
    footerHeight,
    rows,
    sessionEpoch,
    sessionId,
  }: {
    footerHeight: number;
    rows: readonly {
      rowId: string;
    }[];
    sessionEpoch: number;
    sessionId: string;
  }) => ({
    snapshot: buildVirtualTimelineSnapshot({
      footerHeight,
      rows,
      sessionEpoch,
      sessionId,
    }),
    rowStateProvider: null,
    measureRowElement: vi.fn(),
    measureOffscreenShellElement: vi.fn(),
    syncViewportFromDom: vi.fn(() => ({
      anchor: { type: "bottom" },
      bottomScrollTop: 0,
      distanceFromBottom: 0,
      footerHeight,
      nearBottom: true,
      pinnedToBottom: true,
      rowCount: rows.length,
      scrollTop: 0,
      sessionEpoch,
      sessionId,
      viewportHeight: 500,
      virtualScrollHeight: rows.length * 120 + footerHeight,
      widthScope: "w:800",
    })),
    scrollToRow: vi.fn(() => true),
    scrollToBottom: timelineMocks.scrollToBottom,
    isSelectionViewportFrozen: timelineMocks.isSelectionViewportFrozen,
    setRowFocused: vi.fn(),
    markRowInteracted: vi.fn(),
  }),
}));

class ResizeObserverMock {
  observe = vi.fn();
  unobserve = vi.fn();
  disconnect = vi.fn();
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
  vi.spyOn(window, "cancelAnimationFrame").mockImplementation((frameId) => {
    callbacks.delete(frameId);
  });

  return {
    runAll(now: number) {
      for (const [frameId, callback] of [...callbacks]) {
        callbacks.delete(frameId);
        act(() => callback(now));
      }
    },
  };
}

function setScrollMetrics(
  element: HTMLElement,
  {
    scrollTop,
    scrollHeight,
    clientHeight,
    clientWidth = 800,
  }: {
    scrollTop: number;
    scrollHeight: number;
    clientHeight: number;
    clientWidth?: number;
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
  Object.defineProperty(element, "clientWidth", {
    configurable: true,
    value: clientWidth,
  });
}

describe("VirtualMessageTimeline layout-driven bottom scroll", () => {
  beforeEach(() => {
    timelineMocks.scrollToBottom.mockClear();
    timelineMocks.isSelectionViewportFrozen.mockReset();
    timelineMocks.isSelectionViewportFrozen.mockReturnValue(false);
    Object.defineProperty(globalThis, "ResizeObserver", {
      configurable: true,
      writable: true,
      value: ResizeObserverMock,
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("coalesces footer and virtual-height bottom scroll requests into one frame", () => {
    const animationFrame = mockRequestAnimationFrame();
    const messages = [
      textMessage("user-1", "user", "Question"),
      textMessage("assistant-1", "assistant", "Answer"),
    ];
    const { rerender } = renderWithProviders(
      <VirtualMessageTimeline sessionId="session-1" messages={messages} />,
    );
    animationFrame.runAll(1000);
    timelineMocks.scrollToBottom.mockClear();

    rerender(
      <VirtualMessageTimeline
        sessionId="session-1"
        messages={messages}
        footer={<div data-testid="composer-footer" />}
      />,
    );

    expect(timelineMocks.scrollToBottom).not.toHaveBeenCalled();

    animationFrame.runAll(1016);

    expect(timelineMocks.scrollToBottom).toHaveBeenCalledTimes(1);
    expect(timelineMocks.scrollToBottom).toHaveBeenCalledWith("auto");
  });

  it("skips queued layout-driven bottom scroll when selection takes the viewport", () => {
    const animationFrame = mockRequestAnimationFrame();
    const messages = [
      textMessage("user-1", "user", "Question"),
      textMessage("assistant-1", "assistant", "Answer"),
    ];
    const { rerender } = renderWithProviders(
      <VirtualMessageTimeline sessionId="session-1" messages={messages} />,
    );
    animationFrame.runAll(1000);
    timelineMocks.scrollToBottom.mockClear();

    rerender(
      <VirtualMessageTimeline
        sessionId="session-1"
        messages={messages}
        footer={<div data-testid="composer-footer" />}
      />,
    );
    timelineMocks.isSelectionViewportFrozen.mockReturnValue(true);
    animationFrame.runAll(1016);

    expect(timelineMocks.scrollToBottom).not.toHaveBeenCalled();
  });

  it("keeps the pre-drag scroll height while the selection viewport is frozen", async () => {
    timelineMocks.isSelectionViewportFrozen.mockReturnValue(true);
    const messages = [
      textMessage("user-1", "user", "Question"),
      textMessage("assistant-1", "assistant", "Answer"),
    ];
    renderWithProviders(
      <VirtualMessageTimeline sessionId="session-1" messages={messages} />,
    );
    const scroller = screen.getByTestId("message-timeline-scroll");
    setScrollMetrics(scroller, {
      scrollTop: 1100,
      scrollHeight: 1600,
      clientHeight: 500,
    });

    fireEvent.pointerDown(scroller);

    await waitFor(() =>
      expect(
        screen.getByTestId("virtual-message-timeline-list").style.minHeight,
      ).toBe("1600px"),
    );

    timelineMocks.isSelectionViewportFrozen.mockReturnValue(false);
    fireEvent.pointerUp(document);

    await waitFor(() =>
      expect(
        screen.getByTestId("virtual-message-timeline-list").style.minHeight,
      ).toBe(""),
    );
  });
});

import { act } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderWithProviders } from "@/test/render";
import type { Message } from "@/shared/types/messages";
import { VirtualMessageTimeline } from "../VirtualMessageTimeline";
import {
  buildVirtualTimelineSnapshot,
  textMessage,
} from "@/features/chat/transcript/testing/virtualTimelineSnapshotFixture";

const timelineMocks = vi.hoisted(() => ({
  remeasureVisibleRowsSync: vi.fn(),
  scrollToBottom: vi.fn(() => true),
  syncViewportFromDom: vi.fn(() => ({
    sessionId: "session-1",
    sessionEpoch: 0,
  })),
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

vi.mock(
  "../../transcript/virtual/react/useTranscriptVirtualTimeline",
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import("../../transcript/virtual/react/useTranscriptVirtualTimeline")
      >();
    return {
      ...actual,
      useTranscriptVirtualTimeline: ({
        footerHeight,
        rows,
        loadedTranscript,
      }: {
        footerHeight: number;
        rows: readonly {
          rowId: string;
        }[];
        loadedTranscript: { sessionEpoch: number; sessionId: string };
      }) => {
        const { sessionEpoch, sessionId } = loadedTranscript;
        return {
          snapshot: buildVirtualTimelineSnapshot({
            footerHeight,
            rows,
            sessionEpoch,
            sessionId,
          }),
          rowStateProvider: null,
          measureRowElement: vi.fn(),
          measureOffscreenShellElement: vi.fn(),
          measureOffscreenRealElement: vi.fn(),
          remeasureVisibleRowsSync: timelineMocks.remeasureVisibleRowsSync,
          syncViewportFromDom: timelineMocks.syncViewportFromDom,
          scrollToRow: vi.fn(() => true),
          scrollToBottom: timelineMocks.scrollToBottom,
          setRowFocused: vi.fn(),
          markRowInteracted: vi.fn(),
        };
      },
    };
  },
);

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

describe("VirtualMessageTimeline layout-driven bottom scroll", () => {
  beforeEach(() => {
    timelineMocks.scrollToBottom.mockClear();
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
});

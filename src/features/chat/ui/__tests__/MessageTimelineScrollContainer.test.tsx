import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MessageTimelineScrollContainer } from "../MessageTimelineScrollContainer";

const SCROLLBAR_SUPPRESSED_ATTRIBUTE = "data-scrollbar-passive-suppressed";
const resizeObserverCallbacks: ResizeObserverCallback[] = [];

class ResizeObserverMock {
  constructor(callback: ResizeObserverCallback) {
    resizeObserverCallbacks.push(callback);
  }

  observe = vi.fn();
  unobserve = vi.fn();
  disconnect = vi.fn();
}

function triggerResizeObserver(target: Element, width: number, height: number) {
  act(() => {
    for (const callback of resizeObserverCallbacks) {
      callback(
        [
          {
            target,
            contentRect: {
              width,
              height,
            } as DOMRectReadOnly,
          } as ResizeObserverEntry,
        ],
        {} as ResizeObserver,
      );
    }
  });
}

function renderScrollContainer(
  props: Partial<
    React.ComponentProps<typeof MessageTimelineScrollContainer>
  > = {},
) {
  render(
    <MessageTimelineScrollContainer hasFooter={false} {...props}>
      <div>Transcript</div>
    </MessageTimelineScrollContainer>,
  );

  return screen.getByTestId("message-timeline-scroll");
}

describe("MessageTimelineScrollContainer", () => {
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

  it("keeps the scrollbar thumb passively hidden on initial chat load", () => {
    const scroller = renderScrollContainer();

    expect(scroller).toHaveAttribute(SCROLLBAR_SUPPRESSED_ATTRIBUTE, "true");
  });

  it("reveals the scrollbar thumb once the user shows scroll intent", () => {
    const scroller = renderScrollContainer();

    fireEvent.wheel(scroller, { deltaY: 80 });

    expect(scroller).not.toHaveAttribute(SCROLLBAR_SUPPRESSED_ATTRIBUTE);
  });

  it("hides the scrollbar thumb on window resize until the next user scroll intent", () => {
    const scroller = renderScrollContainer();

    fireEvent.wheel(scroller, { deltaY: 80 });
    expect(scroller).not.toHaveAttribute(SCROLLBAR_SUPPRESSED_ATTRIBUTE);

    act(() => {
      window.dispatchEvent(new Event("resize"));
    });
    expect(scroller).toHaveAttribute(SCROLLBAR_SUPPRESSED_ATTRIBUTE, "true");

    fireEvent.wheel(scroller, { deltaY: 80 });
    expect(scroller).not.toHaveAttribute(SCROLLBAR_SUPPRESSED_ATTRIBUTE);
  });

  it("hides the scrollbar thumb on transcript viewport resize until the next user scroll intent", () => {
    const scroller = renderScrollContainer();

    fireEvent.wheel(scroller, { deltaY: 80 });
    expect(scroller).not.toHaveAttribute(SCROLLBAR_SUPPRESSED_ATTRIBUTE);

    triggerResizeObserver(scroller, 640, 480);
    expect(scroller).not.toHaveAttribute(SCROLLBAR_SUPPRESSED_ATTRIBUTE);

    triggerResizeObserver(scroller, 620, 480);
    expect(scroller).toHaveAttribute(SCROLLBAR_SUPPRESSED_ATTRIBUTE, "true");

    fireEvent.wheel(scroller, { deltaY: 80 });
    expect(scroller).not.toHaveAttribute(SCROLLBAR_SUPPRESSED_ATTRIBUTE);
  });

  it("keeps the scrollbar thumb hidden across passive chat content updates before user intent", () => {
    const { rerender } = render(
      <MessageTimelineScrollContainer hasFooter={false}>
        <div>Short transcript</div>
      </MessageTimelineScrollContainer>,
    );
    const scroller = screen.getByTestId("message-timeline-scroll");

    rerender(
      <MessageTimelineScrollContainer hasFooter={false}>
        <div>{"Long transcript\n".repeat(100)}</div>
      </MessageTimelineScrollContainer>,
    );

    expect(scroller).toHaveAttribute(SCROLLBAR_SUPPRESSED_ATTRIBUTE, "true");
  });

  it("does not re-hide the scrollbar for content growth after user scroll intent", () => {
    const { rerender } = render(
      <MessageTimelineScrollContainer hasFooter={false}>
        <div>Short transcript</div>
      </MessageTimelineScrollContainer>,
    );
    const scroller = screen.getByTestId("message-timeline-scroll");

    fireEvent.wheel(scroller, { deltaY: 80 });
    expect(scroller).not.toHaveAttribute(SCROLLBAR_SUPPRESSED_ATTRIBUTE);

    rerender(
      <MessageTimelineScrollContainer hasFooter={false}>
        <div>{"Long transcript\n".repeat(100)}</div>
      </MessageTimelineScrollContainer>,
    );

    expect(scroller).not.toHaveAttribute(SCROLLBAR_SUPPRESSED_ATTRIBUTE);
  });

  it("preserves timeline scroll intent handlers while revealing the scrollbar", () => {
    const onWheel = vi.fn();
    const onPointerDown = vi.fn();
    const scroller = renderScrollContainer({ onWheel, onPointerDown });

    fireEvent.wheel(scroller, { deltaY: 80 });
    fireEvent.pointerDown(scroller);

    expect(onWheel).toHaveBeenCalledOnce();
    expect(onPointerDown).toHaveBeenCalledOnce();
    expect(scroller).not.toHaveAttribute(SCROLLBAR_SUPPRESSED_ATTRIBUTE);
  });
});

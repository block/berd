import { act } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderWithProviders } from "@/test/render";
import type { Message } from "@/shared/types/messages";
import { VirtualMessageTimeline } from "../VirtualMessageTimeline";

const timelineMocks = vi.hoisted(() => ({
  scrollToBottom: vi.fn(() => true),
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

function textMessage(id: string, role: Message["role"], text: string): Message {
  return {
    id,
    role,
    created: Date.UTC(2026, 5, 4, 12, 0, 0),
    content: [{ type: "text", text }],
    metadata: { userVisible: true },
  };
}

function buildVirtualTimelineSnapshot({
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
}) {
  const virtualItems = rows.map((row, index) => ({
    index,
    key: row.rowId,
    row,
    start: index * 120,
    size: 120,
    end: (index + 1) * 120,
    visible: true,
    protected: false,
  }));
  const endIndex = rows.length - 1;
  const scrollHeight = rows.length * 120 + footerHeight;

  return {
    engineKind: "test",
    mode: "bounded-controller",
    range: {
      totalHeight: scrollHeight,
      scrollHeight,
      visibleRange: { startIndex: 0, endIndex },
      renderRange: {
        startIndex: 0,
        endIndex,
        visibleStartIndex: 0,
        visibleEndIndex: endIndex,
      },
      virtualItems,
      visibleRowIds: rows.map((row) => row.rowId),
      renderedRowIds: rows.map((row) => row.rowId),
      protectedRowIds: [],
      paddingStart: 0,
      paddingEnd: footerHeight,
    },
    controllerState: {
      sessionId,
      sessionEpoch,
      widthScope: "w:800",
      scrollTop: 0,
      viewportHeight: 500,
      footerHeight,
      virtualScrollHeight: scrollHeight,
      bottomScrollTop: Math.max(0, scrollHeight - 500),
      distanceFromBottom: 0,
      pinnedToBottom: true,
      nearBottom: true,
      anchor: { type: "bottom" },
      rowCount: rows.length,
    },
    controllerDiagnostics: {
      rowSetUpdates: 0,
      viewportUpdates: 0,
      rangeCalculations: 0,
      measuredHeightUpdates: 0,
      corrections: 0,
      bottomCorrections: 0,
      rowCorrections: 0,
      scrollToRowCorrections: 0,
      staleMeasurementsDropped: 0,
      staleMeasurementSessionDrops: 0,
      staleMeasurementEpochDrops: 0,
      staleMeasurementWidthDrops: 0,
      staleMeasurementRevisionDrops: 0,
      staleMeasurementMissingRowDrops: 0,
      staleAnchorsDropped: 0,
      missingAnchorsDropped: 0,
      recapturedAnchors: 0,
      bottomFollowExits: 0,
      protectedRowsRendered: 0,
      lastCorrection: null,
    },
    keepAliveDecision: null,
    measurementStats: {
      visibleMeasurementAttempts: 0,
      offscreenShellMeasurementAttempts: 0,
      acceptedOffscreenShellMeasurements: 0,
      acceptedOffscreenRealMeasurements: 0,
      acceptedVisibleMeasurements: 0,
      skippedPendingMeasurements: 0,
      skippedZeroMeasurements: 0,
      staleMeasurementsDropped: 0,
      staleMeasurementSessionDrops: 0,
      staleMeasurementEpochDrops: 0,
      staleMeasurementWidthDrops: 0,
      staleMeasurementRevisionDrops: 0,
      staleMeasurementMissingRowDrops: 0,
      reservedMeasurementsDeferred: 0,
      pendingMeasurements: 0,
      controllerUpdatesQueued: 0,
      controllerUpdateBatches: 0,
      controllerUpdateBatchMaxSize: 0,
      controllerUpdatesFlushed: 0,
      controllerUpdatesAccepted: 0,
      controllerUpdatesRejected: 0,
      cacheEntries: 0,
      cacheHits: 0,
      cacheMisses: 0,
      cacheWrites: 0,
      cacheEvictions: 0,
    },
    fallbackReasons: [],
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

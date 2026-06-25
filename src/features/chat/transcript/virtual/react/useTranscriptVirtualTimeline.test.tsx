import { act, render, renderHook, waitFor } from "@testing-library/react";
import { useLayoutEffect, type RefObject } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TranscriptRowDescriptor } from "../../projection/transcriptItemTypes";
import { useTranscriptVirtualTimeline } from "./useTranscriptVirtualTimeline";

const SESSION_ID = "session-a";

describe("useTranscriptVirtualTimeline", () => {
  let frameCallbacks: Array<{ id: number; callback: FrameRequestCallback }>;
  let nextFrameId: number;

  beforeEach(() => {
    frameCallbacks = [];
    nextFrameId = 1;
    Object.defineProperty(globalThis, "requestAnimationFrame", {
      configurable: true,
      writable: true,
      value: vi.fn((callback: FrameRequestCallback) => {
        const id = nextFrameId;
        nextFrameId += 1;
        frameCallbacks.push({ id, callback });
        return id;
      }),
    });
    Object.defineProperty(globalThis, "cancelAnimationFrame", {
      configurable: true,
      writable: true,
      value: vi.fn((id: number) => {
        frameCallbacks = frameCallbacks.filter((frame) => frame.id !== id);
      }),
    });
  });

  afterEach(() => {
    document.body.replaceChildren();
    vi.restoreAllMocks();
  });

  it("flushes visible measurements on the next animation frame instead of a microtask", async () => {
    const container = createContainer();
    const containerRef = {
      current: container,
    } satisfies RefObject<HTMLDivElement | null>;
    const rows = [
      row("intro", 100),
      row("assistant-tail", 120, {
        anchorPriority: "streaming",
      }),
    ];
    const protectedRowIds = ["assistant-tail"];

    const { result } = renderHook(() =>
      useTranscriptVirtualTimeline({
        sessionId: SESSION_ID,
        sessionEpoch: 1,
        rows,
        protectedRowIds,
        containerRef,
        footerHeight: 0,
      }),
    );

    const measuredRow = createMeasuredElement(240);
    await act(async () => {
      result.current.measureRowElement("assistant-tail", measuredRow);
    });

    await act(async () => {
      await Promise.resolve();
    });

    expect(
      result.current.snapshot.measurementStats.visibleMeasurementAttempts,
    ).toBe(0);
    expect(
      result.current.snapshot.measurementStats.acceptedVisibleMeasurements,
    ).toBe(0);

    await act(async () => {
      runPendingFrames();
    });

    await waitFor(() => {
      expect(
        result.current.snapshot.measurementStats.visibleMeasurementAttempts,
      ).toBe(1);
      expect(
        result.current.snapshot.measurementStats.acceptedVisibleMeasurements,
      ).toBe(1);
    });
  });

  it("does not publish a new snapshot for no-op bottom scrolls", async () => {
    const container = createContainer();
    const containerRef = {
      current: container,
    } satisfies RefObject<HTMLDivElement | null>;
    const rows = [row("intro", 100), row("assistant-tail", 120)];

    const { result } = renderHook(() =>
      useTranscriptVirtualTimeline({
        sessionId: SESSION_ID,
        sessionEpoch: 1,
        rows,
        containerRef,
        footerHeight: 0,
      }),
    );
    const initialSnapshot = result.current.snapshot;

    await act(async () => {
      expect(result.current.scrollToBottom("auto")).toBe(true);
    });

    expect(result.current.snapshot).toBe(initialSnapshot);
  });

  it("stabilizes repeated layout-effect bottom syncs", async () => {
    const container = createContainer();
    const containerRef = {
      current: container,
    } satisfies RefObject<HTMLDivElement | null>;
    const rows = [row("intro", 100), row("assistant-tail", 120)];
    const effectSnapshots: unknown[] = [];

    function BottomSyncHarness() {
      const timeline = useTranscriptVirtualTimeline({
        sessionId: SESSION_ID,
        sessionEpoch: 1,
        rows,
        containerRef,
        footerHeight: 0,
      });

      useLayoutEffect(() => {
        effectSnapshots.push(timeline.snapshot);
        timeline.scrollToBottom("auto");
      }, [timeline.snapshot, timeline.scrollToBottom]);

      return null;
    }

    render(<BottomSyncHarness />);

    await act(async () => {
      await Promise.resolve();
    });

    expect(effectSnapshots).toHaveLength(1);
  });

  it("accepts browser-clamped bottom corrections until virtual layout is reachable", () => {
    const { container, setScrollHeight } = createClampedContainer({
      scrollHeight: 300,
    });
    const containerRef = {
      current: container,
    } satisfies RefObject<HTMLDivElement | null>;
    const rows = Array.from({ length: 10 }, (_, index) =>
      row(`row-${index}`, 100),
    );

    const { result } = renderHook(() =>
      useTranscriptVirtualTimeline({
        sessionId: SESSION_ID,
        sessionEpoch: 1,
        rows,
        containerRef,
        footerHeight: 0,
      }),
    );

    expect(container.scrollTop).toBe(0);
    expect(result.current.snapshot.controllerState).toMatchObject({
      scrollTop: 0,
      bottomScrollTop: 700,
      distanceFromBottom: 700,
    });
    expect(result.current.snapshot.controllerState.anchor).toMatchObject({
      type: "row",
      rowId: "row-0",
    });

    act(() => {
      expect(result.current.scrollToBottom("auto")).toBe(true);
    });

    expect(container.scrollTop).toBe(0);
    expect(result.current.snapshot.controllerState.scrollTop).toBe(0);

    setScrollHeight(1000);

    act(() => {
      expect(result.current.scrollToBottom("auto")).toBe(true);
    });

    expect(container.scrollTop).toBe(700);
    expect(result.current.snapshot.controllerState).toMatchObject({
      scrollTop: 700,
      anchor: { type: "bottom" },
      distanceFromBottom: 0,
    });
  });

  it("forces visible remeasurement when returning to a previously measured width", async () => {
    const container = createContainer();
    const containerRef = {
      current: container,
    } satisfies RefObject<HTMLDivElement | null>;
    const rows = [row("intro", 100), row("assistant-tail", 100)];
    const measuredHeight = { current: 240 };
    const measuredElement = createMeasuredElementFromRef(measuredHeight);

    const { result } = renderHook(() =>
      useTranscriptVirtualTimeline({
        sessionId: SESSION_ID,
        sessionEpoch: 1,
        rows,
        containerRef,
        footerHeight: 0,
      }),
    );

    await act(async () => {
      result.current.measureRowElement("assistant-tail", measuredElement);
      runPendingFrames();
    });
    expect(result.current.snapshot.controllerState.virtualScrollHeight).toBe(
      340,
    );

    Object.defineProperty(container, "clientWidth", {
      configurable: true,
      value: 600,
    });
    measuredHeight.current = 360;
    await act(async () => {
      result.current.syncViewportFromDom({ source: "programmatic" });
      result.current.remeasureVisibleRowsSync();
    });
    expect(result.current.snapshot.controllerState.virtualScrollHeight).toBe(
      460,
    );

    Object.defineProperty(container, "clientWidth", {
      configurable: true,
      value: 720,
    });
    measuredHeight.current = 240;
    await act(async () => {
      result.current.syncViewportFromDom({ source: "programmatic" });
      result.current.remeasureVisibleRowsSync();
    });

    // Regression proof for A → B → A resize: even though token A's 240px
    // height was observed earlier, the row-keyed controller measurement was
    // overwritten at width B and must be restored when width A returns.
    expect(result.current.snapshot.controllerState.virtualScrollHeight).toBe(
      340,
    );
    expect(
      result.current.snapshot.measurementStats.acceptedVisibleMeasurements,
    ).toBe(3);
  });

  it("measures rows in layout pixels when css zoom shrinks the visual rect", async () => {
    const container = createContainer();
    const containerRef = {
      current: container,
    } satisfies RefObject<HTMLDivElement | null>;
    const rows = [row("intro", 100), row("assistant-tail", 120)];

    const { result } = renderHook(() =>
      useTranscriptVirtualTimeline({
        sessionId: SESSION_ID,
        sessionEpoch: 1,
        rows,
        containerRef,
        footerHeight: 0,
      }),
    );

    await act(async () => {
      result.current.measureRowElement(
        "assistant-tail",
        createMeasuredElementWithLayout({
          visualHeight: 168,
          layoutHeight: 240,
        }),
      );
      runPendingFrames();
    });

    expect(result.current.snapshot.controllerState.virtualScrollHeight).toBe(
      340,
    );
    expect(
      result.current.snapshot.measurementStats.acceptedVisibleMeasurements,
    ).toBe(1);
  });

  it("ignores tiny mounted measurement jitter for an unchanged row token", async () => {
    const container = createContainer();
    const containerRef = {
      current: container,
    } satisfies RefObject<HTMLDivElement | null>;
    const rows = [row("intro", 100), row("assistant-tail", 120)];

    const { result } = renderHook(() =>
      useTranscriptVirtualTimeline({
        sessionId: SESSION_ID,
        sessionEpoch: 1,
        rows,
        containerRef,
        footerHeight: 0,
      }),
    );

    await act(async () => {
      result.current.measureRowElement(
        "assistant-tail",
        createMeasuredElement(240),
      );
      runPendingFrames();
    });

    await waitFor(() => {
      expect(
        result.current.snapshot.measurementStats.acceptedVisibleMeasurements,
      ).toBe(1);
    });
    const measuredSnapshot = result.current.snapshot;

    await act(async () => {
      result.current.measureRowElement(
        "assistant-tail",
        createMeasuredElement(241),
      );
      runPendingFrames();
    });

    expect(result.current.snapshot).toBe(measuredSnapshot);
    expect(
      result.current.snapshot.measurementStats.acceptedVisibleMeasurements,
    ).toBe(1);
  });

  it("commits measurements immediately while text is selected", async () => {
    const container = createContainer();
    const containerRef = {
      current: container,
    } satisfies RefObject<HTMLDivElement | null>;
    const rows = [row("intro", 100), row("tail", 120)];

    const selectable = document.createElement("p");
    selectable.textContent = "selectable transcript text";
    container.appendChild(selectable);

    const { result } = renderHook(() =>
      useTranscriptVirtualTimeline({
        sessionId: SESSION_ID,
        sessionEpoch: 1,
        rows,
        containerRef,
        footerHeight: 0,
      }),
    );

    // Text selection is browser-owned; it must not freeze measurement commits.
    await act(async () => {
      const range = document.createRange();
      range.selectNodeContents(selectable);
      const selection = document.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
      document.dispatchEvent(new Event("selectionchange"));
    });

    await act(async () => {
      result.current.measureRowElement("tail", createMeasuredElement(240));
      runPendingFrames();
    });

    await waitFor(() => {
      expect(
        result.current.snapshot.measurementStats.visibleMeasurementAttempts,
      ).toBe(1);
      expect(result.current.snapshot.controllerState.virtualScrollHeight).toBe(
        340,
      );
    });
  });

  it("does not suspend scroll writes for an ordinary transcript pointerdown", async () => {
    const container = createContainer();
    const containerRef = {
      current: container,
    } satisfies RefObject<HTMLDivElement | null>;
    const rows = [row("intro", 100), row("tail", 120)];

    const { result } = renderHook(() =>
      useTranscriptVirtualTimeline({
        sessionId: SESSION_ID,
        sessionEpoch: 1,
        rows,
        containerRef,
        footerHeight: 0,
      }),
    );

    await act(async () => {
      container.dispatchEvent(new Event("pointerdown", { bubbles: true }));
      container.scrollTop = 1000;
      result.current.syncViewportFromDom({
        source: "browser",
        userScrollIntent: true,
      });
    });

    expect(container.scrollTop).toBe(0);
  });

  it("keeps bounded rendering during an ordinary transcript pointer release", async () => {
    const container = createContainer();
    const containerRef = {
      current: container,
    } satisfies RefObject<HTMLDivElement | null>;
    const rows = [row("intro", 100), row("tail", 120)];

    const { result, rerender } = renderHook(
      ({ protectedRowIds }: { protectedRowIds: readonly string[] }) =>
        useTranscriptVirtualTimeline({
          sessionId: SESSION_ID,
          sessionEpoch: 1,
          rows,
          protectedRowIds,
          containerRef,
          footerHeight: 0,
        }),
      { initialProps: { protectedRowIds: [] as readonly string[] } },
    );

    await act(async () => {
      container.dispatchEvent(new Event("pointerdown", { bubbles: true }));
    });

    await act(async () => {
      rerender({ protectedRowIds: ["intro"] });
    });

    expect(result.current.snapshot.mode).toBe("bounded-controller");
    expect(result.current.snapshot.range.protectedRowIds).toEqual(["intro"]);

    await act(async () => {
      document.dispatchEvent(new Event("pointerup"));
    });

    expect(result.current.snapshot.mode).toBe("bounded-controller");
    expect(result.current.snapshot.range.protectedRowIds).toEqual(["intro"]);
  });

  it("preserves live scrollTop when a protected-row rebuild replays cached measurements", async () => {
    const container = createContainer();
    const containerRef = {
      current: container,
    } satisfies RefObject<HTMLDivElement | null>;
    const rows = Array.from({ length: 8 }, (_, index) =>
      row(`row-${index}`, 200),
    );

    const { result, rerender } = renderHook(
      ({ protectedRowIds }: { protectedRowIds: readonly string[] }) =>
        useTranscriptVirtualTimeline({
          sessionId: SESSION_ID,
          sessionEpoch: 1,
          rows,
          protectedRowIds,
          containerRef,
          footerHeight: 0,
        }),
      { initialProps: { protectedRowIds: [] as readonly string[] } },
    );

    await act(async () => {
      for (const descriptor of rows) {
        result.current.measureRowElement(
          descriptor.rowId,
          createMeasuredElement(100),
        );
      }
      runPendingFrames();
    });

    expect(result.current.snapshot.controllerState.virtualScrollHeight).toBe(
      800,
    );

    await act(async () => {
      container.scrollTop = 350;
      result.current.syncViewportFromDom({
        source: "browser",
        userScrollIntent: true,
      });
    });

    expect(result.current.snapshot.controllerState.scrollTop).toBe(350);

    await act(async () => {
      rerender({ protectedRowIds: ["row-0"] });
    });

    // The replacement controller starts from estimated row heights and then
    // warms itself from cached measurements. That warm-up must recapture the
    // browser's live viewport instead of replaying row-anchor corrections into
    // the DOM; otherwise a protected-row rebuild can transport an actively
    // scrolled transcript to a different location.
    expect(container.scrollTop).toBe(350);
    expect(result.current.snapshot.controllerState.scrollTop).toBe(350);
    expect(result.current.snapshot.controllerState.virtualScrollHeight).toBe(
      800,
    );
    expect(result.current.snapshot.range.protectedRowIds).toContain("row-0");
  });

  function runPendingFrames() {
    expect(frameCallbacks.length).toBeGreaterThan(0);
    while (frameCallbacks.length > 0) {
      const pendingFrames = frameCallbacks;
      frameCallbacks = [];
      for (const frame of pendingFrames) {
        frame.callback(performance.now());
      }
    }
  }
});

function createContainer(): HTMLDivElement {
  const container = document.createElement("div");
  Object.defineProperties(container, {
    clientHeight: { configurable: true, value: 300 },
    clientWidth: { configurable: true, value: 720 },
    scrollHeight: { configurable: true, value: 300 },
    scrollTop: { configurable: true, writable: true, value: 0 },
  });
  document.body.appendChild(container);
  return container;
}

function createClampedContainer({ scrollHeight }: { scrollHeight: number }): {
  container: HTMLDivElement;
  setScrollHeight: (nextScrollHeight: number) => void;
} {
  const container = document.createElement("div");
  let currentScrollHeight = scrollHeight;
  let currentScrollTop = 0;
  Object.defineProperties(container, {
    clientHeight: { configurable: true, value: 300 },
    clientWidth: { configurable: true, value: 720 },
    scrollHeight: {
      configurable: true,
      get: () => currentScrollHeight,
    },
    scrollTop: {
      configurable: true,
      get: () => currentScrollTop,
      set: (nextScrollTop: number) => {
        currentScrollTop = Math.min(
          Math.max(0, nextScrollTop),
          Math.max(0, currentScrollHeight - container.clientHeight),
        );
      },
    },
  });
  document.body.appendChild(container);
  return {
    container,
    setScrollHeight: (nextScrollHeight: number) => {
      currentScrollHeight = nextScrollHeight;
      container.scrollTop = currentScrollTop;
    },
  };
}

function createMeasuredElement(height: number): HTMLElement {
  return createMeasuredElementFromRef({ current: height });
}

function createMeasuredElementWithLayout({
  visualHeight,
  layoutHeight,
}: {
  visualHeight: number;
  layoutHeight: number;
}): HTMLElement {
  const element = createMeasuredElement(visualHeight);
  Object.defineProperties(element, {
    clientHeight: { configurable: true, value: layoutHeight },
    offsetHeight: { configurable: true, value: layoutHeight },
    scrollHeight: { configurable: true, value: layoutHeight },
  });
  return element;
}

function createMeasuredElementFromRef(heightRef: {
  current: number;
}): HTMLElement {
  const element = document.createElement("div");
  element.getBoundingClientRect = () =>
    ({
      bottom: heightRef.current,
      height: heightRef.current,
      left: 0,
      right: 720,
      top: 0,
      width: 720,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    }) as DOMRect;
  document.body.appendChild(element);
  return element;
}

function row(
  rowId: string,
  estimatedHeight: number,
  overrides: Partial<TranscriptRowDescriptor> = {},
): TranscriptRowDescriptor {
  return {
    rowId,
    reactKey: rowId,
    kind: "message",
    messageId: rowId,
    blockIds: [rowId],
    renderRevision: overrides.renderRevision ?? `render:${rowId}`,
    heightRevision:
      overrides.heightRevision ?? `height:${rowId}:${estimatedHeight}`,
    layoutRevision: overrides.layoutRevision ?? "layout-spacing:0",
    estimatedHeight,
    spacingBefore: overrides.spacingBefore ?? 0,
    anchorPriority: overrides.anchorPriority ?? "stable",
    measurementPolicy: overrides.measurementPolicy ?? "measure-real",
    layoutPendingPolicy: overrides.layoutPendingPolicy ?? "can-finalize",
    capabilities: overrides.capabilities ?? {
      stateful: false,
      hasMcpApp: false,
      hasHostCalls: false,
      hasActiveTimer: false,
      hasDynamicAsyncLayout: false,
      canOffscreenRenderReal: true,
      canOffscreenRenderShell: true,
      protectsSelection: false,
    },
    keepAlivePriority: overrides.keepAlivePriority ?? "none",
    fragment: overrides.fragment ?? {
      fragmentId: rowId,
      fragmentIndex: 0,
      fragmentCount: 1,
      role: "single",
      content: [],
      isStreamingTail: overrides.anchorPriority === "streaming",
      messageScrollTarget: true,
      isCodeContinuationChunk: false,
      startsWithHeading: false,
    },
    ...overrides,
  };
}

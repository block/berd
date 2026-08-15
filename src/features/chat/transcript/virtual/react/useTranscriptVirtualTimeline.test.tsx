import { act, render, renderHook, waitFor } from "@testing-library/react";
import { useLayoutEffect, type RefObject } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TranscriptRowDescriptor } from "../../projection/transcriptItemTypes";
import {
  createLoadedTranscriptState,
  MEASUREMENT_FLUSH_FALLBACK_MS,
  useTranscriptVirtualTimeline,
} from "./useTranscriptVirtualTimeline";

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
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("lets the animation frame flush once and cancel its timer fallback", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
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

    expect(
      result.current.snapshot.measurementStats.visibleMeasurementAttempts,
    ).toBe(1);
    expect(
      result.current.snapshot.measurementStats.acceptedVisibleMeasurements,
    ).toBe(1);
    expect(vi.getTimerCount()).toBe(0);

    // The losing delivery cannot flush the accepted measurement again.
    await act(async () => {
      vi.advanceTimersByTime(MEASUREMENT_FLUSH_FALLBACK_MS + 1);
    });
    expect(
      result.current.snapshot.measurementStats.visibleMeasurementAttempts,
    ).toBe(1);
  });

  it("flushes queued measurements when animation frames are withheld", () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
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

    act(() => {
      result.current.measureRowElement(
        "assistant-tail",
        createMeasuredElement(240),
      );
    });

    // The frame queue is intentionally never delivered, matching WKWebView
    // while it considers the window occluded or in transition.
    act(() => {
      vi.advanceTimersByTime(MEASUREMENT_FLUSH_FALLBACK_MS + 1);
    });

    expect(
      result.current.snapshot.measurementStats.visibleMeasurementAttempts,
    ).toBe(1);
    expect(
      result.current.snapshot.measurementStats.acceptedVisibleMeasurements,
    ).toBe(1);
    expect(frameCallbacks).toHaveLength(0);
    expect(cancelAnimationFrame).toHaveBeenCalled();
  });

  it("cancels pending frame and timer deliveries when the loaded transcript unmounts", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const container = createContainer();
    const containerRef = {
      current: container,
    } satisfies RefObject<HTMLDivElement | null>;
    const rows = [row("assistant-tail", 120)];

    const loadedTranscript = createLoadedTranscriptState(SESSION_ID, 1);
    const { result, unmount } = renderHook(() =>
      useTranscriptVirtualTimeline({
        loadedTranscript,
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
    });
    const pendingMeasurementFrameCount = frameCallbacks.length;
    expect(pendingMeasurementFrameCount).toBeGreaterThan(0);
    expect(vi.getTimerCount()).toBe(1);

    unmount();

    expect(frameCallbacks.length).toBeLessThan(pendingMeasurementFrameCount);
    expect(cancelAnimationFrame).toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("replaces fallback runtime state when the session changes", async () => {
    const container = createContainer();
    const containerRef = {
      current: container,
    } satisfies RefObject<HTMLDivElement | null>;
    const rows = [row("assistant-tail", 120)];
    const { result, rerender } = renderHook(
      ({ sessionId }: { sessionId: string }) =>
        useTranscriptVirtualTimeline({
          sessionId,
          sessionEpoch: 1,
          rows,
          containerRef,
          footerHeight: 0,
        }),
      { initialProps: { sessionId: SESSION_ID } },
    );
    const firstControllerState = result.current.snapshot.controllerState;
    const firstRegistry = result.current.rowStateProvider.registry;

    await act(async () => {
      result.current.measureRowElement(
        "assistant-tail",
        createMeasuredElement(240),
      );
    });
    const pendingFrameId = frameCallbacks.at(-1)?.id;
    expect(pendingFrameId).toBeDefined();

    await act(async () => {
      rerender({ sessionId: "session-b" });
    });

    expect(result.current.snapshot.controllerState).not.toBe(
      firstControllerState,
    );
    expect(result.current.snapshot.controllerState.sessionId).toBe("session-b");
    expect(result.current.rowStateProvider.registry).not.toBe(firstRegistry);
    expect(cancelAnimationFrame).toHaveBeenCalledWith(pendingFrameId);
    expect(frameCallbacks.some((frame) => frame.id === pendingFrameId)).toBe(
      false,
    );
  });

  it("models each loaded transcript as one independently replaceable state value", () => {
    const first = createLoadedTranscriptState(SESSION_ID, 1);
    const replacement = createLoadedTranscriptState(SESSION_ID, 1);

    first.virtualTimeline.rows = [row("retained-only-by-first", 120)];
    first.virtualTimeline.pendingVisibleMeasurementElements.set(
      "retained-only-by-first",
      document.createElement("div"),
    );

    expect(replacement).not.toBe(first);
    expect(replacement.id).not.toBe(first.id);
    expect(replacement.virtualTimeline).not.toBe(first.virtualTimeline);
    expect(replacement.projectionCache).not.toBe(first.projectionCache);
    expect(replacement.virtualTimeline.rows).toEqual([]);
    expect(
      replacement.virtualTimeline.pendingVisibleMeasurementElements,
    ).toEqual(new Map());
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

  it("force-refreshes the virtual range when DOM geometry is unchanged", async () => {
    const container = createContainer();
    const containerRef = {
      current: container,
    } satisfies RefObject<HTMLDivElement | null>;
    const rows = Array.from({ length: 20 }, (_, index) =>
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
    const initialSnapshot = result.current.snapshot;
    const expectedRenderedRowIds = [...initialSnapshot.range.renderedRowIds];
    const initialViewportUpdates =
      initialSnapshot.controllerDiagnostics.viewportUpdates;
    // Model the failure under recovery: React still holds a stale published
    // range while browser and controller viewport geometry agree.
    (
      initialSnapshot.range as {
        renderedRowIds: readonly string[];
      }
    ).renderedRowIds = ["stale-row"];

    await act(async () => {
      result.current.syncViewportFromDom({ source: "browser" });
    });
    expect(result.current.snapshot).toBe(initialSnapshot);
    expect(result.current.snapshot.range.renderedRowIds).toEqual(["stale-row"]);
    expect(result.current.snapshot.controllerDiagnostics.viewportUpdates).toBe(
      initialViewportUpdates,
    );

    await act(async () => {
      result.current.syncViewportFromDom({
        source: "browser",
        forceRangeRefresh: true,
      });
    });

    // A real engine sync clears both the controller's last range and the
    // adapter's range selection before rebuilding and committing the snapshot.
    expect(result.current.snapshot).not.toBe(initialSnapshot);
    expect(
      result.current.snapshot.controllerDiagnostics.viewportUpdates,
    ).toBeGreaterThan(initialViewportUpdates);
    expect(result.current.snapshot.range.renderedRowIds).toEqual(
      expectedRenderedRowIds,
    );
  });

  it("publishes a forced range refresh from a keepalive replacement controller", async () => {
    const now = vi.spyOn(performance, "now").mockReturnValue(1_000);
    const container = createContainer();
    const containerRef = {
      current: container,
    } satisfies RefObject<HTMLDivElement | null>;
    const rows = Array.from({ length: 20 }, (_, index) =>
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

    await act(async () => {
      result.current.rowStateControls.markRowInteracted("row-19", {
        nowMs: 1_000,
        ttlMs: 100,
      });
    });
    expect(result.current.snapshot.range.protectedRowIds).toContain("row-19");

    const protectedSnapshot = result.current.snapshot;
    (
      protectedSnapshot.range as {
        renderedRowIds: readonly string[];
      }
    ).renderedRowIds = ["stale-row"];
    now.mockReturnValue(1_200);

    await act(async () => {
      result.current.syncViewportFromDom({
        source: "browser",
        forceRangeRefresh: true,
      });
    });

    // Expiring the keepalive makes commitSnapshot replace the controller. The
    // forced rebuild must use that retained replacement, not the captured
    // controller that still protects row-19.
    expect(result.current.snapshot).not.toBe(protectedSnapshot);
    expect(result.current.snapshot.range.renderedRowIds).not.toContain(
      "stale-row",
    );
    expect(result.current.snapshot.range.protectedRowIds).not.toContain(
      "row-19",
    );
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

  it("does not replay measurement corrections over in-flight user scroll intent", async () => {
    const container = createContainer({ scrollHeight: 1000 });
    const containerRef = {
      current: container,
    } satisfies RefObject<HTMLDivElement | null>;
    const rows = Array.from({ length: 5 }, (_, index) =>
      row(`row-${index}`, 200),
    );
    let preserveUserViewport = false;

    const { result } = renderHook(() =>
      useTranscriptVirtualTimeline({
        sessionId: SESSION_ID,
        sessionEpoch: 1,
        rows,
        containerRef,
        footerHeight: 0,
        shouldPreserveLiveScrollPosition: () => preserveUserViewport,
      }),
    );

    await act(async () => {
      container.scrollTop = 500;
      result.current.syncViewportFromDom({
        source: "browser",
        userScrollIntent: true,
      });
    });

    // The browser moves first; the React detached-state update that normally
    // enables preserveScrollPosition has not committed yet.
    container.scrollTop = 300;
    preserveUserViewport = true;

    await act(async () => {
      result.current.measureRowElement("row-4", createMeasuredElement(300));
      runPendingFrames();
    });

    expect(container.scrollTop).toBe(300);
    expect(result.current.snapshot.controllerState.scrollTop).toBe(300);
  });

  it("does not replay row-update corrections over in-flight user scroll intent", async () => {
    const container = createContainer({ scrollHeight: 1200 });
    const containerRef = {
      current: container,
    } satisfies RefObject<HTMLDivElement | null>;
    const initialRows = Array.from({ length: 5 }, (_, index) =>
      row(`row-${index}`, 200),
    );
    let preserveUserViewport = false;

    const { result, rerender } = renderHook(
      ({ rows }: { rows: readonly TranscriptRowDescriptor[] }) =>
        useTranscriptVirtualTimeline({
          sessionId: SESSION_ID,
          sessionEpoch: 1,
          rows,
          containerRef,
          footerHeight: 0,
          shouldPreserveLiveScrollPosition: () => preserveUserViewport,
        }),
      { initialProps: { rows: initialRows } },
    );

    await act(async () => {
      container.scrollTop = 500;
      result.current.syncViewportFromDom({
        source: "browser",
        userScrollIntent: true,
      });
    });

    container.scrollTop = 300;
    preserveUserViewport = true;

    await act(async () => {
      rerender({ rows: [...initialRows, row("new-row", 200)] });
    });

    expect(container.scrollTop).toBe(300);
    expect(result.current.snapshot.controllerState.scrollTop).toBe(300);
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

function createContainer({
  scrollHeight = 300,
}: {
  scrollHeight?: number;
} = {}): HTMLDivElement {
  const container = document.createElement("div");
  Object.defineProperties(container, {
    clientHeight: { configurable: true, value: 300 },
    clientWidth: { configurable: true, value: 720 },
    scrollHeight: { configurable: true, value: scrollHeight },
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

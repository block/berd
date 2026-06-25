import { act, render, renderHook, waitFor } from "@testing-library/react";
import { useLayoutEffect, useRef, type RefObject } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TranscriptRowDescriptor } from "../../projection/transcriptItemTypes";
import {
  getSelectionRangeViewportOffset,
  useTranscriptVirtualTimeline,
  type TranscriptVirtualTimelineSnapshot,
} from "./useTranscriptVirtualTimeline";
import { TRANSCRIPT_SELECTION_SURFACE_ATTRIBUTES } from "../transcriptSelectionSurface";

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

  it("reads a selection range offset relative to the transcript viewport", () => {
    const container = createContainer();
    setElementRect(container, { top: 25, height: 300 });
    const textNode = document.createTextNode("selected text");
    container.appendChild(textNode);
    const selection = {
      anchorNode: textNode,
      focusNode: textNode,
      isCollapsed: false,
      rangeCount: 1,
      getRangeAt: () =>
        ({
          getBoundingClientRect: () =>
            ({
              bottom: 141,
              height: 16,
              left: 0,
              right: 120,
              top: 125,
              width: 120,
              x: 0,
              y: 125,
              toJSON: () => ({}),
            }) as DOMRect,
        }) as Range,
    } as unknown as Selection;

    expect(getSelectionRangeViewportOffset(selection, container)).toBe(100);
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

  it("pins selection-spanned rows into the protected set during a drag-select", async () => {
    const container = createContainer();
    const containerRef = {
      current: container,
    } satisfies RefObject<HTMLDivElement | null>;
    const rows = [row("intro", 100), row("middle", 120), row("tail", 140)];

    const introEl = appendRowElement(container, "intro", "intro row text");
    appendRowElement(container, "middle", "middle row text");
    const tailEl = appendRowElement(container, "tail", "tail row text");

    const { result } = renderHook(() =>
      useTranscriptVirtualTimeline({
        sessionId: SESSION_ID,
        sessionEpoch: 1,
        rows,
        containerRef,
        footerHeight: 0,
      }),
    );

    expect(result.current.snapshot.range.protectedRowIds).toEqual([]);

    await act(async () => {
      const range = document.createRange();
      range.setStart(introEl.firstChild as Text, 0);
      range.setEnd(tailEl.firstChild as Text, "tail".length);
      const selection = document.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
      document.dispatchEvent(new Event("selectionchange"));
    });

    expect(result.current.snapshot.range.protectedRowIds).toEqual(
      expect.arrayContaining(["intro", "middle", "tail"]),
    );

    await act(async () => {
      document.getSelection()?.removeAllRanges();
      document.dispatchEvent(new Event("selectionchange"));
    });

    expect(result.current.snapshot.range.protectedRowIds).toEqual([]);
  });

  it("limits long selection spans to endpoint rows", async () => {
    const container = createContainer();
    const containerRef = {
      current: container,
    } satisfies RefObject<HTMLDivElement | null>;
    const rows = Array.from({ length: 7 }, (_, index) =>
      row(`row-${index}`, 100 + index),
    );

    const firstEl = appendRowElement(container, "row-0", "first row text");
    const lastEl = appendRowElement(container, "row-6", "last row text");

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
      const range = document.createRange();
      range.setStart(firstEl.firstChild as Text, 0);
      range.setEnd(lastEl.firstChild as Text, "last".length);
      const selection = document.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
      document.dispatchEvent(new Event("selectionchange"));
    });

    expect(result.current.snapshot.selectionPinnedRowIds).toEqual([
      "row-0",
      "row-6",
    ]);
    expect(result.current.snapshot.range.protectedRowIds).toEqual([
      "row-0",
      "row-6",
    ]);
    expect(result.current.snapshot.range.protectedRowIds).not.toContain(
      "row-3",
    );

    await act(async () => {
      document.getSelection()?.removeAllRanges();
      document.dispatchEvent(new Event("selectionchange"));
    });

    expect(result.current.snapshot.range.protectedRowIds).toEqual([]);
  });

  it("does not keep stale focus rows protected while extending a long drag-select", async () => {
    const container = createContainer();
    const containerRef = {
      current: container,
    } satisfies RefObject<HTMLDivElement | null>;
    const rows = Array.from({ length: 6 }, (_, index) =>
      row(`row-${index}`, 100 + index),
    );
    const rowElements = rows.map((transcriptRow) =>
      appendRowElement(
        container,
        transcriptRow.rowId,
        `${transcriptRow.rowId} text`,
      ),
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
      container.dispatchEvent(new Event("pointerdown", { bubbles: true }));
      const range = document.createRange();
      range.setStart(rowElements[0].firstChild as Text, 0);
      range.setEnd(rowElements[2].firstChild as Text, "row-2".length);
      const selection = document.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
      document.dispatchEvent(new Event("selectionchange"));
    });

    expect(result.current.snapshot.selectionPinnedRowIds).toEqual([
      "row-0",
      "row-1",
      "row-2",
    ]);
    expect(result.current.snapshot.range.protectedRowIds).toEqual([
      "row-0",
      "row-1",
      "row-2",
    ]);

    await act(async () => {
      const range = document.createRange();
      range.setStart(rowElements[0].firstChild as Text, 0);
      range.setEnd(rowElements[5].firstChild as Text, "row-5".length);
      const selection = document.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
      document.dispatchEvent(new Event("selectionchange"));
    });

    expect(result.current.snapshot.selectionPinnedRowIds).toEqual([
      "row-0",
      "row-5",
    ]);
    expect(result.current.snapshot.range.protectedRowIds).toEqual([
      "row-0",
      "row-5",
    ]);

    await act(async () => {
      document.dispatchEvent(new Event("pointerup"));
      document.getSelection()?.removeAllRanges();
      document.dispatchEvent(new Event("selectionchange"));
    });
  });

  it("skips oversized rows when protecting a drag-select", async () => {
    const container = createContainer();
    setElementRect(container, { top: 0, height: 300 });
    const containerRef = {
      current: container,
    } satisfies RefObject<HTMLDivElement | null>;
    const rows = [row("huge", 100), row("tail", 120)];

    const hugeEl = appendRowElement(container, "huge", "huge row text");
    const tailEl = appendRowElement(container, "tail", "tail row text");
    setElementRect(hugeEl, { top: 0, height: 5000 });
    setElementRect(tailEl, { top: 120, height: 40 });

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
      hugeEl.dispatchEvent(new Event("pointerdown", { bubbles: true }));
      const range = document.createRange();
      range.setStart(hugeEl.firstChild as Text, 0);
      range.setEnd(tailEl.firstChild as Text, "tail".length);
      const selection = document.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
      document.dispatchEvent(new Event("selectionchange"));
    });

    expect(result.current.snapshot.selectionPinnedRowIds).toEqual(["tail"]);
    expect(result.current.snapshot.range.protectedRowIds).toContain("tail");
    expect(result.current.snapshot.range.protectedRowIds).not.toContain("huge");

    await act(async () => {
      document.dispatchEvent(new Event("pointerup"));
      document.getSelection()?.removeAllRanges();
      document.dispatchEvent(new Event("selectionchange"));
    });
    document.getSelection()?.removeAllRanges();
  });

  it("skips streaming tail rows when protecting a drag-select", async () => {
    const container = createContainer();
    setElementRect(container, { top: 0, height: 300 });
    const containerRef = {
      current: container,
    } satisfies RefObject<HTMLDivElement | null>;
    const streamTailRowId = "message:assistant:stream-tail";
    const rows = [
      row("start", 100),
      row("middle", 120),
      row(streamTailRowId, 140, {
        kind: "assistant-content-fragment",
        fragment: {
          fragmentId: "stream-tail",
          fragmentIndex: 1,
          fragmentCount: 2,
          role: "end",
          content: [],
          isStreamingTail: false,
          messageScrollTarget: true,
          isCodeContinuationChunk: false,
          startsWithHeading: false,
        },
      }),
    ];

    const startEl = appendRowElement(container, "start", "start row text");
    const middleEl = appendRowElement(container, "middle", "middle row text");
    const streamTailEl = appendRowElement(
      container,
      streamTailRowId,
      "stream tail row text",
    );
    setElementRect(startEl, { top: 0, height: 40 });
    setElementRect(middleEl, { top: 80, height: 40 });
    setElementRect(streamTailEl, { top: 140, height: 40 });

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
      startEl.dispatchEvent(new Event("pointerdown", { bubbles: true }));
      const range = document.createRange();
      range.setStart(startEl.firstChild as Text, 0);
      range.setEnd(streamTailEl.firstChild as Text, "stream tail".length);
      const selection = document.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
      document.dispatchEvent(new Event("selectionchange"));
    });

    expect(result.current.snapshot.selectionPinnedRowIds).toEqual(["middle"]);
    expect(result.current.snapshot.range.protectedRowIds).toContain("middle");
    expect(result.current.snapshot.range.protectedRowIds).not.toContain(
      streamTailRowId,
    );

    await act(async () => {
      document.dispatchEvent(new Event("pointerup"));
      document.getSelection()?.removeAllRanges();
      document.dispatchEvent(new Event("selectionchange"));
    });
    document.getSelection()?.removeAllRanges();
  });

  it("does not protect the pointer-down row for same-row drag-selects", async () => {
    const container = createContainer();
    const containerRef = {
      current: container,
    } satisfies RefObject<HTMLDivElement | null>;
    const rows = [row("intro", 100), row("second", 120), row("tail", 140)];

    const introEl = appendRowElement(container, "intro", "intro row text");
    const secondEl = appendRowElement(container, "second", "second row text");
    setElementRect(container, { top: 0, height: 300 });
    setElementRect(introEl, { top: 80, height: 40 });
    setElementRect(secondEl, { top: 140, height: 40 });

    const { result } = renderHook(() =>
      useTranscriptVirtualTimeline({
        sessionId: SESSION_ID,
        sessionEpoch: 1,
        rows,
        containerRef,
        footerHeight: 0,
      }),
    );

    expect(result.current.snapshot.range.protectedRowIds).toEqual([]);

    await act(async () => {
      introEl.dispatchEvent(new Event("pointerdown", { bubbles: true }));
      const range = document.createRange();
      range.setStart(introEl.firstChild as Text, 0);
      range.setEnd(introEl.firstChild as Text, "intro".length);
      const selection = document.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
      document.dispatchEvent(new Event("selectionchange"));
    });

    expect(result.current.snapshot.selectionPinnedRowIds).toEqual([]);
    expect(result.current.snapshot.range.protectedRowIds).toEqual([]);

    await act(async () => {
      document.dispatchEvent(new Event("pointerup"));
      document.getSelection()?.removeAllRanges();
      document.dispatchEvent(new Event("selectionchange"));
    });
    document.getSelection()?.removeAllRanges();
  });

  it("does not pin rows for drag-selects that start on the timeline gutter", async () => {
    const container = createContainer();
    const containerRef = {
      current: container,
    } satisfies RefObject<HTMLDivElement | null>;
    const rows = [row("intro", 100), row("second", 120), row("tail", 140)];

    const introEl = appendRowElement(container, "intro", "intro row text");
    appendRowElement(container, "second", "second row text");
    const tailEl = appendRowElement(container, "tail", "tail row text");
    const timelineGutter = appendTimelineGutter(container);

    const { result } = renderHook(() =>
      useTranscriptVirtualTimeline({
        sessionId: SESSION_ID,
        sessionEpoch: 1,
        rows,
        containerRef,
        footerHeight: 0,
      }),
    );

    expect(result.current.snapshot.range.protectedRowIds).toEqual([]);

    await act(async () => {
      timelineGutter.dispatchEvent(new Event("pointerdown", { bubbles: true }));
      const range = document.createRange();
      range.setStart(introEl.firstChild as Text, 0);
      range.setEnd(tailEl.firstChild as Text, "tail".length);
      const selection = document.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
      document.dispatchEvent(new Event("selectionchange"));
    });

    expect(result.current.snapshot.selectionPinnedRowIds).toEqual([]);
    expect(result.current.snapshot.range.protectedRowIds).toEqual([]);

    await act(async () => {
      document.dispatchEvent(new Event("pointerup"));
      document.getSelection()?.removeAllRanges();
      document.dispatchEvent(new Event("selectionchange"));
    });
    document.getSelection()?.removeAllRanges();
  });

  it("does not treat timeline test ids as gutter selection surfaces", async () => {
    const container = createContainer();
    const containerRef = {
      current: container,
    } satisfies RefObject<HTMLDivElement | null>;
    const rows = [row("intro", 100), row("second", 120), row("tail", 140)];

    const introEl = appendRowElement(container, "intro", "intro row text");
    appendRowElement(container, "second", "second row text");
    const tailEl = appendRowElement(container, "tail", "tail row text");
    const timelineGutter = document.createElement("div");
    timelineGutter.setAttribute("data-testid", "virtual-message-timeline-list");
    container.appendChild(timelineGutter);

    const { result } = renderHook(() =>
      useTranscriptVirtualTimeline({
        sessionId: SESSION_ID,
        sessionEpoch: 1,
        rows,
        containerRef,
        footerHeight: 0,
      }),
    );

    expect(result.current.snapshot.range.protectedRowIds).toEqual([]);

    await act(async () => {
      timelineGutter.dispatchEvent(new Event("pointerdown", { bubbles: true }));
      const range = document.createRange();
      range.setStart(introEl.firstChild as Text, 0);
      range.setEnd(tailEl.firstChild as Text, "tail".length);
      const selection = document.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
      document.dispatchEvent(new Event("selectionchange"));
    });

    expect(result.current.snapshot.selectionPinnedRowIds).toEqual([
      "intro",
      "second",
      "tail",
    ]);
    expect(result.current.snapshot.range.protectedRowIds).toEqual([
      "intro",
      "second",
      "tail",
    ]);

    await act(async () => {
      document.dispatchEvent(new Event("pointerup"));
      document.getSelection()?.removeAllRanges();
      document.dispatchEvent(new Event("selectionchange"));
    });
    document.getSelection()?.removeAllRanges();
  });

  it("clears gutter-origin selection safe mode on pointer release", async () => {
    const container = createContainer();
    const containerRef = {
      current: container,
    } satisfies RefObject<HTMLDivElement | null>;
    const createRows = (activeRowId: string) =>
      Array.from({ length: 8 }, (_, index) =>
        row(`row-${index}`, 120, {
          keepAlivePriority:
            `row-${index}` === activeRowId ? "active-stream" : "none",
        }),
      );

    const firstSelectedEl = appendRowElement(
      container,
      "row-6",
      "selected row six text",
    );
    const lastSelectedEl = appendRowElement(
      container,
      "row-7",
      "selected row seven text",
    );
    const timelineGutter = appendTimelineGutter(container);

    const { result, rerender } = renderHook(
      ({ rows }: { rows: readonly TranscriptRowDescriptor[] }) =>
        useTranscriptVirtualTimeline({
          sessionId: SESSION_ID,
          sessionEpoch: 1,
          rows,
          containerRef,
          footerHeight: 0,
        }),
      { initialProps: { rows: createRows("row-0") } },
    );

    expect(result.current.snapshot.range.protectedRowIds).toContain("row-0");

    await act(async () => {
      timelineGutter.dispatchEvent(new Event("pointerdown", { bubbles: true }));
      const range = document.createRange();
      range.setStart(firstSelectedEl.firstChild as Text, 0);
      range.setEnd(lastSelectedEl.firstChild as Text, "selected".length);
      const selection = document.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
      document.dispatchEvent(new Event("selectionchange"));
    });

    expect(result.current.snapshot.selectionPinnedRowIds).toEqual([]);
    expect(result.current.snapshot.range.protectedRowIds).toContain("row-0");
    expect(result.current.snapshot.range.protectedRowIds).not.toContain(
      "row-6",
    );
    expect(result.current.snapshot.range.protectedRowIds).not.toContain(
      "row-7",
    );

    await act(async () => {
      document.dispatchEvent(new Event("pointerup"));
    });

    await act(async () => {
      rerender({ rows: createRows("row-1") });
    });

    expect(result.current.snapshot.selectionPinnedRowIds).toEqual([]);
    expect(result.current.snapshot.range.protectedRowIds).toContain("row-1");
    expect(result.current.snapshot.range.protectedRowIds).not.toContain(
      "row-0",
    );

    document.getSelection()?.removeAllRanges();
  });

  it("does not pin rows when replacing a selection from the timeline gutter", async () => {
    const container = createContainer();
    const containerRef = {
      current: container,
    } satisfies RefObject<HTMLDivElement | null>;
    const rows = [
      row("previous", 80),
      row("intro", 100),
      row("second", 120),
      row("tail", 140),
    ];

    const previousEl = appendRowElement(
      container,
      "previous",
      "previous row text",
    );
    const introEl = appendRowElement(container, "intro", "intro row text");
    appendRowElement(container, "second", "second row text");
    const tailEl = appendRowElement(container, "tail", "tail row text");
    const timelineGutter = appendTimelineGutter(container);

    const { result } = renderHook(() =>
      useTranscriptVirtualTimeline({
        sessionId: SESSION_ID,
        sessionEpoch: 1,
        rows,
        containerRef,
        footerHeight: 0,
      }),
    );

    expect(result.current.snapshot.range.protectedRowIds).toEqual([]);

    await act(async () => {
      const range = document.createRange();
      range.setStart(previousEl.firstChild as Text, 0);
      range.setEnd(previousEl.firstChild as Text, "previous".length);
      const selection = document.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
      document.dispatchEvent(new Event("selectionchange"));
    });

    expect(result.current.snapshot.selectionPinnedRowIds).toEqual(["previous"]);

    await act(async () => {
      timelineGutter.dispatchEvent(new Event("pointerdown", { bubbles: true }));
      const range = document.createRange();
      range.setStart(introEl.firstChild as Text, 0);
      range.setEnd(tailEl.firstChild as Text, "tail".length);
      const selection = document.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
      document.dispatchEvent(new Event("selectionchange"));
    });

    expect(result.current.snapshot.selectionPinnedRowIds).toEqual([]);
    expect(result.current.snapshot.range.protectedRowIds).not.toContain(
      "intro",
    );
    expect(result.current.snapshot.range.protectedRowIds).not.toContain("tail");

    await act(async () => {
      document.dispatchEvent(new Event("pointerup"));
      document.getSelection()?.removeAllRanges();
      document.dispatchEvent(new Event("selectionchange"));
    });
    document.getSelection()?.removeAllRanges();
  });

  it("does not pin replacement rows while clearing a selected drag-start row", async () => {
    const container = createContainer();
    const containerRef = {
      current: container,
    } satisfies RefObject<HTMLDivElement | null>;
    const rows = [row("start", 100), row("focus", 120), row("tail", 140)];

    const startEl = appendRowElement(container, "start", "start row text");
    const focusEl = appendRowElement(container, "focus", "focus row text");

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
      const range = document.createRange();
      range.setStart(startEl.firstChild as Text, 0);
      range.setEnd(startEl.firstChild as Text, "start".length);
      const selection = document.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
      document.dispatchEvent(new Event("selectionchange"));
    });

    expect(result.current.snapshot.selectionPinnedRowIds).toEqual(["start"]);
    expect(result.current.snapshot.range.protectedRowIds).toContain("start");

    await act(async () => {
      startEl.dispatchEvent(new Event("pointerdown", { bubbles: true }));
      const range = document.createRange();
      range.setStart(startEl.firstChild as Text, 0);
      range.setEnd(focusEl.firstChild as Text, "focus".length);
      const selection = document.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
      document.dispatchEvent(new Event("selectionchange"));
    });

    expect(result.current.snapshot.selectionPinnedRowIds).toEqual([]);
    expect(result.current.snapshot.range.protectedRowIds).not.toContain(
      "focus",
    );
    expect(result.current.snapshot.range.protectedRowIds).not.toContain(
      "start",
    );

    await act(async () => {
      document.dispatchEvent(new Event("pointerup"));
      document.getSelection()?.removeAllRanges();
      document.dispatchEvent(new Event("selectionchange"));
    });
    document.getSelection()?.removeAllRanges();
  });

  it("defers measurement commits during a drag-select", async () => {
    const container = createContainer();
    const containerRef = {
      current: container,
    } satisfies RefObject<HTMLDivElement | null>;
    const rows = [row("intro", 100), row("tail", 120)];

    // A selectable node inside the transcript that is not part of any virtual
    // row. Selecting it activates the secondary guard (a non-collapsed
    // in-transcript selection) without pinning row endpoints, isolating the
    // measurement-deferral behavior — endpoint pinning is covered above.
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

    // Begin a drag-select: a pointerdown inside the transcript arms the gesture,
    // then a non-collapsed in-transcript selection latches it active. The defer
    // is keyed on the gesture, not the selection alone (see the held-selection
    // case below), so the pointerdown is what engages it.
    await act(async () => {
      container.dispatchEvent(new Event("pointerdown", { bubbles: true }));
      const range = document.createRange();
      range.selectNodeContents(selectable);
      const selection = document.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
      document.dispatchEvent(new Event("selectionchange"));
    });

    const heightDuringSelection =
      result.current.snapshot.controllerState.virtualScrollHeight;

    // A measurement arriving mid-drag is deferred, not committed: committing
    // settles row heights, which changes content height above the viewport and
    // clamps scrollTop under the drag.
    await act(async () => {
      result.current.measureRowElement("tail", createMeasuredElement(240));
      runPendingFrames();
    });

    expect(
      result.current.snapshot.measurementStats.visibleMeasurementAttempts,
    ).toBe(0);
    expect(result.current.snapshot.controllerState.virtualScrollHeight).toBe(
      heightDuringSelection,
    );

    // Pointer release drains the queued measurements even if the browser still
    // has a live Range. The held selection keeps its endpoint rows protected,
    // but it must not keep the controller stuck on stale measurements.
    await act(async () => {
      document.dispatchEvent(new Event("pointerup"));
    });

    await waitFor(() => {
      expect(
        result.current.snapshot.measurementStats.visibleMeasurementAttempts,
      ).toBe(1);
      expect(result.current.snapshot.controllerState.virtualScrollHeight).toBe(
        340,
      );
    });

    const attemptsAfterRelease =
      result.current.snapshot.measurementStats.visibleMeasurementAttempts;

    await act(async () => {
      document.getSelection()?.removeAllRanges();
      document.dispatchEvent(new Event("selectionchange"));
    });

    expect(
      result.current.snapshot.measurementStats.visibleMeasurementAttempts,
    ).toBe(attemptsAfterRelease);
    expect(result.current.snapshot.controllerState.virtualScrollHeight).toBe(
      340,
    );
  });

  it("commits measurements immediately for a held selection with no drag", async () => {
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

    // A non-collapsed in-transcript selection held WITHOUT an active drag (no
    // pointerdown) must not freeze measurement commits: a lingering drag-copy
    // left highlighted while content streams should let new rows settle. The
    // defer only engages during the pointer-down gesture.
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

  it("keeps scroll writes suspended while a click clears a held selection", async () => {
    const container = createContainer();
    const containerRef = {
      current: container,
    } satisfies RefObject<HTMLDivElement | null>;
    const rows = [row("intro", 100), row("tail", 120)];

    const introEl = appendRowElement(container, "intro", "intro row text");

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
      const range = document.createRange();
      range.setStart(introEl.firstChild as Text, 0);
      range.setEnd(introEl.firstChild as Text, "intro".length);
      const selection = document.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
      document.dispatchEvent(new Event("selectionchange"));
    });

    expect(result.current.snapshot.range.protectedRowIds).toContain("intro");

    await act(async () => {
      container.dispatchEvent(new Event("pointerdown", { bubbles: true }));
      container.scrollTop = 1000;
      document.getSelection()?.removeAllRanges();
      document.dispatchEvent(new Event("selectionchange"));
    });

    expect(result.current.snapshot.range.protectedRowIds).toContain("intro");
    expect(container.scrollTop).toBe(1000);

    await act(async () => {
      document.dispatchEvent(new Event("pointerup"));
    });

    expect(container.scrollTop).toBe(0);
    expect(result.current.snapshot.range.protectedRowIds).toEqual([]);
  });

  it("resumes scroll writes when a click-clear gesture loses window focus", async () => {
    const container = createContainer();
    const containerRef = {
      current: container,
    } satisfies RefObject<HTMLDivElement | null>;
    const rows = [row("intro", 100), row("tail", 120)];

    const introEl = appendRowElement(container, "intro", "intro row text");

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
      const range = document.createRange();
      range.setStart(introEl.firstChild as Text, 0);
      range.setEnd(introEl.firstChild as Text, "intro".length);
      const selection = document.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
      document.dispatchEvent(new Event("selectionchange"));
    });

    await act(async () => {
      container.dispatchEvent(new Event("pointerdown", { bubbles: true }));
      container.scrollTop = 1000;
      document.getSelection()?.removeAllRanges();
      document.dispatchEvent(new Event("selectionchange"));
    });

    expect(result.current.snapshot.range.protectedRowIds).toContain("intro");
    expect(container.scrollTop).toBe(1000);

    await act(async () => {
      window.dispatchEvent(new Event("blur"));
    });

    expect(container.scrollTop).toBe(0);
    expect(result.current.snapshot.range.protectedRowIds).toEqual([]);
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

  it("drains topology-deferred measurements after an ordinary transcript pointer release", async () => {
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
    });

    await act(async () => {
      result.current.measureRowElement("tail", createMeasuredElement(240));
      runPendingFrames();
    });

    expect(
      result.current.snapshot.measurementStats.visibleMeasurementAttempts,
    ).toBe(0);
    expect(result.current.snapshot.controllerState.virtualScrollHeight).toBe(
      220,
    );

    await act(async () => {
      document.dispatchEvent(new Event("pointerup"));
    });

    expect(
      result.current.snapshot.measurementStats.visibleMeasurementAttempts,
    ).toBe(1);
    expect(result.current.snapshot.controllerState.virtualScrollHeight).toBe(
      340,
    );
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
    expect(result.current.snapshot.fallbackReasons).not.toContain(
      "selection-safe-mode",
    );
    expect(result.current.snapshot.range.protectedRowIds).toEqual(["intro"]);

    await act(async () => {
      document.dispatchEvent(new Event("pointerup"));
    });

    expect(result.current.snapshot.mode).toBe("bounded-controller");
    expect(result.current.snapshot.fallbackReasons).not.toContain(
      "selection-safe-mode",
    );
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

  it("defers cached measurement replay during selection topology freeze", async () => {
    const container = createContainer();
    const containerRef = {
      current: container,
    } satisfies RefObject<HTMLDivElement | null>;
    const rows = Array.from({ length: 8 }, (_, index) =>
      row(`row-${index}`, 200),
    );

    const firstSelectedEl = appendRowElement(
      container,
      "row-6",
      "selected row six text",
    );
    const lastSelectedEl = appendRowElement(
      container,
      "row-7",
      "selected row seven text",
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
    const flushedBeforeSelection =
      result.current.snapshot.measurementStats.controllerUpdatesFlushed;
    const scrollTopBeforeSelection = container.scrollTop;

    await act(async () => {
      container.dispatchEvent(new Event("pointerdown", { bubbles: true }));
      const range = document.createRange();
      range.setStart(firstSelectedEl.firstChild as Text, 0);
      range.setEnd(lastSelectedEl.firstChild as Text, "selected".length);
      const selection = document.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
      document.dispatchEvent(new Event("selectionchange"));
    });

    expect(result.current.snapshot.mode).toBe("bounded-controller");
    expect(result.current.snapshot.fallbackReasons).not.toContain(
      "selection-safe-mode",
    );
    expect(result.current.snapshot.selectionPinnedRowIds).toEqual(
      expect.arrayContaining(["row-6", "row-7"]),
    );
    expect(result.current.snapshot.range.protectedRowIds).toEqual([
      "row-6",
      "row-7",
    ]);
    expect(result.current.snapshot.controllerState.virtualScrollHeight).toBe(
      800,
    );
    expect(container.scrollTop).toBe(scrollTopBeforeSelection);
    expect(
      result.current.snapshot.measurementStats.controllerUpdatesFlushed,
    ).toBe(flushedBeforeSelection);

    await act(async () => {
      rerender({ protectedRowIds: ["row-0"] });
    });

    expect(result.current.snapshot.mode).toBe("bounded-controller");
    expect(result.current.snapshot.range.protectedRowIds).toEqual([
      "row-0",
      "row-6",
      "row-7",
    ]);
    expect(result.current.snapshot.controllerState.virtualScrollHeight).toBe(
      800,
    );
    expect(
      result.current.snapshot.measurementStats.controllerUpdatesFlushed,
    ).toBe(flushedBeforeSelection);

    await act(async () => {
      document.dispatchEvent(new Event("pointerup"));
    });

    expect(
      result.current.snapshot.measurementStats.controllerUpdatesFlushed,
    ).toBe(flushedBeforeSelection);
    const flushedAfterRelease =
      result.current.snapshot.measurementStats.controllerUpdatesFlushed;

    await act(async () => {
      document.getSelection()?.removeAllRanges();
      document.dispatchEvent(new Event("selectionchange"));
    });

    expect(
      result.current.snapshot.measurementStats.controllerUpdatesFlushed,
    ).toBeGreaterThan(flushedAfterRelease);

    document.getSelection()?.removeAllRanges();
  });

  it("freezes keep-alive protections during a drag-select", async () => {
    const container = createContainer();
    const containerRef = {
      current: container,
    } satisfies RefObject<HTMLDivElement | null>;
    const createRows = (activeRowId: string) =>
      Array.from({ length: 8 }, (_, index) =>
        row(`row-${index}`, 120, {
          keepAlivePriority:
            `row-${index}` === activeRowId ? "active-stream" : "none",
        }),
      );
    const firstSelectedEl = appendRowElement(
      container,
      "row-6",
      "selected row six text",
    );
    const lastSelectedEl = appendRowElement(
      container,
      "row-7",
      "selected row seven text",
    );

    const { result, rerender } = renderHook(
      ({ rows }: { rows: readonly TranscriptRowDescriptor[] }) =>
        useTranscriptVirtualTimeline({
          sessionId: SESSION_ID,
          sessionEpoch: 1,
          rows,
          containerRef,
          footerHeight: 0,
        }),
      { initialProps: { rows: createRows("row-0") } },
    );

    expect(result.current.snapshot.range.protectedRowIds).toContain("row-0");

    await act(async () => {
      container.dispatchEvent(new Event("pointerdown", { bubbles: true }));
      const range = document.createRange();
      range.setStart(firstSelectedEl.firstChild as Text, 0);
      range.setEnd(lastSelectedEl.firstChild as Text, "selected".length);
      const selection = document.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
      document.dispatchEvent(new Event("selectionchange"));
    });

    expect(result.current.snapshot.mode).toBe("bounded-controller");
    expect(result.current.snapshot.fallbackReasons).not.toContain(
      "selection-safe-mode",
    );
    expect(result.current.snapshot.selectionPinnedRowIds).toEqual(
      expect.arrayContaining(["row-6", "row-7"]),
    );
    expect(result.current.snapshot.range.protectedRowIds).toEqual([
      "row-0",
      "row-6",
      "row-7",
    ]);

    await act(async () => {
      rerender({ rows: createRows("row-1") });
    });

    expect(result.current.snapshot.selectionPinnedRowIds).toEqual(
      expect.arrayContaining(["row-6", "row-7"]),
    );
    expect(result.current.snapshot.range.protectedRowIds).toContain("row-0");
    expect(result.current.snapshot.range.protectedRowIds).not.toContain(
      "row-1",
    );

    await act(async () => {
      document.dispatchEvent(new Event("pointerup"));
    });

    expect(result.current.snapshot.selectionPinnedRowIds).toEqual(
      expect.arrayContaining(["row-6", "row-7"]),
    );
    expect(result.current.snapshot.range.protectedRowIds).toContain("row-0");
    expect(result.current.snapshot.range.protectedRowIds).not.toContain(
      "row-1",
    );

    await act(async () => {
      document.getSelection()?.removeAllRanges();
      document.dispatchEvent(new Event("selectionchange"));
    });

    expect(result.current.snapshot.range.protectedRowIds).toEqual(
      expect.arrayContaining(["row-1"]),
    );
    expect(result.current.snapshot.range.protectedRowIds).not.toContain(
      "row-0",
    );

    document.getSelection()?.removeAllRanges();
  });

  it("keeps selection safe mode when a drag begins from protected-threshold fallback", () => {
    const container = createContainer();
    const containerRef = {
      current: container,
    } satisfies RefObject<HTMLDivElement | null>;
    const rows = Array.from({ length: 90 }, (_, index) =>
      row(`row-${index}`, 100, {
        keepAlivePriority: "active-stream",
      }),
    );
    const selectedEl = appendRowElement(
      container,
      "row-89",
      "selected row eighty nine text",
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

    expect(result.current.snapshot.mode).toBe("safe-degraded");
    expect(result.current.snapshot.fallbackReasons).toContain(
      "protected-row-fail-threshold",
    );
    const protectedBeforeSelection =
      result.current.snapshot.range.protectedRowIds;
    expect(protectedBeforeSelection).toHaveLength(rows.length);

    act(() => {
      container.dispatchEvent(new Event("pointerdown", { bubbles: true }));
      const range = document.createRange();
      range.setStart(selectedEl.firstChild as Text, 0);
      range.setEnd(selectedEl.firstChild as Text, 1);
      const selection = document.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
      document.dispatchEvent(new Event("selectionchange"));
    });

    expect(result.current.snapshot.mode).toBe("safe-degraded");
    expect(result.current.snapshot.fallbackReasons).toContain(
      "selection-safe-mode",
    );
    expect(result.current.snapshot.fallbackReasons).not.toContain(
      "protected-row-fail-threshold",
    );
    expect(result.current.snapshot.range.virtualItems).toHaveLength(
      rows.length,
    );
    expect(result.current.snapshot.range.protectedRowIds).toEqual(
      protectedBeforeSelection,
    );

    const selection = document.getSelection();
    expect(selection?.anchorNode).toBe(selectedEl.firstChild);
    expect(selection?.focusNode).toBe(selectedEl.firstChild);
    expect(selection?.toString()).toBe("s");

    act(() => {
      document.dispatchEvent(new Event("pointerup"));
    });

    expect(result.current.snapshot.mode).toBe("safe-degraded");
    expect(result.current.snapshot.fallbackReasons).toContain(
      "selection-safe-mode",
    );
    expect(result.current.snapshot.fallbackReasons).not.toContain(
      "protected-row-fail-threshold",
    );
    expect(result.current.snapshot.range.virtualItems).toHaveLength(
      rows.length,
    );
    expect(result.current.snapshot.range.protectedRowIds).toEqual(
      protectedBeforeSelection,
    );

    act(() => {
      document.getSelection()?.removeAllRanges();
      document.dispatchEvent(new Event("selectionchange"));
    });

    expect(result.current.snapshot.mode).toBe("safe-degraded");
    expect(result.current.snapshot.fallbackReasons).toContain(
      "protected-row-fail-threshold",
    );
  });

  it("defers measurement commits while a click clears a held selection", async () => {
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

    await act(async () => {
      const range = document.createRange();
      range.selectNodeContents(selectable);
      const selection = document.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
      document.dispatchEvent(new Event("selectionchange"));
    });

    const heightBeforeClear =
      result.current.snapshot.controllerState.virtualScrollHeight;

    await act(async () => {
      container.dispatchEvent(new Event("pointerdown", { bubbles: true }));
      document.getSelection()?.removeAllRanges();
      document.dispatchEvent(new Event("selectionchange"));
      result.current.measureRowElement("tail", createMeasuredElement(240));
      runPendingFrames();
    });

    expect(
      result.current.snapshot.measurementStats.visibleMeasurementAttempts,
    ).toBe(0);
    expect(result.current.snapshot.controllerState.virtualScrollHeight).toBe(
      heightBeforeClear,
    );

    await act(async () => {
      document.dispatchEvent(new Event("pointerup"));
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

  it("suspends scroll-position writes during a drag-select and reconciles on pointer release", async () => {
    const container = createContainer();
    const containerRef = {
      current: container,
    } satisfies RefObject<HTMLDivElement | null>;
    const rows = [row("intro", 100), row("tail", 120)];

    const introEl = appendRowElement(container, "intro", "intro row text");
    const tailEl = appendRowElement(container, "tail", "tail row text");

    const { result } = renderHook(() =>
      useTranscriptVirtualTimeline({
        sessionId: SESSION_ID,
        sessionEpoch: 1,
        rows,
        containerRef,
        footerHeight: 0,
      }),
    );

    // Baseline: with no drag-select, an out-of-range scrollTop is corrected back
    // to the valid range (content is shorter than the viewport, so max is 0).
    await act(async () => {
      container.scrollTop = 1000;
      result.current.syncViewportFromDom({
        source: "browser",
        userScrollIntent: true,
      });
    });
    expect(container.scrollTop).toBe(0);

    // Begin a drag-select spanning two rows: a pointerdown inside the transcript
    // arms the gesture, then a non-collapsed selection latches it and pins the
    // endpoints.
    await act(async () => {
      container.dispatchEvent(new Event("pointerdown", { bubbles: true }));
      const range = document.createRange();
      range.setStart(introEl.firstChild as Text, 0);
      range.setEnd(tailEl.firstChild as Text, "tail".length);
      const selection = document.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
      document.dispatchEvent(new Event("selectionchange"));
    });

    // Mid-drag the browser owns the viewport: an out-of-range scrollTop is left
    // where the (simulated) drag auto-scroll put it. Neither the engine's own
    // scrollTop write nor the hook's correction write fires, so a sync that would
    // normally clamp the viewport leaves it alone — we never fight the live drag.
    await act(async () => {
      container.scrollTop = 1000;
      result.current.syncViewportFromDom({
        source: "browser",
        userScrollIntent: true,
      });
    });
    expect(container.scrollTop).toBe(1000);

    // Pointer release ends the gesture, resumes writes, and re-anchors the
    // viewport back into the valid range in one pass — even though the selection
    // is still held (release, not clear, is the reconcile trigger now).
    await act(async () => {
      document.dispatchEvent(new Event("pointerup"));
    });
    expect(container.scrollTop).toBe(0);
  });

  it("preserves bottom anchoring during a bottom drag-select", async () => {
    const container = createContainer();
    const containerRef = {
      current: container,
    } satisfies RefObject<HTMLDivElement | null>;
    const rows = Array.from({ length: 10 }, (_, index) =>
      row(`row-${index}`, 100),
    );

    const firstSelectedEl = appendRowElement(
      container,
      "row-7",
      "selected row seven text",
    );
    const lastSelectedEl = appendRowElement(
      container,
      "row-9",
      "selected row nine text",
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

    expect(container.scrollTop).toBe(700);
    expect(result.current.snapshot.controllerState.anchor).toEqual({
      type: "bottom",
    });

    await act(async () => {
      container.dispatchEvent(new Event("pointerdown", { bubbles: true }));
      const range = document.createRange();
      range.setStart(firstSelectedEl.firstChild as Text, 0);
      range.setEnd(lastSelectedEl.firstChild as Text, "selected".length);
      const selection = document.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
      document.dispatchEvent(new Event("selectionchange"));
    });

    await act(async () => {
      // Native drag auto-scroll can try to move the browser viewport while the
      // controller still holds a bottom anchor. When the gesture started at the
      // bottom, sync restores the DOM to bottom instead of letting the transient
      // movement become visible or turn into a durable row anchor.
      container.scrollTop = 500;
      result.current.syncViewportFromDom({ source: "programmatic" });
    });

    expect(container.scrollTop).toBe(700);
    expect(result.current.snapshot.controllerState.scrollTop).toBe(700);
    expect(result.current.snapshot.controllerState.anchor).toEqual({
      type: "bottom",
    });

    await act(async () => {
      document.dispatchEvent(new Event("pointerup"));
    });

    expect(container.scrollTop).toBe(700);
    expect(result.current.snapshot.controllerState).toMatchObject({
      scrollTop: 700,
      anchor: { type: "bottom" },
      pinnedToBottom: true,
    });
  });

  it("keeps the selected row anchored without entering selection-safe degraded rendering", async () => {
    const rows = Array.from({ length: 20 }, (_, index) =>
      row(`row-${index}`, 100),
    );
    const timelineRef: {
      current: ReturnType<typeof useTranscriptVirtualTimeline> | null;
    } = { current: null };
    const containerRef: { current: HTMLDivElement | null } = { current: null };

    function Harness() {
      const hookContainerRef = useRef<HTMLDivElement | null>(null);
      const timeline = useTranscriptVirtualTimeline({
        sessionId: SESSION_ID,
        sessionEpoch: 1,
        rows,
        containerRef: hookContainerRef,
        footerHeight: 0,
      });
      const selectedOffset =
        timeline.snapshot.mode === "safe-degraded" ? 620 : 180;

      useLayoutEffect(() => {
        timelineRef.current = timeline;
      }, [timeline]);

      return (
        <div
          ref={(element) => {
            if (!element) {
              hookContainerRef.current = null;
              containerRef.current = null;
              return;
            }
            if (!element.hasAttribute("data-test-scroll-props")) {
              Object.defineProperties(element, {
                clientHeight: { configurable: true, value: 300 },
                clientWidth: { configurable: true, value: 720 },
                scrollHeight: { configurable: true, value: 2000 },
                scrollTop: { configurable: true, writable: true, value: 0 },
              });
              element.setAttribute("data-test-scroll-props", "true");
            }
            setElementRect(element, { top: 0, height: 300 });
            hookContainerRef.current = element;
            containerRef.current = element;
          }}
        >
          {rows.map((descriptor) => (
            <div
              key={descriptor.rowId}
              data-virtual-row-state-row-id={descriptor.rowId}
              ref={(element) => {
                if (
                  element &&
                  (descriptor.rowId === "row-6" || descriptor.rowId === "row-7")
                ) {
                  setElementRect(element, {
                    top: selectedOffset,
                    height: 40,
                  });
                }
              }}
            >
              selected text for {descriptor.rowId}
            </div>
          ))}
        </div>
      );
    }

    render(<Harness />);

    await waitFor(() => expect(timelineRef.current).not.toBeNull());
    const container = containerRef.current as HTMLDivElement;

    await act(async () => {
      container.scrollTop = 500;
      timelineRef.current?.syncViewportFromDom({
        source: "browser",
        userScrollIntent: true,
      });
    });

    expect(container.scrollTop).toBe(500);
    expect(timelineRef.current?.snapshot.controllerState.anchor).toMatchObject({
      type: "row",
    });

    const firstSelectedEl = container.querySelector(
      '[data-virtual-row-state-row-id="row-6"]',
    ) as HTMLElement;
    const lastSelectedEl = container.querySelector(
      '[data-virtual-row-state-row-id="row-7"]',
    ) as HTMLElement;

    await act(async () => {
      container.dispatchEvent(new Event("pointerdown", { bubbles: true }));
      const range = document.createRange();
      range.setStart(firstSelectedEl.firstChild as Text, 0);
      range.setEnd(lastSelectedEl.firstChild as Text, "selected".length);
      const selection = document.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
      document.dispatchEvent(new Event("selectionchange"));
    });

    expect(timelineRef.current?.snapshot.mode).toBe("bounded-controller");
    expect(timelineRef.current?.snapshot.fallbackReasons).not.toContain(
      "selection-safe-mode",
    );
    expect(timelineRef.current?.snapshot.selectionPinnedRowIds).toEqual(
      expect.arrayContaining(["row-6", "row-7"]),
    );
    expect(timelineRef.current?.snapshot.range.protectedRowIds).toEqual(
      expect.arrayContaining(["row-6", "row-7"]),
    );
    expect(container.scrollTop).toBe(500);
    expect(timelineRef.current?.snapshot.controllerState.scrollTop).toBe(500);

    document.getSelection()?.removeAllRanges();
  });

  it("restores the selected endpoint after a protected-row rebuild shifts mounted geometry", async () => {
    const rows = Array.from({ length: 20 }, (_, index) =>
      row(`row-${index}`, 100),
    );
    const timelineRef: {
      current: ReturnType<typeof useTranscriptVirtualTimeline> | null;
    } = { current: null };
    const containerRef: { current: HTMLDivElement | null } = { current: null };

    function Harness() {
      const hookContainerRef = useRef<HTMLDivElement | null>(null);
      const timeline = useTranscriptVirtualTimeline({
        sessionId: SESSION_ID,
        sessionEpoch: 1,
        rows,
        containerRef: hookContainerRef,
        footerHeight: 0,
      });
      const rowEightProtected =
        timeline.snapshot.range.protectedRowIds.includes("row-8");

      useLayoutEffect(() => {
        timelineRef.current = timeline;
      }, [timeline]);

      return (
        <div
          ref={(element) => {
            if (!element) {
              hookContainerRef.current = null;
              containerRef.current = null;
              return;
            }
            if (!element.hasAttribute("data-test-scroll-props")) {
              Object.defineProperties(element, {
                clientHeight: { configurable: true, value: 300 },
                clientWidth: { configurable: true, value: 720 },
                scrollHeight: { configurable: true, value: 2000 },
                scrollTop: { configurable: true, writable: true, value: 0 },
              });
              element.setAttribute("data-test-scroll-props", "true");
            }
            setElementRect(element, { top: 0, height: 300 });
            hookContainerRef.current = element;
            containerRef.current = element;
          }}
        >
          {rows.map((descriptor) => (
            <div
              key={descriptor.rowId}
              data-virtual-row-state-row-id={descriptor.rowId}
              ref={(element) => {
                if (!element) {
                  return;
                }
                if (descriptor.rowId === "row-7") {
                  setElementRect(element, { top: 140, height: 40 });
                }
                if (descriptor.rowId === "row-8") {
                  setElementRect(element, {
                    top: rowEightProtected ? 540 : 320,
                    height: 40,
                  });
                }
              }}
            >
              selected text for {descriptor.rowId}
            </div>
          ))}
        </div>
      );
    }

    render(<Harness />);

    await waitFor(() => expect(timelineRef.current).not.toBeNull());
    const container = containerRef.current as HTMLDivElement;

    await act(async () => {
      container.scrollTop = 500;
      timelineRef.current?.syncViewportFromDom({
        source: "browser",
        userScrollIntent: true,
      });
    });

    const firstSelectedEl = container.querySelector(
      '[data-virtual-row-state-row-id="row-7"]',
    ) as HTMLElement;
    const lastSelectedEl = container.querySelector(
      '[data-virtual-row-state-row-id="row-8"]',
    ) as HTMLElement;

    await act(async () => {
      container.dispatchEvent(new Event("pointerdown", { bubbles: true }));
      const range = document.createRange();
      range.setStart(firstSelectedEl.firstChild as Text, 0);
      range.setEnd(firstSelectedEl.firstChild as Text, "selected".length);
      const selection = document.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
      document.dispatchEvent(new Event("selectionchange"));
    });

    expect(container.scrollTop).toBe(500);
    expect(timelineRef.current?.snapshot.range.protectedRowIds).toContain(
      "row-7",
    );

    await act(async () => {
      const range = document.createRange();
      range.setStart(firstSelectedEl.firstChild as Text, 0);
      range.setEnd(lastSelectedEl.firstChild as Text, "selected".length);
      const selection = document.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
      document.dispatchEvent(new Event("selectionchange"));
    });

    expect(timelineRef.current?.snapshot.mode).toBe("bounded-controller");
    expect(timelineRef.current?.snapshot.range.protectedRowIds).toEqual(
      expect.arrayContaining(["row-7", "row-8"]),
    );
    expect(container.scrollTop).toBe(720);
    expect(timelineRef.current?.snapshot.controllerState.scrollTop).toBe(720);

    act(() => {
      document.dispatchEvent(new Event("pointerup"));
    });
    document.getSelection()?.removeAllRanges();
  });

  it("skips large protected-row viewport restores during drag-select", async () => {
    const rows = Array.from({ length: 20 }, (_, index) =>
      row(`row-${index}`, 100),
    );
    const timelineRef: {
      current: ReturnType<typeof useTranscriptVirtualTimeline> | null;
    } = { current: null };
    const containerRef: { current: HTMLDivElement | null } = { current: null };

    function Harness() {
      const hookContainerRef = useRef<HTMLDivElement | null>(null);
      const timeline = useTranscriptVirtualTimeline({
        sessionId: SESSION_ID,
        sessionEpoch: 1,
        rows,
        containerRef: hookContainerRef,
        footerHeight: 0,
      });
      const rowEightProtected =
        timeline.snapshot.range.protectedRowIds.includes("row-8");

      useLayoutEffect(() => {
        timelineRef.current = timeline;
      }, [timeline]);

      return (
        <div
          ref={(element) => {
            if (!element) {
              hookContainerRef.current = null;
              containerRef.current = null;
              return;
            }
            if (!element.hasAttribute("data-test-scroll-props")) {
              Object.defineProperties(element, {
                clientHeight: { configurable: true, value: 300 },
                clientWidth: { configurable: true, value: 720 },
                scrollHeight: { configurable: true, value: 2000 },
                scrollTop: { configurable: true, writable: true, value: 0 },
              });
              element.setAttribute("data-test-scroll-props", "true");
            }
            setElementRect(element, { top: 0, height: 300 });
            hookContainerRef.current = element;
            containerRef.current = element;
          }}
        >
          {rows.map((descriptor) => (
            <div
              key={descriptor.rowId}
              data-virtual-row-state-row-id={descriptor.rowId}
              ref={(element) => {
                if (!element) {
                  return;
                }
                if (descriptor.rowId === "row-7") {
                  setElementRect(element, { top: 140, height: 40 });
                }
                if (descriptor.rowId === "row-8") {
                  setElementRect(element, {
                    top: rowEightProtected ? 900 : 320,
                    height: 40,
                  });
                }
              }}
            >
              selected text for {descriptor.rowId}
            </div>
          ))}
        </div>
      );
    }

    render(<Harness />);

    await waitFor(() => expect(timelineRef.current).not.toBeNull());
    const container = containerRef.current as HTMLDivElement;

    await act(async () => {
      container.scrollTop = 500;
      timelineRef.current?.syncViewportFromDom({
        source: "browser",
        userScrollIntent: true,
      });
    });

    const firstSelectedEl = container.querySelector(
      '[data-virtual-row-state-row-id="row-7"]',
    ) as HTMLElement;
    const lastSelectedEl = container.querySelector(
      '[data-virtual-row-state-row-id="row-8"]',
    ) as HTMLElement;

    await act(async () => {
      container.dispatchEvent(new Event("pointerdown", { bubbles: true }));
      const range = document.createRange();
      range.setStart(firstSelectedEl.firstChild as Text, 0);
      range.setEnd(firstSelectedEl.firstChild as Text, "selected".length);
      const selection = document.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
      document.dispatchEvent(new Event("selectionchange"));
    });

    expect(container.scrollTop).toBe(500);
    expect(timelineRef.current?.snapshot.range.protectedRowIds).toContain(
      "row-7",
    );

    await act(async () => {
      const range = document.createRange();
      range.setStart(firstSelectedEl.firstChild as Text, 0);
      range.setEnd(lastSelectedEl.firstChild as Text, "selected".length);
      const selection = document.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
      document.dispatchEvent(new Event("selectionchange"));
    });

    expect(timelineRef.current?.snapshot.mode).toBe("bounded-controller");
    expect(timelineRef.current?.snapshot.range.protectedRowIds).toEqual(
      expect.arrayContaining(["row-7", "row-8"]),
    );
    expect(container.scrollTop).toBe(500);
    expect(timelineRef.current?.snapshot.controllerState.scrollTop).toBe(500);

    act(() => {
      document.dispatchEvent(new Event("pointerup"));
    });
    document.getSelection()?.removeAllRanges();
  });

  it("does not replay a stale bottom jump larger than the viewport during drag-select", () => {
    const container = createContainer();
    const containerRef = {
      current: container,
    } satisfies RefObject<HTMLDivElement | null>;
    const rows = Array.from({ length: 10 }, (_, index) =>
      row(`row-${index}`, 100),
    );

    const firstSelectedEl = appendRowElement(
      container,
      "row-8",
      "selected row eight text",
    );
    const lastSelectedEl = appendRowElement(
      container,
      "row-9",
      "selected row nine text",
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

    expect(container.scrollTop).toBe(700);

    act(() => {
      container.dispatchEvent(new Event("pointerdown", { bubbles: true }));
      const range = document.createRange();
      range.setStart(firstSelectedEl.firstChild as Text, 0);
      range.setEnd(lastSelectedEl.firstChild as Text, "selected".length);
      range.getBoundingClientRect = () =>
        ({
          bottom: 60,
          height: 40,
          left: 0,
          right: 120,
          top: 20,
          width: 120,
          x: 0,
          y: 20,
          toJSON: () => ({}),
        }) as DOMRect;
      const selection = document.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
      document.dispatchEvent(new Event("selectionchange"));
    });

    Object.defineProperty(container, "scrollHeight", {
      configurable: true,
      value: 2000,
    });

    act(() => {
      result.current.syncViewportFromDom({ source: "programmatic" });
    });

    expect(container.scrollTop).toBe(700);
    expect(result.current.snapshot.controllerState.anchor).toMatchObject({
      type: "row",
    });

    act(() => {
      document.dispatchEvent(new Event("pointerup"));
    });
    document.getSelection()?.removeAllRanges();
  });

  it("preserves selection endpoints when restoring bottom scroll during a drag-select", () => {
    const container = createContainer();
    const containerRef = {
      current: container,
    } satisfies RefObject<HTMLDivElement | null>;
    const rows = Array.from({ length: 10 }, (_, index) =>
      row(`row-${index}`, 100),
    );

    const firstSelectedEl = appendRowElement(
      container,
      "row-8",
      "selected row eight text",
    );
    const lastSelectedEl = appendRowElement(
      container,
      "row-9",
      "selected row nine text",
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

    let scrollTop = container.scrollTop;
    let collapseSelectionOnScrollWrite = false;
    Object.defineProperty(container, "scrollTop", {
      configurable: true,
      get: () => scrollTop,
      set: (nextScrollTop: number) => {
        scrollTop = nextScrollTop;
        if (!collapseSelectionOnScrollWrite) {
          return;
        }
        collapseSelectionOnScrollWrite = false;
        collapseSelectionToContainer(container);
      },
    });

    act(() => {
      container.dispatchEvent(new Event("pointerdown", { bubbles: true }));
      const range = document.createRange();
      range.setStart(firstSelectedEl.firstChild as Text, 0);
      range.setEnd(lastSelectedEl.firstChild as Text, "selected".length);
      const selection = document.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
      document.dispatchEvent(new Event("selectionchange"));
    });

    act(() => {
      container.scrollTop = 500;
      collapseSelectionOnScrollWrite = true;
      result.current.syncViewportFromDom({ source: "programmatic" });
    });

    const selection = document.getSelection();
    expect(container.scrollTop).toBe(700);
    expect(selection?.isCollapsed).toBe(false);
    expect(selection?.anchorNode).toBe(firstSelectedEl.firstChild);
    expect(selection?.focusNode).toBe(lastSelectedEl.firstChild);
    expect(selection?.toString()).toBe("selected row eight textselected");

    act(() => {
      document.dispatchEvent(new Event("pointerup"));
    });
    document.getSelection()?.removeAllRanges();
  });

  it("restores the last good drag-select endpoints after a transient collapse", () => {
    const container = createContainer();
    const containerRef = {
      current: container,
    } satisfies RefObject<HTMLDivElement | null>;
    const rows = Array.from({ length: 10 }, (_, index) =>
      row(`row-${index}`, 100),
    );

    const firstSelectedEl = appendRowElement(
      container,
      "row-8",
      "selected row eight text",
    );
    const lastSelectedEl = appendRowElement(
      container,
      "row-9",
      "selected row nine text",
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

    act(() => {
      container.dispatchEvent(new Event("pointerdown", { bubbles: true }));
      const range = document.createRange();
      range.setStart(firstSelectedEl.firstChild as Text, 0);
      range.setEnd(lastSelectedEl.firstChild as Text, "selected".length);
      const selection = document.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
      document.dispatchEvent(new Event("selectionchange"));
    });

    act(() => {
      const range = document.createRange();
      range.setStart(container, 0);
      range.setEnd(lastSelectedEl.firstChild as Text, "selected".length);
      const selection = document.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
      document.dispatchEvent(new Event("selectionchange"));
    });

    act(() => {
      collapseSelectionToContainer(container);
      container.scrollTop = 500;
      result.current.syncViewportFromDom({ source: "programmatic" });
    });

    const selection = document.getSelection();
    expect(container.scrollTop).toBe(700);
    expect(selection?.isCollapsed).toBe(false);
    expect(selection?.anchorNode).toBe(firstSelectedEl.firstChild);
    expect(selection?.focusNode).toBe(lastSelectedEl.firstChild);
    expect(selection?.toString()).toBe("selected row eight textselected");

    act(() => {
      document.dispatchEvent(new Event("pointerup"));
    });
    document.getSelection()?.removeAllRanges();
  });

  it("restores the last good drag-select endpoints after selected rows remount", () => {
    const container = createContainer();
    const containerRef = {
      current: container,
    } satisfies RefObject<HTMLDivElement | null>;
    const rows = Array.from({ length: 10 }, (_, index) =>
      row(`row-${index}`, 100),
    );

    const firstSelectedEl = appendRowElement(
      container,
      "row-8",
      "selected row eight text",
    );
    const lastSelectedEl = appendRowElement(
      container,
      "row-9",
      "selected row nine text",
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

    act(() => {
      container.dispatchEvent(new Event("pointerdown", { bubbles: true }));
      const range = document.createRange();
      range.setStart(firstSelectedEl.firstChild as Text, 0);
      range.setEnd(lastSelectedEl.firstChild as Text, "selected".length);
      const selection = document.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
      document.dispatchEvent(new Event("selectionchange"));
    });

    const remountedFirstEl = document.createElement("div");
    remountedFirstEl.setAttribute("data-virtual-row-state-row-id", "row-8");
    remountedFirstEl.textContent = "selected row eight text";
    const remountedLastEl = document.createElement("div");
    remountedLastEl.setAttribute("data-virtual-row-state-row-id", "row-9");
    remountedLastEl.textContent = "selected row nine text";
    firstSelectedEl.replaceWith(remountedFirstEl);
    lastSelectedEl.replaceWith(remountedLastEl);

    act(() => {
      collapseSelectionToContainer(container);
      container.scrollTop = 500;
      result.current.syncViewportFromDom({ source: "programmatic" });
    });

    const selection = document.getSelection();
    expect(container.scrollTop).toBe(700);
    expect(selection?.isCollapsed).toBe(false);
    expect(selection?.anchorNode).toBe(remountedFirstEl.firstChild);
    expect(selection?.focusNode).toBe(remountedLastEl.firstChild);
    expect(selection?.toString()).toBe("selected row eight textselected");

    act(() => {
      document.dispatchEvent(new Event("pointerup"));
    });
    document.getSelection()?.removeAllRanges();
  });

  it("keeps the selected row anchored when a deferred measurement flush resumes after drag-select clears", async () => {
    const container = createContainer();
    const containerRef = {
      current: container,
    } satisfies RefObject<HTMLDivElement | null>;
    const rows = Array.from({ length: 10 }, (_, index) =>
      row(`row-${index}`, 100),
    );

    const firstSelectedEl = appendRowElement(
      container,
      "row-7",
      "selected row seven text",
    );
    const lastSelectedEl = appendRowElement(
      container,
      "row-9",
      "selected row nine text",
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
      container.scrollTop = 500;
      result.current.syncViewportFromDom({
        source: "browser",
        userScrollIntent: true,
      });
    });
    expect(result.current.snapshot.controllerState).toMatchObject({
      scrollTop: 500,
      anchor: {
        type: "row",
        rowId: "row-5",
      },
    });

    await act(async () => {
      container.dispatchEvent(new Event("pointerdown", { bubbles: true }));
      const range = document.createRange();
      range.setStart(firstSelectedEl.firstChild as Text, 0);
      range.setEnd(lastSelectedEl.firstChild as Text, "selected".length);
      const selection = document.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
      document.dispatchEvent(new Event("selectionchange"));
    });

    await act(async () => {
      container.scrollTop = 500;
      result.current.syncViewportFromDom({ source: "programmatic" });
    });

    expect(container.scrollTop).toBe(500);
    expect(result.current.snapshot.controllerState.scrollTop).toBe(500);

    await act(async () => {
      result.current.measureRowElement("row-0", createMeasuredElement(200));
      runPendingFrames();
    });

    expect(container.scrollTop).toBe(500);
    expect(
      result.current.snapshot.measurementStats.visibleMeasurementAttempts,
    ).toBe(0);
    expect(result.current.snapshot.controllerState.virtualScrollHeight).toBe(
      1000,
    );

    await act(async () => {
      document.dispatchEvent(new Event("pointerup"));
    });

    expect(
      result.current.snapshot.measurementStats.visibleMeasurementAttempts,
    ).toBe(0);
    expect(result.current.snapshot.controllerState.virtualScrollHeight).toBe(
      1000,
    );
    expect(container.scrollTop).toBe(500);
    expect(result.current.snapshot.controllerState.scrollTop).toBe(500);

    await act(async () => {
      document.getSelection()?.removeAllRanges();
      document.dispatchEvent(new Event("selectionchange"));
    });

    expect(
      result.current.snapshot.measurementStats.visibleMeasurementAttempts,
    ).toBe(1);
    expect(result.current.snapshot.controllerState.virtualScrollHeight).toBe(
      1100,
    );
    expect(container.scrollTop).toBe(600);
    expect(result.current.snapshot.controllerState.scrollTop).toBe(600);
    expect(selectedRowOffset(result.current.snapshot, "row-9", container)).toBe(
      400,
    );

    document.getSelection()?.removeAllRanges();
  });

  it("preserves the live viewport when a deferred selection restore would jump by more than a viewport", async () => {
    const container = createContainer();
    const containerRef = {
      current: container,
    } satisfies RefObject<HTMLDivElement | null>;
    const rows = Array.from({ length: 12 }, (_, index) =>
      row(`row-${index}`, 100),
    );

    const firstSelectedEl = appendRowElement(
      container,
      "row-7",
      "selected row seven text",
    );
    const lastSelectedEl = appendRowElement(
      container,
      "row-9",
      "selected row nine text",
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
      container.scrollTop = 500;
      result.current.syncViewportFromDom({
        source: "browser",
        userScrollIntent: true,
      });
    });

    await act(async () => {
      container.dispatchEvent(new Event("pointerdown", { bubbles: true }));
      const range = document.createRange();
      range.setStart(firstSelectedEl.firstChild as Text, 0);
      range.setEnd(lastSelectedEl.firstChild as Text, "selected".length);
      const selection = document.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
      document.dispatchEvent(new Event("selectionchange"));
    });

    await act(async () => {
      result.current.measureRowElement("row-0", createMeasuredElement(500));
      result.current.measureRowElement("row-1", createMeasuredElement(500));
      result.current.measureRowElement("row-2", createMeasuredElement(500));
      result.current.measureRowElement("row-3", createMeasuredElement(500));
      runPendingFrames();
    });

    expect(container.scrollTop).toBe(500);
    expect(
      result.current.snapshot.measurementStats.visibleMeasurementAttempts,
    ).toBe(0);

    await act(async () => {
      document.dispatchEvent(new Event("pointerup"));
    });

    expect(
      result.current.snapshot.measurementStats.visibleMeasurementAttempts,
    ).toBe(0);
    expect(result.current.snapshot.controllerState.virtualScrollHeight).toBe(
      1200,
    );
    expect(container.scrollTop).toBe(500);
    expect(result.current.snapshot.controllerState.scrollTop).toBe(500);

    await act(async () => {
      document.getSelection()?.removeAllRanges();
      document.dispatchEvent(new Event("selectionchange"));
    });

    expect(
      result.current.snapshot.measurementStats.visibleMeasurementAttempts,
    ).toBe(4);
    expect(result.current.snapshot.controllerState.virtualScrollHeight).toBe(
      2800,
    );
    expect(container.scrollTop).toBe(500);
    expect(result.current.snapshot.controllerState.scrollTop).toBe(500);

    document.getSelection()?.removeAllRanges();
  });

  it("keeps the bottom selected message anchored when deferred measurements settle above it", async () => {
    const container = createContainer();
    const containerRef = {
      current: container,
    } satisfies RefObject<HTMLDivElement | null>;
    const rows = Array.from({ length: 10 }, (_, index) =>
      row(`row-${index}`, 100),
    );

    const firstSelectedEl = appendRowElement(
      container,
      "row-8",
      "selected row eight text",
    );
    const lastSelectedEl = appendRowElement(
      container,
      "row-9",
      "selected row nine text",
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

    expect(container.scrollTop).toBe(700);
    expect(selectedRowOffset(result.current.snapshot, "row-9", container)).toBe(
      200,
    );

    act(() => {
      container.dispatchEvent(new Event("pointerdown", { bubbles: true }));
      const range = document.createRange();
      range.setStart(firstSelectedEl.firstChild as Text, 0);
      range.setEnd(lastSelectedEl.firstChild as Text, "selected".length);
      const selection = document.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
      document.dispatchEvent(new Event("selectionchange"));
    });

    act(() => {
      container.scrollTop = 500;
      result.current.syncViewportFromDom({ source: "programmatic" });
    });

    expect(container.scrollTop).toBe(700);
    expect(result.current.snapshot.controllerState.anchor).toEqual({
      type: "bottom",
    });

    act(() => {
      result.current.measureRowElement("row-0", createMeasuredElement(200));
      runNextFrameBatch();
    });

    expect(container.scrollTop).toBe(700);
    expect(
      result.current.snapshot.measurementStats.visibleMeasurementAttempts,
    ).toBe(0);

    act(() => {
      document.dispatchEvent(new Event("pointerup"));
    });

    expect(
      result.current.snapshot.measurementStats.visibleMeasurementAttempts,
    ).toBe(0);
    expect(result.current.snapshot.controllerState.virtualScrollHeight).toBe(
      1000,
    );
    expect(container.scrollTop).toBe(700);
    expect(result.current.snapshot.controllerState.scrollTop).toBe(700);
    expect(selectedRowOffset(result.current.snapshot, "row-9", container)).toBe(
      200,
    );

    act(() => {
      document.getSelection()?.removeAllRanges();
      document.dispatchEvent(new Event("selectionchange"));
    });

    expect(
      result.current.snapshot.measurementStats.visibleMeasurementAttempts,
    ).toBe(1);
    expect(result.current.snapshot.controllerState.virtualScrollHeight).toBe(
      1100,
    );
    expect(container.scrollTop).toBe(800);
    expect(result.current.snapshot.controllerState.scrollTop).toBe(800);
    expect(selectedRowOffset(result.current.snapshot, "row-9", container)).toBe(
      200,
    );

    document.getSelection()?.removeAllRanges();
  });

  it("uses mounted row geometry when restoring a deferred selection flush", async () => {
    const container = createContainer();
    setElementRect(container, { top: 0, height: 300 });
    const containerRef = {
      current: container,
    } satisfies RefObject<HTMLDivElement | null>;
    const rows = Array.from({ length: 10 }, (_, index) =>
      row(`row-${index}`, 100),
    );

    const firstSelectedEl = appendRowElement(
      container,
      "row-7",
      "selected row seven text",
    );
    const lastSelectedEl = appendRowElement(
      container,
      "row-9",
      "selected row nine text",
    );
    setElementRect(lastSelectedEl, { top: 260, height: 40 });

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
      container.scrollTop = 500;
      result.current.syncViewportFromDom({
        source: "browser",
        userScrollIntent: true,
      });
    });

    act(() => {
      container.dispatchEvent(new Event("pointerdown", { bubbles: true }));
      const range = document.createRange();
      range.setStart(firstSelectedEl.firstChild as Text, 0);
      range.setEnd(lastSelectedEl.firstChild as Text, "selected".length);
      const selection = document.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
      document.dispatchEvent(new Event("selectionchange"));
    });

    expect(selectedRowOffset(result.current.snapshot, "row-9", container)).toBe(
      400,
    );

    act(() => {
      result.current.measureRowElement("row-0", createMeasuredElement(200));
      runNextFrameBatch();
    });

    act(() => {
      document.dispatchEvent(new Event("pointerup"));
    });

    expect(result.current.snapshot.controllerState.virtualScrollHeight).toBe(
      1000,
    );
    expect(container.scrollTop).toBe(500);
    expect(result.current.snapshot.controllerState.scrollTop).toBe(500);

    act(() => {
      document.getSelection()?.removeAllRanges();
      document.dispatchEvent(new Event("selectionchange"));
    });

    expect(result.current.snapshot.controllerState.virtualScrollHeight).toBe(
      1100,
    );
    expect(container.scrollTop).toBe(740);
    expect(result.current.snapshot.controllerState.scrollTop).toBe(740);

    document.getSelection()?.removeAllRanges();
  });

  it("resumes scroll writes when window blur interrupts a drag-select", async () => {
    const container = createContainer();
    const containerRef = {
      current: container,
    } satisfies RefObject<HTMLDivElement | null>;
    const rows = [row("intro", 100), row("tail", 120)];

    const introEl = appendRowElement(container, "intro", "intro row text");
    const tailEl = appendRowElement(container, "tail", "tail row text");

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
      const range = document.createRange();
      range.setStart(introEl.firstChild as Text, 0);
      range.setEnd(tailEl.firstChild as Text, "tail".length);
      const selection = document.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
      document.dispatchEvent(new Event("selectionchange"));
    });

    await act(async () => {
      container.scrollTop = 1000;
      result.current.syncViewportFromDom({
        source: "browser",
        userScrollIntent: true,
      });
    });
    expect(container.scrollTop).toBe(1000);

    await act(async () => {
      window.dispatchEvent(new Event("blur"));
    });
    expect(container.scrollTop).toBe(0);
  });

  it("keeps scroll writes suspended through a transient mid-drag collapse", async () => {
    const container = createContainer();
    const containerRef = {
      current: container,
    } satisfies RefObject<HTMLDivElement | null>;
    const rows = [row("intro", 100), row("tail", 120)];

    // Select a non-row node so no endpoints are pinned: this isolates the
    // suspension latch from controller rebuilds caused by changing pins.
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

    // Arm and latch the drag-select gesture (pointer down + non-collapsed
    // in-transcript selection).
    await act(async () => {
      container.dispatchEvent(new Event("pointerdown", { bubbles: true }));
      const range = document.createRange();
      range.selectNodeContents(selectable);
      const selection = document.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
      document.dispatchEvent(new Event("selectionchange"));
    });

    // The selection collapses mid-drag (an endpoint row unmounts and the browser
    // recomputes the Range) — but the pointer is still down, so the latch holds
    // and writes stay suspended. This is the regression: keying the freeze on the
    // live collapsed state instead resumed writes here and let a queued
    // correction yank the viewport.
    await act(async () => {
      document.getSelection()?.removeAllRanges();
      document.dispatchEvent(new Event("selectionchange"));
      container.scrollTop = 1000;
      result.current.syncViewportFromDom({
        source: "browser",
        userScrollIntent: true,
      });
    });
    expect(container.scrollTop).toBe(1000);

    // Pointer release ends the gesture and reconciles the viewport in one pass.
    await act(async () => {
      document.dispatchEvent(new Event("pointerup"));
    });
    expect(container.scrollTop).toBe(0);
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

  function runNextFrameBatch() {
    expect(frameCallbacks.length).toBeGreaterThan(0);
    const pendingFrames = frameCallbacks;
    frameCallbacks = [];
    for (const frame of pendingFrames) {
      frame.callback(performance.now());
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

function setElementRect(
  element: HTMLElement,
  rect: { top: number; height: number },
) {
  element.getBoundingClientRect = () =>
    ({
      bottom: rect.top + rect.height,
      height: rect.height,
      left: 0,
      right: 720,
      top: rect.top,
      width: 720,
      x: 0,
      y: rect.top,
      toJSON: () => ({}),
    }) as DOMRect;
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

function appendRowElement(
  container: HTMLElement,
  rowId: string,
  text: string,
): HTMLElement {
  const element = document.createElement("div");
  element.setAttribute("data-virtual-row-state-row-id", rowId);
  element.textContent = text;
  container.appendChild(element);
  return element;
}

function appendTimelineGutter(container: HTMLElement): HTMLElement {
  const element = document.createElement("div");
  for (const [attribute, value] of Object.entries(
    TRANSCRIPT_SELECTION_SURFACE_ATTRIBUTES,
  )) {
    element.setAttribute(attribute, value);
  }
  container.appendChild(element);
  return element;
}

function collapseSelectionToContainer(container: HTMLElement) {
  const range = document.createRange();
  range.setStart(container, 0);
  range.collapse(true);
  const selection = document.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
}

function selectedRowOffset(
  snapshot: TranscriptVirtualTimelineSnapshot,
  rowId: string,
  container: HTMLElement,
): number | null {
  const item = snapshot.range.virtualItems.find(
    (virtualItem) => virtualItem.row.rowId === rowId,
  );
  return item ? item.start - container.scrollTop : null;
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

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

  it("pins selection-endpoint rows into the protected set during a drag-select", async () => {
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

    // Only the endpoint rows are pinned — the fully-selected row between them
    // can still unmount, since the live Range is defined by its endpoints.
    expect(result.current.snapshot.range.protectedRowIds).toEqual(
      expect.arrayContaining(["intro", "tail"]),
    );
    expect(result.current.snapshot.range.protectedRowIds).not.toContain(
      "middle",
    );

    await act(async () => {
      document.getSelection()?.removeAllRanges();
      document.dispatchEvent(new Event("selectionchange"));
    });

    expect(result.current.snapshot.range.protectedRowIds).toEqual([]);
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

    // Pointer release ends the gesture and runs the deferred measurement in a
    // single pass — even though the selection is still held.
    await act(async () => {
      document.dispatchEvent(new Event("pointerup"));
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

    expect(result.current.snapshot.range.protectedRowIds).toEqual([]);
    expect(container.scrollTop).toBe(1000);

    await act(async () => {
      document.dispatchEvent(new Event("pointerup"));
    });

    expect(container.scrollTop).toBe(0);
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

    expect(result.current.snapshot.range.protectedRowIds).toEqual([]);
    expect(container.scrollTop).toBe(1000);

    await act(async () => {
      window.dispatchEvent(new Event("blur"));
    });

    expect(container.scrollTop).toBe(0);
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
    estimatedHeight,
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

import { describe, expect, it } from "vitest";
import type { TranscriptRowDescriptor } from "../projection/transcriptItemTypes";
import {
  computeTranscriptVirtualRange,
  createTranscriptVirtualController,
  TranscriptViewportCoordinator,
} from "./index";
import type { TranscriptVirtualMeasurementToken } from "./transcriptVirtualTypes";

const SESSION_ID = "direct-session";
const WIDTH_SCOPE = "w:720";

describe("direct controller to viewport coordinator composition", () => {
  it("matches a hand-calculated variable-height geometry fixture", () => {
    const controller = createController({ viewportHeight: 180, scrollTop: 90 });
    controller.setRows([
      row("intro", 80),
      row("tool", 140),
      row("answer", 220),
    ]);

    // This expected geometry is fixed independently of any adapter output.
    expect(controller.getRange()).toMatchObject({
      totalHeight: 440,
      scrollHeight: 440,
      visibleRange: { startIndex: 1, endIndex: 2 },
      renderRange: { startIndex: 0, endIndex: 2 },
      virtualItems: [
        { index: 0, start: 0, size: 80, end: 80, visible: false },
        { index: 1, start: 80, size: 140, end: 220, visible: true },
        { index: 2, start: 220, size: 220, end: 440, visible: true },
      ],
      paddingStart: 0,
      paddingEnd: 0,
    });
  });

  it("aligns targets independently and clamps them to bounds", () => {
    expect(target("row-2", "start")).toBe(200);
    expect(target("row-2", "center")).toBe(100);
    expect(target("row-2", "end")).toBe(0);
    expect(target("row-2", "auto")).toBe(200);
    expect(target("row-9", "start")).toBe(700);
    expect(target("row-9", "center")).toBe(700);
    expect(target("row-9", "end")).toBe(700);
  });

  it("applies explicit pixel and row overscan around the visible window", () => {
    const controller = createController(
      { viewportHeight: 200, scrollTop: 400 },
      {
        overscanBeforePx: 100,
        overscanAfterPx: 100,
        overscanBeforeRows: 1,
        overscanAfterRows: 1,
      },
    );
    controller.setRows(makeRows(12, 100));

    expect(controller.getRange()).toMatchObject({
      visibleRange: { startIndex: 4, endIndex: 5 },
      renderRange: {
        startIndex: 3,
        endIndex: 6,
        visibleStartIndex: 4,
        visibleEndIndex: 5,
      },
      renderedRowIds: ["row-3", "row-4", "row-5", "row-6"],
      paddingStart: 300,
      paddingEnd: 500,
    });
  });

  it("corrects exactly for a preceding-row measurement while keeping a detached anchor", () => {
    const controller = detachedController();
    const result = controller.applyMeasuredHeight({
      token: tokenFor(controller, "row-2"),
      height: 160,
    });

    expect(result).toMatchObject({
      accepted: true,
      correction: {
        previousScrollTop: 400,
        nextScrollTop: 460,
        delta: 60,
        reason: "row-anchor",
      },
    });
    expect(controller.getState()).toMatchObject({
      scrollTop: 400,
      anchor: { type: "row", rowId: "row-4", offsetWithinRow: 0 },
    });
    acknowledge(controller, result.correction);
    expect(controller.getState()).toMatchObject({
      scrollTop: 460,
      anchor: { type: "row", rowId: "row-4", offsetWithinRow: 0 },
    });
  });

  it("reduces a mixed-validity measurement batch to one correction", () => {
    const controller = detachedController();
    const valid = tokenFor(controller, "row-2");
    const batch = controller.applyMeasuredHeights([
      { token: valid, height: 160 },
      { token: { ...valid, sessionId: "old-session" }, height: 900 },
      { token: { ...valid, widthScope: "w:600" }, height: 900 },
      { token: { ...valid, heightRevision: "old-height" }, height: 900 },
      { token: { ...valid, rowId: "missing" }, height: 900 },
    ]);

    expect(batch.acceptedTokens).toEqual([valid]);
    expect(batch.rejected).toBe(4);
    expect(batch.correction).toMatchObject({
      previousScrollTop: 400,
      nextScrollTop: 460,
      delta: 60,
    });
    expect(controller.getState().scrollTop).toBe(400);
    expect(controller.getRange().virtualItems).not.toContainEqual(
      expect.objectContaining({ size: 900 }),
    );
    expect(controller.getDiagnostics()).toMatchObject({
      staleMeasurementsDropped: 4,
      staleMeasurementSessionDrops: 1,
      staleMeasurementWidthDrops: 1,
      staleMeasurementRevisionDrops: 1,
      staleMeasurementMissingRowDrops: 1,
    });
  });

  it("keeps protected rows outside the contiguous window exactly once and sorted", () => {
    const controller = createController(
      { viewportHeight: 500, scrollTop: 5000 },
      {
        overscanBeforePx: 0,
        overscanAfterPx: 0,
        overscanBeforeRows: 0,
        overscanAfterRows: 0,
        protectedRowIds: ["row-99", "row-0"],
      },
    );
    controller.setRows(makeRows(100, 100));

    expect(controller.getRange()).toMatchObject({
      visibleRange: { startIndex: 50, endIndex: 54 },
      renderRange: { startIndex: 50, endIndex: 54 },
      renderedRowIds: [
        "row-0",
        "row-50",
        "row-51",
        "row-52",
        "row-53",
        "row-54",
        "row-99",
      ],
      protectedRowIds: ["row-0", "row-99"],
    });
  });

  it("rejects an old measurement after reset and accepts only the new epoch token", () => {
    const controller = createController({ viewportHeight: 200 });
    controller.setRows(makeRows(3, 50));
    const oldToken = tokenFor(controller, "row-1");

    controller.reset({
      sessionId: "new-session",
      sessionEpoch: 2,
      widthScope: "w:600",
      viewportHeight: 200,
      scrollTop: 0,
    });
    controller.setRows(makeRows(3, 50));

    expect(
      controller.applyMeasuredHeight({ token: oldToken, height: 80 }),
    ).toEqual({
      accepted: false,
      correction: null,
    });
    const newToken = tokenFor(controller, "row-1");
    expect(
      controller.applyMeasuredHeight({ token: newToken, height: 80 }),
    ).toEqual({ accepted: true, correction: null });
    expect(controller.getState()).toMatchObject({
      sessionId: "new-session",
      sessionEpoch: 2,
      widthScope: "w:600",
      scrollTop: 0,
    });
    expect(controller.getRange().virtualItems[1]).toMatchObject({
      start: 50,
      size: 80,
      end: 130,
    });
  });

  it("counts linear metric construction and caches repeated controller reads", () => {
    const rows = makeRows(10_000, 48);
    let metricReads = 0;
    const directRange = computeTranscriptVirtualRange({
      rows,
      scrollTop: 240_000,
      viewportHeight: 720,
      overscanBeforePx: 1200,
      overscanAfterPx: 600,
      overscanBeforeRows: 4,
      overscanAfterRows: 4,
      getRowHeight: (current) => {
        metricReads += 1;
        return current.estimatedHeight;
      },
    });

    expect(metricReads).toBe(rows.length);
    expect(directRange.visibleRange).toEqual({
      startIndex: 5000,
      endIndex: 5014,
    });
    expect(directRange.virtualItems.length).toBeLessThanOrEqual(55);
    expect(directRange.virtualItems.length).toBeGreaterThan(15);

    const controller = createController(
      {
        viewportHeight: 720,
        scrollTop: 240_000,
      },
      {
        overscanBeforePx: 1200,
        overscanAfterPx: 600,
        overscanBeforeRows: 4,
        overscanAfterRows: 4,
      },
    );
    controller.setRows(rows);
    const first = controller.getRange();
    expect(controller.getRange()).toBe(first);
    expect(controller.getDiagnostics().rangeCalculations).toBe(1);

    controller.syncViewport(
      {
        scrollTop: 240_001,
        viewportHeight: 720,
        widthScope: WIDTH_SCOPE,
      },
      { source: "browser", userScrollIntent: true },
    );
    expect(controller.getRange()).not.toBe(first);
    expect(controller.getDiagnostics().rangeCalculations).toBe(2);
  });

  it("propagates a direct-controller correction through the coordinator's sole browser writer", () => {
    const { container, writes } = browserHarness({
      viewportHeight: 300,
      scrollHeight: 1000,
    });
    const controller = createController({ viewportHeight: 300 });
    const coordinator = new TranscriptViewportCoordinator({
      container,
      engine: controller,
      getFooterHeight: () => 0,
    });

    coordinator.setRows(makeRows(10, 100));
    container.scrollTop = 400;
    writes.length = 0;
    coordinator.syncViewport(
      {
        scrollTop: 400,
        viewportHeight: 300,
        widthScope: WIDTH_SCOPE,
        browserScrollHeight: 1000,
      },
      { source: "browser", userScrollIntent: true },
    );
    const token = tokenFor(controller, "row-2");
    const measured = coordinator.applyMeasuredHeight({ token, height: 160 });

    expect(measured).toMatchObject({
      accepted: true,
      correction: null,
    });
    expect(writes).toEqual([460]);
    expect(container.scrollTop).toBe(460);
    expect(controller.getState()).toMatchObject({
      scrollTop: 460,
      anchor: { type: "row", rowId: "row-4", offsetWithinRow: 0 },
    });
    expect(controller.getRange().virtualItems[4]).toMatchObject({
      start: 460,
      end: 560,
    });
  });

  it("uses the controller directly below the coordinator with one browser writer", () => {
    const { container, writes } = browserHarness({
      viewportHeight: 200,
      scrollHeight: 500,
    });
    const controller = createController({ viewportHeight: 200 });
    const coordinator = new TranscriptViewportCoordinator({
      container,
      engine: controller,
      getFooterHeight: () => 0,
    });

    coordinator.setRows(makeRows(5, 100));

    expect("writeScrollTop" in controller).toBe(false);
    expect(writes).toEqual([300]);
    expect(container.scrollTop).toBe(300);
    expect(controller.getState()).toMatchObject({
      scrollTop: 300,
      virtualScrollHeight: 500,
      anchor: { type: "bottom" },
    });
  });
});

function createController(
  geometry: Partial<{ viewportHeight: number; scrollTop: number }> = {},
  options: Parameters<typeof createTranscriptVirtualController>[1] = {},
) {
  return createTranscriptVirtualController(
    {
      sessionId: SESSION_ID,
      sessionEpoch: 1,
      widthScope: WIDTH_SCOPE,
      viewportHeight: geometry.viewportHeight ?? 500,
      scrollTop: geometry.scrollTop ?? 0,
    },
    options,
  );
}

function detachedController() {
  const controller = createController({ viewportHeight: 300 });
  acknowledge(controller, controller.setRows(makeRows(10, 100)).correction);
  controller.syncViewport(
    {
      scrollTop: 400,
      viewportHeight: 300,
      widthScope: WIDTH_SCOPE,
    },
    { source: "browser", userScrollIntent: true },
  );
  expect(controller.getState().anchor).toMatchObject({
    type: "row",
    rowId: "row-4",
    offsetWithinRow: 0,
  });
  return controller;
}

function target(
  rowId: string,
  align: "start" | "center" | "end" | "auto",
): number | null {
  const controller = createController({ viewportHeight: 300 });
  acknowledge(controller, controller.setRows(makeRows(10, 100)).correction);
  return (
    controller.scrollToRow(rowId, align).correction?.nextScrollTop ??
    controller.getState().scrollTop
  );
}

function acknowledge(
  controller: ReturnType<typeof createTranscriptVirtualController>,
  correction: { nextScrollTop: number } | null | undefined,
): void {
  if (!correction) return;
  const state = controller.getState();
  controller.syncViewport(
    {
      scrollTop: correction.nextScrollTop,
      viewportHeight: state.viewportHeight,
      widthScope: state.widthScope,
      browserScrollHeight: state.virtualScrollHeight,
    },
    { source: "browser" },
  );
}

function tokenFor(
  controller: ReturnType<typeof createTranscriptVirtualController>,
  rowId: string,
): TranscriptVirtualMeasurementToken {
  const token = controller.getMeasurementToken(rowId);
  expect(token).not.toBeNull();
  return token as TranscriptVirtualMeasurementToken;
}

function browserHarness({
  viewportHeight,
  scrollHeight,
}: {
  viewportHeight: number;
  scrollHeight: number;
}) {
  const container = document.createElement("div");
  let scrollTop = 0;
  const writes: number[] = [];
  Object.defineProperties(container, {
    clientHeight: { configurable: true, value: viewportHeight },
    clientWidth: { configurable: true, value: 720 },
    scrollHeight: { configurable: true, value: scrollHeight },
    scrollTop: {
      configurable: true,
      get: () => scrollTop,
      set: (value: number) => {
        writes.push(value);
        scrollTop = Math.min(scrollHeight - viewportHeight, Math.max(0, value));
      },
    },
  });
  container.getBoundingClientRect = () =>
    ({ top: 0, width: 720, height: viewportHeight }) as DOMRect;
  return { container, writes };
}

function makeRows(count: number, height: number): TranscriptRowDescriptor[] {
  return Array.from({ length: count }, (_, index) =>
    row(`row-${index}`, height),
  );
}

function row(rowId: string, estimatedHeight: number): TranscriptRowDescriptor {
  return {
    rowId,
    reactKey: rowId,
    kind: "message",
    messageId: rowId,
    blockIds: [rowId],
    renderRevision: `render:${rowId}`,
    heightRevision: `height:${rowId}:${estimatedHeight}`,
    layoutRevision: "layout:0",
    estimatedHeight,
    spacingBefore: 0,
    anchorPriority: "stable",
    measurementPolicy: "measure-real",
    layoutPendingPolicy: "can-finalize",
    capabilities: {
      stateful: false,
      hasMcpApp: false,
      hasHostCalls: false,
      hasActiveTimer: false,
      hasDynamicAsyncLayout: false,
      canOffscreenRenderReal: true,
      canOffscreenRenderShell: true,
      protectsSelection: false,
    },
    keepAlivePriority: "none",
  };
}

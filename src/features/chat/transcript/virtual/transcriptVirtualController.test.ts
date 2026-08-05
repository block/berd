import { describe, expect, it } from "vitest";
import type { TranscriptRowDescriptor } from "../projection/transcriptItemTypes";
import {
  computeTanStackRangeIndexes,
  createTranscriptVirtualController,
} from "./index";
import type { TranscriptVirtualMeasurementToken } from "./transcriptVirtualTypes";

const SESSION_ID = "session-a";
const WIDTH_SCOPE = "w:720";

describe("transcript virtual controller", () => {
  it("keeps bottom anchors pinned through append and footer geometry changes", () => {
    const controller = createController({ viewportHeight: 500 });
    const rows = makeRows(20, 100);

    const initial = controller.setRows(rows);

    expect(initial.correction?.nextScrollTop).toBe(1500);
    expect(controller.getState().anchor).toEqual({ type: "bottom" });
    acknowledge(controller, initial.correction);

    const appended = controller.setRows([...rows, row("new", 120)]);

    expect(appended.correction?.nextScrollTop).toBe(1620);
    expect(controller.getState().scrollTop).toBe(1500);
    acknowledge(controller, appended.correction);

    const footer = controller.syncViewport({
      scrollTop: controller.getState().scrollTop,
      viewportHeight: 500,
      footerHeight: 80,
      widthScope: WIDTH_SCOPE,
    });

    expect(footer.correction?.nextScrollTop).toBe(1700);
    acknowledge(controller, footer.correction, { footerHeight: 80 });
    expect(controller.getState()).toMatchObject({
      scrollTop: 1700,
      footerHeight: 80,
      bottomScrollTop: 1700,
      pinnedToBottom: true,
    });
  });

  it("holds the clicked row when an in-place disclosure grows at the bottom", () => {
    const controller = createController({ viewportHeight: 500 });
    acknowledge(controller, controller.setRows(makeRows(10, 100)).correction);

    expect(controller.getState()).toMatchObject({
      scrollTop: 500,
      anchor: { type: "bottom" },
    });

    // View-more pins the live viewport before changing row height, using the
    // same preserve-position path as explicit user scroll intent.
    const pinned = controller.syncViewport(
      {
        scrollTop: 500,
        viewportHeight: 500,
        widthScope: WIDTH_SCOPE,
      },
      {
        source: "browser",
        userScrollIntent: true,
        preserveScrollPosition: true,
      },
    );

    expect(pinned.correction).toBeNull();
    expect(controller.getState().anchor).toMatchObject({
      type: "row",
      rowId: "row-5",
      offsetWithinRow: 0,
    });

    const expanded = controller.applyMeasuredHeight({
      token: tokenFor(controller, "row-9"),
      height: 900,
    });

    expect(expanded.accepted).toBe(true);
    // The pinned row begins above the changed row, so no corrective DOM write
    // is needed; most importantly, bottom-follow does not request the new end.
    expect(expanded.correction).toBeNull();
    expect(controller.getState()).toMatchObject({
      scrollTop: 500,
      anchor: {
        type: "row",
        rowId: "row-5",
        offsetWithinRow: 0,
      },
      // Bottom follow would have requested this new end instead.
      bottomScrollTop: 1300,
    });
  });

  it("keeps the bottom anchored when the viewport shrinks while following", () => {
    const controller = createController({ viewportHeight: 500 });
    acknowledge(controller, controller.setRows(makeRows(20, 100)).correction);

    expect(controller.getState()).toMatchObject({
      scrollTop: 1500,
      anchor: { type: "bottom" },
    });

    // A window/rail resize shrinks the viewport. The browser keeps scrollTop
    // where it was, which now sits 200px above the new bottom. The clamp-
    // induced scroll event carries no user intent, so bottom follow must not
    // exit.
    const resized = controller.syncViewport(
      {
        scrollTop: 1500,
        viewportHeight: 300,
        widthScope: WIDTH_SCOPE,
      },
      { source: "browser" },
    );

    expect(resized.correction).toMatchObject({
      reason: "bottom-anchor",
      nextScrollTop: 1700,
    });
    acknowledge(controller, resized.correction, { viewportHeight: 300 });
    expect(controller.getState()).toMatchObject({
      scrollTop: 1700,
      anchor: { type: "bottom" },
      pinnedToBottom: true,
    });
    expect(controller.getDiagnostics().bottomFollowExits).toBe(0);
  });

  it("keeps the captured row anchored while a width change rewraps row heights", () => {
    const controller = createController({ viewportHeight: 300 });
    controller.setRows(makeRows(10, 100));
    controller.applyMeasuredHeight({
      token: tokenFor(controller, "row-2"),
      height: 200,
    });

    controller.syncViewport(
      {
        scrollTop: 620,
        viewportHeight: 300,
        widthScope: WIDTH_SCOPE,
      },
      { source: "browser", userScrollIntent: true },
    );

    expect(controller.getState().anchor).toMatchObject({
      type: "row",
      rowId: "row-5",
      offsetWithinRow: 20,
    });

    // A rail animation changes the transcript width. Cached/replayed
    // measurements are width-scoped, but live geometry keeps the last accepted
    // height as a provisional value so the visible anchor does not jump rows.
    const resized = controller.syncViewport(
      {
        scrollTop: 620,
        viewportHeight: 300,
        widthScope: "w:600",
      },
      { source: "browser", userScrollIntent: true },
    );

    expect(resized.correction).toBeNull();
    expect(controller.getState()).toMatchObject({
      scrollTop: 620,
      anchor: {
        type: "row",
        rowId: "row-5",
        offsetWithinRow: 20,
      },
    });

    // Remeasurement at the new width lands: row-2 rewraps from 200px to
    // 320px, shifting everything after it down. The captured row must stay
    // pinned at the same viewport offset.
    const remeasured = controller.applyMeasuredHeight({
      token: tokenFor(controller, "row-2"),
      height: 320,
    });

    expect(remeasured.accepted).toBe(true);
    expect(remeasured.correction).toMatchObject({
      reason: "row-anchor",
      nextScrollTop: 740,
    });
    expect(controller.getState().anchor).toMatchObject({
      type: "row",
      rowId: "row-5",
      offsetWithinRow: 20,
    });
  });

  it("pauses bottom follow on upward scroll before idle measurements flush", () => {
    const controller = createController({ viewportHeight: 300 });
    const rows = makeRows(10, 100);
    acknowledge(controller, controller.setRows(rows).correction);

    expect(controller.getState().scrollTop).toBe(700);

    controller.syncViewport(
      {
        scrollTop: 620,
        viewportHeight: 300,
        widthScope: WIDTH_SCOPE,
      },
      { source: "browser", userScrollIntent: true },
    );

    expect(controller.getState().anchor).toMatchObject({
      type: "row",
      rowId: "row-6",
      offsetWithinRow: 20,
    });
    expect(controller.getState().nearBottom).toBe(true);

    const measured = controller.applyMeasuredHeight({
      token: tokenFor(controller, "row-2"),
      height: 200,
    });

    expect(measured.accepted).toBe(true);
    expect(measured.correction).toMatchObject({
      reason: "row-anchor",
      previousScrollTop: 620,
      nextScrollTop: 720,
      delta: 100,
    });
    acknowledge(controller, measured.correction);
    expect(controller.getState().scrollTop).toBe(720);
    expect(controller.getState().bottomScrollTop).toBe(800);
    expect(controller.getDiagnostics().bottomFollowExits).toBe(1);
  });

  it("captures a row anchor while preserving browser-owned scroll", () => {
    const controller = createController({ viewportHeight: 300 });
    acknowledge(controller, controller.setRows(makeRows(10, 100)).correction);

    expect(controller.getState()).toMatchObject({
      scrollTop: 700,
      anchor: { type: "bottom" },
    });

    const preserved = controller.syncViewport(
      {
        scrollTop: 500,
        viewportHeight: 300,
        widthScope: WIDTH_SCOPE,
      },
      {
        source: "browser",
        userScrollIntent: true,
        preserveScrollPosition: true,
      },
    );

    expect(preserved.correction).toBeNull();
    expect(controller.getState()).toMatchObject({
      scrollTop: 500,
      anchor: {
        type: "row",
        rowId: "row-5",
        offsetWithinRow: 0,
      },
      distanceFromBottom: 200,
    });

    const measured = controller.applyMeasuredHeight({
      token: tokenFor(controller, "row-0"),
      height: 200,
    });

    expect(measured.accepted).toBe(true);
    expect(measured.correction).toMatchObject({
      reason: "row-anchor",
      previousScrollTop: 500,
      nextScrollTop: 600,
      delta: 100,
    });
    acknowledge(controller, measured.correction);
    expect(controller.getState()).toMatchObject({
      scrollTop: 600,
      anchor: {
        type: "row",
        rowId: "row-5",
        offsetWithinRow: 0,
      },
      pinnedToBottom: false,
    });
  });

  it("rejects stale session epoch, width, revision, and missing-row measurements", () => {
    const controller = createController({ viewportHeight: 300 });
    controller.setRows(makeRows(5, 100));
    const token = tokenFor(controller, "row-2");

    expect(
      controller.applyMeasuredHeight({
        token: { ...token, sessionEpoch: 0 },
        height: 150,
      }).accepted,
    ).toBe(false);
    expect(
      controller.applyMeasuredHeight({
        token: { ...token, widthScope: "w:compact" },
        height: 150,
      }).accepted,
    ).toBe(false);
    expect(
      controller.applyMeasuredHeight({
        token: { ...token, heightRevision: "height:stale" },
        height: 150,
      }).accepted,
    ).toBe(false);
    expect(
      controller.applyMeasuredHeight({
        token: { ...token, rowId: "missing-row" },
        height: 150,
      }).accepted,
    ).toBe(false);

    expect(
      controller.applyMeasuredHeight({ token, height: 150 }).accepted,
    ).toBe(true);
    expect(controller.getDiagnostics()).toMatchObject({
      staleMeasurementsDropped: 4,
      staleMeasurementEpochDrops: 1,
      staleMeasurementWidthDrops: 1,
      staleMeasurementRevisionDrops: 1,
      staleMeasurementMissingRowDrops: 1,
      measuredHeightUpdates: 1,
    });
  });

  it("keeps render revision changes separate from anchor freshness", () => {
    const controller = createController({
      viewportHeight: 300,
      scrollTop: 150,
    });
    const anchored = row("message-1", 400, {
      renderRevision: "render:old",
      heightRevision: "height:stable",
    });
    controller.setRows([row("intro", 100), anchored, row("after", 400)]);
    controller.syncViewport(
      {
        scrollTop: 150,
        viewportHeight: 300,
        widthScope: WIDTH_SCOPE,
      },
      { source: "browser", userScrollIntent: true },
    );

    const renderOnly = controller.setRows([
      row("intro", 100),
      row("message-1", 400, {
        renderRevision: "render:new",
        heightRevision: "height:stable",
      }),
      row("after", 400),
    ]);

    expect(renderOnly.correction).toBeNull();
    expect(controller.getDiagnostics().staleAnchorsDropped).toBe(0);

    const heightChanged = controller.setRows([
      row("intro", 100),
      row("message-1", 400, {
        renderRevision: "render:newer",
        heightRevision: "height:new",
      }),
      row("after", 400),
    ]);

    expect(heightChanged.correction).toBeNull();
    expect(controller.getDiagnostics().staleAnchorsDropped).toBe(1);
    expect(controller.getState().anchor).toMatchObject({
      type: "row",
      rowId: "message-1",
      anchorRevision: "height:new",
    });
  });

  it("preserves current scroll position when anchored row disappears during row split", () => {
    const controller = createController({
      viewportHeight: 400,
      scrollTop: 250,
    });
    controller.setRows([
      row("intro", 100),
      row("message-1", 1000, {
        heightRevision: "message:whole",
      }),
    ]);
    controller.syncViewport(
      {
        scrollTop: 250,
        viewportHeight: 400,
        widthScope: WIDTH_SCOPE,
      },
      { source: "browser", userScrollIntent: true },
    );

    expect(controller.getState().anchor).toMatchObject({
      type: "row",
      rowId: "message-1",
      offsetWithinRow: 150,
      anchorRevision: "message:whole",
    });

    const split = controller.setRows([
      row("intro", 100),
      row("message-1:block-0", 300, {
        heightRevision: "block:0",
      }),
      row("message-1:block-1", 300, {
        heightRevision: "block:1",
      }),
      row("message-1:block-2", 400, {
        heightRevision: "block:2",
      }),
    ]);

    expect(split.correction).toBeNull();
    expect(controller.getState()).toMatchObject({
      scrollTop: 250,
      anchor: {
        type: "row",
        rowId: "message-1:block-0",
        offsetWithinRow: 150,
        anchorRevision: "block:0",
      },
    });
    expect(controller.getRange().visibleRowIds).toEqual([
      "message-1:block-0",
      "message-1:block-1",
    ]);
    expect(controller.getDiagnostics()).toMatchObject({
      missingAnchorsDropped: 1,
      recapturedAnchors: 2,
    });
  });

  it("anchors detached browser scrolls below virtual history to the nearest row", () => {
    const controller = createController({ viewportHeight: 200 });
    controller.setRows(makeRows(3, 200));

    controller.syncViewport(
      {
        scrollTop: 700,
        viewportHeight: 200,
        widthScope: WIDTH_SCOPE,
        browserScrollHeight: 1200,
      },
      { source: "browser", userScrollIntent: true },
    );

    expect(controller.getState()).toMatchObject({
      scrollTop: 700,
      distanceFromBottom: 300,
      anchor: {
        type: "row",
        rowId: "row-2",
        offsetWithinRow: 300,
      },
    });

    const measured = controller.applyMeasuredHeight({
      token: tokenFor(controller, "row-1"),
      height: 250,
    });

    expect(measured.accepted).toBe(true);
    expect(measured.correction).toMatchObject({
      reason: "row-anchor",
      previousScrollTop: 700,
      nextScrollTop: 750,
      delta: 50,
    });
    controller.syncViewport(
      {
        scrollTop: measured.correction?.nextScrollTop ?? 0,
        viewportHeight: 200,
        widthScope: WIDTH_SCOPE,
        browserScrollHeight: 1200,
      },
      { source: "browser" },
    );
    expect(controller.getState()).toMatchObject({
      scrollTop: 750,
      distanceFromBottom: 250,
      anchor: {
        type: "row",
        rowId: "row-2",
        offsetWithinRow: 300,
      },
    });
  });

  it("recaptures completed streaming fragment when tail revision changes", () => {
    const controller = createController({
      viewportHeight: 400,
      scrollTop: 250,
    });
    controller.setRows([
      row("intro", 100),
      row("message-1:stream-tail", 1000, {
        anchorPriority: "streaming",
        heightRevision: "tail:old",
      }),
    ]);
    controller.syncViewport(
      {
        scrollTop: 250,
        viewportHeight: 400,
        widthScope: WIDTH_SCOPE,
      },
      { source: "browser", userScrollIntent: true },
    );

    expect(controller.getState().anchor).toMatchObject({
      type: "row",
      rowId: "message-1:stream-tail",
      anchorRevision: "tail:old",
    });

    const promoted = controller.setRows([
      row("intro", 100),
      row("message-1:stream-block-0", 300, {
        heightRevision: "block:0",
      }),
      row("message-1:stream-tail", 700, {
        anchorPriority: "streaming",
        heightRevision: "tail:new",
      }),
    ]);

    expect(promoted.correction).toBeNull();
    expect(controller.getState()).toMatchObject({
      scrollTop: 250,
      anchor: {
        type: "row",
        rowId: "message-1:stream-block-0",
        offsetWithinRow: 150,
        anchorRevision: "block:0",
      },
    });
    expect(controller.getDiagnostics().staleAnchorsDropped).toBe(1);
  });

  it("keeps active streaming row virtual heights from shrinking until stable", () => {
    const controller = createController({ viewportHeight: 100 });
    controller.setRows([
      row("stream-tail", 300, {
        anchorPriority: "streaming",
        heightRevision: "stream:1",
      }),
    ]);

    expect(
      controller.applyMeasuredHeight({
        token: tokenFor(controller, "stream-tail"),
        height: 320,
      }).accepted,
    ).toBe(true);
    expect(controller.getState().virtualScrollHeight).toBe(320);

    controller.setRows([
      row("stream-tail", 120, {
        anchorPriority: "streaming",
        heightRevision: "stream:2",
      }),
    ]);

    expect(controller.getState().virtualScrollHeight).toBe(320);

    expect(
      controller.applyMeasuredHeight({
        token: tokenFor(controller, "stream-tail"),
        height: 200,
      }).accepted,
    ).toBe(true);
    expect(controller.getState().virtualScrollHeight).toBe(320);

    expect(
      controller.applyMeasuredHeight({
        token: tokenFor(controller, "stream-tail"),
        height: 360,
      }).accepted,
    ).toBe(true);
    expect(controller.getState().virtualScrollHeight).toBe(360);

    controller.setRows([
      row("stream-tail", 140, {
        anchorPriority: "stable",
        heightRevision: "stream:3",
      }),
    ]);

    expect(controller.getState().virtualScrollHeight).toBe(140);
  });

  it("includes row spacing in estimated virtual heights", () => {
    const controller = createController({ viewportHeight: 50 });

    controller.setRows([
      row("first", 100),
      row("second", 100, { spacingBefore: 16 }),
    ]);

    expect(controller.getState().virtualScrollHeight).toBe(216);
    expect(controller.getScrollTopForRow("first", "end")).toBe(50);
    expect(controller.getScrollTopForRow("second", "start")).toBe(100);
    expect(controller.getScrollTopForRow("second", "end")).toBe(166);
  });

  it("drops stale measurements when only row layout revision changes", () => {
    const controller = createController({ viewportHeight: 300 });
    controller.setRows([row("message-1", 100)]);
    const staleToken = tokenFor(controller, "message-1");

    expect(
      controller.applyMeasuredHeight({
        token: staleToken,
        height: 220,
      }).accepted,
    ).toBe(true);
    expect(controller.getState().virtualScrollHeight).toBe(220);

    controller.setRows([row("message-1", 100, { spacingBefore: 16 })]);

    expect(controller.getState().virtualScrollHeight).toBe(116);
    expect(
      controller.applyMeasuredHeight({
        token: staleToken,
        height: 240,
      }).accepted,
    ).toBe(false);
    expect(controller.getDiagnostics()).toMatchObject({
      staleMeasurementsDropped: 1,
      staleMeasurementRevisionDrops: 1,
    });
  });

  it("skips non-anchorable sentinels and falls back to streaming only when no stable row intersects", () => {
    const controller = createController({ viewportHeight: 300, scrollTop: 40 });
    controller.setRows([
      row("top-loading", 100, { anchorPriority: "none" }),
      row("stable-1", 100),
      row("stream-tail", 300, { anchorPriority: "streaming" }),
    ]);

    controller.syncViewport(
      {
        scrollTop: 40,
        viewportHeight: 300,
        widthScope: WIDTH_SCOPE,
      },
      { source: "browser", userScrollIntent: true },
    );

    expect(controller.getState().anchor).toMatchObject({
      type: "row",
      rowId: "stable-1",
      offsetWithinRow: -60,
    });

    controller.setRows([
      row("top-loading", 100, { anchorPriority: "none" }),
      row("stream-tail", 300, { anchorPriority: "streaming" }),
    ]);

    expect(controller.getState().anchor).toMatchObject({
      type: "row",
      rowId: "stream-tail",
      offsetWithinRow: -60,
    });
  });

  it("calculates pixel overscan ranges and includes protected rows outside the visible window", () => {
    const controller = createController(
      { viewportHeight: 100, scrollTop: 1000 },
      {
        overscanBeforePx: 200,
        overscanAfterPx: 80,
        overscanBeforeRows: 2,
        overscanAfterRows: 2,
        protectedRowIds: ["row-2", "row-90"],
      },
    );
    controller.setRows(makeRows(100, 20));
    controller.syncViewport({
      scrollTop: 1000,
      viewportHeight: 100,
      widthScope: WIDTH_SCOPE,
    });

    const range = controller.getRange();

    expect(range.visibleRange).toEqual({ startIndex: 50, endIndex: 54 });
    expect(range.renderRange.startIndex).toBe(40);
    expect(range.renderRange.endIndex).toBe(58);
    expect(range.renderedRowIds).toContain("row-2");
    expect(range.renderedRowIds).toContain("row-90");
    expect(range.protectedRowIds).toEqual(["row-2", "row-90"]);
    expect(controller.getDiagnostics()).toMatchObject({
      rangeCalculations: 1,
      protectedRowsRendered: 2,
    });
  });

  it("extracts TanStack ranges with protected indexes separate from ordinary overscan", () => {
    expect(
      computeTanStackRangeIndexes({
        range: { startIndex: 40, endIndex: 45, overscan: 2, count: 100 },
        protectedIndexes: [3, 44, 95],
      }),
    ).toEqual([3, 38, 39, 40, 41, 42, 43, 44, 45, 46, 47, 95]);
  });

  it("scrolls to initially unmounted rows by stable row id", () => {
    const controller = createController({ viewportHeight: 500 });
    controller.setRows(makeRows(100, 100));

    expect(controller.getRange().visibleRowIds).not.toContain("row-80");

    const result = controller.scrollToRow("row-80", "center");

    expect(result.found).toBe(true);
    expect(result.correction).toMatchObject({
      reason: "scroll-to-row",
      nextScrollTop: 7800,
    });
    acknowledge(controller, result.correction);
    expect(controller.getRange().visibleRowIds).toContain("row-80");
  });
});

function acknowledge(
  controller: ReturnType<typeof createTranscriptVirtualController>,
  correction: { nextScrollTop: number } | null | undefined,
  geometry: Partial<{ viewportHeight: number; footerHeight: number }> = {},
): void {
  if (!correction) return;
  const state = controller.getState();
  controller.syncViewport(
    {
      scrollTop: correction.nextScrollTop,
      viewportHeight: geometry.viewportHeight ?? state.viewportHeight,
      footerHeight: geometry.footerHeight ?? state.footerHeight,
      widthScope: state.widthScope,
      browserScrollHeight: state.virtualScrollHeight,
    },
    { source: "browser" },
  );
}

function createController(
  geometry: Partial<{
    viewportHeight: number;
    scrollTop: number;
    footerHeight: number;
  }> = {},
  options: Parameters<typeof createTranscriptVirtualController>[1] = {},
) {
  return createTranscriptVirtualController(
    {
      sessionId: SESSION_ID,
      sessionEpoch: 1,
      widthScope: WIDTH_SCOPE,
      viewportHeight: geometry.viewportHeight ?? 500,
      footerHeight: geometry.footerHeight ?? 0,
      scrollTop: geometry.scrollTop ?? 0,
    },
    options,
  );
}

function tokenFor(
  controller: ReturnType<typeof createTranscriptVirtualController>,
  rowId: string,
  overrides: Partial<TranscriptVirtualMeasurementToken> = {},
): TranscriptVirtualMeasurementToken {
  const token = controller.getMeasurementToken(rowId);
  expect(token).not.toBeNull();
  return {
    ...(token as TranscriptVirtualMeasurementToken),
    ...overrides,
  };
}

function makeRows(
  count: number,
  height: number | ((index: number) => number),
): TranscriptRowDescriptor[] {
  return Array.from({ length: count }, (_, index) =>
    row(`row-${index}`, typeof height === "number" ? height : height(index)),
  );
}

function row(
  rowId: string,
  estimatedHeight: number,
  overrides: Partial<TranscriptRowDescriptor> = {},
): TranscriptRowDescriptor {
  const spacingBefore = overrides.spacingBefore ?? 0;
  return {
    rowId,
    reactKey: rowId,
    kind: "message",
    messageId: rowId,
    blockIds: [rowId],
    renderRevision: overrides.renderRevision ?? `render:${rowId}`,
    heightRevision:
      overrides.heightRevision ?? `height:${rowId}:${estimatedHeight}`,
    layoutRevision:
      overrides.layoutRevision ?? `layout-spacing:${spacingBefore}`,
    estimatedHeight,
    spacingBefore,
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
    ...overrides,
  };
}

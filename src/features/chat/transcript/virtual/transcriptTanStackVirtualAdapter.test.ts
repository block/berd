import { describe, expect, it, vi } from "vitest";
import type { TranscriptRowDescriptor } from "../projection/transcriptItemTypes";
import {
  createTranscriptTanStackVirtualAdapter,
  type TranscriptTanStackVirtualAdapterOptions,
} from "./index";
import { TranscriptViewportCoordinator } from "./transcriptViewportCoordinator";
import type { TranscriptVirtualMeasurementToken } from "./transcriptVirtualTypes";

const SESSION_ID = "session-a";
const WIDTH_SCOPE = "w:720";

describe("TranscriptTanStackVirtualAdapter", () => {
  it("uses updated TanStack end-anchor APIs while preserving Goose bottom follow", () => {
    const adapter = createAdapter({ viewportHeight: 500 });
    const rows = makeRows(20, 100);
    adapter.setRows(rows);

    adapter.syncViewport(
      {
        scrollTop: 1496,
        viewportHeight: 500,
        widthScope: WIDTH_SCOPE,
      },
      { source: "browser", userScrollIntent: true },
    );

    expect(adapter.getDistanceFromEnd()).toBe(4);
    expect(adapter.isAtEnd()).toBe(true);
    expect(adapter.isAtEnd(1)).toBe(false);

    adapter.setRows([...rows, row("new-a", 120), row("new-b", 120)]);

    expect(adapter.getScrollTop()).toBe(adapter.getState().bottomScrollTop);
    expect(adapter.getDistanceFromEnd()).toBe(0);
    expect(adapter.isAtEnd()).toBe(true);
  });

  it("keeps proposals non-authoritative until the coordinator observes browser clamping", () => {
    const container = document.createElement("div");
    let scrollTop = 100;
    Object.defineProperties(container, {
      clientHeight: { configurable: true, value: 400 },
      clientWidth: { configurable: true, value: 720 },
      scrollHeight: { configurable: true, value: 2000 },
      scrollTop: {
        configurable: true,
        get: () => scrollTop,
        set: (value: number) => {
          scrollTop = Math.min(1600, Math.max(0, value));
        },
      },
    });
    container.getBoundingClientRect = () =>
      ({ top: 0, width: 720, height: 400 }) as DOMRect;

    const adapter = createAdapter({ viewportHeight: 400, scrollTop: 100 });
    const coordinator = new TranscriptViewportCoordinator({
      container,
      engine: adapter,
      getFooterHeight: () => 0,
    });

    expect(adapter.getState().scrollTop).toBe(100);
    coordinator.writeScrollTop(4000);
    expect(container.scrollTop).toBe(1600);
    expect(adapter.getState().scrollTop).toBe(1600);
  });

  it("keeps the bottom anchored through a viewport resize while following", () => {
    const adapter = createAdapter({ viewportHeight: 500 });
    acknowledge(adapter, adapter.setRows(makeRows(20, 100)).correction);

    expect(adapter.getScrollTop()).toBe(1500);
    expect(adapter.getState().anchor).toEqual({ type: "bottom" });

    // Shrinking the viewport leaves the browser scrollTop above the new
    // bottom; the intent-less geometry sync must restore bottom follow
    // instead of treating the drift as a user scroll away from the end.
    const resized = adapter.syncViewport(
      {
        scrollTop: 1500,
        viewportHeight: 300,
        widthScope: WIDTH_SCOPE,
      },
      { source: "browser" },
    );
    acknowledge(adapter, resized.correction);

    expect(adapter.getScrollTop()).toBe(1700);
    expect(adapter.getState()).toMatchObject({
      anchor: { type: "bottom" },
      pinnedToBottom: true,
    });
    expect(adapter.getDiagnostics().bottomFollowExits).toBe(0);
  });

  it("keeps the captured row anchored through a width-scope change", () => {
    const adapter = createAdapter({ viewportHeight: 300 });
    adapter.setRows(makeRows(10, 100));
    adapter.applyMeasuredHeight({
      token: tokenFor(adapter, "row-2"),
      height: 200,
    });

    adapter.syncViewport(
      {
        scrollTop: 620,
        viewportHeight: 300,
        widthScope: WIDTH_SCOPE,
      },
      { source: "browser", userScrollIntent: true },
    );

    expect(adapter.getState().anchor).toMatchObject({
      type: "row",
      rowId: "row-5",
      offsetWithinRow: 20,
    });

    // The width change keeps the last accepted height as provisional live
    // geometry, so the browser scroll position stays put and the captured row
    // remains stable while same-width remeasurement catches up.
    adapter.syncViewport(
      {
        scrollTop: 620,
        viewportHeight: 300,
        widthScope: "w:600",
      },
      { source: "browser", userScrollIntent: true },
    );

    expect(adapter.getScrollTop()).toBe(620);
    expect(adapter.getState().anchor).toMatchObject({
      type: "row",
      rowId: "row-5",
      offsetWithinRow: 20,
    });

    // Remeasurement at the new width rewraps row-2 to 320px; the anchored row
    // stays pinned at the same viewport offset.
    const remeasured = adapter.applyMeasuredHeight({
      token: tokenFor(adapter, "row-2"),
      height: 320,
    });

    expect(remeasured.accepted).toBe(true);
    expect(adapter.getScrollTop()).toBe(740);
    expect(adapter.getState().anchor).toMatchObject({
      type: "row",
      rowId: "row-5",
      offsetWithinRow: 20,
    });
  });

  it("keeps detached users detached when updated TanStack follow-on-append is enabled", () => {
    const adapter = createAdapter({ viewportHeight: 500 });
    const rows = makeRows(20, 100);
    adapter.setRows(rows);
    adapter.syncViewport(
      {
        scrollTop: 1200,
        viewportHeight: 500,
        widthScope: WIDTH_SCOPE,
      },
      { source: "browser", userScrollIntent: true },
    );

    expect(adapter.isAtEnd()).toBe(false);

    adapter.setRows([...rows, row("new-a", 120), row("new-b", 120)]);

    expect(adapter.getScrollTop()).toBe(1200);
    expect(adapter.isAtEnd()).toBe(false);
  });

  it("uses updated TanStack scrollToEnd for explicit bottom targets", () => {
    const adapter = createAdapter({ viewportHeight: 500 });
    adapter.setRows(makeRows(20, 100));
    adapter.syncViewport({
      scrollTop: 0,
      viewportHeight: 500,
      widthScope: WIDTH_SCOPE,
    });

    adapter.scrollToEnd();

    expect(adapter.getScrollTop()).toBe(adapter.getState().bottomScrollTop);
    expect(adapter.getDistanceFromEnd()).toBe(0);
    expect(adapter.isAtEnd()).toBe(true);
  });

  it("passes requested scroll behavior through explicit bottom targets", () => {
    const adapter = createAdapter({ viewportHeight: 500 });
    adapter.setRows(makeRows(20, 100));
    const scrollToEnd = vi.spyOn(
      (
        adapter as unknown as {
          virtualizer: { scrollToEnd: (options?: unknown) => void };
        }
      ).virtualizer,
      "scrollToEnd",
    );

    adapter.scrollToEnd({ behavior: "smooth" });

    expect(scrollToEnd).toHaveBeenCalledWith({ behavior: "smooth" });
  });

  it("extracts a pixel lookbehind range and protected rows through TanStack range extraction", () => {
    const adapter = createAdapter(
      { viewportHeight: 100, scrollTop: 1000 },
      {
        overscanBeforePx: 200,
        overscanAfterPx: 80,
        overscanBeforeRows: 2,
        overscanAfterRows: 2,
        protectedRowIds: ["row-2", "row-90"],
      },
    );
    acknowledge(adapter, adapter.setRows(makeRows(100, 20)).correction);
    adapter.syncViewport({
      scrollTop: 1000,
      viewportHeight: 100,
      widthScope: WIDTH_SCOPE,
    });

    const range = adapter.getRange();

    expect(range.visibleRange).toEqual({ startIndex: 50, endIndex: 54 });
    expect(range.renderRange).toMatchObject({
      startIndex: 40,
      endIndex: 58,
    });
    expect(range.renderedRowIds).toContain("row-2");
    expect(range.renderedRowIds).toContain("row-90");
    expect(range.protectedRowIds).toEqual(["row-2", "row-90"]);
  });

  it("keeps stable row keys separate from revisions and rejects stale measurements before TanStack cache writes", () => {
    const adapter = createAdapter({ viewportHeight: 500 });
    const rows = makeRows(20, 100);
    adapter.setRows(rows);

    const token = tokenFor(adapter, "row-5");
    const beforeSize = adapter.getTanStackTotalSize();
    const renderOnlyRows = rows.map((current) =>
      current.rowId === "row-5"
        ? row("row-5", 100, {
            renderRevision: "render:new",
            heightRevision: current.heightRevision,
          })
        : current,
    );
    adapter.setRows(renderOnlyRows);

    expect(
      adapter.getTanStackVirtualItems().map((item) => String(item.key)),
    ).toContain("row-5");
    expect(
      adapter.applyMeasuredHeight({
        token: { ...token, heightRevision: "height:stale" },
        height: 180,
      }).accepted,
    ).toBe(false);
    expect(adapter.getTanStackTotalSize()).toBe(beforeSize);

    expect(adapter.applyMeasuredHeight({ token, height: 180 }).accepted).toBe(
      true,
    );
    expect(adapter.getTanStackTotalSize()).toBe(beforeSize + 80);
    expect(adapter.getDiagnostics()).toMatchObject({
      staleMeasurementsDropped: 1,
      staleMeasurementRevisionDrops: 1,
      measuredHeightUpdates: 1,
    });
  });

  it("keeps the rendered range on the acknowledged viewport while a measurement correction is suspended", () => {
    const container = document.createElement("div");
    let scrollTop = 620;
    Object.defineProperties(container, {
      clientHeight: { configurable: true, value: 300 },
      clientWidth: { configurable: true, value: 720 },
      scrollHeight: { configurable: true, value: 1100 },
      scrollTop: {
        configurable: true,
        get: () => scrollTop,
        set: (value: number) => {
          // Model a browser that accepts the write only up to its live limit.
          scrollTop = Math.min(700, Math.max(0, value));
        },
      },
    });
    container.getBoundingClientRect = () =>
      ({ top: 0, width: 720, height: 300 }) as DOMRect;

    const adapter = createAdapter({ viewportHeight: 300, scrollTop: 620 });
    adapter.setRows(makeRows(10, 100));
    adapter.syncViewport(
      {
        scrollTop: 620,
        viewportHeight: 300,
        widthScope: WIDTH_SCOPE,
      },
      { source: "browser", userScrollIntent: true },
    );
    const coordinator = new TranscriptViewportCoordinator({
      container,
      engine: adapter,
      getFooterHeight: () => 0,
    });

    coordinator.setScrollWritesSuspended(true);
    const measured = coordinator.applyMeasuredHeight({
      token: tokenFor(adapter, "row-2"),
      height: 200,
    });

    expect(measured).toMatchObject({
      accepted: true,
      correction: { previousScrollTop: 620, nextScrollTop: 720 },
    });
    expect(container.scrollTop).toBe(620);
    expect(adapter.getScrollTop()).toBe(620);
    expect(coordinator.getRange().visibleRowIds).toEqual([
      "row-5",
      "row-6",
      "row-7",
      "row-8",
    ]);

    coordinator.setScrollWritesSuspended(false);
    coordinator.writeScrollTop(measured.correction?.nextScrollTop ?? 0, {
      source: "correction",
    });

    expect(container.scrollTop).toBe(700);
    expect(adapter.getScrollTop()).toBe(700);
    expect(adapter.getState().scrollTop).toBe(700);
    expect(coordinator.getRange().visibleRowIds).toEqual([
      "row-6",
      "row-7",
      "row-8",
    ]);
  });

  it("keeps Goose row anchors when upward scroll detaches before idle measurement flush", () => {
    const adapter = createAdapter({ viewportHeight: 300 });
    adapter.setRows(makeRows(10, 100));

    adapter.syncViewport(
      {
        scrollTop: 620,
        viewportHeight: 300,
        widthScope: WIDTH_SCOPE,
      },
      { source: "browser", userScrollIntent: true },
    );

    expect(adapter.getState().anchor).toMatchObject({
      type: "row",
      rowId: "row-6",
      offsetWithinRow: 20,
    });

    const measured = adapter.applyMeasuredHeight({
      token: tokenFor(adapter, "row-2"),
      height: 200,
    });

    expect(measured).toMatchObject({
      accepted: true,
      correction: {
        reason: "row-anchor",
        previousScrollTop: 620,
        nextScrollTop: 720,
        delta: 100,
      },
    });
    expect(adapter.getScrollTop()).toBe(720);
    expect(adapter.getState().scrollTop).toBe(620);
    acknowledge(adapter, measured.correction);
    expect(adapter.getState()).toMatchObject({
      scrollTop: 720,
      anchor: {
        type: "row",
        rowId: "row-6",
        offsetWithinRow: 20,
      },
    });
  });

  it("keeps active streaming row virtual heights from shrinking until stable", () => {
    const adapter = createAdapter({ viewportHeight: 100 });
    adapter.setRows([
      row("stream-tail", 300, {
        anchorPriority: "streaming",
        heightRevision: "stream:1",
      }),
    ]);

    expect(
      adapter.applyMeasuredHeight({
        token: tokenFor(adapter, "stream-tail"),
        height: 320,
      }).accepted,
    ).toBe(true);
    expect(adapter.getTanStackTotalSize()).toBe(320);

    adapter.setRows([
      row("stream-tail", 120, {
        anchorPriority: "streaming",
        heightRevision: "stream:2",
      }),
    ]);

    expect(adapter.getTanStackTotalSize()).toBe(320);

    expect(
      adapter.applyMeasuredHeight({
        token: tokenFor(adapter, "stream-tail"),
        height: 200,
      }).accepted,
    ).toBe(true);
    expect(adapter.getTanStackTotalSize()).toBe(320);

    expect(
      adapter.applyMeasuredHeight({
        token: tokenFor(adapter, "stream-tail"),
        height: 360,
      }).accepted,
    ).toBe(true);
    expect(adapter.getTanStackTotalSize()).toBe(360);

    adapter.setRows([
      row("stream-tail", 140, {
        anchorPriority: "stable",
        heightRevision: "stream:3",
      }),
    ]);

    expect(adapter.getTanStackTotalSize()).toBe(140);
  });

  it("uses Goose stale-anchor guards for same-row height revisions", () => {
    const adapter = createAdapter({
      viewportHeight: 300,
      scrollTop: 150,
    });
    adapter.setRows([
      row("intro", 100),
      row("message-1", 400, {
        renderRevision: "render:old",
        heightRevision: "height:stable",
      }),
      row("after", 400),
    ]);
    adapter.syncViewport(
      {
        scrollTop: 150,
        viewportHeight: 300,
        widthScope: WIDTH_SCOPE,
      },
      { source: "browser", userScrollIntent: true },
    );

    adapter.setRows([
      row("intro", 100),
      row("message-1", 400, {
        renderRevision: "render:new",
        heightRevision: "height:stable",
      }),
      row("after", 400),
    ]);

    expect(adapter.getDiagnostics().staleAnchorsDropped).toBe(0);

    adapter.setRows([
      row("intro", 100),
      row("message-1", 400, {
        renderRevision: "render:newer",
        heightRevision: "height:new",
      }),
      row("after", 400),
    ]);

    expect(adapter.getDiagnostics().staleAnchorsDropped).toBe(1);
    expect(adapter.getState().anchor).toMatchObject({
      type: "row",
      rowId: "message-1",
      anchorRevision: "height:new",
    });
  });

  it("recaptures Goose anchors across whole-row split and streaming-tail promotion", () => {
    const splitAdapter = createAdapter({
      viewportHeight: 400,
      scrollTop: 250,
    });
    splitAdapter.setRows([
      row("intro", 100),
      row("message-1", 1000, {
        heightRevision: "message:whole",
      }),
    ]);
    splitAdapter.syncViewport(
      {
        scrollTop: 250,
        viewportHeight: 400,
        widthScope: WIDTH_SCOPE,
      },
      { source: "browser", userScrollIntent: true },
    );

    splitAdapter.setRows([
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

    expect(splitAdapter.getState()).toMatchObject({
      scrollTop: 250,
      anchor: {
        type: "row",
        rowId: "message-1:block-0",
        offsetWithinRow: 150,
        anchorRevision: "block:0",
      },
    });

    const streamingAdapter = createAdapter({
      viewportHeight: 400,
      scrollTop: 250,
    });
    streamingAdapter.setRows([
      row("intro", 100),
      row("message-1:stream-tail", 1000, {
        anchorPriority: "streaming",
        heightRevision: "tail:old",
      }),
    ]);
    streamingAdapter.syncViewport(
      {
        scrollTop: 250,
        viewportHeight: 400,
        widthScope: WIDTH_SCOPE,
      },
      { source: "browser", userScrollIntent: true },
    );

    streamingAdapter.setRows([
      row("intro", 100),
      row("message-1:stream-block-0", 300, {
        heightRevision: "block:0",
      }),
      row("message-1:stream-tail", 700, {
        anchorPriority: "streaming",
        heightRevision: "tail:new",
      }),
    ]);

    expect(streamingAdapter.getState()).toMatchObject({
      scrollTop: 250,
      anchor: {
        type: "row",
        rowId: "message-1:stream-block-0",
        offsetWithinRow: 150,
        anchorRevision: "block:0",
      },
    });
    expect(streamingAdapter.getDiagnostics().staleAnchorsDropped).toBe(1);
  });
});

function createAdapter(
  geometry: Partial<{
    viewportHeight: number;
    scrollTop: number;
    footerHeight: number;
  }> = {},
  options: TranscriptTanStackVirtualAdapterOptions = {},
) {
  return createTranscriptTanStackVirtualAdapter(
    {
      sessionId: SESSION_ID,
      sessionEpoch: 1,
      widthScope: WIDTH_SCOPE,
      viewportHeight: geometry.viewportHeight ?? 500,
      footerHeight: geometry.footerHeight ?? 0,
      scrollTop: geometry.scrollTop ?? 0,
    },
    {
      anchorTo: "end",
      followOnAppend: "auto",
      scrollEndThresholdPx: 5,
      ...options,
    },
  );
}

function acknowledge(
  adapter: ReturnType<typeof createTranscriptTanStackVirtualAdapter>,
  correction: { nextScrollTop: number } | null | undefined,
): void {
  if (!correction) return;
  const state = adapter.getState();
  adapter.syncViewport(
    {
      scrollTop: correction.nextScrollTop,
      viewportHeight: state.viewportHeight,
      footerHeight: state.footerHeight,
      widthScope: state.widthScope,
      browserScrollHeight: state.virtualScrollHeight,
    },
    { source: "browser" },
  );
}

function tokenFor(
  adapter: ReturnType<typeof createTranscriptTanStackVirtualAdapter>,
  rowId: string,
  overrides: Partial<TranscriptVirtualMeasurementToken> = {},
): TranscriptVirtualMeasurementToken {
  const token = adapter.getMeasurementToken(rowId);
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
    ...overrides,
  };
}

import type { Message } from "@/shared/types/messages";

/**
 * Test fixtures for mocking useTranscriptVirtualTimeline in component tests.
 * Single source for the snapshot shape so suites don't drift as controller
 * diagnostics/measurement fields evolve.
 */

export function textMessage(
  id: string,
  role: Message["role"],
  text: string,
): Message {
  return {
    id,
    role,
    created: Date.UTC(2026, 5, 4, 12, 0, 0),
    content: [{ type: "text", text }],
    metadata: { userVisible: true },
  };
}

export function buildVirtualTimelineSnapshot({
  footerHeight,
  rows,
  sessionEpoch,
  sessionId,
  window: renderWindow,
}: {
  footerHeight: number;
  rows: readonly { rowId: string }[];
  sessionEpoch: number;
  sessionId: string;
  /** Bounded-controller render window; rows outside it are unmounted. */
  window?: { start: number; end: number };
}) {
  const windowStart = Math.max(0, renderWindow?.start ?? 0);
  const windowEnd = Math.min(
    rows.length,
    renderWindow?.end ?? Number.POSITIVE_INFINITY,
  );
  const windowedRows = rows.slice(windowStart, windowEnd);
  const virtualItems = windowedRows.map((row, offset) => {
    const index = windowStart + offset;
    return {
      index,
      key: row.rowId,
      row,
      start: index * 120,
      size: 120,
      end: (index + 1) * 120,
      visible: true,
      protected: false,
    };
  });
  const scrollHeight = rows.length * 120 + footerHeight;

  return {
    engineKind: "test",
    mode: "bounded-controller",
    range: {
      totalHeight: scrollHeight,
      scrollHeight,
      visibleRange: { startIndex: windowStart, endIndex: windowEnd - 1 },
      renderRange: {
        startIndex: windowStart,
        endIndex: windowEnd - 1,
        visibleStartIndex: windowStart,
        visibleEndIndex: windowEnd - 1,
      },
      virtualItems,
      visibleRowIds: windowedRows.map((row) => row.rowId),
      renderedRowIds: windowedRows.map((row) => row.rowId),
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

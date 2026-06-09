import type { TranscriptRowDescriptor } from "../projection/transcriptItemTypes";
import {
  TRANSCRIPT_DEFAULT_OVERSCAN_AFTER_PX,
  TRANSCRIPT_DEFAULT_OVERSCAN_AFTER_ROWS,
  TRANSCRIPT_DEFAULT_OVERSCAN_BEFORE_PX,
  TRANSCRIPT_DEFAULT_OVERSCAN_BEFORE_ROWS,
  type TranscriptRenderRange,
  type TranscriptVirtualItem,
  type TranscriptVirtualRangeSnapshot,
  type TranscriptVisibleRange,
} from "./transcriptVirtualTypes";

export interface TranscriptRangeInput {
  rows: readonly TranscriptRowDescriptor[];
  scrollTop: number;
  viewportHeight: number;
  footerHeight?: number;
  overscanBeforePx?: number;
  overscanAfterPx?: number;
  overscanBeforeRows?: number;
  overscanAfterRows?: number;
  protectedRowIds?: readonly string[];
  getRowHeight: (row: TranscriptRowDescriptor) => number;
}

export interface TanStackRangeLike {
  startIndex: number;
  endIndex: number;
  overscan: number;
  count: number;
}

export interface TranscriptPixelRangeInput {
  rows: readonly TranscriptRowDescriptor[];
  range: TanStackRangeLike;
  overscanBeforePx?: number;
  overscanAfterPx?: number;
  overscanBeforeRows?: number;
  overscanAfterRows?: number;
  protectedIndexes?: readonly number[];
  getRowHeight: (row: TranscriptRowDescriptor) => number;
}

export interface TranscriptPixelRangeSelection {
  visibleRange: TranscriptVisibleRange;
  renderRange: TranscriptRenderRange;
  indexes: readonly number[];
  protectedIndexes: readonly number[];
}

export function computeTranscriptVirtualRange({
  rows,
  scrollTop,
  viewportHeight,
  footerHeight = 0,
  overscanBeforePx = TRANSCRIPT_DEFAULT_OVERSCAN_BEFORE_PX,
  overscanAfterPx = TRANSCRIPT_DEFAULT_OVERSCAN_AFTER_PX,
  overscanBeforeRows = TRANSCRIPT_DEFAULT_OVERSCAN_BEFORE_ROWS,
  overscanAfterRows = TRANSCRIPT_DEFAULT_OVERSCAN_AFTER_ROWS,
  protectedRowIds = [],
  getRowHeight,
}: TranscriptRangeInput): TranscriptVirtualRangeSnapshot {
  const rowMetrics = buildRowMetrics(rows, getRowHeight);
  const totalHeight = rowMetrics.at(-1)?.end ?? 0;
  const scrollHeight = totalHeight + footerHeight;
  const visibleRange = computeVisibleRangeFromMetrics({
    rowCount: rows.length,
    rowMetrics,
    scrollTop,
    viewportHeight,
  });
  const renderRange = computeRenderRange({
    rowMetrics,
    visibleRange,
    scrollTop,
    viewportHeight,
    overscanBeforePx,
    overscanAfterPx,
    overscanBeforeRows,
    overscanAfterRows,
  });
  const protectedIndexes = getProtectedIndexes(rows, protectedRowIds);
  const renderedIndexes = createContiguousRangeIndexes(
    renderRange.startIndex,
    renderRange.endIndex,
  );

  for (const index of protectedIndexes) {
    renderedIndexes.add(index);
  }

  const virtualItems = Array.from(renderedIndexes)
    .sort((left, right) => left - right)
    .map((index) => {
      const row = rows[index] as TranscriptRowDescriptor;
      const metric = rowMetrics[index] as RowMetric;
      return {
        index,
        key: row.rowId,
        row,
        start: metric.start,
        size: metric.size,
        end: metric.end,
        visible: isIndexInsideRange(index, visibleRange),
        protected: protectedIndexes.has(index),
      } satisfies TranscriptVirtualItem;
    });

  const paddingStart = rowMetrics[renderRange.startIndex]?.start ?? 0;
  const paddingEnd =
    totalHeight - (rowMetrics[renderRange.endIndex]?.end ?? totalHeight);

  return {
    totalHeight,
    scrollHeight,
    visibleRange,
    renderRange,
    virtualItems,
    visibleRowIds: rows
      .slice(visibleRange.startIndex, visibleRange.endIndex + 1)
      .map((row) => row.rowId),
    renderedRowIds: virtualItems.map((item) => item.key),
    protectedRowIds: virtualItems
      .filter((item) => item.protected)
      .map((item) => item.key),
    paddingStart,
    paddingEnd: Math.max(0, paddingEnd),
  };
}

export function createTranscriptRangeExtractor(
  protectedIndexes: () => readonly number[],
): (range: TanStackRangeLike) => number[] {
  return (range) =>
    computeTanStackRangeIndexes({
      range,
      protectedIndexes: protectedIndexes(),
    });
}

export function computeTranscriptPixelRangeIndexes({
  rows,
  range,
  overscanBeforePx = TRANSCRIPT_DEFAULT_OVERSCAN_BEFORE_PX,
  overscanAfterPx = TRANSCRIPT_DEFAULT_OVERSCAN_AFTER_PX,
  overscanBeforeRows = TRANSCRIPT_DEFAULT_OVERSCAN_BEFORE_ROWS,
  overscanAfterRows = TRANSCRIPT_DEFAULT_OVERSCAN_AFTER_ROWS,
  protectedIndexes = [],
  getRowHeight,
}: TranscriptPixelRangeInput): TranscriptPixelRangeSelection {
  const rowMetrics = buildRowMetrics(rows, getRowHeight);
  const visibleRange = normalizeVisibleRange(range, rows.length);

  if (
    rows.length === 0 ||
    visibleRange.startIndex < 0 ||
    visibleRange.endIndex < visibleRange.startIndex
  ) {
    return {
      visibleRange,
      renderRange: {
        startIndex: 0,
        endIndex: -1,
        visibleStartIndex: visibleRange.startIndex,
        visibleEndIndex: visibleRange.endIndex,
      },
      indexes: [],
      protectedIndexes: [],
    };
  }

  const renderRange = computeRenderRangeFromVisibleMetrics({
    rowMetrics,
    visibleRange,
    overscanBeforePx,
    overscanAfterPx,
    overscanBeforeRows: Math.max(overscanBeforeRows, range.overscan),
    overscanAfterRows: Math.max(overscanAfterRows, range.overscan),
  });
  const renderedIndexes = createContiguousRangeIndexes(
    renderRange.startIndex,
    renderRange.endIndex,
  );
  const validProtectedIndexes = protectedIndexes.filter(
    (index) => Number.isInteger(index) && index >= 0 && index < range.count,
  );

  for (const index of validProtectedIndexes) {
    renderedIndexes.add(index);
  }

  return {
    visibleRange,
    renderRange,
    indexes: Array.from(renderedIndexes).sort((left, right) => left - right),
    protectedIndexes: Array.from(new Set(validProtectedIndexes)).sort(
      (left, right) => left - right,
    ),
  };
}

export function computeTanStackRangeIndexes({
  range,
  protectedIndexes = [],
}: {
  range: TanStackRangeLike;
  protectedIndexes?: readonly number[];
}): number[] {
  const indexes = createContiguousRangeIndexes(
    Math.max(0, range.startIndex - range.overscan),
    Math.min(range.count - 1, range.endIndex + range.overscan),
  );

  for (const index of protectedIndexes) {
    if (index >= 0 && index < range.count) {
      indexes.add(index);
    }
  }

  return Array.from(indexes).sort((left, right) => left - right);
}

interface RowMetric {
  start: number;
  size: number;
  end: number;
}

function normalizeVisibleRange(
  range: TanStackRangeLike,
  rowCount: number,
): TranscriptVisibleRange {
  if (rowCount === 0 || range.count === 0) {
    return { startIndex: 0, endIndex: -1 };
  }

  const maxIndex = Math.min(rowCount, range.count) - 1;
  const startIndex = clampIndex(range.startIndex, maxIndex);
  const endIndex = clampIndex(range.endIndex, maxIndex);

  return {
    startIndex: Math.min(startIndex, endIndex),
    endIndex: Math.max(startIndex, endIndex),
  };
}

function buildRowMetrics(
  rows: readonly TranscriptRowDescriptor[],
  getRowHeight: (row: TranscriptRowDescriptor) => number,
): readonly RowMetric[] {
  let offset = 0;
  return rows.map((row) => {
    const size = Math.max(0, getRowHeight(row));
    const metric = {
      start: offset,
      size,
      end: offset + size,
    };
    offset = metric.end;
    return metric;
  });
}

function computeRenderRangeFromVisibleMetrics({
  rowMetrics,
  visibleRange,
  overscanBeforePx,
  overscanAfterPx,
  overscanBeforeRows,
  overscanAfterRows,
}: {
  rowMetrics: readonly RowMetric[];
  visibleRange: TranscriptVisibleRange;
  overscanBeforePx: number;
  overscanAfterPx: number;
  overscanBeforeRows: number;
  overscanAfterRows: number;
}): TranscriptRenderRange {
  const visibleStartMetric = rowMetrics[visibleRange.startIndex] as RowMetric;
  const visibleEndMetric = rowMetrics[visibleRange.endIndex] as RowMetric;
  const beforeTarget = Math.max(0, visibleStartMetric.start - overscanBeforePx);
  const afterTarget = visibleEndMetric.end + overscanAfterPx;
  let startIndex = visibleRange.startIndex;
  let endIndex = visibleRange.endIndex;

  while (startIndex > 0) {
    const previous = rowMetrics[startIndex - 1] as RowMetric;
    if (
      previous.end <= beforeTarget &&
      visibleRange.startIndex - startIndex >= overscanBeforeRows
    ) {
      break;
    }
    startIndex -= 1;
  }

  while (endIndex < rowMetrics.length - 1) {
    const next = rowMetrics[endIndex + 1] as RowMetric;
    if (
      next.start >= afterTarget &&
      endIndex - visibleRange.endIndex >= overscanAfterRows
    ) {
      break;
    }
    endIndex += 1;
  }

  return {
    startIndex,
    endIndex,
    visibleStartIndex: visibleRange.startIndex,
    visibleEndIndex: visibleRange.endIndex,
  };
}

function computeVisibleRangeFromMetrics({
  rowCount,
  rowMetrics,
  scrollTop,
  viewportHeight,
}: {
  rowCount: number;
  rowMetrics: readonly RowMetric[];
  scrollTop: number;
  viewportHeight: number;
}): TranscriptVisibleRange {
  if (rowCount === 0) {
    return { startIndex: 0, endIndex: -1 };
  }

  const viewportEnd = scrollTop + viewportHeight;
  let startIndex = rowCount - 1;
  let endIndex = 0;

  for (let index = 0; index < rowMetrics.length; index += 1) {
    const metric = rowMetrics[index] as RowMetric;
    if (metric.end > scrollTop) {
      startIndex = index;
      break;
    }
  }

  for (let index = startIndex; index < rowMetrics.length; index += 1) {
    const metric = rowMetrics[index] as RowMetric;
    if (metric.start < viewportEnd) {
      endIndex = index;
      continue;
    }
    break;
  }

  return {
    startIndex,
    endIndex: Math.max(startIndex, endIndex),
  };
}

function computeRenderRange({
  rowMetrics,
  visibleRange,
  scrollTop,
  viewportHeight,
  overscanBeforePx,
  overscanAfterPx,
  overscanBeforeRows,
  overscanAfterRows,
}: {
  rowMetrics: readonly RowMetric[];
  visibleRange: TranscriptVisibleRange;
  scrollTop: number;
  viewportHeight: number;
  overscanBeforePx: number;
  overscanAfterPx: number;
  overscanBeforeRows: number;
  overscanAfterRows: number;
}): TranscriptRenderRange {
  if (
    rowMetrics.length === 0 ||
    visibleRange.endIndex < visibleRange.startIndex
  ) {
    return {
      startIndex: 0,
      endIndex: -1,
      visibleStartIndex: visibleRange.startIndex,
      visibleEndIndex: visibleRange.endIndex,
    };
  }

  const beforeTarget = Math.max(0, scrollTop - overscanBeforePx);
  const afterTarget = scrollTop + viewportHeight + overscanAfterPx;
  let startIndex = visibleRange.startIndex;
  let endIndex = visibleRange.endIndex;

  while (startIndex > 0) {
    const previous = rowMetrics[startIndex - 1] as RowMetric;
    if (
      previous.end <= beforeTarget &&
      visibleRange.startIndex - startIndex >= overscanBeforeRows
    ) {
      break;
    }
    startIndex -= 1;
  }

  while (endIndex < rowMetrics.length - 1) {
    const next = rowMetrics[endIndex + 1] as RowMetric;
    if (
      next.start >= afterTarget &&
      endIndex - visibleRange.endIndex >= overscanAfterRows
    ) {
      break;
    }
    endIndex += 1;
  }

  return {
    startIndex,
    endIndex,
    visibleStartIndex: visibleRange.startIndex,
    visibleEndIndex: visibleRange.endIndex,
  };
}

function createContiguousRangeIndexes(startIndex: number, endIndex: number) {
  const indexes = new Set<number>();
  for (let index = startIndex; index <= endIndex; index += 1) {
    indexes.add(index);
  }
  return indexes;
}

function clampIndex(index: number, maxIndex: number): number {
  return Math.min(Math.max(0, index), maxIndex);
}

function getProtectedIndexes(
  rows: readonly TranscriptRowDescriptor[],
  protectedRowIds: readonly string[],
): Set<number> {
  const protectedIds = new Set(protectedRowIds);
  const indexes = new Set<number>();
  rows.forEach((row, index) => {
    if (protectedIds.has(row.rowId)) {
      indexes.add(index);
    }
  });
  return indexes;
}

function isIndexInsideRange(
  index: number,
  range: TranscriptVisibleRange,
): boolean {
  return index >= range.startIndex && index <= range.endIndex;
}

import {
  Virtualizer,
  type Range,
  type Rect,
  type VirtualItem,
} from "@tanstack/react-virtual";

export interface SpikeRow {
  id: string;
  estimatedHeight: number;
  heightRevision: string;
}

export interface MeasurementToken {
  sessionId: string;
  sessionEpoch: number;
  widthScope: string;
  rowId: string;
  heightRevision: string;
}

export interface CapturedAnchor {
  rowId: string;
  offsetWithinRow: number;
}

interface SpikeEngineInit {
  rows: readonly SpikeRow[];
  viewportHeight: number;
  width: number;
  sessionId: string;
  sessionEpoch: number;
  widthScope: string;
  scrollTop?: number;
  overscan?: number;
  anchorTo?: "start" | "end";
  followOnAppend?: boolean | "auto" | "smooth" | "instant";
  scrollEndThreshold?: number;
}

type ScrollAlignment = "start" | "center" | "end" | "auto";

interface FakeScrollElement {
  clientHeight: number;
  scrollHeight: number;
  scrollTop: number;
  flushAnimationFrames: () => void;
  ownerDocument: {
    defaultView: {
      performance: Pick<Performance, "now">;
      requestAnimationFrame: (callback: FrameRequestCallback) => number;
      cancelAnimationFrame: (id: number) => void;
    };
  };
}

export function makeRows(
  count: number,
  heightForIndex: (index: number) => number,
  prefix = "row",
): SpikeRow[] {
  return Array.from({ length: count }, (_, index) => {
    const height = heightForIndex(index);
    return {
      id: `${prefix}-${index}`,
      estimatedHeight: height,
      heightRevision: `h:${height}`,
    };
  });
}

function createFakeScrollElement(
  viewportHeight: number,
  initialScrollTop: number,
): FakeScrollElement {
  let frameId = 0;
  const queuedFrames: FrameRequestCallback[] = [];
  return {
    clientHeight: viewportHeight,
    scrollHeight: 0,
    scrollTop: initialScrollTop,
    flushAnimationFrames: () => {
      while (queuedFrames.length > 0) {
        queuedFrames.shift()?.(performance.now());
      }
    },
    ownerDocument: {
      defaultView: {
        performance: {
          now: () => performance.now(),
        },
        requestAnimationFrame: (callback) => {
          frameId += 1;
          queuedFrames.push(callback);
          return frameId;
        },
        cancelAnimationFrame: () => undefined,
      },
    },
  };
}

function validateMeasurementToken(
  token: MeasurementToken,
  expected: {
    sessionId: string;
    sessionEpoch: number;
    widthScope: string;
    rowsById: ReadonlyMap<string, SpikeRow>;
  },
): boolean {
  const row = expected.rowsById.get(token.rowId);
  return (
    token.sessionId === expected.sessionId &&
    token.sessionEpoch === expected.sessionEpoch &&
    token.widthScope === expected.widthScope &&
    row?.heightRevision === token.heightRevision
  );
}

export class ReferenceTranscriptController {
  private rows: readonly SpikeRow[];
  private readonly measuredHeights = new Map<string, number>();

  constructor(rows: readonly SpikeRow[]) {
    this.rows = rows;
  }

  setRows(rows: readonly SpikeRow[]): void {
    this.rows = rows;
  }

  getTotalHeight(): number {
    return this.rows.reduce((total, row) => total + this.getRowHeight(row), 0);
  }

  getBottomScrollTop(viewportHeight: number): number {
    return Math.max(0, this.getTotalHeight() - viewportHeight);
  }

  captureAnchor(scrollTop: number): CapturedAnchor {
    let top = 0;
    for (const row of this.rows) {
      const height = this.getRowHeight(row);
      if (top + height > scrollTop) {
        return {
          rowId: row.id,
          offsetWithinRow: scrollTop - top,
        };
      }
      top += height;
    }

    const lastRow = this.rows.at(-1);
    if (!lastRow) {
      return { rowId: "", offsetWithinRow: 0 };
    }

    return {
      rowId: lastRow.id,
      offsetWithinRow: this.getRowHeight(lastRow),
    };
  }

  restoreAnchor(anchor: CapturedAnchor): number {
    return Math.max(0, this.getRowTop(anchor.rowId) + anchor.offsetWithinRow);
  }

  measureRow(rowId: string, height: number): void {
    this.measuredHeights.set(rowId, height);
  }

  getRowTop(rowId: string): number {
    let top = 0;
    for (const row of this.rows) {
      if (row.id === rowId) {
        return top;
      }
      top += this.getRowHeight(row);
    }
    return top;
  }

  private getRowHeight(row: SpikeRow): number {
    return this.measuredHeights.get(row.id) ?? row.estimatedHeight;
  }
}

export class TanStackSpikeAdapter {
  private rows: readonly SpikeRow[];
  private readonly scrollElement: FakeScrollElement;
  private readonly measuredHeights = new Map<string, number>();
  private readonly viewportHeight: number;
  private readonly width: number;
  private readonly overscan: number;
  private readonly anchorTo: "start" | "end";
  private readonly followOnAppend: boolean | "auto" | "smooth" | "instant";
  private readonly scrollEndThreshold: number;
  private readonly sessionId: string;
  private readonly sessionEpoch: number;
  private readonly widthScope: string;
  private offsetCallback:
    | ((offset: number, isScrolling: boolean) => void)
    | null = null;
  private rectCallback: ((rect: Rect) => void) | null = null;
  private virtualizer: Virtualizer<HTMLElement, HTMLElement>;

  constructor({
    rows,
    viewportHeight,
    width,
    sessionId,
    sessionEpoch,
    widthScope,
    scrollTop = 0,
    overscan = 3,
    anchorTo = "start",
    followOnAppend = false,
    scrollEndThreshold = 1,
  }: SpikeEngineInit) {
    this.rows = rows;
    this.viewportHeight = viewportHeight;
    this.width = width;
    this.overscan = overscan;
    this.anchorTo = anchorTo;
    this.followOnAppend = followOnAppend;
    this.scrollEndThreshold = scrollEndThreshold;
    this.sessionId = sessionId;
    this.sessionEpoch = sessionEpoch;
    this.widthScope = widthScope;
    this.scrollElement = createFakeScrollElement(viewportHeight, scrollTop);
    this.virtualizer = new Virtualizer<HTMLElement, HTMLElement>(
      this.buildOptions(),
    );
    this.syncScrollHeight();
    this.virtualizer._willUpdate();
  }

  setRows(rows: readonly SpikeRow[]): void {
    this.rows = rows;
    this.virtualizer.setOptions(this.buildOptions());
    this.syncScrollHeight();
    this.virtualizer._willUpdate();
  }

  appendRowsFollowingBottom(rows: readonly SpikeRow[]): void {
    this.setRows(rows);
    if (this.rows.length === 0) {
      return;
    }
    this.scrollToRow(this.rows.at(-1)?.id ?? "", "end");
  }

  prependRowsPreservingAnchor(
    rows: readonly SpikeRow[],
    anchor: CapturedAnchor,
  ): void {
    this.setRows(rows);
    this.scrollToOffset(this.getRowTop(anchor.rowId) + anchor.offsetWithinRow);
  }

  captureAnchor(): CapturedAnchor {
    const item = this.getVirtualItemForOffset(this.getScrollTop());
    if (item) {
      return {
        rowId: String(item.key),
        offsetWithinRow: this.getScrollTop() - item.start,
      };
    }

    return { rowId: "", offsetWithinRow: 0 };
  }

  applyMeasurement(token: MeasurementToken, height: number): boolean {
    if (
      !validateMeasurementToken(token, {
        sessionId: this.sessionId,
        sessionEpoch: this.sessionEpoch,
        widthScope: this.widthScope,
        rowsById: new Map(this.rows.map((row) => [row.id, row])),
      })
    ) {
      return false;
    }

    const index = this.rows.findIndex((row) => row.id === token.rowId);
    if (index < 0) {
      return false;
    }

    this.virtualizer.resizeItem(index, height);
    this.measuredHeights.set(token.rowId, height);
    this.syncScrollHeight();
    return true;
  }

  scrollToRow(rowId: string, align: ScrollAlignment): void {
    const index = this.rows.findIndex((row) => row.id === rowId);
    if (index < 0) {
      return;
    }
    this.syncScrollHeight();
    this.virtualizer.scrollToIndex(index, { align, behavior: "auto" });
  }

  getScrollTop(): number {
    return this.scrollElement.scrollTop;
  }

  getBottomScrollTop(): number {
    return Math.max(0, this.getTotalHeight() - this.viewportHeight);
  }

  getDistanceFromEnd(): number {
    return this.virtualizer.getDistanceFromEnd();
  }

  isAtEnd(threshold?: number): boolean {
    return this.virtualizer.isAtEnd(threshold);
  }

  scrollToEnd(): void {
    this.virtualizer.scrollToEnd({ behavior: "auto" });
  }

  getVisibleRowIds(): string[] {
    return this.virtualizer.getVirtualItems().map((item) => String(item.key));
  }

  getTotalHeight(): number {
    return this.rows.reduce((total, row) => total + this.getRowHeight(row), 0);
  }

  getRowTop(rowId: string): number {
    let top = 0;
    for (const row of this.rows) {
      if (row.id === rowId) {
        return top;
      }
      top += this.getRowHeight(row);
    }
    return top;
  }

  private buildOptions() {
    const rows = this.rows;
    const measuredHeights = this.measuredHeights;

    return {
      count: rows.length,
      getScrollElement: () => this.scrollElement as unknown as HTMLElement,
      estimateSize: (index: number) =>
        measuredHeights.get(rows[index]?.id ?? "") ??
        rows[index]?.estimatedHeight ??
        0,
      getItemKey: (index: number) => rows[index]?.id ?? index,
      initialRect: { width: this.width, height: this.viewportHeight },
      initialOffset: this.scrollElement.scrollTop,
      overscan: this.overscan,
      anchorTo: this.anchorTo,
      followOnAppend: this.followOnAppend,
      scrollEndThreshold: this.scrollEndThreshold,
      observeElementRect: (
        _instance: Virtualizer<HTMLElement, HTMLElement>,
        callback: (rect: Rect) => void,
      ) => {
        this.rectCallback = callback;
        callback({ width: this.width, height: this.viewportHeight });
        return () => {
          this.rectCallback = null;
        };
      },
      observeElementOffset: (
        _instance: Virtualizer<HTMLElement, HTMLElement>,
        callback: (offset: number, isScrolling: boolean) => void,
      ) => {
        this.offsetCallback = callback;
        callback(this.scrollElement.scrollTop, false);
        return () => {
          this.offsetCallback = null;
        };
      },
      scrollToFn: (
        offset: number,
        options: { adjustments?: number },
        _instance: Virtualizer<HTMLElement, HTMLElement>,
      ) => {
        this.scrollToOffset(offset + (options.adjustments ?? 0));
      },
    };
  }

  private getRowHeight(row: SpikeRow): number {
    return this.measuredHeights.get(row.id) ?? row.estimatedHeight;
  }

  private getVirtualItemForOffset(offset: number): VirtualItem | undefined {
    let top = 0;
    for (let index = 0; index < this.rows.length; index += 1) {
      const row = this.rows[index];
      if (!row) {
        continue;
      }
      const height = this.getRowHeight(row);
      if (top + height > offset) {
        return {
          key: row.id,
          index,
          start: top,
          end: top + height,
          size: height,
          lane: 0,
        };
      }
      top += height;
    }
    return undefined;
  }

  private scrollToOffset(offset: number): void {
    this.scrollElement.scrollTop = Math.max(0, offset);
    this.offsetCallback?.(this.scrollElement.scrollTop, false);
  }

  private syncScrollHeight(): void {
    this.scrollElement.scrollHeight = this.getTotalHeight();
    this.rectCallback?.({ width: this.width, height: this.viewportHeight });
  }
}

export function evaluateCountOverscanCoverage({
  rows,
  scrollTop,
  viewportHeight,
  overscanCount,
  requiredBeforePx,
}: {
  rows: readonly SpikeRow[];
  scrollTop: number;
  viewportHeight: number;
  overscanCount: number;
  requiredBeforePx: number;
}) {
  const visibleRange = computeVisibleRange(rows, scrollTop, viewportHeight);
  const renderedStartIndex = Math.max(
    0,
    visibleRange.startIndex - overscanCount,
  );
  const renderedBeforePx = sumRows(
    rows.slice(renderedStartIndex, visibleRange.startIndex),
  );

  return {
    visibleRange,
    renderedStartIndex,
    renderedBeforePx,
    satisfiesRequiredBeforePx: renderedBeforePx >= requiredBeforePx,
  };
}

export function customRangeWithPinnedIndexes(
  range: Range,
  pinnedIndexes: readonly number[],
): number[] {
  const indexes = new Set<number>();
  for (
    let index = Math.max(0, range.startIndex - range.overscan);
    index <= Math.min(range.count - 1, range.endIndex + range.overscan);
    index += 1
  ) {
    indexes.add(index);
  }

  for (const index of pinnedIndexes) {
    if (index >= 0 && index < range.count) {
      indexes.add(index);
    }
  }

  return Array.from(indexes).sort((left, right) => left - right);
}

function computeVisibleRange(
  rows: readonly SpikeRow[],
  scrollTop: number,
  viewportHeight: number,
) {
  let top = 0;
  let startIndex = rows.length;
  let endIndex = rows.length - 1;

  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index];
    if (!row) {
      continue;
    }
    const nextTop = top + row.estimatedHeight;
    if (startIndex === rows.length && nextTop > scrollTop) {
      startIndex = index;
    }
    if (top < scrollTop + viewportHeight) {
      endIndex = index;
    }
    top = nextTop;
  }

  return {
    startIndex: Math.min(startIndex, rows.length - 1),
    endIndex,
  };
}

function sumRows(rows: readonly SpikeRow[]): number {
  return rows.reduce((total, row) => total + row.estimatedHeight, 0);
}

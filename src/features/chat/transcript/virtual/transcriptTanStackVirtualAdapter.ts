import {
  Virtualizer,
  type Range,
  type Rect,
  type VirtualItem,
  type VirtualizerOptions,
} from "@tanstack/react-virtual";
import {
  getTranscriptRowEstimatedHeight,
  type TranscriptRowDescriptor,
} from "../projection/transcriptItemTypes";
import { TranscriptVirtualController } from "./transcriptVirtualController";
import type {
  TranscriptMeasurementBatchResult,
  TranscriptMeasurementResult,
  TranscriptRowsUpdateResult,
  TranscriptScrollToRowResult,
  TranscriptViewportUpdateResult,
  TranscriptVirtualEngine,
} from "./transcriptVirtualEngine";
import {
  computeTranscriptPixelRangeIndexes,
  type TranscriptPixelRangeSelection,
} from "./transcriptVirtualRange";
import {
  TRANSCRIPT_DEFAULT_OVERSCAN_AFTER_PX,
  TRANSCRIPT_DEFAULT_OVERSCAN_AFTER_ROWS,
  TRANSCRIPT_DEFAULT_OVERSCAN_BEFORE_PX,
  TRANSCRIPT_DEFAULT_OVERSCAN_BEFORE_ROWS,
  TRANSCRIPT_PINNED_BOTTOM_THRESHOLD_PX,
  type TranscriptScrollAlign,
  type TranscriptScrollCorrection,
  type TranscriptSessionGeometry,
  type TranscriptViewportGeometry,
  type TranscriptVirtualControllerOptions,
  type TranscriptVirtualControllerState,
  type TranscriptVirtualDiagnostics,
  type TranscriptVirtualItem,
  type TranscriptVirtualMeasurementToken,
  type TranscriptVirtualRangeSnapshot,
} from "./transcriptVirtualTypes";

type TanStackAnchorTo = NonNullable<
  VirtualizerOptions<HTMLElement, HTMLElement>["anchorTo"]
>;
type TanStackFollowOnAppend = NonNullable<
  VirtualizerOptions<HTMLElement, HTMLElement>["followOnAppend"]
>;

export interface TranscriptTanStackVirtualAdapterOptions
  extends TranscriptVirtualControllerOptions {
  viewportWidth?: number;
  anchorTo?: TanStackAnchorTo;
  followOnAppend?: TanStackFollowOnAppend;
  scrollEndThresholdPx?: number;
}

interface MeasurementEntry {
  widthScope: string;
  heightRevision: string;
  layoutRevision: string;
  height: number;
}

type OffsetCallback = (offset: number, isScrolling: boolean) => void;

export class TranscriptTanStackVirtualAdapter
  implements TranscriptVirtualEngine
{
  readonly engineKind = "tanstack";

  private rows: readonly TranscriptRowDescriptor[] = [];
  private rowIndexById = new Map<string, number>();
  private measurements = new Map<string, MeasurementEntry>();
  private streamingHeightFloors = new Map<string, number>();
  private readonly scrollElement: HTMLElement;
  private readonly controllerOptions: TranscriptVirtualControllerOptions;
  private readonly anchorTo: TanStackAnchorTo;
  private readonly followOnAppend: TanStackFollowOnAppend;
  private readonly scrollEndThresholdPx: number;
  private readonly viewportWidth: number;
  private readonly overscanBeforePx: number;
  private readonly overscanAfterPx: number;
  private readonly overscanBeforeRows: number;
  private readonly overscanAfterRows: number;
  private readonly protectedRowIds: readonly string[];
  private controller: TranscriptVirtualController;
  private virtualizer: Virtualizer<HTMLElement, HTMLElement>;
  private offsetCallback: OffsetCallback | null = null;
  private rectCallback: ((rect: Rect) => void) | null = null;
  private lastRangeSelection: TranscriptPixelRangeSelection | null = null;
  private correctionWritesSuspended = false;

  constructor(
    input: TranscriptSessionGeometry,
    options: TranscriptTanStackVirtualAdapterOptions = {},
  ) {
    this.controllerOptions = options;
    this.anchorTo = options.anchorTo ?? "end";
    this.followOnAppend = options.followOnAppend ?? "auto";
    this.scrollEndThresholdPx =
      options.scrollEndThresholdPx ?? TRANSCRIPT_PINNED_BOTTOM_THRESHOLD_PX;
    this.viewportWidth = options.viewportWidth ?? 720;
    this.overscanBeforePx =
      options.overscanBeforePx ?? TRANSCRIPT_DEFAULT_OVERSCAN_BEFORE_PX;
    this.overscanAfterPx =
      options.overscanAfterPx ?? TRANSCRIPT_DEFAULT_OVERSCAN_AFTER_PX;
    this.overscanBeforeRows =
      options.overscanBeforeRows ?? TRANSCRIPT_DEFAULT_OVERSCAN_BEFORE_ROWS;
    this.overscanAfterRows =
      options.overscanAfterRows ?? TRANSCRIPT_DEFAULT_OVERSCAN_AFTER_ROWS;
    this.protectedRowIds = options.protectedRowIds ?? [];
    this.scrollElement = createInMemoryScrollElement(
      input.viewportHeight,
      input.scrollTop ?? 0,
    );
    this.controller = new TranscriptVirtualController(
      input,
      this.controllerOptions,
    );
    this.syncScrollElementToController();
    this.virtualizer = new Virtualizer<HTMLElement, HTMLElement>(
      this.buildOptions(),
    );
    this.virtualizer.shouldAdjustScrollPositionOnItemSizeChange = () => false;
    this.syncScrollHeight();
    this.virtualizer._willUpdate();
  }

  reset(input: TranscriptSessionGeometry): void {
    this.rows = [];
    this.rowIndexById = new Map();
    this.measurements = new Map();
    this.streamingHeightFloors = new Map();
    this.lastRangeSelection = null;
    this.controller.reset(input);
    this.syncScrollElementToController();
    this.virtualizer.setOptions(this.buildOptions());
    this.syncScrollHeight();
    this.virtualizer._willUpdate();
  }

  setRows(
    rows: readonly TranscriptRowDescriptor[],
  ): TranscriptRowsUpdateResult {
    this.rows = rows;
    this.rowIndexById = new Map(
      rows.map((row, index) => [row.rowId, index] as const),
    );
    const releasedStreamingFloorIndexes = this.releaseInactiveStreamingFloors();
    this.lastRangeSelection = null;
    this.virtualizer.setOptions(this.buildOptions());
    this.resizeReleasedStreamingFloorItems(releasedStreamingFloorIndexes);
    this.syncScrollHeight();
    this.virtualizer._willUpdate();

    const result = this.controller.setRows(rows);
    this.applyCorrection(result.correction);
    this.syncVirtualizerOffset();
    this.virtualizer._willUpdate();
    return result;
  }

  syncViewport(
    geometry: TranscriptViewportGeometry,
    options: {
      source?: "browser" | "programmatic" | "correction";
      userScrollIntent?: boolean;
      preserveScrollPosition?: boolean;
    } = {},
  ): TranscriptViewportUpdateResult {
    // Any viewport sync supersedes a pending TanStack scroll reconcile.
    // TanStack arms a multi-frame loop (via scrollToEnd/scrollToIndex and its
    // internal followOnAppend path) that re-asserts a stale bottom/row target
    // for seconds; with Goose's controller owning scroll truth, that loop
    // yanks detached users back to the bottom after resizes.
    this.disarmVirtualizerScrollReconcile();
    const previousState = this.controller.getState();
    this.setScrollOffset(geometry.scrollTop, false);
    this.lastRangeSelection = null;
    const result = this.controller.syncViewport(geometry, options);
    const nextState = this.controller.getState();
    const geometryChanged =
      previousState.viewportHeight !== nextState.viewportHeight ||
      previousState.footerHeight !== nextState.footerHeight ||
      previousState.widthScope !== nextState.widthScope;

    if (result.correction) {
      this.applyCorrection(result.correction);
    } else {
      this.setScrollOffset(nextState.scrollTop, false);
    }

    if (geometryChanged) {
      this.virtualizer.setOptions(this.buildOptions());
      this.syncScrollHeight(nextState);
      this.virtualizer._willUpdate();
    } else {
      this.virtualizer._willUpdate();
    }
    return result;
  }

  applyMeasuredHeight(input: {
    token: TranscriptVirtualMeasurementToken;
    height: number;
  }): TranscriptMeasurementResult {
    const result = this.controller.applyMeasuredHeight(input);
    if (!result.accepted) {
      return result;
    }

    const index = this.rowIndexById.get(input.token.rowId);
    const row = index === undefined ? undefined : this.rows[index];
    const height = Math.max(0, input.height);
    if (row?.anchorPriority === "streaming") {
      this.updateStreamingHeightFloor(row, input.token.widthScope, height);
    }

    this.measurements.set(this.measurementKey(input.token.rowId), {
      widthScope: input.token.widthScope,
      heightRevision: input.token.heightRevision,
      layoutRevision: input.token.layoutRevision,
      height,
    });

    if (index !== undefined && row) {
      this.virtualizer.resizeItem(
        index,
        this.getRowHeight(row, input.token.widthScope),
      );
    }
    this.lastRangeSelection = null;
    this.syncScrollHeight();
    this.applyCorrection(result.correction);
    this.syncVirtualizerOffset();
    this.virtualizer._willUpdate();
    return result;
  }

  applyMeasuredHeights(
    inputs: readonly {
      token: TranscriptVirtualMeasurementToken;
      height: number;
    }[],
  ): TranscriptMeasurementBatchResult {
    const result = this.controller.applyMeasuredHeights(inputs);
    if (result.acceptedTokens.length === 0) {
      return result;
    }

    const heightByRowId = new Map(
      inputs.map((input) => [input.token.rowId, Math.max(0, input.height)]),
    );
    for (const token of result.acceptedTokens) {
      const height = heightByRowId.get(token.rowId);
      if (height === undefined) {
        continue;
      }

      const index = this.rowIndexById.get(token.rowId);
      const row = index === undefined ? undefined : this.rows[index];
      if (row?.anchorPriority === "streaming") {
        this.updateStreamingHeightFloor(row, token.widthScope, height);
      }

      this.measurements.set(this.measurementKey(token.rowId), {
        widthScope: token.widthScope,
        heightRevision: token.heightRevision,
        layoutRevision: token.layoutRevision,
        height,
      });

      if (index !== undefined && row) {
        this.virtualizer.resizeItem(
          index,
          this.getRowHeight(row, token.widthScope),
        );
      }
    }

    this.lastRangeSelection = null;
    this.syncScrollHeight();
    this.applyCorrection(result.correction);
    this.syncVirtualizerOffset();
    this.virtualizer._willUpdate();
    return result;
  }

  scrollToRow(
    rowId: string,
    align: TranscriptScrollAlign = "start",
  ): TranscriptScrollToRowResult {
    const index = this.rowIndexById.get(rowId);
    if (index !== undefined) {
      this.virtualizer.scrollToIndex(index, {
        align,
        behavior: "auto",
      });
      this.disarmVirtualizerScrollReconcile();
    }

    const result = this.controller.scrollToRow(rowId, align);
    this.applyCorrection(result.correction);
    this.syncScrollElementToController();
    this.syncVirtualizerOffset();
    return result;
  }

  writeScrollTop(
    scrollTop: number,
    options: {
      behavior?: ScrollBehavior;
      source?: "browser" | "programmatic" | "correction";
      userScrollIntent?: boolean;
      preserveScrollPosition?: boolean;
    } = {},
  ): void {
    this.setScrollOffset(scrollTop, options.behavior !== "auto");
  }

  scrollToEnd(options: { behavior?: ScrollBehavior } = {}): void {
    this.virtualizer.scrollToEnd({ behavior: options.behavior ?? "auto" });
    this.disarmVirtualizerScrollReconcile();
    const state = this.controller.getState();
    const result = this.controller.syncViewport(
      {
        scrollTop: getElementScrollTop(this.scrollElement),
        viewportHeight: state.viewportHeight,
        footerHeight: state.footerHeight,
        widthScope: state.widthScope,
        browserScrollHeight: getElementScrollHeight(this.scrollElement),
      },
      { source: "browser", userScrollIntent: true },
    );
    this.applyCorrection(result.correction);
    this.syncScrollElementToController();
    this.syncVirtualizerOffset();
  }

  setScrollWritesSuspended(suspended: boolean): void {
    this.correctionWritesSuspended = suspended;
  }

  getPendingScrollCorrection(): TranscriptScrollCorrection | null {
    return this.controller.getPendingScrollCorrection();
  }

  getRange(): TranscriptVirtualRangeSnapshot {
    const virtualItems = this.virtualizer.getVirtualItems();
    const state = this.controller.getState();
    const rowTotalHeight = this.getRowsHeight(state.widthScope);
    const selection =
      this.lastRangeSelection ??
      this.createFallbackRangeSelection(state.widthScope);

    const protectedIndexes = new Set(selection.protectedIndexes);
    const virtualItemByIndex = new Map(
      virtualItems.map((item) => [item.index, item] as const),
    );
    const transcriptItems = selection.indexes
      .map((index) =>
        this.toTranscriptVirtualItem(
          virtualItemByIndex.get(index),
          index,
          protectedIndexes,
          selection,
          state.widthScope,
        ),
      )
      .filter((item): item is TranscriptVirtualItem => item !== null);
    const paddingStart =
      this.getRowTopByIndex(
        selection.renderRange.startIndex,
        state.widthScope,
      ) ?? 0;
    const renderEnd =
      this.getRowBottomByIndex(
        selection.renderRange.endIndex,
        state.widthScope,
      ) ?? rowTotalHeight;

    return {
      totalHeight: rowTotalHeight,
      scrollHeight: rowTotalHeight + state.footerHeight,
      visibleRange: selection.visibleRange,
      renderRange: selection.renderRange,
      virtualItems: transcriptItems,
      visibleRowIds: this.rows
        .slice(
          selection.visibleRange.startIndex,
          selection.visibleRange.endIndex + 1,
        )
        .map((row) => row.rowId),
      renderedRowIds: transcriptItems.map((item) => item.row.rowId),
      protectedRowIds: transcriptItems
        .filter((item) => item.protected)
        .map((item) => item.row.rowId),
      paddingStart,
      paddingEnd: Math.max(0, rowTotalHeight - renderEnd),
    };
  }

  getState(): TranscriptVirtualControllerState {
    return this.controller.getState();
  }

  getDiagnostics(): TranscriptVirtualDiagnostics {
    return this.controller.getDiagnostics();
  }

  getMeasurementToken(rowId: string): TranscriptVirtualMeasurementToken | null {
    return this.controller.getMeasurementToken(rowId);
  }

  getScrollTop(): number {
    return getElementScrollTop(this.scrollElement);
  }

  getTanStackTotalSize(): number {
    return this.virtualizer.getTotalSize();
  }

  getDistanceFromEnd(): number {
    return this.virtualizer.getDistanceFromEnd();
  }

  isAtEnd(threshold?: number): boolean {
    return this.virtualizer.isAtEnd(threshold);
  }

  getTanStackVirtualItems(): readonly VirtualItem[] {
    return this.virtualizer.getVirtualItems();
  }

  private buildOptions(): VirtualizerOptions<HTMLElement, HTMLElement> {
    const state = this.controller.getState();
    const widthScope = state.widthScope;
    const shouldAnchorToEnd = state.nearBottom;

    return {
      count: this.rows.length,
      getScrollElement: () => this.scrollElement,
      estimateSize: (index) =>
        this.getRowHeight(
          this.rows[index] as TranscriptRowDescriptor,
          widthScope,
        ),
      getItemKey: (index) => this.rows[index]?.reactKey ?? index,
      initialRect: {
        width: this.viewportWidth,
        height: state.viewportHeight,
      },
      initialOffset: getElementScrollTop(this.scrollElement),
      overscan: 0,
      paddingEnd: state.footerHeight,
      anchorTo: shouldAnchorToEnd ? this.anchorTo : "start",
      followOnAppend: shouldAnchorToEnd ? this.followOnAppend : false,
      scrollEndThreshold: this.scrollEndThresholdPx,
      rangeExtractor: (range) => this.extractRange(range),
      observeElementRect: (_instance, callback) => {
        this.rectCallback = callback;
        callback({ width: this.viewportWidth, height: state.viewportHeight });
        return () => {
          if (this.rectCallback === callback) {
            this.rectCallback = null;
          }
        };
      },
      observeElementOffset: (_instance, callback) => {
        this.offsetCallback = callback;
        callback(getElementScrollTop(this.scrollElement), false);
        return () => {
          if (this.offsetCallback === callback) {
            this.offsetCallback = null;
          }
        };
      },
      scrollToFn: (offset, options) => {
        if (options.adjustments) {
          this.offsetCallback?.(getElementScrollTop(this.scrollElement), false);
          return;
        }

        this.setScrollOffset(offset, false);
      },
    };
  }

  private extractRange(range: Range): number[] {
    const { widthScope } = this.controller.getState();
    const protectedIndexes = this.protectedRowIds.flatMap((rowId) => {
      const index = this.rowIndexById.get(rowId);
      return index === undefined ? [] : [index];
    });
    const selection = computeTranscriptPixelRangeIndexes({
      rows: this.rows,
      range,
      overscanBeforePx: this.overscanBeforePx,
      overscanAfterPx: this.overscanAfterPx,
      overscanBeforeRows: this.overscanBeforeRows,
      overscanAfterRows: this.overscanAfterRows,
      protectedIndexes,
      getRowHeight: (row) => this.getRowHeight(row, widthScope),
    });
    this.lastRangeSelection = selection;
    return [...selection.indexes];
  }

  private createFallbackRangeSelection(
    widthScope: string,
  ): TranscriptPixelRangeSelection {
    const range = this.virtualizer.range;
    return computeTranscriptPixelRangeIndexes({
      rows: this.rows,
      range: {
        startIndex: range?.startIndex ?? 0,
        endIndex: range?.endIndex ?? -1,
        overscan: 0,
        count: this.rows.length,
      },
      overscanBeforePx: this.overscanBeforePx,
      overscanAfterPx: this.overscanAfterPx,
      overscanBeforeRows: this.overscanBeforeRows,
      overscanAfterRows: this.overscanAfterRows,
      protectedIndexes: this.protectedRowIds.flatMap((rowId) => {
        const index = this.rowIndexById.get(rowId);
        return index === undefined ? [] : [index];
      }),
      getRowHeight: (row) => this.getRowHeight(row, widthScope),
    });
  }

  private toTranscriptVirtualItem(
    item: VirtualItem | undefined,
    index: number,
    protectedIndexes: ReadonlySet<number>,
    range: TranscriptPixelRangeSelection,
    widthScope: string,
  ): TranscriptVirtualItem | null {
    const row = this.rows[index];
    if (!row) {
      return null;
    }

    const start = item?.start ?? this.getRowTopByIndex(index, widthScope) ?? 0;
    const size = item?.size ?? this.getRowHeight(row, widthScope);

    return {
      index,
      key: String(item?.key ?? row.reactKey),
      row,
      start,
      size,
      end: item?.end ?? start + size,
      visible:
        index >= range.visibleRange.startIndex &&
        index <= range.visibleRange.endIndex,
      protected: protectedIndexes.has(index),
    };
  }

  private applyCorrection(
    correction: TranscriptScrollCorrection | null | undefined,
  ): void {
    if (!correction || this.correctionWritesSuspended) {
      return;
    }
    this.setScrollOffset(correction.nextScrollTop, false);
  }

  // TanStack's scrollToIndex/scrollToEnd arm a multi-frame "scroll reconcile"
  // loop that keeps re-asserting the original target offset on later frames.
  // Goose's controller owns scroll-position truth (anchors + corrections), so
  // a stale reconcile target fights user detaches and resize corrections —
  // e.g. yanking a freshly detached user back to the bottom. Use TanStack for
  // the immediate jump only and disarm its follow-up loop.
  private disarmVirtualizerScrollReconcile(): void {
    (this.virtualizer as unknown as { scrollState: unknown }).scrollState =
      null;
  }

  private syncScrollElementToController(): void {
    const state = this.controller.getState();
    this.setScrollOffset(state.scrollTop, false);
    this.syncScrollHeight(state);
  }

  private syncVirtualizerOffset(): void {
    this.offsetCallback?.(getElementScrollTop(this.scrollElement), false);
  }

  private setScrollOffset(offset: number, isScrolling: boolean): void {
    setElementNumber(this.scrollElement, "scrollTop", Math.max(0, offset));
    this.offsetCallback?.(getElementScrollTop(this.scrollElement), isScrolling);
  }

  private syncScrollHeight(state = this.controller.getState()): void {
    setElementNumber(
      this.scrollElement,
      "scrollHeight",
      this.getRowsHeight(state.widthScope) + state.footerHeight,
    );
    this.rectCallback?.({
      width: this.viewportWidth,
      height: state.viewportHeight,
    });
  }

  private getRowHeight(
    row: TranscriptRowDescriptor,
    _widthScope: string,
  ): number {
    const measured = this.measurements.get(this.measurementKey(row.rowId));
    const estimatedHeight = getTranscriptRowEstimatedHeight(row);
    const measuredHeight =
      measured &&
      measured.heightRevision === row.heightRevision &&
      measured.layoutRevision === row.layoutRevision
        ? measured.height
        : null;
    const measuredFloorHeight =
      measured?.layoutRevision === row.layoutRevision ? measured.height : 0;
    if (row.anchorPriority === "streaming") {
      return Math.max(
        measuredHeight ?? estimatedHeight,
        measuredFloorHeight,
        this.streamingHeightFloors.get(this.measurementKey(row.rowId)) ?? 0,
      );
    }
    return measuredHeight ?? estimatedHeight;
  }

  private updateStreamingHeightFloor(
    row: TranscriptRowDescriptor,
    widthScope: string,
    measuredHeight: number,
  ): void {
    const key = this.measurementKey(row.rowId);
    this.streamingHeightFloors.set(
      key,
      Math.max(
        this.streamingHeightFloors.get(key) ?? 0,
        this.getRowHeight(row, widthScope),
        measuredHeight,
      ),
    );
  }

  private releaseInactiveStreamingFloors(): number[] {
    const activeStreamingKeys = new Set(
      this.rows
        .filter((row) => row.anchorPriority === "streaming")
        .map((row) => this.measurementKey(row.rowId)),
    );
    const releasedIndexes: number[] = [];
    for (const key of this.streamingHeightFloors.keys()) {
      if (activeStreamingKeys.has(key)) {
        continue;
      }

      const index = this.rowIndexById.get(key);
      if (index !== undefined) {
        releasedIndexes.push(index);
      }
      this.streamingHeightFloors.delete(key);
    }
    return releasedIndexes;
  }

  private resizeReleasedStreamingFloorItems(indexes: readonly number[]): void {
    const { widthScope } = this.controller.getState();
    for (const index of indexes) {
      const row = this.rows[index];
      if (!row) {
        continue;
      }
      this.virtualizer.resizeItem(index, this.getRowHeight(row, widthScope));
    }
  }

  private getRowsHeight(widthScope: string): number {
    return this.rows.reduce(
      (total, row) => total + this.getRowHeight(row, widthScope),
      0,
    );
  }

  private getRowTopByIndex(index: number, widthScope: string): number | null {
    if (index < 0 || index >= this.rows.length) {
      return null;
    }

    let top = 0;
    for (let currentIndex = 0; currentIndex < index; currentIndex += 1) {
      top += this.getRowHeight(
        this.rows[currentIndex] as TranscriptRowDescriptor,
        widthScope,
      );
    }
    return top;
  }

  private getRowBottomByIndex(
    index: number,
    widthScope: string,
  ): number | null {
    const top = this.getRowTopByIndex(index, widthScope);
    const row = this.rows[index];
    return top === null || !row
      ? null
      : top + this.getRowHeight(row, widthScope);
  }

  private measurementKey(rowId: string): string {
    return rowId;
  }
}

export function createTranscriptTanStackVirtualAdapter(
  input: TranscriptSessionGeometry,
  options?: TranscriptTanStackVirtualAdapterOptions,
): TranscriptTanStackVirtualAdapter {
  return new TranscriptTanStackVirtualAdapter(input, options);
}

function createInMemoryScrollElement(
  viewportHeight: number,
  scrollTop: number,
): HTMLElement {
  let frameId = 0;
  const queuedFrames: FrameRequestCallback[] = [];
  const element = {
    clientHeight: viewportHeight,
    scrollHeight: 0,
    scrollTop,
    ownerDocument: {
      defaultView: {
        performance: {
          now: () => performance.now(),
        },
        requestAnimationFrame: (callback: FrameRequestCallback) => {
          frameId += 1;
          queuedFrames.push(callback);
          return frameId;
        },
        cancelAnimationFrame: () => undefined,
      },
    },
    flushAnimationFrames: () => {
      while (queuedFrames.length > 0) {
        queuedFrames.shift()?.(performance.now());
      }
    },
  };

  return element as unknown as HTMLElement;
}

function getElementScrollTop(element: HTMLElement): number {
  return Math.max(
    0,
    Number((element as unknown as { scrollTop?: number }).scrollTop ?? 0),
  );
}

function getElementScrollHeight(element: HTMLElement): number {
  return Math.max(
    0,
    Number((element as unknown as { scrollHeight?: number }).scrollHeight ?? 0),
  );
}

function setElementNumber(
  element: HTMLElement,
  key: "scrollTop" | "scrollHeight",
  value: number,
): void {
  try {
    (element as unknown as Record<"scrollTop" | "scrollHeight", number>)[key] =
      value;
  } catch {
    // Real HTMLElement dimensions can be read-only; browser layout remains
    // authoritative there. The headless proof element accepts direct writes.
  }
}

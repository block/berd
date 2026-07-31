import {
  getTranscriptRowEstimatedHeight,
  type TranscriptRowDescriptor,
} from "../projection/transcriptItemTypes";
import {
  transitionTranscriptGeometryViewport,
  type TranscriptGeometryViewportState,
} from "./transcriptGeometryTransition";
import {
  computeTranscriptVirtualRange,
  type TranscriptRangeInput,
} from "./transcriptVirtualRange";
import type {
  TranscriptMeasurementBatchResult,
  TranscriptMeasurementResult,
  TranscriptRowsUpdateResult,
  TranscriptScrollToRowResult,
  TranscriptViewportUpdateResult,
  TranscriptVirtualEngine,
} from "./transcriptVirtualEngine";
import {
  TRANSCRIPT_AUTO_SCROLL_THRESHOLD_PX,
  TRANSCRIPT_DEFAULT_OVERSCAN_AFTER_PX,
  TRANSCRIPT_DEFAULT_OVERSCAN_AFTER_ROWS,
  TRANSCRIPT_DEFAULT_OVERSCAN_BEFORE_PX,
  TRANSCRIPT_DEFAULT_OVERSCAN_BEFORE_ROWS,
  TRANSCRIPT_MEASUREMENT_EPSILON_PX,
  TRANSCRIPT_PINNED_BOTTOM_THRESHOLD_PX,
  type TranscriptAnchorResolution,
  type TranscriptCorrectionReason,
  type TranscriptScrollAlign,
  type TranscriptScrollAnchor,
  type TranscriptScrollCorrection,
  type TranscriptScrollDirection,
  type TranscriptSessionGeometry,
  type TranscriptViewportGeometry,
  type TranscriptVirtualControllerOptions,
  type TranscriptVirtualControllerState,
  type TranscriptVirtualDiagnostics,
  type TranscriptVirtualMeasurementToken,
  type TranscriptVirtualRangeSnapshot,
} from "./transcriptVirtualTypes";

interface MeasurementEntry {
  widthScope: string;
  heightRevision: string;
  layoutRevision: string;
  height: number;
}

interface RowPosition {
  top: number;
  height: number;
  bottom: number;
}

type PendingScrollAnchor =
  | { type: "bottom" }
  | { type: "scroll-position"; scrollTop: number }
  | {
      type: "row";
      rowId: string;
      offsetWithinRow: number;
    };

interface ReconcileOptions {
  reason: TranscriptCorrectionReason;
  updateAnchorOnStale?: boolean;
}

const TRANSCRIPT_VIEWPORT_GEOMETRY_EPSILON_PX = 1;

const EMPTY_DIAGNOSTICS: TranscriptVirtualDiagnostics = {
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
};

export class TranscriptVirtualController implements TranscriptVirtualEngine {
  private rows: readonly TranscriptRowDescriptor[] = [];
  private rowIndexById = new Map<string, number>();
  private measurements = new Map<string, MeasurementEntry>();
  private streamingHeightFloors = new Map<string, number>();
  private sessionId: string;
  private sessionEpoch: number;
  private widthScope: string;
  private viewport: TranscriptGeometryViewportState;
  private viewportHeight: number;
  private footerHeight: number;
  private browserScrollHeight: number | null;
  private anchor: TranscriptScrollAnchor = { type: "bottom" };
  private lastRange: TranscriptVirtualRangeSnapshot | null = null;
  private diagnostics: TranscriptVirtualDiagnostics = { ...EMPTY_DIAGNOSTICS };

  private readonly pinnedBottomThresholdPx: number;
  private readonly autoScrollThresholdPx: number;
  private readonly measurementEpsilonPx: number;
  private readonly overscanBeforePx: number;
  private readonly overscanAfterPx: number;
  private readonly overscanBeforeRows: number;
  private readonly overscanAfterRows: number;
  private readonly protectedRowIds: readonly string[];

  constructor(
    input: TranscriptSessionGeometry,
    options: TranscriptVirtualControllerOptions = {},
  ) {
    this.sessionId = input.sessionId;
    this.sessionEpoch = input.sessionEpoch;
    this.widthScope = input.widthScope;
    this.viewport = {
      observedScrollTop: Math.max(0, input.scrollTop ?? 0),
      pendingScroll: null,
    };
    this.viewportHeight = Math.max(0, input.viewportHeight);
    this.footerHeight = Math.max(0, input.footerHeight ?? 0);
    this.browserScrollHeight =
      input.browserScrollHeight === undefined
        ? null
        : Math.max(0, input.browserScrollHeight);

    this.pinnedBottomThresholdPx =
      options.pinnedBottomThresholdPx ?? TRANSCRIPT_PINNED_BOTTOM_THRESHOLD_PX;
    this.autoScrollThresholdPx =
      options.autoScrollThresholdPx ?? TRANSCRIPT_AUTO_SCROLL_THRESHOLD_PX;
    this.measurementEpsilonPx =
      options.measurementEpsilonPx ?? TRANSCRIPT_MEASUREMENT_EPSILON_PX;
    this.overscanBeforePx =
      options.overscanBeforePx ?? TRANSCRIPT_DEFAULT_OVERSCAN_BEFORE_PX;
    this.overscanAfterPx =
      options.overscanAfterPx ?? TRANSCRIPT_DEFAULT_OVERSCAN_AFTER_PX;
    this.overscanBeforeRows =
      options.overscanBeforeRows ?? TRANSCRIPT_DEFAULT_OVERSCAN_BEFORE_ROWS;
    this.overscanAfterRows =
      options.overscanAfterRows ?? TRANSCRIPT_DEFAULT_OVERSCAN_AFTER_ROWS;
    this.protectedRowIds = options.protectedRowIds ?? [];
  }

  reset(input: TranscriptSessionGeometry): void {
    this.sessionId = input.sessionId;
    this.sessionEpoch = input.sessionEpoch;
    this.widthScope = input.widthScope;
    this.viewport = {
      observedScrollTop: Math.max(0, input.scrollTop ?? 0),
      pendingScroll: null,
    };
    this.viewportHeight = Math.max(0, input.viewportHeight);
    this.footerHeight = Math.max(0, input.footerHeight ?? 0);
    this.browserScrollHeight =
      input.browserScrollHeight === undefined
        ? null
        : Math.max(0, input.browserScrollHeight);
    this.rows = [];
    this.rowIndexById = new Map();
    this.measurements = new Map();
    this.streamingHeightFloors = new Map();
    this.lastRange = null;
    this.setScrollAnchor({ type: "bottom" });
  }

  setRows(
    rows: readonly TranscriptRowDescriptor[],
  ): TranscriptRowsUpdateResult {
    this.rows = rows;
    this.rowIndexById = new Map(
      rows.map((row, index) => [row.rowId, index] as const),
    );
    this.releaseInactiveStreamingFloors();
    this.lastRange = null;
    this.diagnostics.rowSetUpdates += 1;

    const correction = this.reconcileAnchor({
      reason: this.anchor.type === "bottom" ? "bottom-anchor" : "row-anchor",
      updateAnchorOnStale: true,
    });
    return { correction };
  }

  syncViewport(
    geometry: TranscriptViewportGeometry,
    options: {
      source?: "browser" | "programmatic" | "correction";
      userScrollIntent?: boolean;
      preserveScrollPosition?: boolean;
    } = {},
  ): TranscriptViewportUpdateResult {
    const previousScrollTop = this.observedScrollTop;
    const nextViewportHeight = Math.max(0, geometry.viewportHeight);
    const nextFooterHeight = Math.max(0, geometry.footerHeight ?? 0);
    // Viewport geometry changes (window resize, side-rail animation, footer
    // growth) move scrollTop through browser clamping and invalidate width-
    // scoped measurements. Those scrollTop drifts are not user scrolls, so the
    // existing anchor must be reconciled rather than recaptured at the drifted
    // position.
    const geometryChanged =
      Math.abs(nextViewportHeight - this.viewportHeight) >
        TRANSCRIPT_VIEWPORT_GEOMETRY_EPSILON_PX ||
      Math.abs(nextFooterHeight - this.footerHeight) >
        TRANSCRIPT_VIEWPORT_GEOMETRY_EPSILON_PX ||
      geometry.widthScope !== this.widthScope;
    this.viewportHeight = nextViewportHeight;
    this.footerHeight = nextFooterHeight;
    this.widthScope = geometry.widthScope;
    this.browserScrollHeight =
      geometry.browserScrollHeight === undefined
        ? null
        : Math.max(0, geometry.browserScrollHeight);
    this.viewport = transitionTranscriptGeometryViewport(this.viewport, {
      type: "observe",
      scrollTop: geometry.scrollTop,
      maxScrollTop: this.getBottomScrollTop(),
    }).state;
    this.lastRange = null;
    this.diagnostics.viewportUpdates += 1;

    const direction = getScrollDirection(
      previousScrollTop,
      this.observedScrollTop,
    );
    const source = options.source ?? "browser";
    const distanceFromBottom = this.getDistanceFromBottom(
      this.observedScrollTop,
    );
    // Explicit user intent (wheel/touch) wins even mid-resize so a user can
    // still scroll away while a rail animation is changing geometry.
    const treatAsUserScroll =
      source === "browser" &&
      (options.userScrollIntent === true || !geometryChanged);

    if (treatAsUserScroll && options.preserveScrollPosition === true) {
      this.captureViewportAnchor({ fallback: "scroll-position" });
      return { correction: null };
    }

    if (
      treatAsUserScroll &&
      this.anchor.type === "bottom" &&
      direction === "up" &&
      distanceFromBottom > this.pinnedBottomThresholdPx
    ) {
      this.diagnostics.bottomFollowExits += 1;
      this.captureViewportAnchor();
      return { correction: null };
    }

    if (
      treatAsUserScroll &&
      (options.userScrollIntent || direction !== "none")
    ) {
      if (distanceFromBottom <= this.pinnedBottomThresholdPx) {
        this.setScrollAnchor({ type: "bottom" });
      } else {
        this.captureViewportAnchor();
      }
      return { correction: null };
    }

    const correction = this.reconcileAnchor({
      reason: this.anchor.type === "bottom" ? "bottom-anchor" : "row-anchor",
      updateAnchorOnStale: true,
    });
    return { correction };
  }

  applyMeasuredHeight(input: {
    token: TranscriptVirtualMeasurementToken;
    height: number;
  }): TranscriptMeasurementResult {
    if (!this.validateMeasurementToken(input.token)) {
      return { accepted: false, correction: null };
    }

    const row = this.getRow(input.token.rowId);
    const height = Math.max(0, input.height);
    if (row?.anchorPriority === "streaming") {
      this.updateStreamingHeightFloor(row, height);
    }

    this.measurements.set(this.measurementKey(input.token.rowId), {
      widthScope: input.token.widthScope,
      heightRevision: input.token.heightRevision,
      layoutRevision: input.token.layoutRevision,
      height,
    });
    this.lastRange = null;
    this.diagnostics.measuredHeightUpdates += 1;

    const correction = this.reconcileAnchor({
      reason: this.anchor.type === "bottom" ? "bottom-anchor" : "row-anchor",
      updateAnchorOnStale: true,
    });
    return { accepted: true, correction };
  }

  applyMeasuredHeights(
    inputs: readonly {
      token: TranscriptVirtualMeasurementToken;
      height: number;
    }[],
  ): TranscriptMeasurementBatchResult {
    const acceptedTokens: TranscriptVirtualMeasurementToken[] = [];
    let rejected = 0;

    for (const input of inputs) {
      if (!this.validateMeasurementToken(input.token)) {
        rejected += 1;
        continue;
      }

      const row = this.getRow(input.token.rowId);
      const height = Math.max(0, input.height);
      if (row?.anchorPriority === "streaming") {
        this.updateStreamingHeightFloor(row, height);
      }

      this.measurements.set(this.measurementKey(input.token.rowId), {
        widthScope: input.token.widthScope,
        heightRevision: input.token.heightRevision,
        layoutRevision: input.token.layoutRevision,
        height,
      });
      this.diagnostics.measuredHeightUpdates += 1;
      acceptedTokens.push({ ...input.token });
    }

    if (acceptedTokens.length === 0) {
      return {
        acceptedTokens,
        rejected,
        correction: null,
      };
    }

    this.lastRange = null;
    const correction = this.reconcileAnchor({
      reason: this.anchor.type === "bottom" ? "bottom-anchor" : "row-anchor",
      updateAnchorOnStale: true,
    });

    return {
      acceptedTokens,
      rejected,
      correction,
    };
  }

  scrollToRow(
    rowId: string,
    align: TranscriptScrollAlign = "start",
  ): TranscriptScrollToRowResult {
    const row = this.getRow(rowId);
    if (!row) {
      return { found: false, correction: null };
    }

    const target = this.getScrollTopForRow(rowId, align);
    if (target === null) {
      return { found: false, correction: null };
    }

    const correction = this.applyScrollCorrection({
      reason: "scroll-to-row",
      nextScrollTop: target,
    });
    return { found: true, correction };
  }

  getRange(): TranscriptVirtualRangeSnapshot {
    if (this.lastRange) {
      return this.lastRange;
    }

    this.diagnostics.rangeCalculations += 1;
    const rangeInput: TranscriptRangeInput = {
      rows: this.rows,
      scrollTop: this.observedScrollTop,
      viewportHeight: this.viewportHeight,
      footerHeight: this.footerHeight,
      overscanBeforePx: this.overscanBeforePx,
      overscanAfterPx: this.overscanAfterPx,
      overscanBeforeRows: this.overscanBeforeRows,
      overscanAfterRows: this.overscanAfterRows,
      protectedRowIds: this.protectedRowIds,
      getRowHeight: (row) => this.getRowHeight(row),
    };
    this.lastRange = computeTranscriptVirtualRange(rangeInput);
    this.diagnostics.protectedRowsRendered =
      this.lastRange.protectedRowIds.length;
    return this.lastRange;
  }

  getPendingScrollCorrection(): TranscriptScrollCorrection | null {
    return this.viewport.pendingScroll;
  }

  getState(): TranscriptVirtualControllerState {
    const bottomScrollTop = this.getBottomScrollTop();
    const distanceFromBottom = Math.max(
      0,
      bottomScrollTop - this.observedScrollTop,
    );
    return {
      sessionId: this.sessionId,
      sessionEpoch: this.sessionEpoch,
      widthScope: this.widthScope,
      scrollTop: this.observedScrollTop,
      viewportHeight: this.viewportHeight,
      footerHeight: this.footerHeight,
      virtualScrollHeight: this.getVirtualScrollHeight(),
      bottomScrollTop,
      distanceFromBottom,
      pinnedToBottom: distanceFromBottom <= this.pinnedBottomThresholdPx,
      nearBottom: distanceFromBottom < this.autoScrollThresholdPx,
      anchor: this.anchor,
      rowCount: this.rows.length,
    };
  }

  getDiagnostics(): TranscriptVirtualDiagnostics {
    return {
      ...this.diagnostics,
      lastCorrection: this.diagnostics.lastCorrection
        ? { ...this.diagnostics.lastCorrection }
        : null,
    };
  }

  getMeasurementToken(rowId: string): TranscriptVirtualMeasurementToken | null {
    const row = this.getRow(rowId);
    if (!row) {
      return null;
    }
    return {
      sessionId: this.sessionId,
      sessionEpoch: this.sessionEpoch,
      widthScope: this.widthScope,
      rowId,
      heightRevision: row.heightRevision,
      layoutRevision: row.layoutRevision,
    };
  }

  getScrollTopForRow(
    rowId: string,
    align: TranscriptScrollAlign = "start",
  ): number | null {
    const row = this.getRow(rowId);
    if (!row) {
      return null;
    }

    const position = this.getRowPosition(row.rowId);
    if (!position) {
      return null;
    }

    const current = this.observedScrollTop;
    const viewportEnd = current + this.viewportHeight;
    let nextScrollTop: number;

    switch (align) {
      case "start":
        nextScrollTop = position.top;
        break;
      case "center":
        nextScrollTop =
          position.top - (this.viewportHeight - position.height) / 2;
        break;
      case "end":
        nextScrollTop = position.bottom - this.viewportHeight;
        break;
      case "auto":
        if (position.top >= current && position.bottom <= viewportEnd) {
          nextScrollTop = current;
        } else if (position.top < current) {
          nextScrollTop = position.top;
        } else {
          nextScrollTop = position.bottom - this.viewportHeight;
        }
        break;
      default:
        assertNever(align);
    }

    return this.clampScrollTop(nextScrollTop);
  }

  private validateMeasurementToken(
    token: TranscriptVirtualMeasurementToken,
  ): boolean {
    const row = this.getRow(token.rowId);
    let valid = true;

    if (token.sessionId !== this.sessionId) {
      this.diagnostics.staleMeasurementSessionDrops += 1;
      valid = false;
    }
    if (token.sessionEpoch !== this.sessionEpoch) {
      this.diagnostics.staleMeasurementEpochDrops += 1;
      valid = false;
    }
    if (token.widthScope !== this.widthScope) {
      this.diagnostics.staleMeasurementWidthDrops += 1;
      valid = false;
    }
    if (!row) {
      this.diagnostics.staleMeasurementMissingRowDrops += 1;
      valid = false;
    } else if (
      row.heightRevision !== token.heightRevision ||
      row.layoutRevision !== token.layoutRevision
    ) {
      this.diagnostics.staleMeasurementRevisionDrops += 1;
      valid = false;
    }

    if (!valid) {
      this.diagnostics.staleMeasurementsDropped += 1;
    }

    return valid;
  }

  private reconcileAnchor(
    options: ReconcileOptions,
  ): TranscriptScrollCorrection | null {
    const resolution = this.resolveAnchor();

    if (resolution.anchor.type === "bottom") {
      return this.applyScrollCorrection({
        reason: "bottom-anchor",
        nextScrollTop: this.getBottomScrollTop(),
      });
    }

    if (resolution.anchor.type === "scroll-position") {
      return this.applyScrollCorrection({
        reason: "row-anchor",
        nextScrollTop: resolution.anchor.scrollTop,
      });
    }

    if (resolution.stale || resolution.missing) {
      if (resolution.stale) {
        this.diagnostics.staleAnchorsDropped += 1;
      }
      if (resolution.missing) {
        this.diagnostics.missingAnchorsDropped += 1;
      }

      const clamped = this.clampScrollTop(this.observedScrollTop);
      const correction = this.applyScrollCorrection({
        reason: resolution.stale
          ? "stale-anchor-clamp"
          : "missing-anchor-clamp",
        nextScrollTop: clamped,
      });
      if (options.updateAnchorOnStale) {
        this.captureViewportAnchor();
      }
      return correction;
    }

    const targetTop = this.clampScrollTop(
      this.getRowTop(resolution.anchor.rowId) +
        resolution.anchor.offsetWithinRow,
    );
    return this.applyScrollCorrection({
      reason: options.reason,
      nextScrollTop: targetTop,
    });
  }

  private resolveAnchor(): TranscriptAnchorResolution {
    if (this.anchor.type === "bottom") {
      return {
        anchor: this.anchor,
        stale: false,
        missing: false,
      };
    }

    if (this.anchor.type === "scroll-position") {
      return {
        anchor: this.anchor,
        stale: false,
        missing: false,
      };
    }

    const row = this.getRow(this.anchor.rowId);
    if (!row) {
      return {
        anchor: this.anchor,
        stale: false,
        missing: true,
      };
    }

    if (row.heightRevision !== this.anchor.anchorRevision) {
      return {
        anchor: this.anchor,
        stale: true,
        missing: false,
      };
    }

    return {
      anchor: this.anchor,
      stale: false,
      missing: false,
    };
  }

  private captureViewportAnchor(
    options: { fallback?: "bottom" | "scroll-position" } = {},
  ): void {
    const viewportEnd = this.observedScrollTop + this.viewportHeight;
    const stable = this.findAnchorableRow("stable", viewportEnd);
    const streaming = this.findAnchorableRow("streaming", viewportEnd);
    const nearestStable = this.findNearestAnchorableRow("stable", viewportEnd);
    const nearestStreaming = this.findNearestAnchorableRow(
      "streaming",
      viewportEnd,
    );
    const selected = stable ?? streaming ?? nearestStable ?? nearestStreaming;

    if (!selected) {
      this.setScrollAnchor(
        options.fallback === "scroll-position"
          ? { type: "scroll-position", scrollTop: this.observedScrollTop }
          : { type: "bottom" },
      );
      return;
    }

    this.setScrollAnchor({
      type: "row",
      rowId: selected.row.rowId,
      offsetWithinRow: this.observedScrollTop - selected.position.top,
    });
    this.diagnostics.recapturedAnchors += 1;
  }

  private findAnchorableRow(
    priority: "stable" | "streaming",
    viewportEnd: number,
  ): {
    row: TranscriptRowDescriptor;
    position: RowPosition;
  } | null {
    let top = 0;
    for (const row of this.rows) {
      const height = this.getRowHeight(row);
      const bottom = top + height;
      const position = { top, height, bottom };
      top = bottom;

      if (row.anchorPriority !== priority) {
        continue;
      }

      if (
        position.bottom > this.observedScrollTop &&
        position.top < viewportEnd
      ) {
        return { row, position };
      }
    }

    return null;
  }

  private findNearestAnchorableRow(
    priority: "stable" | "streaming",
    viewportEnd: number,
  ): {
    row: TranscriptRowDescriptor;
    position: RowPosition;
  } | null {
    let top = 0;
    let nearestBefore: {
      row: TranscriptRowDescriptor;
      position: RowPosition;
    } | null = null;
    let nearestAfter: {
      row: TranscriptRowDescriptor;
      position: RowPosition;
    } | null = null;

    for (const row of this.rows) {
      const height = this.getRowHeight(row);
      const bottom = top + height;
      const position = { top, height, bottom };
      top = bottom;

      if (row.anchorPriority !== priority) {
        continue;
      }

      if (position.bottom <= this.observedScrollTop) {
        nearestBefore = { row, position };
        continue;
      }

      if (position.top >= viewportEnd) {
        nearestAfter ??= { row, position };
      }
    }

    return nearestBefore ?? nearestAfter;
  }

  private setScrollAnchor(anchor: PendingScrollAnchor): void {
    if (anchor.type === "bottom") {
      this.anchor = { type: "bottom" };
      return;
    }

    if (anchor.type === "scroll-position") {
      this.anchor = {
        type: "scroll-position",
        scrollTop: this.clampScrollTop(anchor.scrollTop),
      };
      return;
    }

    const row = this.getRow(anchor.rowId);
    if (!row) {
      this.anchor = {
        type: "row",
        rowId: anchor.rowId,
        offsetWithinRow: anchor.offsetWithinRow,
        anchorRevision: "",
      };
      return;
    }

    this.anchor = {
      type: "row",
      rowId: anchor.rowId,
      offsetWithinRow: anchor.offsetWithinRow,
      anchorRevision: row.heightRevision,
    };
  }

  private applyScrollCorrection({
    reason,
    nextScrollTop,
  }: {
    reason: TranscriptCorrectionReason;
    nextScrollTop: number;
  }): TranscriptScrollCorrection | null {
    const transition = transitionTranscriptGeometryViewport(this.viewport, {
      type: "propose",
      reason,
      scrollTop: nextScrollTop,
      maxScrollTop: this.getBottomScrollTop(),
      epsilon: this.measurementEpsilonPx,
    });
    this.viewport = transition.state;
    if (transition.effect) {
      this.recordCorrection(transition.effect);
    }
    return transition.effect;
  }

  private get observedScrollTop(): number {
    return this.viewport.observedScrollTop;
  }

  private recordCorrection(correction: TranscriptScrollCorrection): void {
    this.diagnostics.corrections += 1;
    this.diagnostics.lastCorrection = correction;
    switch (correction.reason) {
      case "bottom-anchor":
        this.diagnostics.bottomCorrections += 1;
        break;
      case "row-anchor":
        this.diagnostics.rowCorrections += 1;
        break;
      case "scroll-to-row":
        this.diagnostics.scrollToRowCorrections += 1;
        break;
      case "stale-anchor-clamp":
      case "missing-anchor-clamp":
        break;
      default:
        assertNever(correction.reason);
    }
  }

  private getBottomScrollTop(): number {
    const virtualBottom = this.getVirtualScrollHeight() - this.viewportHeight;
    const browserBottom =
      this.browserScrollHeight === null
        ? 0
        : this.browserScrollHeight - this.viewportHeight;
    return Math.max(0, virtualBottom, browserBottom);
  }

  private getDistanceFromBottom(scrollTop: number): number {
    return Math.max(0, this.getBottomScrollTop() - scrollTop);
  }

  private getVirtualScrollHeight(): number {
    return this.getRowsHeight() + this.footerHeight;
  }

  private getRowsHeight(): number {
    return this.rows.reduce((total, row) => total + this.getRowHeight(row), 0);
  }

  private getRowTop(rowId: string): number {
    const position = this.getRowPosition(rowId);
    return position?.top ?? this.getRowsHeight();
  }

  private getRowPosition(rowId: string): RowPosition | null {
    let top = 0;
    for (const row of this.rows) {
      const height = this.getRowHeight(row);
      const bottom = top + height;
      if (row.rowId === rowId) {
        return { top, height, bottom };
      }
      top = bottom;
    }
    return null;
  }

  private getRowHeight(row: TranscriptRowDescriptor): number {
    const measured = this.measurements.get(this.measurementKey(row.rowId));
    const estimatedHeight = getTranscriptRowEstimatedHeight(row);
    // The scheduler/cache are width-scoped, but live controller geometry keeps
    // the last accepted height as a provisional value across width changes.
    // That preserves the visible anchor while same-width remeasurement catches
    // up after resize.
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
    measuredHeight: number,
  ): void {
    const key = this.measurementKey(row.rowId);
    this.streamingHeightFloors.set(
      key,
      Math.max(
        this.streamingHeightFloors.get(key) ?? 0,
        this.getRowHeight(row),
        measuredHeight,
      ),
    );
  }

  private releaseInactiveStreamingFloors(): void {
    const activeStreamingKeys = new Set(
      this.rows
        .filter((row) => row.anchorPriority === "streaming")
        .map((row) => this.measurementKey(row.rowId)),
    );
    for (const key of this.streamingHeightFloors.keys()) {
      if (!activeStreamingKeys.has(key)) {
        this.streamingHeightFloors.delete(key);
      }
    }
  }

  private getRow(rowId: string): TranscriptRowDescriptor | null {
    const index = this.rowIndexById.get(rowId);
    return index === undefined ? null : (this.rows[index] ?? null);
  }

  private clampScrollTop(scrollTop: number): number {
    return Math.min(Math.max(0, scrollTop), this.getBottomScrollTop());
  }

  private measurementKey(rowId: string): string {
    return rowId;
  }
}

export function createTranscriptVirtualController(
  input: TranscriptSessionGeometry,
  options?: TranscriptVirtualControllerOptions,
): TranscriptVirtualController {
  return new TranscriptVirtualController(input, options);
}

function getScrollDirection(
  previousScrollTop: number,
  nextScrollTop: number,
): TranscriptScrollDirection {
  if (nextScrollTop > previousScrollTop) {
    return "down";
  }
  if (nextScrollTop < previousScrollTop) {
    return "up";
  }
  return "none";
}

function assertNever(value: never): never {
  throw new Error(`Unhandled value: ${JSON.stringify(value)}`);
}

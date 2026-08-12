import type { TranscriptRowDescriptor } from "../projection/transcriptItemTypes";

export const TRANSCRIPT_PINNED_BOTTOM_THRESHOLD_PX = 8;
export const TRANSCRIPT_AUTO_SCROLL_THRESHOLD_PX = 180;
export const TRANSCRIPT_MEASUREMENT_EPSILON_PX = 2;
export const TRANSCRIPT_DEFAULT_OVERSCAN_BEFORE_PX = 1200;
export const TRANSCRIPT_DEFAULT_OVERSCAN_AFTER_PX = 600;
export const TRANSCRIPT_DEFAULT_OVERSCAN_BEFORE_ROWS = 4;
export const TRANSCRIPT_DEFAULT_OVERSCAN_AFTER_ROWS = 4;

export type TranscriptScrollAnchor =
  | { type: "bottom" }
  | { type: "scroll-position"; scrollTop: number }
  | {
      type: "row";
      rowId: string;
      offsetWithinRow: number;
      anchorRevision: string;
    };

export type TranscriptScrollSource = "browser" | "programmatic" | "correction";

export type TranscriptScrollDirection = "up" | "down" | "none";

export type TranscriptScrollAlign = "start" | "center" | "end" | "auto";

export type TranscriptCorrectionReason =
  | "bottom-anchor"
  | "row-anchor"
  | "stale-anchor-clamp"
  | "missing-anchor-clamp"
  | "scroll-to-row";

export interface TranscriptViewportGeometry {
  scrollTop: number;
  viewportHeight: number;
  widthScope: string;
  footerHeight?: number;
  browserScrollHeight?: number;
}

export interface TranscriptSessionGeometry {
  sessionId: string;
  sessionEpoch: number;
  widthScope: string;
  viewportHeight: number;
  footerHeight?: number;
  scrollTop?: number;
  browserScrollHeight?: number;
}

export interface TranscriptVirtualMeasurementToken {
  sessionId: string;
  sessionEpoch: number;
  widthScope: string;
  rowId: string;
  heightRevision: string;
  layoutRevision: string;
}

export type TranscriptMeasurementSource =
  | "visible"
  | "offscreen-real"
  | "offscreen-shell"
  | "reserved"
  | "estimate";

export interface TranscriptMeasurementUpdate {
  token: TranscriptVirtualMeasurementToken;
  height: number;
  source?: TranscriptMeasurementSource;
}

export interface TranscriptScrollCorrection {
  reason: TranscriptCorrectionReason;
  previousScrollTop: number;
  nextScrollTop: number;
  delta: number;
}

export interface TranscriptAnchorResolution {
  anchor: TranscriptScrollAnchor;
  stale: boolean;
  missing: boolean;
}

export interface TranscriptVirtualDiagnostics {
  rowSetUpdates: number;
  viewportUpdates: number;
  rangeCalculations: number;
  measuredHeightUpdates: number;
  corrections: number;
  bottomCorrections: number;
  rowCorrections: number;
  scrollToRowCorrections: number;
  staleMeasurementsDropped: number;
  staleMeasurementSessionDrops: number;
  staleMeasurementEpochDrops: number;
  staleMeasurementWidthDrops: number;
  staleMeasurementRevisionDrops: number;
  staleMeasurementMissingRowDrops: number;
  staleAnchorsDropped: number;
  missingAnchorsDropped: number;
  recapturedAnchors: number;
  bottomFollowExits: number;
  protectedRowsRendered: number;
  lastCorrection: TranscriptScrollCorrection | null;
}

export interface TranscriptVirtualControllerOptions {
  pinnedBottomThresholdPx?: number;
  autoScrollThresholdPx?: number;
  measurementEpsilonPx?: number;
  overscanBeforePx?: number;
  overscanAfterPx?: number;
  overscanBeforeRows?: number;
  overscanAfterRows?: number;
  protectedRowIds?: readonly string[];
}

export interface TranscriptVirtualControllerState {
  sessionId: string;
  sessionEpoch: number;
  widthScope: string;
  scrollTop: number;
  viewportHeight: number;
  footerHeight: number;
  virtualScrollHeight: number;
  bottomScrollTop: number;
  distanceFromBottom: number;
  pinnedToBottom: boolean;
  nearBottom: boolean;
  anchor: TranscriptScrollAnchor;
  rowCount: number;
}

export interface TranscriptVisibleRange {
  startIndex: number;
  endIndex: number;
}

export interface TranscriptRenderRange {
  startIndex: number;
  endIndex: number;
  visibleStartIndex: number;
  visibleEndIndex: number;
}

export interface TranscriptVirtualItem {
  index: number;
  key: string;
  row: TranscriptRowDescriptor;
  start: number;
  size: number;
  end: number;
  visible: boolean;
  protected: boolean;
}

export interface TranscriptVirtualRangeSnapshot {
  totalHeight: number;
  scrollHeight: number;
  visibleRange: TranscriptVisibleRange;
  renderRange: TranscriptRenderRange;
  virtualItems: readonly TranscriptVirtualItem[];
  visibleRowIds: readonly string[];
  renderedRowIds: readonly string[];
  protectedRowIds: readonly string[];
  paddingStart: number;
  paddingEnd: number;
}

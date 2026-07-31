import type { TranscriptRowDescriptor } from "../projection/transcriptItemTypes";
import type {
  TranscriptScrollAlign,
  TranscriptScrollCorrection,
  TranscriptSessionGeometry,
  TranscriptViewportGeometry,
  TranscriptVirtualControllerState,
  TranscriptVirtualDiagnostics,
  TranscriptVirtualMeasurementToken,
  TranscriptVirtualRangeSnapshot,
} from "./transcriptVirtualTypes";

export interface TranscriptMeasurementResult {
  accepted: boolean;
  correction: TranscriptScrollCorrection | null;
}

export interface TranscriptMeasurementBatchResult {
  acceptedTokens: readonly TranscriptVirtualMeasurementToken[];
  rejected: number;
  correction: TranscriptScrollCorrection | null;
}

export interface TranscriptRowsUpdateResult {
  correction: TranscriptScrollCorrection | null;
}

export interface TranscriptViewportUpdateResult {
  correction: TranscriptScrollCorrection | null;
}

export interface TranscriptScrollToRowResult {
  found: boolean;
  correction: TranscriptScrollCorrection | null;
}

export interface TranscriptVirtualEngine {
  readonly engineKind?: string;
  reset(input: TranscriptSessionGeometry): void;
  setRows(rows: readonly TranscriptRowDescriptor[]): TranscriptRowsUpdateResult;
  syncViewport(
    geometry: TranscriptViewportGeometry,
    options?: {
      source?: "browser" | "programmatic" | "correction";
      userScrollIntent?: boolean;
      preserveScrollPosition?: boolean;
      /** Recovery-only escape hatch that invalidates and recomputes a stale range. */
      forceRangeRefresh?: boolean;
    },
  ): TranscriptViewportUpdateResult;
  applyMeasuredHeight(input: {
    token: TranscriptVirtualMeasurementToken;
    height: number;
  }): TranscriptMeasurementResult;
  applyMeasuredHeights?(
    inputs: readonly {
      token: TranscriptVirtualMeasurementToken;
      height: number;
    }[],
  ): TranscriptMeasurementBatchResult;
  scrollToRow(
    rowId: string,
    align?: TranscriptScrollAlign,
  ): TranscriptScrollToRowResult;
  scrollToEnd?(options?: { behavior?: ScrollBehavior }): void;
  /** Commit a product scroll through the viewport transaction owner. */
  writeScrollTop?(
    scrollTop: number,
    options?: {
      behavior?: ScrollBehavior;
      source?: "browser" | "programmatic" | "correction";
      userScrollIntent?: boolean;
      preserveScrollPosition?: boolean;
    },
  ): unknown;
  // Suspend/resume DOM scrollTop writes. When suspended the engine still
  // computes ranges/anchors; it just does not assert scrollTop on the scroll
  // element.
  setScrollWritesSuspended?(suspended: boolean): void;
  getRange(): TranscriptVirtualRangeSnapshot;
  /** Current unacknowledged geometry proposal. */
  getPendingScrollCorrection(): TranscriptScrollCorrection | null;
  getState(): TranscriptVirtualControllerState;
  getDiagnostics(): TranscriptVirtualDiagnostics;
}

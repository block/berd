import type { TranscriptRowDescriptor } from "../projection/transcriptItemTypes";
import type {
  TranscriptScrollAlign,
  TranscriptScrollAnchor,
  TranscriptScrollCorrection,
  TranscriptScrollOperation,
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
      operation?: TranscriptScrollOperation;
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
    options?: { operation?: TranscriptScrollOperation },
  ): TranscriptScrollToRowResult;
  scrollToEnd?(options?: { behavior?: ScrollBehavior }): void;
  /** Commit a product scroll through the viewport transaction owner. */
  writeScrollTop?(
    scrollTop: number,
    options?: {
      behavior?: ScrollBehavior;
      source?: "browser" | "programmatic" | "correction";
      userScrollIntent?: boolean;
      operation?: TranscriptScrollOperation;
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
  /** Optional row-token access for coordination wrappers. */
  getMeasurementToken?(rowId: string): TranscriptVirtualMeasurementToken | null;
  /**
   * Narrow escape hatch for an external coordination owner to install an
   * anchor explicitly, without cloning controller/geometry state. Optional
   * `operation` tags the resulting correction so ownership/generation checks
   * in the geometry transition still apply.
   */
  installAuthorityAnchor?(
    anchor: TranscriptScrollAnchor,
    operation?: TranscriptScrollOperation,
  ): TranscriptScrollCorrection | null;
  getState(): TranscriptVirtualControllerState;
  getDiagnostics(): TranscriptVirtualDiagnostics;
}

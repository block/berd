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
      preserveBottomAnchor?: boolean;
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
  // Suspend/resume DOM scrollTop writes (used to stop fighting browser-owned
  // auto-scroll during a drag-select). When suspended the engine still computes
  // ranges/anchors; it just does not assert scrollTop on the scroll element.
  setScrollWritesSuspended?(suspended: boolean): void;
  getRange(): TranscriptVirtualRangeSnapshot;
  getState(): TranscriptVirtualControllerState;
  getDiagnostics(): TranscriptVirtualDiagnostics;
}

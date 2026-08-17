import type { TranscriptRowDescriptor } from "../projection/transcriptItemTypes";
import type {
  TranscriptMeasurementBatchResult,
  TranscriptMeasurementResult,
  TranscriptRowsUpdateResult,
  TranscriptScrollToRowResult,
  TranscriptViewportUpdateResult,
  TranscriptVirtualEngine,
} from "./transcriptVirtualEngine";
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

/** A survivor engine that also implements the narrow authority-anchor escape hatch. */
export type TranscriptScrollCoordinationEngine = TranscriptVirtualEngine & {
  installAuthorityAnchor(
    anchor: TranscriptScrollAnchor,
    operation?: TranscriptScrollOperation,
  ): TranscriptScrollCorrection | null;
  getMeasurementToken(rowId: string): TranscriptVirtualMeasurementToken | null;
};

export interface TranscriptScrollCoordinationAuthorityOptions {
  initialAnchor?: TranscriptScrollAnchor;
  initialOperation?: TranscriptScrollOperation;
}

/**
 * Owner-driven coordination authority wrapping a TranscriptVirtualEngine
 * survivor. The authority - not the wrapped engine - owns anchor identity
 * across reset/replay and resize: anchor installs are explicit owner
 * proposals carrying generation identity, and acknowledging or superseding
 * an operation retires it so a stale generation can't tag a later reflow.
 *
 * Architectural spike: wraps existing survivors, adds one narrow engine API.
 * Nothing in production wiring constructs or calls this class yet.
 */
export class TranscriptScrollCoordinationAuthority {
  private readonly engine: TranscriptScrollCoordinationEngine;
  private pendingOperation: TranscriptScrollOperation | null;
  private trackedAnchor: TranscriptScrollAnchor;

  constructor(
    engine: TranscriptScrollCoordinationEngine,
    options: TranscriptScrollCoordinationAuthorityOptions = {},
  ) {
    this.engine = engine;
    this.pendingOperation = options.initialOperation ?? null;
    this.trackedAnchor = options.initialAnchor ?? engine.getState().anchor;
    if (options.initialAnchor) {
      this.engine.installAuthorityAnchor(
        options.initialAnchor,
        options.initialOperation,
      );
    }
  }

  // The engine's own reset seeds an untagged bottom anchor as a scaffold;
  // overriding it here means no autonomous bottom correction ever reaches
  // the owner untagged.
  reset(
    geometry: TranscriptSessionGeometry,
    anchor: TranscriptScrollAnchor,
    operation: TranscriptScrollOperation,
  ): TranscriptScrollCorrection | null {
    this.engine.reset(geometry);
    this.pendingOperation = operation;
    this.trackedAnchor = anchor;
    return this.engine.installAuthorityAnchor(anchor, operation);
  }

  /** Only a strictly newer generation supersedes the pending operation. */
  proposeAnchor(
    anchor: TranscriptScrollAnchor,
    operation: TranscriptScrollOperation,
  ): TranscriptScrollCorrection | null {
    if (
      this.pendingOperation &&
      operation.generation <= this.pendingOperation.generation
    ) {
      return null;
    }
    this.pendingOperation = operation;
    this.trackedAnchor = anchor;
    return this.engine.installAuthorityAnchor(anchor, operation);
  }

  // Only an exact generation match retires the pending operation - older,
  // no-op, or unmatched-newer acknowledgements never touch it. Supersession
  // is a proposal-only act.
  acknowledge(operation: TranscriptScrollOperation): boolean {
    if (
      !this.pendingOperation ||
      operation.generation !== this.pendingOperation.generation
    ) {
      return false;
    }
    this.pendingOperation = null;
    return true;
  }

  // The wrapped engine may autonomously recapture a different anchor on its
  // own (e.g. a stale row revision forces a recapture); re-target the
  // authority's own tracked anchor afterward so it survives resize
  // regardless of the engine's drift.
  reconcileResize(
    geometry: TranscriptViewportGeometry,
  ): TranscriptScrollCorrection | null {
    this.engine.syncViewport(geometry, { source: "programmatic" });
    return this.engine.installAuthorityAnchor(
      this.trackedAnchor,
      this.pendingOperation ?? undefined,
    );
  }

  // Overscroll past the modeled bottom (elastic/rubber-band bounce) is never
  // forwarded to the engine, so it can't mutate anchor, manufacture
  // pinned/range intent, or produce a correction.
  observeScroll(
    geometry: TranscriptViewportGeometry,
    options: { userScrollIntent?: boolean } = {},
  ): TranscriptViewportUpdateResult {
    const modeledBottom = this.engine.getState().bottomScrollTop;
    if (geometry.scrollTop > modeledBottom) {
      return { correction: null };
    }
    return this.engine.syncViewport(geometry, {
      source: "browser",
      userScrollIntent: options.userScrollIntent,
    });
  }

  setRows(
    rows: readonly TranscriptRowDescriptor[],
  ): TranscriptRowsUpdateResult {
    return this.engine.setRows(rows);
  }

  applyMeasuredHeight(input: {
    token: TranscriptVirtualMeasurementToken;
    height: number;
  }): TranscriptMeasurementResult {
    return this.engine.applyMeasuredHeight(input);
  }

  applyMeasuredHeights(
    inputs: readonly {
      token: TranscriptVirtualMeasurementToken;
      height: number;
    }[],
  ): TranscriptMeasurementBatchResult {
    if (!this.engine.applyMeasuredHeights) {
      throw new Error("Wrapped engine does not support batched measurements.");
    }
    return this.engine.applyMeasuredHeights(inputs);
  }

  scrollToRow(
    rowId: string,
    align?: TranscriptScrollAlign,
  ): TranscriptScrollToRowResult {
    return this.engine.scrollToRow(rowId, align);
  }

  getMeasurementToken(rowId: string): TranscriptVirtualMeasurementToken | null {
    return this.engine.getMeasurementToken(rowId);
  }

  getRange(): TranscriptVirtualRangeSnapshot {
    return this.engine.getRange();
  }

  getState(): TranscriptVirtualControllerState {
    return this.engine.getState();
  }

  getDiagnostics(): TranscriptVirtualDiagnostics {
    return this.engine.getDiagnostics();
  }

  getPendingScrollCorrection(): TranscriptScrollCorrection | null {
    return this.engine.getPendingScrollCorrection();
  }

  getPendingOperation(): TranscriptScrollOperation | null {
    return this.pendingOperation;
  }

  getTrackedAnchor(): TranscriptScrollAnchor {
    return this.trackedAnchor;
  }
}

export function createTranscriptScrollCoordinationAuthority(
  engine: TranscriptScrollCoordinationEngine,
  options?: TranscriptScrollCoordinationAuthorityOptions,
): TranscriptScrollCoordinationAuthority {
  return new TranscriptScrollCoordinationAuthority(engine, options);
}

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
  TranscriptScrollCause,
  TranscriptScrollOperation,
  TranscriptSessionGeometry,
  TranscriptViewportGeometry,
  TranscriptVirtualControllerState,
  TranscriptVirtualDiagnostics,
  TranscriptVirtualMeasurementToken,
  TranscriptVirtualRangeSnapshot,
  TranscriptUserInputKind,
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

export interface TranscriptScrollOperationResult {
  operation: TranscriptScrollOperation;
  correction: TranscriptScrollCorrection | null;
}

/**
 * Owner-driven coordination authority wrapping a TranscriptVirtualEngine
 * survivor. The authority - not the wrapped engine - owns anchor identity and
 * operation lifecycle across reset/replay and resize. Browser corrections are
 * effects of an operation, not the operation itself, so an at-anchor request
 * remains observable and acknowledgeable even when no browser write is needed.
 */
export class TranscriptScrollCoordinationAuthority {
  private readonly engine: TranscriptScrollCoordinationEngine;
  private pendingOperation: TranscriptScrollOperation | null;
  private trackedAnchor: TranscriptScrollAnchor;
  private nextGeneration: number;

  constructor(
    engine: TranscriptScrollCoordinationEngine,
    options: TranscriptScrollCoordinationAuthorityOptions = {},
  ) {
    this.engine = engine;
    this.pendingOperation = options.initialOperation ?? null;
    this.trackedAnchor = options.initialAnchor ?? engine.getState().anchor;
    this.nextGeneration = options.initialOperation?.generation ?? 0;
    if (options.initialAnchor) {
      this.engine.installAuthorityAnchor(
        options.initialAnchor,
        options.initialOperation,
      );
    }
  }

  // The engine's own reset seeds an untagged bottom anchor as a scaffold;
  // overriding it here means no autonomous bottom correction reaches the owner.
  reset(
    geometry: TranscriptSessionGeometry,
    anchor: TranscriptScrollAnchor,
    operation: TranscriptScrollOperation,
  ): TranscriptScrollCorrection | null {
    this.nextGeneration = Math.max(this.nextGeneration, operation.generation);
    this.engine.reset(geometry);
    this.pendingOperation = operation;
    this.trackedAnchor = anchor;
    return this.engine.installAuthorityAnchor(anchor, operation);
  }

  /** Start an authority-owned operation and retain it even at the anchor. */
  startOperation(
    anchor: TranscriptScrollAnchor,
    cause: TranscriptScrollCause,
    userInputKind?: TranscriptUserInputKind,
  ): TranscriptScrollOperationResult {
    const operation: TranscriptScrollOperation = {
      generation: ++this.nextGeneration,
      cause,
      ...(userInputKind ? { userInputKind } : {}),
    };
    return (
      this.startWithOperation(anchor, operation) ?? {
        operation,
        correction: null,
      }
    );
  }

  /** Start and execute one authority-owned row target operation. */
  startTargetOperation(
    rowId: string,
    align: TranscriptScrollAlign = "auto",
  ): TranscriptScrollOperationResult & { found: boolean } {
    const operation: TranscriptScrollOperation = {
      generation: ++this.nextGeneration,
      cause: "target",
    };
    this.pendingOperation = operation;
    const result = this.engine.scrollToRow(rowId, align, { operation });
    if (!result.found) {
      this.retire(operation);
      return { operation, correction: null, found: false };
    }
    this.trackedAnchor = this.engine.getState().anchor;
    return { operation, correction: result.correction, found: true };
  }

  /** Only a strictly newer generation supersedes the pending operation. */
  proposeAnchor(
    anchor: TranscriptScrollAnchor,
    operation: TranscriptScrollOperation,
  ): TranscriptScrollCorrection | null {
    return this.startWithOperation(anchor, operation)?.correction ?? null;
  }

  /** Complete is the acknowledgement path used after browser acceptance. */
  complete(operation: TranscriptScrollOperation): boolean {
    return this.acknowledge(operation);
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
    return this.retire(operation);
  }

  /** Retire one exact generation, or all pending work for an external reset. */
  retire(operation?: TranscriptScrollOperation): boolean {
    if (!this.pendingOperation) {
      return false;
    }
    if (
      operation &&
      operation.generation !== this.pendingOperation.generation
    ) {
      return false;
    }
    this.pendingOperation = null;
    return true;
  }

  /** Record a physical browser detachment outside or between canonical rows. */
  detachAtScrollPosition(scrollTop: number): void {
    this.trackedAnchor = {
      type: "scroll-position",
      scrollTop: Math.max(0, scrollTop),
    };
  }

  /** Physical input interrupts pending work and observes under a newer operation. */
  observeUserInput(
    geometry: TranscriptViewportGeometry,
    userInputKind: TranscriptUserInputKind,
  ): TranscriptViewportUpdateResult {
    this.interrupt(userInputKind);
    const operation: TranscriptScrollOperation = {
      generation: ++this.nextGeneration,
      cause: "user-input",
      userInputKind,
    };
    this.pendingOperation = operation;
    const result = this.engine.syncViewport(geometry, {
      source: "browser",
      userScrollIntent: true,
      operation,
      preserveScrollPosition: true,
    });
    this.trackedAnchor = this.engine.getState().anchor;
    this.complete(operation);
    return result;
  }

  /** Physical input interrupts pending work; late completion becomes inert. */
  interrupt(
    userInputKind: TranscriptUserInputKind,
  ): TranscriptScrollOperation | null {
    // The kind is intentionally part of the authority boundary even though
    // every explicit physical input has the same retirement effect.
    void userInputKind;
    const interrupted = this.pendingOperation;
    if (interrupted) {
      this.retire(interrupted);
    }
    return interrupted;
  }

  // The wrapped engine may autonomously recapture a different anchor on its
  // own (e.g. a stale row revision forces a recapture); re-target the
  // authority's own tracked anchor afterward so it survives resize.
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
  // forwarded to the engine, so it can't mutate anchor or manufacture intent.
  observeScroll(
    geometry: TranscriptViewportGeometry,
    options: { userScrollIntent?: boolean } = {},
  ): TranscriptViewportUpdateResult {
    const modeledBottom = this.engine.getState().bottomScrollTop;
    if (geometry.scrollTop > modeledBottom) {
      const browserBottom = Math.max(
        0,
        (geometry.browserScrollHeight ?? 0) - geometry.viewportHeight,
      );
      if (
        options.userScrollIntent &&
        browserBottom > modeledBottom &&
        geometry.scrollTop < browserBottom
      ) {
        // A split live tail can extend the physical browser range beyond the
        // canonical virtual geometry. Preserve that browser-owned position as
        // an authority-owned detachment until the tail joins canonical rows.
        this.trackedAnchor = {
          type: "scroll-position",
          scrollTop: geometry.scrollTop,
        };
      }
      return { correction: null };
    }
    const result = this.engine.syncViewport(geometry, {
      source: "browser",
      userScrollIntent: options.userScrollIntent,
    });
    if (options.userScrollIntent) {
      this.trackedAnchor = this.engine.getState().anchor;
    }
    return result;
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
    options?: { operation?: TranscriptScrollOperation },
  ): TranscriptScrollToRowResult {
    return this.engine.scrollToRow(rowId, align, options);
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

  private startWithOperation(
    anchor: TranscriptScrollAnchor,
    operation: TranscriptScrollOperation,
  ): TranscriptScrollOperationResult | null {
    if (
      this.pendingOperation &&
      operation.generation <= this.pendingOperation.generation
    ) {
      return null;
    }
    this.nextGeneration = Math.max(this.nextGeneration, operation.generation);
    this.pendingOperation = operation;
    this.trackedAnchor = anchor;
    return {
      operation,
      correction: this.engine.installAuthorityAnchor(anchor, operation),
    };
  }
}

export function createTranscriptScrollCoordinationAuthority(
  engine: TranscriptScrollCoordinationEngine,
  options?: TranscriptScrollCoordinationAuthorityOptions,
): TranscriptScrollCoordinationAuthority {
  return new TranscriptScrollCoordinationAuthority(engine, options);
}

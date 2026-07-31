import type { TranscriptRowDescriptor } from "../projection/transcriptItemTypes";
import {
  createTranscriptBrowserViewport,
  type TranscriptBrowserViewport,
  type TranscriptBrowserViewportSnapshot,
} from "./browserViewport";
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
  TranscriptScrollCorrection,
  TranscriptSessionGeometry,
  TranscriptViewportGeometry,
  TranscriptVirtualControllerState,
  TranscriptVirtualDiagnostics,
  TranscriptVirtualMeasurementToken,
  TranscriptVirtualRangeSnapshot,
} from "./transcriptVirtualTypes";

export interface TranscriptViewportCoordinatorOptions {
  container: HTMLDivElement;
  engine: TranscriptVirtualEngine;
  getFooterHeight: () => number;
  transcriptRoot?: HTMLElement | null;
}

export interface TranscriptViewportWriteOptions {
  behavior?: ScrollBehavior;
  source?: "browser" | "programmatic" | "correction";
  userScrollIntent?: boolean;
  preserveScrollPosition?: boolean;
  /** Recovery-only escape hatch forwarded to the geometry engine. */
  forceRangeRefresh?: boolean;
}

/**
 * Sole normal-path owner of transcript browser geometry and scroll writes.
 *
 * Every engine mutation runs as one reconciliation transaction: read live
 * browser geometry, apply the pure geometry mutation, coalesce its proposal to
 * one browser write, read the accepted browser position, and publish that
 * accepted geometry back to the engine.
 */
export class TranscriptViewportCoordinator implements TranscriptVirtualEngine {
  readonly engineKind: string;

  private readonly browser: TranscriptBrowserViewport;
  private readonly engine: TranscriptVirtualEngine;
  private readonly getFooterHeight: () => number;
  private transactionWriteSuspensionDepth = 0;
  private footerHeightOverride: number | null = null;

  constructor(options: TranscriptViewportCoordinatorOptions) {
    this.engine = options.engine;
    this.engineKind = options.engine.engineKind ?? "coordinated";
    this.browser = createTranscriptBrowserViewport(
      options.container,
      options.transcriptRoot ?? options.container,
    );
    this.getFooterHeight = options.getFooterHeight;
    // The wrapped engine is geometry-only. The coordinator commits proposals.
  }

  reset(input: TranscriptSessionGeometry): void {
    this.engine.reset(input);
    this.reconcile(() => null);
  }

  setRows(
    rows: readonly TranscriptRowDescriptor[],
  ): TranscriptRowsUpdateResult {
    let result: TranscriptRowsUpdateResult = { correction: null };
    this.reconcile(() => {
      result = this.engine.setRows(rows);
      return result.correction;
    });
    return { correction: null };
  }

  syncViewport(
    geometry: TranscriptViewportGeometry,
    options: TranscriptViewportWriteOptions = {},
  ): TranscriptViewportUpdateResult {
    this.footerHeightOverride = geometry.footerHeight ?? null;
    let result: TranscriptViewportUpdateResult = { correction: null };
    this.reconcile(
      () => {
        result = this.engine.syncViewport(this.readGeometry(), options);
        return result.correction;
      },
      options,
      false,
    );
    return { correction: null };
  }

  applyMeasuredHeight(input: {
    token: TranscriptVirtualMeasurementToken;
    height: number;
  }): TranscriptMeasurementResult {
    let result: TranscriptMeasurementResult = {
      accepted: false,
      correction: null,
    };
    this.reconcile(() => {
      result = this.engine.applyMeasuredHeight(input);
      return result.correction;
    });
    return {
      ...result,
      correction:
        this.transactionWriteSuspensionDepth > 0 ? result.correction : null,
    };
  }

  applyMeasuredHeights(
    inputs: readonly {
      token: TranscriptVirtualMeasurementToken;
      height: number;
    }[],
  ): TranscriptMeasurementBatchResult {
    let result: TranscriptMeasurementBatchResult = {
      acceptedTokens: [],
      rejected: inputs.length,
      correction: null,
    };
    this.reconcile(() => {
      result = this.engine.applyMeasuredHeights
        ? this.engine.applyMeasuredHeights(inputs)
        : applyMeasurementsIndividually(this.engine, inputs);
      return result.correction;
    });
    return {
      ...result,
      correction:
        this.transactionWriteSuspensionDepth > 0 ? result.correction : null,
    };
  }

  scrollToRow(
    rowId: string,
    align: TranscriptScrollAlign = "auto",
  ): TranscriptScrollToRowResult {
    let result: TranscriptScrollToRowResult = {
      found: false,
      correction: null,
    };
    this.reconcile(() => {
      result = this.engine.scrollToRow(rowId, align);
      return result.correction;
    });
    return { ...result, correction: null };
  }

  scrollToEnd(options: { behavior?: ScrollBehavior } = {}): void {
    const browser = this.browser.read();
    const state = this.engine.getState();
    this.writeScrollTop(
      Math.max(
        state.bottomScrollTop,
        browser.scrollHeight - browser.viewportHeight,
      ),
      { behavior: options.behavior, source: "programmatic" },
    );
  }

  writeScrollTop(
    scrollTop: number,
    options: TranscriptViewportWriteOptions = {},
  ): TranscriptBrowserViewportSnapshot {
    return this.reconcile(
      () => ({
        previousScrollTop: this.engine.getState().scrollTop,
        nextScrollTop: scrollTop,
        delta: scrollTop - this.engine.getState().scrollTop,
        reason: "scroll-to-row",
      }),
      options,
      false,
    );
  }

  readBrowserViewport(): TranscriptBrowserViewportSnapshot {
    return this.browser.read();
  }

  readRealRowCoverage(transcriptRoot?: HTMLElement | null) {
    return this.browser.readRealRowCoverage(transcriptRoot ?? undefined);
  }

  setScrollWritesSuspended(suspended: boolean): void {
    // This controls coordinator transaction commits only; the wrapped geometry
    // adapter remains permanently suspended from direct live-DOM writes.
    this.transactionWriteSuspensionDepth = suspended
      ? this.transactionWriteSuspensionDepth + 1
      : Math.max(0, this.transactionWriteSuspensionDepth - 1);
    this.engine.setScrollWritesSuspended?.(
      this.transactionWriteSuspensionDepth > 0,
    );
  }

  getPendingScrollCorrection(): TranscriptScrollCorrection | null {
    return this.engine.getPendingScrollCorrection();
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

  private reconcile(
    mutate: () => TranscriptScrollCorrection | null,
    options: TranscriptViewportWriteOptions = {},
    syncBeforeMutation = true,
  ): TranscriptBrowserViewportSnapshot {
    const before = this.browser.read();
    let syncCorrection: TranscriptScrollCorrection | null = null;
    if (syncBeforeMutation) {
      syncCorrection = this.engine.syncViewport(this.toGeometry(before), {
        source: options.source ?? "programmatic",
        userScrollIntent: options.userScrollIntent,
        preserveScrollPosition: options.preserveScrollPosition,
      }).correction;
    }

    const mutationCorrection = mutate();
    const correction =
      mutationCorrection ??
      (this.engine.getPendingScrollCorrection() ? syncCorrection : null);
    const acceptedEngineScrollTop = this.engine.getState().scrollTop;
    const proposedScrollTop =
      correction?.nextScrollTop ?? acceptedEngineScrollTop;
    const browserBottomScrollTop = Math.max(
      0,
      before.scrollHeight - before.viewportHeight,
    );
    const nextScrollTop = options.preserveScrollPosition
      ? before.scrollTop
      : before.scrollHeight > before.viewportHeight
        ? Math.min(proposedScrollTop, browserBottomScrollTop)
        : proposedScrollTop;
    if (
      this.transactionWriteSuspensionDepth === 0 &&
      options.preserveScrollPosition !== true &&
      Math.abs(nextScrollTop - before.scrollTop) > 1
    ) {
      this.browser.writeScrollTop(nextScrollTop, options.behavior ?? "auto");
    }

    const accepted = this.browser.read();
    if (this.transactionWriteSuspensionDepth === 0) {
      // Browser clamping is authoritative. Publishing with explicit browser
      // ownership verifies engine/browser agreement without permitting a
      // second write in this transaction. Suspended layout transactions defer
      // both the write and this publish until the new DOM has committed.
      this.engine.syncViewport(this.toGeometry(accepted), {
        source: "browser",
        userScrollIntent: true,
        preserveScrollPosition: options.preserveScrollPosition,
      });
    }
    return accepted;
  }

  private readGeometry(): TranscriptViewportGeometry {
    return this.toGeometry(this.browser.read());
  }

  private toGeometry(
    viewport: TranscriptBrowserViewportSnapshot,
  ): TranscriptViewportGeometry {
    return {
      scrollTop: viewport.scrollTop,
      viewportHeight:
        viewport.viewportHeight || this.engine.getState().viewportHeight,
      widthScope:
        viewport.viewportWidth > 0
          ? `w:${Math.max(0, Math.round(viewport.viewportWidth))}`
          : this.engine.getState().widthScope,
      footerHeight: this.footerHeightOverride ?? this.getFooterHeight(),
      browserScrollHeight: viewport.scrollHeight,
    };
  }
}

function applyMeasurementsIndividually(
  engine: TranscriptVirtualEngine,
  inputs: readonly {
    token: TranscriptVirtualMeasurementToken;
    height: number;
  }[],
): TranscriptMeasurementBatchResult {
  const acceptedTokens: TranscriptVirtualMeasurementToken[] = [];
  let correction: TranscriptScrollCorrection | null = null;
  for (const input of inputs) {
    const result = engine.applyMeasuredHeight(input);
    if (result.accepted) {
      acceptedTokens.push(input.token);
    }
    correction = result.correction ?? correction;
  }
  return {
    acceptedTokens,
    rejected: inputs.length - acceptedTokens.length,
    correction,
  };
}

import {
  useCallback,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type RefObject,
} from "react";
import { flushSync } from "react-dom";
import {
  getMeasurementFinalizationDecision,
  parseVirtualReservedBlockSize,
  VIRTUAL_ROW_LAYOUT_PENDING_ATTRIBUTE,
  VIRTUAL_ROW_RESERVED_BLOCK_SIZE_ATTRIBUTE,
} from "../../measurement";
import type { TranscriptRowDescriptor } from "../../projection";
import {
  createTranscriptRowStateRegistry,
  type TranscriptKeepAliveDecision,
  type TranscriptMcpActivityKind,
  type TranscriptOpenOverlayKind,
  type TranscriptRowStateRegistry,
} from "../../row-state";
import {
  createTranscriptTanStackVirtualAdapter,
  type TranscriptScrollAlign,
  type TranscriptScrollAnchor,
  type TranscriptScrollCorrection,
  type TranscriptVirtualControllerState,
  type TranscriptVirtualDiagnostics,
  type TranscriptVirtualEngine,
  type TranscriptVirtualItem,
  type TranscriptVirtualMeasurementToken,
  type TranscriptVirtualRangeSnapshot,
  type TranscriptViewportGeometry,
} from "../";
import {
  createTranscriptMeasurementScheduler,
  type TranscriptMeasurementScheduler,
  type TranscriptMeasurementSchedulerDiagnostics,
} from "../measurement";

function hasNonCollapsedTranscriptSelection(container: HTMLElement): boolean {
  const selection = container.ownerDocument.getSelection();
  if (!selection || selection.rangeCount === 0 || selection.isCollapsed) {
    return false;
  }
  const { anchorNode, focusNode } = selection;
  return Boolean(
    (anchorNode && container.contains(anchorNode)) ||
      (focusNode && container.contains(focusNode)),
  );
}

// Row roots carry this attribute (set by useTranscriptRowStateBinding in
// transcriptRowStateContext.tsx), so a selection endpoint node can be mapped
// back to the row that owns it.
const VIRTUAL_ROW_STATE_ROW_ID_ATTRIBUTE = "data-virtual-row-state-row-id";

// Resolve the transcript row that owns a selection endpoint node. Returns null
// when the node is outside the transcript container or is not inside any row
// (e.g. padding/spacers), so the caller can leave such an endpoint unpinned.
function resolveSelectionEndpointRowId(
  node: Node | null,
  container: HTMLElement,
): string | null {
  if (!node || !container.contains(node)) {
    return null;
  }
  const element =
    node.nodeType === Node.ELEMENT_NODE
      ? (node as Element)
      : node.parentElement;
  const rowElement = element?.closest(
    `[${VIRTUAL_ROW_STATE_ROW_ID_ATTRIBUTE}]`,
  );
  return rowElement?.getAttribute(VIRTUAL_ROW_STATE_ROW_ID_ATTRIBUTE) ?? null;
}

export type TranscriptVirtualTimelineMode =
  | "bounded-controller"
  | "safe-degraded";

export type TranscriptVirtualTimelineFallbackReason =
  | "empty-controller-range"
  | "protected-row-fail-threshold"
  | "unsupported-row-kind";

export interface TranscriptVirtualTimelineMeasurementStats {
  visibleMeasurementAttempts: number;
  offscreenShellMeasurementAttempts: number;
  offscreenRealMeasurementAttempts: number;
  acceptedOffscreenShellMeasurements: number;
  acceptedOffscreenRealMeasurements: number;
  acceptedVisibleMeasurements: number;
  skippedPendingMeasurements: number;
  skippedZeroMeasurements: number;
  staleMeasurementsDropped: number;
  staleMeasurementSessionDrops: number;
  staleMeasurementEpochDrops: number;
  staleMeasurementWidthDrops: number;
  staleMeasurementRevisionDrops: number;
  staleMeasurementMissingRowDrops: number;
  reservedMeasurementsDeferred: number;
  pendingMeasurements: number;
  controllerUpdatesQueued: number;
  controllerUpdateBatches: number;
  controllerUpdateBatchMaxSize: number;
  controllerUpdatesFlushed: number;
  controllerUpdatesAccepted: number;
  controllerUpdatesRejected: number;
  cacheEntries: number;
  cacheHits: number;
  cacheMisses: number;
  cacheWrites: number;
  cacheEvictions: number;
}

export interface TranscriptVirtualTimelineSnapshot {
  engineKind: string;
  mode: TranscriptVirtualTimelineMode;
  range: TranscriptVirtualRangeSnapshot;
  controllerState: TranscriptVirtualControllerState;
  controllerDiagnostics: TranscriptVirtualDiagnostics;
  keepAliveDecision: TranscriptKeepAliveDecision | null;
  measurementStats: TranscriptVirtualTimelineMeasurementStats;
  fallbackReasons: readonly TranscriptVirtualTimelineFallbackReason[];
}

export interface TranscriptVirtualRowStateProviderConfig {
  registry: TranscriptRowStateRegistry;
  sessionId: string;
  sessionEpoch: number;
  onRowStateChange: () => void;
}

export interface TranscriptVirtualTimelineRowStateControls {
  setRowFocused: (
    rowId: string,
    focused: boolean,
    options?: {
      focusTargetId?: string;
      sourceId?: string;
      nowMs?: number;
    },
  ) => void;
  setRowOpenOverlay: (
    rowId: string,
    open: boolean,
    options: {
      overlayKind: TranscriptOpenOverlayKind;
      overlayId?: string;
      nowMs?: number;
    },
  ) => void;
  setRowMcpActivity: (
    rowId: string,
    active: boolean,
    options: {
      kind: TranscriptMcpActivityKind;
      sourceId?: string;
      ttlMs?: number;
      nowMs?: number;
    },
  ) => void;
  markRowInteracted: (
    rowId: string,
    options?: {
      sourceId?: string;
      ttlMs?: number;
      nowMs?: number;
    },
  ) => void;
  clearSessionRowState: () => void;
}

interface UseTranscriptVirtualTimelineInput {
  sessionId: string;
  sessionEpoch: number;
  rows: readonly TranscriptRowDescriptor[];
  protectedRowIds?: readonly string[];
  containerRef: RefObject<HTMLDivElement | null>;
  footerHeight: number;
  preserveScrollPosition?: boolean;
}

interface SyncViewportOptions {
  source?: "browser" | "programmatic" | "correction";
  userScrollIntent?: boolean;
  preserveScrollPosition?: boolean;
}

interface DeferredTranscriptCorrection {
  correction: TranscriptScrollCorrection;
  source: string;
}

interface QueueCachedMeasurementsOptions {
  preserveLiveViewport?: boolean;
}

const SUPPORTED_ROW_KINDS = new Set<TranscriptRowDescriptor["kind"]>([
  "assistant-content-fragment",
  "date-separator",
  "message",
  "tool-chain",
  "tool-chain-detail",
]);

const EMPTY_MEASUREMENT_STATS: TranscriptVirtualTimelineMeasurementStats = {
  visibleMeasurementAttempts: 0,
  offscreenShellMeasurementAttempts: 0,
  offscreenRealMeasurementAttempts: 0,
  acceptedOffscreenShellMeasurements: 0,
  acceptedOffscreenRealMeasurements: 0,
  acceptedVisibleMeasurements: 0,
  skippedPendingMeasurements: 0,
  skippedZeroMeasurements: 0,
  staleMeasurementsDropped: 0,
  staleMeasurementSessionDrops: 0,
  staleMeasurementEpochDrops: 0,
  staleMeasurementWidthDrops: 0,
  staleMeasurementRevisionDrops: 0,
  staleMeasurementMissingRowDrops: 0,
  reservedMeasurementsDeferred: 0,
  pendingMeasurements: 0,
  controllerUpdatesQueued: 0,
  controllerUpdateBatches: 0,
  controllerUpdateBatchMaxSize: 0,
  controllerUpdatesFlushed: 0,
  controllerUpdatesAccepted: 0,
  controllerUpdatesRejected: 0,
  cacheEntries: 0,
  cacheHits: 0,
  cacheMisses: 0,
  cacheWrites: 0,
  cacheEvictions: 0,
};

interface LocalMeasurementCounters {
  visibleMeasurementAttempts: number;
  offscreenShellMeasurementAttempts: number;
  offscreenRealMeasurementAttempts: number;
  skippedZeroMeasurements: number;
  reservedMeasurementsDeferred: number;
  controllerUpdateBatchMaxSize: number;
}

const EMPTY_LOCAL_MEASUREMENT_COUNTERS: LocalMeasurementCounters = {
  visibleMeasurementAttempts: 0,
  offscreenShellMeasurementAttempts: 0,
  offscreenRealMeasurementAttempts: 0,
  skippedZeroMeasurements: 0,
  reservedMeasurementsDeferred: 0,
  controllerUpdateBatchMaxSize: 0,
};

const DEFAULT_ASSUMED_VIEWPORT_HEIGHT_PX = 640;
const TANSTACK_UI_OVERSCAN_BEFORE_PX = 1600;
const TANSTACK_UI_OVERSCAN_AFTER_PX = 1200;
const MAX_CONTROLLER_MEASUREMENT_UPDATES_PER_BATCH = 24;
const TRANSCRIPT_MEASUREMENT_STABILITY_EPSILON_PX = 2;
const TRANSCRIPT_LAYOUT_SYNC_EPSILON_PX = 1;
const EMPTY_PROTECTED_ROW_IDS: readonly string[] = [];

export function useTranscriptVirtualTimeline({
  sessionId,
  sessionEpoch,
  rows,
  protectedRowIds = EMPTY_PROTECTED_ROW_IDS,
  containerRef,
  footerHeight,
  preserveScrollPosition = false,
}: UseTranscriptVirtualTimelineInput) {
  const normalizedProtectedRowIds = useMemo(
    () => normalizeProtectedRowIds(rows, protectedRowIds),
    [protectedRowIds, rows],
  );
  const rowsRef = useRef(rows);
  const normalizedProtectedRowIdsRef = useRef(normalizedProtectedRowIds);
  const controllerRef = useRef<TranscriptVirtualEngine | null>(null);
  const controllerScrollElementRef = useRef<HTMLDivElement | null>(null);
  const measurementSchedulerRef = useRef<TranscriptMeasurementScheduler | null>(
    null,
  );
  const protectedRowKeyRef = useRef("");
  const cachedMeasurementReplayRef = useRef<{
    rows: readonly TranscriptRowDescriptor[];
    widthScope: string;
    protectedRowKey: string;
  } | null>(null);
  const rowStateRegistryRef = useRef(createTranscriptRowStateRegistry());
  const localMeasurementCountersRef = useRef<LocalMeasurementCounters>({
    ...EMPTY_LOCAL_MEASUREMENT_COUNTERS,
  });
  const measuredHeightByTokenRef = useRef(new Map<string, number>());
  const offscreenMeasuredHeightByTokenRef = useRef(new Map<string, number>());
  const cachedHeightAppliedByTokenRef = useRef(new Map<string, number>());
  const skippedMeasurementByTokenRef = useRef(new Set<string>());
  const deferredMeasurementByTokenRef = useRef(new Set<string>());
  const measurementFlushScheduledRef = useRef(false);
  const visibleMeasurementFrameRef = useRef<number | null>(null);
  // While a rAF measurement flush is running, scroll corrections are recorded
  // here instead of being written to the DOM, then applied after the snapshot
  // commits so scrollTop and row layout change in the same paint.
  const deferDomCorrectionsRef = useRef(false);
  const deferredCorrectionRef = useRef<DeferredTranscriptCorrection | null>(
    null,
  );
  const pendingVisibleMeasurementElementsRef = useRef(
    new Map<string, HTMLElement>(),
  );
  const pendingOffscreenShellMeasurementElementsRef = useRef(
    new Map<string, HTMLElement>(),
  );
  const pendingOffscreenRealMeasurementElementsRef = useRef(
    new Map<string, HTMLElement>(),
  );
  // All currently mounted visible row elements, kept so a width change can
  // remeasure every visible row before the next paint instead of only the
  // rows whose ResizeObserver happened to fire first.
  const registeredVisibleRowElementsRef = useRef(
    new Map<string, HTMLElement>(),
  );

  // Selection-endpoint pinning. While a non-collapsed selection is active inside
  // the transcript, the rows that own its anchor/focus endpoints are forced into
  // the protected set so virtualization never unmounts them mid-drag — unmounting
  // an in-use endpoint is what corrupts the live Range (the browser collapses it
  // onto whatever DOM survives), making the highlight shrink and jump. The two
  // endpoints are tracked separately so a row that stays mounted keeps its pin
  // even across a frame where the other end momentarily fails to resolve, and
  // the combined list lets the selectionchange listener re-commit only when the
  // pinned set actually changes.
  const selectionAnchorRowIdRef = useRef<string | undefined>(undefined);
  const selectionFocusRowIdRef = useRef<string | undefined>(undefined);
  const selectionPinnedRowIdsRef = useRef<readonly string[]>(
    EMPTY_PROTECTED_ROW_IDS,
  );

  // Secondary selection guards. Pinning the endpoints (above) keeps the in-use
  // Range mounted, but scrollTop writes can still move the viewport under a live
  // drag, so while a drag-select gesture is in progress all three writers are
  // frozen:
  //   1. The measurement-flush path (see flushPendingMeasurements): committing
  //      still-settling row heights mid-drag changes content height above the
  //      viewport, the browser clamps scrollTop, and the engine fires a
  //      follow-up correction.
  //   2. The engine's own scrollTop writes (TanStack adapter): every viewport
  //      sync re-anchors by writing the scroll element, and a synchronous burst
  //      of those compounds and walks the viewport. Frozen via the engine's
  //      setScrollWritesSuspended.
  //   3. The hook's direct correction write (see applyCorrection): dropped while
  //      the gesture is active so it cannot move the viewport once the engine's
  //      own write is suspended.
  // dragSelectActive gates those writes for a real drag-select. It is keyed on
  // the drag *gesture*, NOT on the instantaneous non-collapsed selection state,
  // because native auto-scroll momentarily collapses the Range mid-drag (an
  // endpoint row unmounts and the browser recomputes it).
  // dragSelectActive latches on when a non-collapsed in-transcript selection
  // appears while the pointer is down and only clears on pointer release
  // (endDragSelect), so a transient collapse no longer lifts the freeze.
  //
  // selectionClearActive covers a plain click that clears an already-held
  // transcript selection while the pointer is down, before dragSelectActive can
  // latch. Freeze it only for the pointerdown->pointerup clear gesture; a held
  // selection after release still lets streaming measurements settle.
  //
  // selectionActive still tracks the non-collapsed selection — it drives endpoint
  // pinning, which must persist for any held Range, even after release.
  // measurementFlushDeferred records that a flush is owed; endDragSelect resumes
  // engine writes and reconciles once on release (through
  // runDeferredMeasurementFlush, a ref because the listener is declared above
  // scheduleMeasurementFlush, or a direct commit when no flush was deferred — a
  // still-held selection doesn't change the pinned set, so no pin-commit fires).
  const selectionActiveRef = useRef(false);
  const measurementFlushDeferredRef = useRef(false);
  const runDeferredMeasurementFlushRef = useRef<(() => void) | null>(null);
  // Drag-select gesture tracking. dragSelectPointerDown is true between a
  // pointerdown inside the transcript and the matching pointerup/pointercancel;
  // dragSelectActive latches on when a non-collapsed in-transcript selection is
  // observed during that window and gates the three writers above. Tying the
  // freeze to the gesture (not the live collapsed state) is what survives a
  // transient mid-drag collapse; see the block comment above.
  const dragSelectPointerDownRef = useRef(false);
  const dragSelectActiveRef = useRef(false);
  const selectionClearActiveRef = useRef(false);
  const isSelectionScrollFreezeActive = useCallback(
    () => dragSelectActiveRef.current || selectionClearActiveRef.current,
    [],
  );

  rowsRef.current = rows;
  normalizedProtectedRowIdsRef.current = normalizedProtectedRowIds;

  if (!controllerRef.current) {
    const container = containerRef.current;
    const controller = createController({
      sessionId,
      sessionEpoch,
      container,
      footerHeight,
      protectedRowIds: normalizedProtectedRowIds,
      scrollWritesSuspended: isSelectionScrollFreezeActive(),
    });
    controller.setRows(rows);
    controllerRef.current = controller;
    controllerScrollElementRef.current = container;
  }

  if (!measurementSchedulerRef.current) {
    const controllerState = (
      controllerRef.current as TranscriptVirtualEngine
    ).getState();
    measurementSchedulerRef.current = createTranscriptMeasurementScheduler({
      sessionId,
      sessionEpoch,
      widthScope: controllerState.widthScope,
      rows,
    });
  }

  const [snapshot, setSnapshot] = useState<TranscriptVirtualTimelineSnapshot>(
    () =>
      buildSnapshot({
        controller: controllerRef.current as TranscriptVirtualEngine,
        registry: rowStateRegistryRef.current,
        rows,
        sessionId,
        sessionEpoch,
      }),
  );
  const snapshotRef = useRef(snapshot);
  snapshotRef.current = snapshot;

  const applyCorrection = useCallback(
    (
      correction: TranscriptScrollCorrection | null | undefined,
      source = "unknown",
    ) => {
      if (!correction) {
        return;
      }

      // While a text-selection pointer gesture is in progress, the browser owns
      // the viewport: drag auto-scroll should extend the selection, and a click
      // that clears an existing selection should not be moved by row-anchor
      // reconciliation before pointerup. This pairs with suspending the engine's
      // own scrollTop writes; the reconcile happens once on pointer release.
      if (isSelectionScrollFreezeActive()) {
        return;
      }

      if (deferDomCorrectionsRef.current) {
        deferredCorrectionRef.current = { correction, source };
        return;
      }

      const container = containerRef.current;
      if (!container) {
        return;
      }

      container.scrollTop = correction.nextScrollTop;
      if (Math.abs(container.scrollTop - correction.nextScrollTop) <= 1) {
        return;
      }
      const syncResult = controllerRef.current?.syncViewport(
        readViewportGeometry(container, footerHeight),
        { source: "correction" },
      );
      if (syncResult?.correction) {
        container.scrollTop = syncResult.correction.nextScrollTop;
      }
    },
    [containerRef, footerHeight, isSelectionScrollFreezeActive],
  );

  const invalidateWidthScopedMeasurementReplay = useCallback(() => {
    // Controller heights are row-keyed while scheduler/cache entries are
    // width-scoped. Whenever the controller width changes, previously-applied
    // token records may no longer reflect the controller's current row height
    // (for visible or offscreen rows), so cached replay must be allowed to
    // restore the current width's measurement.
    cachedHeightAppliedByTokenRef.current.clear();
  }, []);

  const syncMeasurementScheduler = useCallback(
    (controller: TranscriptVirtualEngine) => {
      const scheduler = measurementSchedulerRef.current;
      if (!scheduler) {
        return null;
      }

      scheduler.setContext({
        sessionId,
        sessionEpoch,
        widthScope: controller.getState().widthScope,
        rows: rowsRef.current,
      });
      return scheduler;
    },
    [sessionEpoch, sessionId],
  );

  const syncControllerFromLiveViewport = useCallback(
    (controller: TranscriptVirtualEngine) => {
      const liveViewport = readViewportGeometry(
        containerRef.current,
        footerHeight,
      );
      const controllerState = controller.getState();

      if (!shouldSyncViewport(controllerState, liveViewport)) {
        return;
      }

      // This is an internal coherence sync (controller vs live DOM), not a
      // user scroll: real user scrolls always arrive through scroll events
      // and syncViewportFromDom before this runs. Treat drift here (clamped
      // corrections, in-flight layout changes) as programmatic so the
      // controller reconciles its existing anchor instead of exiting bottom
      // follow or recapturing a row anchor at a transient position.
      const previousWidthScope = controllerState.widthScope;
      const viewportResult = controller.syncViewport(liveViewport, {
        source: preserveScrollPosition ? "browser" : "programmatic",
        userScrollIntent: preserveScrollPosition,
        preserveScrollPosition,
      });
      if (controller.getState().widthScope !== previousWidthScope) {
        invalidateWidthScopedMeasurementReplay();
      }
      applyCorrection(
        viewportResult.correction,
        "sync-controller-from-live-viewport",
      );
    },
    [
      applyCorrection,
      containerRef,
      footerHeight,
      invalidateWidthScopedMeasurementReplay,
      preserveScrollPosition,
    ],
  );

  const flushMeasurementBatch = useCallback(
    (controller: TranscriptVirtualEngine) => {
      const scheduler = measurementSchedulerRef.current;
      if (!scheduler) {
        return null;
      }

      let aggregateResult: ReturnType<
        TranscriptMeasurementScheduler["flushControllerUpdateBatch"]
      > | null = null;

      while (true) {
        syncControllerFromLiveViewport(controller);
        const result = scheduler.flushControllerUpdateBatch(
          controller,
          MAX_CONTROLLER_MEASUREMENT_UPDATES_PER_BATCH,
        );
        if (
          result.updates.length >
          localMeasurementCountersRef.current.controllerUpdateBatchMaxSize
        ) {
          localMeasurementCountersRef.current = {
            ...localMeasurementCountersRef.current,
            controllerUpdateBatchMaxSize: result.updates.length,
          };
        }
        for (const correction of result.corrections) {
          applyCorrection(correction, "measurement-batch");
        }

        aggregateResult = aggregateResult
          ? {
              updates: [...aggregateResult.updates, ...result.updates],
              accepted: aggregateResult.accepted + result.accepted,
              rejected: aggregateResult.rejected + result.rejected,
              corrections: [
                ...aggregateResult.corrections,
                ...result.corrections,
              ],
            }
          : result;

        if (
          result.updates.length < MAX_CONTROLLER_MEASUREMENT_UPDATES_PER_BATCH
        ) {
          break;
        }
      }

      return aggregateResult;
    },
    [applyCorrection, syncControllerFromLiveViewport],
  );

  const queueCachedMeasurementsForController = useCallback(
    (
      controller: TranscriptVirtualEngine,
      options: QueueCachedMeasurementsOptions = {},
    ) => {
      const scheduler = syncMeasurementScheduler(controller);
      if (!scheduler) {
        return false;
      }

      const state = controller.getState();
      const previousReplay = cachedMeasurementReplayRef.current;
      if (
        previousReplay?.rows === rowsRef.current &&
        previousReplay.widthScope === state.widthScope &&
        previousReplay.protectedRowKey === protectedRowKeyRef.current
      ) {
        return false;
      }

      cachedMeasurementReplayRef.current = {
        rows: rowsRef.current,
        widthScope: state.widthScope,
        protectedRowKey: protectedRowKeyRef.current,
      };

      let queued = false;
      for (const row of rowsRef.current) {
        const cached = scheduler.peekCachedMeasurement(row.rowId);
        if (!cached) {
          continue;
        }

        const tokenKey = getMeasurementTokenKey(cached.token);
        if (
          cachedHeightAppliedByTokenRef.current.get(tokenKey) === cached.height
        ) {
          continue;
        }

        if (scheduler.queueCachedControllerUpdate(row.rowId)) {
          cachedHeightAppliedByTokenRef.current.set(tokenKey, cached.height);
          queued = true;
        }
      }

      if (queued) {
        if (options.preserveLiveViewport) {
          // Controller rebuilds start from estimates; cached replay is an
          // internal warm-up, so recapture the browser's live viewport instead
          // of replaying estimate-based row-anchor corrections into the DOM.
          const wasDeferringCorrections = deferDomCorrectionsRef.current;
          const previousDeferredCorrection = deferredCorrectionRef.current;

          deferDomCorrectionsRef.current = true;
          deferredCorrectionRef.current = null;
          controller.setScrollWritesSuspended?.(true);
          try {
            flushMeasurementBatch(controller);
          } finally {
            deferDomCorrectionsRef.current = wasDeferringCorrections;
            deferredCorrectionRef.current = previousDeferredCorrection;
            controller.setScrollWritesSuspended?.(
              isSelectionScrollFreezeActive(),
            );
          }

          const previousWidthScope = controller.getState().widthScope;
          const viewportResult = controller.syncViewport(
            readViewportGeometry(containerRef.current, footerHeight),
            {
              source: "browser",
              userScrollIntent: true,
              preserveScrollPosition: true,
            },
          );
          if (controller.getState().widthScope !== previousWidthScope) {
            invalidateWidthScopedMeasurementReplay();
          }
          applyCorrection(
            viewportResult.correction,
            "cached-measurement-replay-live-viewport",
          );
        } else {
          flushMeasurementBatch(controller);
        }
      }
      return queued;
    },
    [
      applyCorrection,
      containerRef,
      flushMeasurementBatch,
      footerHeight,
      invalidateWidthScopedMeasurementReplay,
      isSelectionScrollFreezeActive,
      syncMeasurementScheduler,
    ],
  );

  const commitSnapshot = useCallback(() => {
    const controller = controllerRef.current;
    if (!controller) {
      return null;
    }

    const registry = rowStateRegistryRef.current;
    registry.setSessionEpoch(sessionId, sessionEpoch);
    syncControllerFromLiveViewport(controller);
    syncMeasurementScheduler(controller);
    queueCachedMeasurementsForController(controller);

    let nextSnapshot = buildSnapshot({
      controller,
      registry,
      rows: rowsRef.current,
      sessionId,
      sessionEpoch,
      measurementStats: getMeasurementStats(
        measurementSchedulerRef.current?.getDiagnostics(),
        localMeasurementCountersRef.current,
      ),
    });

    const protectedRowIds = normalizeProtectedRowIds(rowsRef.current, [
      ...normalizedProtectedRowIdsRef.current,
      ...(nextSnapshot.keepAliveDecision?.protectedRowIds ?? []),
      ...selectionPinnedRowIdsRef.current,
    ]);
    const nextProtectedRowKey = protectedRowIds.join("\u0000");
    if (nextProtectedRowKey !== protectedRowKeyRef.current) {
      const state = controller.getState();
      const replacement = createController({
        sessionId,
        sessionEpoch,
        container: containerRef.current,
        footerHeight: state.footerHeight,
        protectedRowIds,
        state,
        scrollWritesSuspended: isSelectionScrollFreezeActive(),
      });
      controllerRef.current = replacement;
      controllerScrollElementRef.current = containerRef.current;
      const liveViewportBeforeRows = readViewportGeometry(
        containerRef.current,
        footerHeight,
      );
      const liveBottomScrollTop = Math.max(
        0,
        (liveViewportBeforeRows.browserScrollHeight ??
          state.virtualScrollHeight) - liveViewportBeforeRows.viewportHeight,
      );
      const liveDistanceFromBottom = Math.max(
        0,
        liveBottomScrollTop - liveViewportBeforeRows.scrollTop,
      );
      if (preserveScrollPosition) {
        replacement.syncViewport(liveViewportBeforeRows, {
          source: "browser",
          userScrollIntent: true,
          preserveScrollPosition,
        });
      }
      const rowsResult = replacement.setRows(rowsRef.current);
      if (
        preserveScrollPosition ||
        state.anchor.type === "row" ||
        !state.nearBottom ||
        liveDistanceFromBottom > 1
      ) {
        replacement.syncViewport(liveViewportBeforeRows, {
          source: "browser",
          userScrollIntent: true,
          preserveScrollPosition,
        });
      } else {
        applyCorrection(rowsResult.correction, "protected-rows-setRows");
      }
      protectedRowKeyRef.current = nextProtectedRowKey;
      cachedMeasurementReplayRef.current = null;
      cachedHeightAppliedByTokenRef.current.clear();
      syncMeasurementScheduler(replacement);
      queueCachedMeasurementsForController(replacement, {
        preserveLiveViewport: true,
      });
      nextSnapshot = buildSnapshot({
        controller: replacement,
        registry,
        rows: rowsRef.current,
        sessionId,
        sessionEpoch,
        measurementStats: getMeasurementStats(
          measurementSchedulerRef.current?.getDiagnostics(),
          localMeasurementCountersRef.current,
        ),
      });
    }

    if (!areTimelineSnapshotsEquivalent(snapshotRef.current, nextSnapshot)) {
      snapshotRef.current = nextSnapshot;
      setSnapshot(nextSnapshot);
    }
    return nextSnapshot.controllerState;
  }, [
    applyCorrection,
    containerRef,
    footerHeight,
    isSelectionScrollFreezeActive,
    queueCachedMeasurementsForController,
    sessionEpoch,
    sessionId,
    syncControllerFromLiveViewport,
    syncMeasurementScheduler,
    preserveScrollPosition,
  ]);

  const syncViewportFromDom = useCallback(
    (options: SyncViewportOptions = {}) => {
      const controller = controllerRef.current;
      if (!controller) {
        return null;
      }

      const liveViewport = readViewportGeometry(
        containerRef.current,
        footerHeight,
      );
      if (!shouldSyncViewport(controller.getState(), liveViewport)) {
        return controller.getState();
      }

      const previousWidthScope = controller.getState().widthScope;
      const result = controller.syncViewport(liveViewport, options);
      if (controller.getState().widthScope !== previousWidthScope) {
        invalidateWidthScopedMeasurementReplay();
      }
      applyCorrection(result.correction, "sync-viewport-from-dom");
      return commitSnapshot();
    },
    [
      applyCorrection,
      commitSnapshot,
      containerRef,
      footerHeight,
      invalidateWidthScopedMeasurementReplay,
    ],
  );

  useLayoutEffect(() => {
    const controller = controllerRef.current;
    const container = containerRef.current;
    const shouldBindRealContainer =
      container != null && controllerScrollElementRef.current !== container;
    const controllerState = controller?.getState();
    const shouldResetSessionState =
      !controller || controllerState?.sessionId !== sessionId;
    if (shouldResetSessionState || shouldBindRealContainer) {
      const previousState =
        controllerState?.sessionId === sessionId ? controllerState : undefined;
      controllerRef.current = createController({
        sessionId,
        sessionEpoch,
        container,
        footerHeight,
        protectedRowIds: normalizedProtectedRowIds,
        state: previousState,
        scrollWritesSuspended: isSelectionScrollFreezeActive(),
      });
      controllerScrollElementRef.current = container;
      measurementSchedulerRef.current = createTranscriptMeasurementScheduler({
        sessionId,
        sessionEpoch,
        widthScope:
          controllerRef.current?.getState().widthScope ?? getWidthScope(null),
        rows,
      });
      if (shouldResetSessionState) {
        protectedRowKeyRef.current = "";
        localMeasurementCountersRef.current = {
          ...EMPTY_LOCAL_MEASUREMENT_COUNTERS,
        };
        cachedMeasurementReplayRef.current = null;
        measuredHeightByTokenRef.current.clear();
        offscreenMeasuredHeightByTokenRef.current.clear();
        cachedHeightAppliedByTokenRef.current.clear();
        skippedMeasurementByTokenRef.current.clear();
        deferredMeasurementByTokenRef.current.clear();
        measurementFlushScheduledRef.current = false;
        pendingVisibleMeasurementElementsRef.current.clear();
        pendingOffscreenShellMeasurementElementsRef.current.clear();
        pendingOffscreenRealMeasurementElementsRef.current.clear();
        selectionAnchorRowIdRef.current = undefined;
        selectionFocusRowIdRef.current = undefined;
        selectionPinnedRowIdsRef.current = EMPTY_PROTECTED_ROW_IDS;
        selectionActiveRef.current = false;
        dragSelectPointerDownRef.current = false;
        dragSelectActiveRef.current = false;
        selectionClearActiveRef.current = false;
        measurementFlushDeferredRef.current = false;
        if (visibleMeasurementFrameRef.current !== null) {
          cancelAnimationFrame(visibleMeasurementFrameRef.current);
          visibleMeasurementFrameRef.current = null;
        }
      } else {
        cachedMeasurementReplayRef.current = null;
        cachedHeightAppliedByTokenRef.current.clear();
      }
    }

    const currentController = controllerRef.current;
    if (!currentController) {
      return;
    }

    rowStateRegistryRef.current.setSessionEpoch(sessionId, sessionEpoch);
    syncMeasurementScheduler(currentController);
    applyCorrection(
      currentController.syncViewport(
        readViewportGeometry(containerRef.current, footerHeight),
        {
          source: preserveScrollPosition ? "browser" : "programmatic",
          userScrollIntent: preserveScrollPosition,
          preserveScrollPosition,
        },
      ).correction,
      "layout-sync-viewport",
    );
    applyCorrection(
      currentController.setRows(rows).correction,
      "layout-setRows",
    );
    syncMeasurementScheduler(currentController);
    commitSnapshot();
  }, [
    applyCorrection,
    commitSnapshot,
    containerRef,
    footerHeight,
    isSelectionScrollFreezeActive,
    normalizedProtectedRowIds,
    preserveScrollPosition,
    rows,
    sessionEpoch,
    sessionId,
    syncMeasurementScheduler,
  ]);

  useLayoutEffect(
    () => () => {
      rowStateRegistryRef.current.cleanupSession(sessionId);
      measurementSchedulerRef.current?.cleanupSession(sessionId);
    },
    [sessionId],
  );

  // Selection-endpoint pinning (the fix for the drag-select jump). A multi-row
  // drag-select keeps its anchor in one row and its focus in another; when the
  // viewport moves under the drag — native auto-scroll, or scroll-height churn
  // from still-settling measurements — an endpoint row that leaves the render
  // window unmounts and the browser collapses the live Range onto whatever DOM
  // survives, so the highlight visibly shrinks and jumps. Resolve the rows that
  // own the live selection's endpoints and force them into the protected set
  // (merged in commitSnapshot) so virtualization keeps them mounted; native
  // auto-scroll then just extends the selection as the browser intends. The
  // endpoints are captured while still mounted and retained per-endpoint, so a
  // pinned row stays protected for the life of the selection even after it would
  // otherwise scroll out of the window. Bound on the document (the only target
  // that fires selectionchange); the listener reads the live container and refs
  // each event, so a single binding survives container rebinds.
  useLayoutEffect(() => {
    if (typeof document === "undefined") {
      return;
    }

    const onSelectionChange = () => {
      const container = containerRef.current;
      if (!container) {
        return;
      }

      const selection = container.ownerDocument.getSelection();
      let nextAnchor: string | undefined;
      let nextFocus: string | undefined;
      let active = false;
      if (selection && selection.rangeCount > 0 && !selection.isCollapsed) {
        const anchorInside = Boolean(
          selection.anchorNode && container.contains(selection.anchorNode),
        );
        const focusInside = Boolean(
          selection.focusNode && container.contains(selection.focusNode),
        );
        // A non-collapsed selection with at least one endpoint inside the
        // transcript is what both guards key off: its endpoints get pinned, and
        // the measurement-flush path defers until the selection clears.
        active = anchorInside || focusInside;
        // Retain the prior endpoint when it can't be resolved this frame
        // (transient gap, or a node briefly inside the container but outside any
        // row): a pinned row stays mounted, so the next event re-resolves it.
        if (anchorInside) {
          nextAnchor =
            resolveSelectionEndpointRowId(selection.anchorNode, container) ??
            selectionAnchorRowIdRef.current;
        }
        if (focusInside) {
          nextFocus =
            resolveSelectionEndpointRowId(selection.focusNode, container) ??
            selectionFocusRowIdRef.current;
        }
      }

      selectionAnchorRowIdRef.current = nextAnchor;
      selectionFocusRowIdRef.current = nextFocus;

      const wasActive = selectionActiveRef.current;
      selectionActiveRef.current = active;

      // Latch the drag-select gesture: once a non-collapsed in-transcript
      // selection appears while the pointer is down, the gesture is active and
      // stays active until pointer release (endDragSelect), even across a
      // transient mid-drag collapse. Never cleared here.
      if (active && dragSelectPointerDownRef.current) {
        dragSelectActiveRef.current = true;
      }
      if (wasActive && !active && dragSelectPointerDownRef.current) {
        selectionClearActiveRef.current = true;
      }

      // Suspend the engine's own scrollTop writes for the life of the gesture.
      // This is the load-bearing guard: the TanStack adapter writes scrollTop
      // directly inside syncViewport, so the hook's applyCorrection write only
      // ever echoes a position the adapter already reached. Freezing the
      // adapter's writes stops the re-anchor burst from walking the viewport out
      // from under the live drag.
      // Keyed on the latched gesture (not `active`) so a transient mid-drag
      // collapse keeps writes suspended instead of resuming them and yanking the
      // viewport; resumed once in endDragSelect on release. Idempotent across the
      // repeated selectionchange events a drag fires.
      controllerRef.current?.setScrollWritesSuspended?.(
        isSelectionScrollFreezeActive(),
      );
      // Fallback reconcile: if an in-transcript selection clears while NO drag
      // gesture is active (a keyboard/programmatic selection, or a pointer
      // release we somehow missed), run any owed measurement flush now so the
      // settled heights commit in one pass and re-anchor against the final
      // position. During an active drag this is intentionally skipped — the flush
      // stays deferred until pointer release (endDragSelect), so a transient
      // mid-drag collapse can't reconcile and jump the viewport.
      if (
        wasActive &&
        !active &&
        !isSelectionScrollFreezeActive() &&
        measurementFlushDeferredRef.current
      ) {
        measurementFlushDeferredRef.current = false;
        measurementFlushScheduledRef.current = false;
        runDeferredMeasurementFlushRef.current?.();
      }

      const nextPinned =
        nextAnchor === undefined && nextFocus === undefined
          ? EMPTY_PROTECTED_ROW_IDS
          : Array.from(
              new Set(
                [nextAnchor, nextFocus].filter(
                  (rowId): rowId is string => rowId !== undefined,
                ),
              ),
            );
      const pinnedChanged = !areStringArraysEqual(
        nextPinned,
        selectionPinnedRowIdsRef.current,
      );

      if (pinnedChanged) {
        selectionPinnedRowIdsRef.current = nextPinned;
        commitSnapshot();
      }
    };

    // Drag-select gesture boundary. A drag-select always begins with a
    // pointerdown inside the transcript; gating on the container avoids arming
    // the freeze for unrelated page drags.
    const onPointerDown = (event: Event) => {
      const container = containerRef.current;
      const target = event.target;
      if (container && target instanceof Node && container.contains(target)) {
        dragSelectPointerDownRef.current = true;
        if (hasNonCollapsedTranscriptSelection(container)) {
          selectionClearActiveRef.current = true;
          controllerRef.current?.setScrollWritesSuspended?.(true);
        }
      }
    };

    // Pointer release or a window-level cancel ends the gesture (pointer release
    // is bound on the document, not the container — auto-scroll can carry the
    // release outside). Resume the engine's scroll writes and reconcile once
    // against the final viewport: the single correction after the freeze. If a
    // measurement flush was deferred during the drag, re-running it commits the
    // settled heights and its viewport sync re-anchors; otherwise commit a
    // snapshot directly, since a still-held selection doesn't change the pinned
    // set (no pin-commit fires here).
    const endDragSelect = () => {
      const wasScrollFreezeActive = isSelectionScrollFreezeActive();
      dragSelectPointerDownRef.current = false;
      if (!wasScrollFreezeActive) {
        return;
      }
      dragSelectActiveRef.current = false;
      selectionClearActiveRef.current = false;
      controllerRef.current?.setScrollWritesSuspended?.(false);
      if (measurementFlushDeferredRef.current) {
        measurementFlushDeferredRef.current = false;
        measurementFlushScheduledRef.current = false;
        runDeferredMeasurementFlushRef.current?.();
      } else {
        commitSnapshot();
      }
    };

    const doc = containerRef.current?.ownerDocument ?? document;
    const win = doc.defaultView;
    doc.addEventListener("selectionchange", onSelectionChange);
    doc.addEventListener("pointerdown", onPointerDown);
    doc.addEventListener("pointerup", endDragSelect);
    doc.addEventListener("pointercancel", endDragSelect);
    win?.addEventListener("blur", endDragSelect);
    return () => {
      doc.removeEventListener("selectionchange", onSelectionChange);
      doc.removeEventListener("pointerdown", onPointerDown);
      doc.removeEventListener("pointerup", endDragSelect);
      doc.removeEventListener("pointercancel", endDragSelect);
      win?.removeEventListener("blur", endDragSelect);
    };
  }, [commitSnapshot, containerRef, isSelectionScrollFreezeActive]);

  const flushPendingMeasurementsInner = useCallback(() => {
    measurementFlushScheduledRef.current = false;
    visibleMeasurementFrameRef.current = null;

    const controller = controllerRef.current;
    if (!controller) {
      pendingVisibleMeasurementElementsRef.current.clear();
      pendingOffscreenShellMeasurementElementsRef.current.clear();
      pendingOffscreenRealMeasurementElementsRef.current.clear();
      return;
    }

    const scheduler = syncMeasurementScheduler(controller);
    if (!scheduler) {
      pendingVisibleMeasurementElementsRef.current.clear();
      pendingOffscreenShellMeasurementElementsRef.current.clear();
      pendingOffscreenRealMeasurementElementsRef.current.clear();
      return;
    }

    const visibleEntries = Array.from(
      pendingVisibleMeasurementElementsRef.current,
    );
    const offscreenEntries = Array.from(
      pendingOffscreenShellMeasurementElementsRef.current,
    );
    const offscreenRealEntries = Array.from(
      pendingOffscreenRealMeasurementElementsRef.current,
    );
    pendingVisibleMeasurementElementsRef.current.clear();
    pendingOffscreenShellMeasurementElementsRef.current.clear();
    pendingOffscreenRealMeasurementElementsRef.current.clear();

    let queuedSinceFlush = 0;
    let shouldCommitSnapshot = false;
    const flushQueuedUpdates = () => {
      if (queuedSinceFlush === 0) {
        return;
      }
      flushMeasurementBatch(controller);
      queuedSinceFlush = 0;
      shouldCommitSnapshot = true;
    };
    const markControllerUpdateQueued = () => {
      queuedSinceFlush += 1;
      if (queuedSinceFlush >= MAX_CONTROLLER_MEASUREMENT_UPDATES_PER_BATCH) {
        flushQueuedUpdates();
      }
    };

    for (const [rowId, element] of visibleEntries) {
      if (!element.isConnected) {
        continue;
      }

      const plan = scheduler.planMountedMeasurement(rowId);
      if (plan.kind !== "mounted") {
        continue;
      }

      const tokenKey = getMeasurementTokenKey(plan.token);
      const measuredBlockSize = Math.ceil(
        element.getBoundingClientRect().height,
      );

      if (measuredBlockSize <= 0) {
        if (!skippedMeasurementByTokenRef.current.has(`${tokenKey}:zero`)) {
          skippedMeasurementByTokenRef.current.add(`${tokenKey}:zero`);
          localMeasurementCountersRef.current = {
            ...localMeasurementCountersRef.current,
            skippedZeroMeasurements:
              localMeasurementCountersRef.current.skippedZeroMeasurements + 1,
          };
          shouldCommitSnapshot = true;
        }
        continue;
      }

      const reservedBlockSize = getReservedBlockSizeForRow(element);
      const finalization = getMeasurementFinalizationDecision({
        measuredBlockSize,
        root: element,
        reservedBlockSize,
      });
      const shouldAcceptPendingAnimationMeasurement =
        shouldAcceptVisibleAnimationMeasurement(element, finalization);
      const previousHeight = measuredHeightByTokenRef.current.get(tokenKey);
      if (
        (finalization.canFinalize || shouldAcceptPendingAnimationMeasurement) &&
        previousHeight !== undefined &&
        Math.abs(previousHeight - finalization.blockSize) <=
          TRANSCRIPT_MEASUREMENT_STABILITY_EPSILON_PX
      ) {
        continue;
      }

      localMeasurementCountersRef.current = {
        ...localMeasurementCountersRef.current,
        visibleMeasurementAttempts:
          localMeasurementCountersRef.current.visibleMeasurementAttempts + 1,
      };

      const result = scheduler.finalizePendingMeasurement(
        shouldAcceptPendingAnimationMeasurement
          ? {
              token: plan.token,
              measuredBlockSize,
            }
          : {
              token: plan.token,
              measuredBlockSize,
              root: element,
              reservedBlockSize,
            },
      );

      if (
        !finalization.canFinalize &&
        !shouldAcceptPendingAnimationMeasurement
      ) {
        const skippedKey = `${tokenKey}:${finalization.source}`;
        if (!deferredMeasurementByTokenRef.current.has(skippedKey)) {
          deferredMeasurementByTokenRef.current.add(skippedKey);
          localMeasurementCountersRef.current = {
            ...localMeasurementCountersRef.current,
            reservedMeasurementsDeferred:
              localMeasurementCountersRef.current.reservedMeasurementsDeferred +
              (finalization.source === "reserved" ? 1 : 0),
          };
          shouldCommitSnapshot = true;
        }
        continue;
      }

      if (result.status === "accepted") {
        measuredHeightByTokenRef.current.set(tokenKey, result.entry.height);
        cachedHeightAppliedByTokenRef.current.set(
          tokenKey,
          result.entry.height,
        );
        markControllerUpdateQueued();
      }
    }

    for (const [rowId, element] of offscreenEntries) {
      if (!element.isConnected) {
        continue;
      }

      const plan = scheduler.planOffscreenMeasurement(rowId);
      if (plan.kind !== "offscreen-shell") {
        continue;
      }

      const measuredBlockSize = Math.ceil(
        element.getBoundingClientRect().height,
      );
      if (measuredBlockSize <= 0) {
        continue;
      }

      const tokenKey = getMeasurementTokenKey(plan.token);
      if (
        isStableMeasurementHeight(
          offscreenMeasuredHeightByTokenRef.current.get(tokenKey),
          measuredBlockSize,
        )
      ) {
        continue;
      }

      offscreenMeasuredHeightByTokenRef.current.set(
        tokenKey,
        measuredBlockSize,
      );
      localMeasurementCountersRef.current = {
        ...localMeasurementCountersRef.current,
        offscreenShellMeasurementAttempts:
          localMeasurementCountersRef.current
            .offscreenShellMeasurementAttempts + 1,
      };

      const result = scheduler.recordOffscreenMeasurement({
        token: plan.token,
        height: measuredBlockSize,
        source: "offscreen-shell",
      });
      if (result.status === "accepted") {
        cachedHeightAppliedByTokenRef.current.set(
          tokenKey,
          result.entry.height,
        );
        markControllerUpdateQueued();
      }
    }

    for (const [rowId, element] of offscreenRealEntries) {
      if (!element.isConnected) {
        continue;
      }

      const plan = scheduler.planOffscreenMeasurement(rowId);
      if (plan.kind !== "offscreen-real") {
        continue;
      }

      const measuredBlockSize = Math.ceil(
        element.getBoundingClientRect().height,
      );
      if (measuredBlockSize <= 0) {
        continue;
      }

      const tokenKey = getMeasurementTokenKey(plan.token);
      if (
        isStableMeasurementHeight(
          offscreenMeasuredHeightByTokenRef.current.get(tokenKey),
          measuredBlockSize,
        )
      ) {
        continue;
      }

      offscreenMeasuredHeightByTokenRef.current.set(
        tokenKey,
        measuredBlockSize,
      );
      localMeasurementCountersRef.current = {
        ...localMeasurementCountersRef.current,
        offscreenRealMeasurementAttempts:
          localMeasurementCountersRef.current.offscreenRealMeasurementAttempts +
          1,
      };

      const result = scheduler.recordOffscreenMeasurement({
        token: plan.token,
        height: measuredBlockSize,
        source: "offscreen-real",
      });
      if (result.status === "accepted") {
        cachedHeightAppliedByTokenRef.current.set(
          tokenKey,
          result.entry.height,
        );
        markControllerUpdateQueued();
      }
    }

    flushQueuedUpdates();
    if (shouldCommitSnapshot) {
      commitSnapshot();
    }
  }, [commitSnapshot, flushMeasurementBatch, syncMeasurementScheduler]);

  const flushPendingMeasurements = useCallback(() => {
    const takeDeferredCorrection = (): DeferredTranscriptCorrection | null => {
      const deferredCorrection = deferredCorrectionRef.current;
      deferredCorrectionRef.current = null;
      return deferredCorrection;
    };
    // While a text-selection pointer gesture is frozen, defer the measurement
    // commit so settling row heights cannot move the viewport under the gesture.
    // The pending elements stay queued, and the flush re-runs on pointer release.
    if (isSelectionScrollFreezeActive()) {
      measurementFlushDeferredRef.current = true;
      measurementFlushScheduledRef.current = true;
      return;
    }

    // Measurement-driven scroll corrections must hit the DOM in the same
    // paint as the re-rendered row positions. Defer the scrollTop writes
    // while the controller updates run, commit the snapshot synchronously,
    // then apply the final correction against the new layout.
    deferDomCorrectionsRef.current = true;
    deferredCorrectionRef.current = null;
    try {
      flushSync(() => {
        flushPendingMeasurementsInner();
      });
    } finally {
      deferDomCorrectionsRef.current = false;
    }

    const deferredCorrection = takeDeferredCorrection();
    if (deferredCorrection) {
      applyCorrection(
        deferredCorrection.correction,
        `${deferredCorrection.source}:deferred`,
      );
    }
  }, [
    applyCorrection,
    flushPendingMeasurementsInner,
    isSelectionScrollFreezeActive,
  ]);

  const scheduleMeasurementFlush = useCallback(() => {
    if (measurementFlushScheduledRef.current) {
      return;
    }

    measurementFlushScheduledRef.current = true;
    visibleMeasurementFrameRef.current = requestAnimationFrame(
      flushPendingMeasurements,
    );
  }, [flushPendingMeasurements]);

  // Expose scheduleMeasurementFlush to the selectionchange listener (declared
  // above it) so a flush deferred during a selection can be re-armed once the
  // selection clears. Assigned during render like rowsRef above; idempotent.
  runDeferredMeasurementFlushRef.current = scheduleMeasurementFlush;

  const measureRowElement = useCallback(
    (rowId: string, element: HTMLElement | null) => {
      if (!element) {
        pendingVisibleMeasurementElementsRef.current.delete(rowId);
        registeredVisibleRowElementsRef.current.delete(rowId);
        return;
      }

      registeredVisibleRowElementsRef.current.set(rowId, element);
      pendingVisibleMeasurementElementsRef.current.set(rowId, element);
      scheduleMeasurementFlush();
    },
    [scheduleMeasurementFlush],
  );

  // Synchronously remeasures every mounted visible row and applies the
  // resulting controller corrections and snapshot before the next paint.
  // Used when the transcript width changes: waiting for per-row
  // ResizeObserver callbacks lets partially remeasured layouts paint, which
  // reads as content jumping during rail/window resizes.
  const remeasureVisibleRowsSync = useCallback(() => {
    for (const [rowId, element] of registeredVisibleRowElementsRef.current) {
      if (!element.isConnected) {
        registeredVisibleRowElementsRef.current.delete(rowId);
        continue;
      }
      const token = measurementSchedulerRef.current?.getMeasurementToken(rowId);
      if (token) {
        // Force the current-width visible measurement through even if this
        // exact token height was observed before. Controller measurements are
        // row-keyed, so an intervening width can overwrite the current row
        // height; on A → B → A resize, token A must be allowed to restore its
        // height even when the DOM height equals the previous A measurement.
        measuredHeightByTokenRef.current.delete(getMeasurementTokenKey(token));
      }
      pendingVisibleMeasurementElementsRef.current.set(rowId, element);
    }

    if (pendingVisibleMeasurementElementsRef.current.size === 0) {
      return;
    }

    if (visibleMeasurementFrameRef.current !== null) {
      cancelAnimationFrame(visibleMeasurementFrameRef.current);
      visibleMeasurementFrameRef.current = null;
    }
    measurementFlushScheduledRef.current = false;
    flushPendingMeasurements();
  }, [flushPendingMeasurements]);

  const measureOffscreenShellElement = useCallback(
    (rowId: string, element: HTMLElement | null) => {
      if (!element) {
        pendingOffscreenShellMeasurementElementsRef.current.delete(rowId);
        return;
      }

      pendingOffscreenShellMeasurementElementsRef.current.set(rowId, element);
      scheduleMeasurementFlush();
    },
    [scheduleMeasurementFlush],
  );

  const measureOffscreenRealElement = useCallback(
    (rowId: string, element: HTMLElement | null) => {
      if (!element) {
        pendingOffscreenRealMeasurementElementsRef.current.delete(rowId);
        return;
      }

      pendingOffscreenRealMeasurementElementsRef.current.set(rowId, element);
      scheduleMeasurementFlush();
    },
    [scheduleMeasurementFlush],
  );

  const scrollToRow = useCallback(
    (rowId: string, align: TranscriptScrollAlign = "auto") => {
      const controller = controllerRef.current;
      if (!controller) {
        return false;
      }

      const result = controller.scrollToRow(rowId, align);
      applyCorrection(result.correction, "scroll-to-row");
      commitSnapshot();
      return result.found;
    },
    [applyCorrection, commitSnapshot],
  );

  const scrollToBottom = useCallback(
    (behavior: ScrollBehavior = "smooth") => {
      const controller = controllerRef.current;
      const container = containerRef.current;
      if (!controller || !container) {
        return false;
      }

      const liveViewport = readViewportGeometry(container, footerHeight);
      const controllerState = controller.getState();
      const liveBottomScrollTop = getLiveBottomScrollTop(
        controllerState,
        liveViewport,
      );
      const nextScrollTop = Math.max(
        controllerState.bottomScrollTop,
        liveBottomScrollTop,
      );
      const nextViewport = {
        ...liveViewport,
        scrollTop: nextScrollTop,
      };
      if (
        Math.abs(liveViewport.scrollTop - nextScrollTop) <=
          TRANSCRIPT_LAYOUT_SYNC_EPSILON_PX &&
        Math.abs(controllerState.scrollTop - nextScrollTop) <=
          TRANSCRIPT_LAYOUT_SYNC_EPSILON_PX &&
        !shouldSyncViewport(controllerState, nextViewport)
      ) {
        return true;
      }

      if (controller.scrollToEnd) {
        controller.scrollToEnd({ behavior });
      }

      if (behavior === "auto") {
        container.scrollTop = nextScrollTop;
      } else if (typeof container.scrollTo === "function") {
        container.scrollTo({ top: nextScrollTop, behavior });
      } else {
        container.scrollTop = nextScrollTop;
      }
      const result = controller.syncViewport(
        {
          ...readViewportGeometry(container, footerHeight),
          scrollTop: nextScrollTop,
        },
        { source: "browser" },
      );
      applyCorrection(result.correction, "scroll-to-bottom-sync");
      commitSnapshot();
      return true;
    },
    [applyCorrection, commitSnapshot, containerRef, footerHeight],
  );

  const setRowFocused = useCallback<
    TranscriptVirtualTimelineRowStateControls["setRowFocused"]
  >(
    (rowId, focused, options = {}) => {
      rowStateRegistryRef.current.setFocusedRow({
        sessionId,
        sessionEpoch,
        rowId,
        focused,
        focusTargetId: options.focusTargetId,
        sourceId: options.sourceId,
        nowMs: options.nowMs,
      });
      commitSnapshot();
    },
    [commitSnapshot, sessionEpoch, sessionId],
  );

  const setRowOpenOverlay = useCallback<
    TranscriptVirtualTimelineRowStateControls["setRowOpenOverlay"]
  >(
    (rowId, open, options) => {
      rowStateRegistryRef.current.setOpenOverlay({
        sessionId,
        sessionEpoch,
        rowId,
        open,
        overlayKind: options.overlayKind,
        overlayId: options.overlayId,
        nowMs: options.nowMs,
      });
      commitSnapshot();
    },
    [commitSnapshot, sessionEpoch, sessionId],
  );

  const setRowMcpActivity = useCallback<
    TranscriptVirtualTimelineRowStateControls["setRowMcpActivity"]
  >(
    (rowId, active, options) => {
      rowStateRegistryRef.current.setMcpActivity({
        sessionId,
        sessionEpoch,
        rowId,
        active,
        kind: options.kind,
        sourceId: options.sourceId,
        ttlMs: options.ttlMs,
        nowMs: options.nowMs,
      });
      commitSnapshot();
    },
    [commitSnapshot, sessionEpoch, sessionId],
  );

  const markRowInteracted = useCallback<
    TranscriptVirtualTimelineRowStateControls["markRowInteracted"]
  >(
    (rowId, options = {}) => {
      rowStateRegistryRef.current.markRowInteracted({
        sessionId,
        sessionEpoch,
        rowId,
        sourceId: options.sourceId,
        ttlMs: options.ttlMs,
        nowMs: options.nowMs,
      });
      commitSnapshot();
    },
    [commitSnapshot, sessionEpoch, sessionId],
  );

  const clearSessionRowState = useCallback(() => {
    rowStateRegistryRef.current.cleanupSession(sessionId);
    commitSnapshot();
  }, [commitSnapshot, sessionId]);

  const rowStateControls = useMemo(
    () =>
      ({
        setRowFocused,
        setRowOpenOverlay,
        setRowMcpActivity,
        markRowInteracted,
        clearSessionRowState,
      }) satisfies TranscriptVirtualTimelineRowStateControls,
    [
      clearSessionRowState,
      markRowInteracted,
      setRowFocused,
      setRowMcpActivity,
      setRowOpenOverlay,
    ],
  );

  const rowStateProvider = useMemo(
    () =>
      ({
        registry: rowStateRegistryRef.current,
        sessionId,
        sessionEpoch,
        onRowStateChange: commitSnapshot,
      }) satisfies TranscriptVirtualRowStateProviderConfig,
    [commitSnapshot, sessionEpoch, sessionId],
  );

  return {
    snapshot,
    rowStateProvider,
    rowStateControls,
    measureRowElement,
    measureOffscreenShellElement,
    measureOffscreenRealElement,
    remeasureVisibleRowsSync,
    syncViewportFromDom,
    scrollToRow,
    scrollToBottom,
    setRowFocused,
    markRowInteracted,
  };
}

function getReservedBlockSizeForRow(element: HTMLElement): number | null {
  const rootReservedBlockSize = parseVirtualReservedBlockSize(
    element.getAttribute(VIRTUAL_ROW_RESERVED_BLOCK_SIZE_ATTRIBUTE),
  );
  if (rootReservedBlockSize !== null) {
    return rootReservedBlockSize;
  }

  let reservedBlockSize = 0;
  for (const descendant of element.querySelectorAll(
    `[${VIRTUAL_ROW_RESERVED_BLOCK_SIZE_ATTRIBUTE}]`,
  )) {
    reservedBlockSize +=
      parseVirtualReservedBlockSize(
        descendant.getAttribute(VIRTUAL_ROW_RESERVED_BLOCK_SIZE_ATTRIBUTE),
      ) ?? 0;
  }

  return reservedBlockSize > 0 ? reservedBlockSize : null;
}

const VISIBLE_ANIMATION_PENDING_REASONS = new Set([
  "reasoning-animation",
  "streamdown-async",
  "tool-animation",
]);

function shouldAcceptVisibleAnimationMeasurement(
  element: HTMLElement,
  finalization: ReturnType<typeof getMeasurementFinalizationDecision>,
): boolean {
  if (finalization.canFinalize || finalization.source !== "measured") {
    return false;
  }

  const pendingMarkers = [
    ...(element.hasAttribute(VIRTUAL_ROW_LAYOUT_PENDING_ATTRIBUTE)
      ? [element]
      : []),
    ...Array.from(
      element.querySelectorAll(`[${VIRTUAL_ROW_LAYOUT_PENDING_ATTRIBUTE}]`),
    ),
  ];

  return (
    pendingMarkers.length > 0 &&
    pendingMarkers.every((marker) =>
      VISIBLE_ANIMATION_PENDING_REASONS.has(
        marker.getAttribute(VIRTUAL_ROW_LAYOUT_PENDING_ATTRIBUTE) ?? "",
      ),
    )
  );
}

function getMeasurementStats(
  diagnostics: TranscriptMeasurementSchedulerDiagnostics | undefined,
  localCounters: LocalMeasurementCounters,
): TranscriptVirtualTimelineMeasurementStats {
  if (!diagnostics) {
    return { ...EMPTY_MEASUREMENT_STATS };
  }

  return {
    visibleMeasurementAttempts: localCounters.visibleMeasurementAttempts,
    offscreenShellMeasurementAttempts:
      localCounters.offscreenShellMeasurementAttempts,
    offscreenRealMeasurementAttempts:
      localCounters.offscreenRealMeasurementAttempts,
    acceptedOffscreenShellMeasurements:
      diagnostics.offscreenShellMeasurementsAccepted,
    acceptedOffscreenRealMeasurements:
      diagnostics.offscreenRealMeasurementsAccepted,
    acceptedVisibleMeasurements: diagnostics.mountedMeasurementsAccepted,
    skippedPendingMeasurements: diagnostics.pendingMeasurementsCreated,
    skippedZeroMeasurements: localCounters.skippedZeroMeasurements,
    staleMeasurementsDropped: diagnostics.staleMeasurementsDropped,
    staleMeasurementSessionDrops: diagnostics.staleMeasurementSessionDrops,
    staleMeasurementEpochDrops: diagnostics.staleMeasurementEpochDrops,
    staleMeasurementWidthDrops: diagnostics.staleMeasurementWidthDrops,
    staleMeasurementRevisionDrops: diagnostics.staleMeasurementRevisionDrops,
    staleMeasurementMissingRowDrops:
      diagnostics.staleMeasurementMissingRowDrops,
    reservedMeasurementsDeferred: localCounters.reservedMeasurementsDeferred,
    pendingMeasurements: diagnostics.pendingMeasurements,
    controllerUpdatesQueued: diagnostics.controllerUpdatesQueued,
    controllerUpdateBatches: diagnostics.controllerUpdateBatches,
    controllerUpdateBatchMaxSize: localCounters.controllerUpdateBatchMaxSize,
    controllerUpdatesFlushed: diagnostics.controllerUpdatesFlushed,
    controllerUpdatesAccepted: diagnostics.controllerUpdatesAccepted,
    controllerUpdatesRejected: diagnostics.controllerUpdatesRejected,
    cacheEntries: diagnostics.cache.size,
    cacheHits: diagnostics.cache.hits,
    cacheMisses: diagnostics.cache.misses,
    cacheWrites: diagnostics.cache.writes,
    cacheEvictions: diagnostics.cache.evictions,
  };
}

function createController({
  sessionId,
  sessionEpoch,
  container,
  footerHeight,
  protectedRowIds,
  state,
  scrollWritesSuspended,
}: {
  sessionId: string;
  sessionEpoch: number;
  container: HTMLDivElement | null;
  footerHeight: number;
  protectedRowIds: readonly string[];
  state?: TranscriptVirtualControllerState;
  scrollWritesSuspended?: boolean;
}) {
  return createTranscriptTanStackVirtualAdapter(
    {
      sessionId,
      sessionEpoch,
      widthScope: container
        ? getWidthScope(container)
        : (state?.widthScope ?? "w:unknown"),
      viewportHeight: getViewportHeight(container, state),
      footerHeight,
      scrollTop: container?.scrollTop ?? state?.scrollTop ?? 0,
      browserScrollHeight:
        container?.scrollHeight ?? state?.virtualScrollHeight,
    },
    {
      protectedRowIds,
      overscanBeforePx: TANSTACK_UI_OVERSCAN_BEFORE_PX,
      overscanAfterPx: TANSTACK_UI_OVERSCAN_AFTER_PX,
      scrollElement: container,
      viewportWidth: container?.clientWidth,
      // A controller rebuilt mid-drag (e.g. the endpoint-pin set changing) must
      // start with scroll writes already suspended so its constructor sync and
      // first viewport reconcile don't snap the browser-owned drag scroll.
      scrollWritesSuspended,
    },
  );
}

function readViewportGeometry(
  container: HTMLDivElement | null,
  footerHeight: number,
) {
  return {
    scrollTop: container?.scrollTop ?? 0,
    viewportHeight: getViewportHeight(container),
    widthScope: getWidthScope(container),
    footerHeight,
    browserScrollHeight: container?.scrollHeight,
  };
}

function getViewportHeight(
  container: HTMLDivElement | null,
  state?: TranscriptVirtualControllerState,
): number {
  return Math.max(
    1,
    container?.clientHeight ||
      state?.viewportHeight ||
      DEFAULT_ASSUMED_VIEWPORT_HEIGHT_PX,
  );
}

function getWidthScope(container: HTMLDivElement | null): string {
  return `w:${Math.max(0, Math.round(container?.clientWidth ?? 0))}`;
}

function buildSnapshot({
  controller,
  registry,
  rows,
  sessionId,
  sessionEpoch,
  measurementStats = EMPTY_MEASUREMENT_STATS,
}: {
  controller: TranscriptVirtualEngine;
  registry: ReturnType<typeof createTranscriptRowStateRegistry>;
  rows: readonly TranscriptRowDescriptor[];
  sessionId: string;
  sessionEpoch: number;
  measurementStats?: TranscriptVirtualTimelineMeasurementStats;
}): TranscriptVirtualTimelineSnapshot {
  const range = controller.getRange();
  const keepAliveDecision = registry.evaluateKeepAlive({
    sessionId,
    sessionEpoch,
    rows,
    visibleRowIds: range.visibleRowIds,
  });
  const fallbackReasons = getFallbackReasons(rows, range, keepAliveDecision);

  return {
    engineKind: controller.engineKind ?? "controller",
    mode: fallbackReasons.length === 0 ? "bounded-controller" : "safe-degraded",
    range,
    controllerState: controller.getState(),
    controllerDiagnostics: controller.getDiagnostics(),
    keepAliveDecision,
    measurementStats: { ...measurementStats },
    fallbackReasons,
  };
}

function shouldSyncViewport(
  state: TranscriptVirtualControllerState,
  viewport: TranscriptViewportGeometry,
): boolean {
  const liveBottomScrollTop = getLiveBottomScrollTop(state, viewport);
  const liveDistanceFromBottom = Math.max(
    0,
    liveBottomScrollTop - viewport.scrollTop,
  );

  return (
    Math.abs(viewport.scrollTop - state.scrollTop) >
      TRANSCRIPT_LAYOUT_SYNC_EPSILON_PX ||
    Math.abs(viewport.viewportHeight - state.viewportHeight) >
      TRANSCRIPT_LAYOUT_SYNC_EPSILON_PX ||
    viewport.widthScope !== state.widthScope ||
    Math.abs((viewport.footerHeight ?? 0) - state.footerHeight) >
      TRANSCRIPT_LAYOUT_SYNC_EPSILON_PX ||
    Math.abs(liveBottomScrollTop - state.bottomScrollTop) >
      TRANSCRIPT_LAYOUT_SYNC_EPSILON_PX ||
    (state.anchor.type === "bottom" &&
      liveDistanceFromBottom > TRANSCRIPT_LAYOUT_SYNC_EPSILON_PX)
  );
}

function getLiveBottomScrollTop(
  state: TranscriptVirtualControllerState,
  viewport: TranscriptViewportGeometry,
): number {
  const browserScrollHeight =
    viewport.browserScrollHeight ?? state.virtualScrollHeight;

  return Math.max(
    0,
    state.virtualScrollHeight - viewport.viewportHeight,
    browserScrollHeight - viewport.viewportHeight,
  );
}

function isStableMeasurementHeight(
  previousHeight: number | undefined,
  nextHeight: number,
): boolean {
  return (
    previousHeight !== undefined &&
    Math.abs(previousHeight - nextHeight) <=
      TRANSCRIPT_MEASUREMENT_STABILITY_EPSILON_PX
  );
}

function areTimelineSnapshotsEquivalent(
  left: TranscriptVirtualTimelineSnapshot,
  right: TranscriptVirtualTimelineSnapshot,
): boolean {
  return (
    left.engineKind === right.engineKind &&
    left.mode === right.mode &&
    areVirtualRangesEquivalent(left.range, right.range) &&
    areControllerStatesEquivalent(
      left.controllerState,
      right.controllerState,
    ) &&
    areKeepAliveDecisionsEquivalent(
      left.keepAliveDecision,
      right.keepAliveDecision,
    ) &&
    areMeasurementStatsEquivalent(
      left.measurementStats,
      right.measurementStats,
    ) &&
    areStringArraysEqual(left.fallbackReasons, right.fallbackReasons)
  );
}

function areVirtualRangesEquivalent(
  left: TranscriptVirtualRangeSnapshot,
  right: TranscriptVirtualRangeSnapshot,
): boolean {
  return (
    areNumbersClose(left.totalHeight, right.totalHeight) &&
    areNumbersClose(left.scrollHeight, right.scrollHeight) &&
    left.visibleRange.startIndex === right.visibleRange.startIndex &&
    left.visibleRange.endIndex === right.visibleRange.endIndex &&
    left.renderRange.startIndex === right.renderRange.startIndex &&
    left.renderRange.endIndex === right.renderRange.endIndex &&
    left.renderRange.visibleStartIndex ===
      right.renderRange.visibleStartIndex &&
    left.renderRange.visibleEndIndex === right.renderRange.visibleEndIndex &&
    areVirtualItemsEquivalent(left.virtualItems, right.virtualItems) &&
    areStringArraysEqual(left.visibleRowIds, right.visibleRowIds) &&
    areStringArraysEqual(left.renderedRowIds, right.renderedRowIds) &&
    areStringArraysEqual(left.protectedRowIds, right.protectedRowIds) &&
    areNumbersClose(left.paddingStart, right.paddingStart) &&
    areNumbersClose(left.paddingEnd, right.paddingEnd)
  );
}

function areVirtualItemsEquivalent(
  left: readonly TranscriptVirtualItem[],
  right: readonly TranscriptVirtualItem[],
): boolean {
  if (left.length !== right.length) {
    return false;
  }

  return left.every((leftItem, index) => {
    const rightItem = right[index];
    return (
      rightItem !== undefined &&
      leftItem.index === rightItem.index &&
      leftItem.key === rightItem.key &&
      leftItem.row === rightItem.row &&
      areNumbersClose(leftItem.start, rightItem.start) &&
      areNumbersClose(leftItem.size, rightItem.size) &&
      areNumbersClose(leftItem.end, rightItem.end) &&
      leftItem.visible === rightItem.visible &&
      leftItem.protected === rightItem.protected
    );
  });
}

function areControllerStatesEquivalent(
  left: TranscriptVirtualControllerState,
  right: TranscriptVirtualControllerState,
): boolean {
  return (
    left.sessionId === right.sessionId &&
    left.sessionEpoch === right.sessionEpoch &&
    left.widthScope === right.widthScope &&
    areNumbersClose(left.scrollTop, right.scrollTop) &&
    areNumbersClose(left.viewportHeight, right.viewportHeight) &&
    areNumbersClose(left.footerHeight, right.footerHeight) &&
    areNumbersClose(left.virtualScrollHeight, right.virtualScrollHeight) &&
    areNumbersClose(left.bottomScrollTop, right.bottomScrollTop) &&
    areNumbersClose(left.distanceFromBottom, right.distanceFromBottom) &&
    left.pinnedToBottom === right.pinnedToBottom &&
    left.nearBottom === right.nearBottom &&
    areScrollAnchorsEquivalent(left.anchor, right.anchor) &&
    left.rowCount === right.rowCount
  );
}

function areScrollAnchorsEquivalent(
  left: TranscriptScrollAnchor,
  right: TranscriptScrollAnchor,
): boolean {
  if (left.type !== right.type) {
    return false;
  }

  if (left.type === "bottom" || right.type === "bottom") {
    return true;
  }

  if (left.type === "scroll-position" || right.type === "scroll-position") {
    return (
      left.type === "scroll-position" &&
      right.type === "scroll-position" &&
      areNumbersClose(left.scrollTop, right.scrollTop)
    );
  }

  return (
    left.rowId === right.rowId &&
    areNumbersClose(left.offsetWithinRow, right.offsetWithinRow) &&
    left.anchorRevision === right.anchorRevision
  );
}

function areKeepAliveDecisionsEquivalent(
  left: TranscriptKeepAliveDecision | null,
  right: TranscriptKeepAliveDecision | null,
): boolean {
  if (left === right) {
    return true;
  }
  if (!left || !right) {
    return false;
  }

  return (
    areStringArraysEqual(left.protectedRowIds, right.protectedRowIds) &&
    areStringArraysEqual(
      left.protectedOffscreenRowIds,
      right.protectedOffscreenRowIds,
    ) &&
    areStringArraysEqual(left.evictedRowIds, right.evictedRowIds) &&
    left.diagnostics.warnThresholdExceeded ===
      right.diagnostics.warnThresholdExceeded &&
    left.diagnostics.failThresholdExceeded ===
      right.diagnostics.failThresholdExceeded &&
    left.diagnostics.failThresholdJustifiedByActiveInteraction ===
      right.diagnostics.failThresholdJustifiedByActiveInteraction
  );
}

function areMeasurementStatsEquivalent(
  left: TranscriptVirtualTimelineMeasurementStats,
  right: TranscriptVirtualTimelineMeasurementStats,
): boolean {
  for (const key of Object.keys(
    EMPTY_MEASUREMENT_STATS,
  ) as (keyof TranscriptVirtualTimelineMeasurementStats)[]) {
    if (left[key] !== right[key]) {
      return false;
    }
  }
  return true;
}

function areStringArraysEqual(
  left: readonly string[],
  right: readonly string[],
): boolean {
  return (
    left.length === right.length &&
    left.every((leftValue, index) => leftValue === right[index])
  );
}

function areNumbersClose(left: number, right: number): boolean {
  return Math.abs(left - right) <= TRANSCRIPT_LAYOUT_SYNC_EPSILON_PX;
}

function getFallbackReasons(
  rows: readonly TranscriptRowDescriptor[],
  range: TranscriptVirtualRangeSnapshot,
  keepAliveDecision: TranscriptKeepAliveDecision,
): readonly TranscriptVirtualTimelineFallbackReason[] {
  const reasons: TranscriptVirtualTimelineFallbackReason[] = [];

  if (rows.some((row) => !SUPPORTED_ROW_KINDS.has(row.kind))) {
    reasons.push("unsupported-row-kind");
  }

  if (rows.length > 0 && range.virtualItems.length === 0) {
    reasons.push("empty-controller-range");
  }

  if (
    keepAliveDecision.diagnostics.failThresholdExceeded &&
    !keepAliveDecision.diagnostics.failThresholdJustifiedByActiveInteraction
  ) {
    reasons.push("protected-row-fail-threshold");
  }

  return reasons;
}

function getMeasurementTokenKey(
  token: TranscriptVirtualMeasurementToken,
): string {
  return [
    token.sessionId,
    token.sessionEpoch,
    token.widthScope,
    token.rowId,
    token.heightRevision,
  ].join("\u0000");
}

function normalizeProtectedRowIds(
  rows: readonly TranscriptRowDescriptor[],
  protectedRowIds: readonly string[],
): readonly string[] {
  if (protectedRowIds.length === 0 || rows.length === 0) {
    return EMPTY_PROTECTED_ROW_IDS;
  }

  const requestedRowIds = new Set(protectedRowIds);
  const normalizedRowIds: string[] = [];
  for (const row of rows) {
    if (requestedRowIds.has(row.rowId)) {
      normalizedRowIds.push(row.rowId);
    }
  }
  return normalizedRowIds;
}

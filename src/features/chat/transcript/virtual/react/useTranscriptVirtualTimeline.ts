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
import {
  createTranscriptProjectionCache,
  type TranscriptProjectionCache,
  type TranscriptRowDescriptor,
} from "../../projection";
import {
  createTranscriptRowStateRegistry,
  type TranscriptKeepAliveDecision,
  type TranscriptMcpActivityKind,
  type TranscriptOpenOverlayKind,
  type TranscriptRowStateRegistry,
} from "../../row-state";
import {
  createTranscriptTanStackVirtualAdapter,
  TranscriptViewportCoordinator,
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
  readTranscriptElementBlockSize,
  type TranscriptMeasurementScheduler,
  type TranscriptMeasurementSchedulerDiagnostics,
} from "../measurement";

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
  onPinScrollAnchor?: () => void;
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
  loadedTranscript?: LoadedTranscriptState;
  sessionId?: string;
  sessionEpoch?: number;
  rows: readonly TranscriptRowDescriptor[];
  protectedRowIds?: readonly string[];
  containerRef: RefObject<HTMLDivElement | null>;
  footerHeight: number;
  preserveScrollPosition?: boolean;
  /** Reads ref-backed ownership that can change before React state commits. */
  shouldPreserveLiveScrollPosition?: () => boolean;
}

interface SyncViewportOptions {
  source?: "browser" | "programmatic" | "correction";
  userScrollIntent?: boolean;
  preserveScrollPosition?: boolean;
  /** Recovery-only escape hatch that invalidates and recomputes a stale range. */
  forceRangeRefresh?: boolean;
}

interface DeferredTranscriptCorrection {
  correction: TranscriptScrollCorrection;
  source: string;
}

interface QueueCachedMeasurementsOptions {
  preserveLiveViewport?: boolean;
}

const SUPPORTED_ROW_KINDS = new Set<TranscriptRowDescriptor["kind"]>([
  "agent-work",
  "assistant-content-fragment",
  "date-separator",
  "message",
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
// Animation frames are the fast path, but WKWebView can withhold them while a
// window is occluded or transitioning. This fallback guarantees delivery
// without moving measurement work into a second scheduler.
export const MEASUREMENT_FLUSH_FALLBACK_MS = 80;
const EMPTY_PROTECTED_ROW_IDS: readonly string[] = [];
let nextLoadedTranscriptStateId = 0;

/** All mutable virtual-renderer state owned by one loaded transcript. */
export interface LoadedTranscriptState {
  readonly id: string;
  readonly sessionId: string;
  readonly sessionEpoch: number;
  readonly projectionCache: TranscriptProjectionCache;
  readonly virtualTimeline: TranscriptVirtualTimelineState;
}

export interface TranscriptVirtualTimelineState {
  rows: readonly TranscriptRowDescriptor[];
  normalizedProtectedRowIds: readonly string[];
  controller: TranscriptVirtualEngine | null;
  controllerScrollElement: HTMLDivElement | null;
  measurementScheduler: TranscriptMeasurementScheduler | null;
  protectedRowKey: string;
  cachedMeasurementReplay: {
    rows: readonly TranscriptRowDescriptor[];
    widthScope: string;
    protectedRowKey: string;
  } | null;
  readonly rowStateRegistry: ReturnType<
    typeof createTranscriptRowStateRegistry
  >;
  localMeasurementCounters: LocalMeasurementCounters;
  readonly measuredHeightByToken: Map<string, number>;
  readonly offscreenMeasuredHeightByToken: Map<string, number>;
  readonly cachedHeightAppliedByToken: Map<string, number>;
  readonly skippedMeasurementByToken: Set<string>;
  readonly deferredMeasurementByToken: Set<string>;
  measurementFlushScheduled: boolean;
  visibleMeasurementFrame: number | null;
  visibleMeasurementTimeout: number | null;
  deferDomCorrections: boolean;
  controllerScrollWritesSuspended: boolean;
  deferredCorrection: DeferredTranscriptCorrection | null;
  readonly pendingVisibleMeasurementElements: Map<string, HTMLElement>;
  readonly pendingOffscreenShellMeasurementElements: Map<string, HTMLElement>;
  readonly pendingOffscreenRealMeasurementElements: Map<string, HTMLElement>;
  readonly registeredVisibleRowElements: Map<string, HTMLElement>;
  snapshot: TranscriptVirtualTimelineSnapshot | null;
}

function createTranscriptVirtualTimelineState(): TranscriptVirtualTimelineState {
  return {
    rows: [],
    normalizedProtectedRowIds: [],
    controller: null,
    controllerScrollElement: null,
    measurementScheduler: null,
    protectedRowKey: "",
    cachedMeasurementReplay: null,
    rowStateRegistry: createTranscriptRowStateRegistry(),
    localMeasurementCounters: { ...EMPTY_LOCAL_MEASUREMENT_COUNTERS },
    measuredHeightByToken: new Map(),
    offscreenMeasuredHeightByToken: new Map(),
    cachedHeightAppliedByToken: new Map(),
    skippedMeasurementByToken: new Set(),
    deferredMeasurementByToken: new Set(),
    measurementFlushScheduled: false,
    visibleMeasurementFrame: null,
    visibleMeasurementTimeout: null,
    deferDomCorrections: false,
    controllerScrollWritesSuspended: false,
    deferredCorrection: null,
    pendingVisibleMeasurementElements: new Map(),
    pendingOffscreenShellMeasurementElements: new Map(),
    pendingOffscreenRealMeasurementElements: new Map(),
    registeredVisibleRowElements: new Map(),
    snapshot: null,
  };
}

export function createLoadedTranscriptState(
  sessionId: string,
  sessionEpoch = 0,
): LoadedTranscriptState {
  return {
    id: `loaded-transcript-${nextLoadedTranscriptStateId++}`,
    sessionId,
    sessionEpoch,
    projectionCache: createTranscriptProjectionCache(),
    virtualTimeline: createTranscriptVirtualTimelineState(),
  };
}

export function useTranscriptVirtualTimeline({
  loadedTranscript: providedLoadedTranscript,
  sessionId: providedSessionId,
  sessionEpoch: providedSessionEpoch = 0,
  rows,
  protectedRowIds = EMPTY_PROTECTED_ROW_IDS,
  containerRef,
  footerHeight,
  preserveScrollPosition = false,
  shouldPreserveLiveScrollPosition: readLiveScrollOwnership,
}: UseTranscriptVirtualTimelineInput) {
  const fallbackLoadedTranscriptRef = useRef<LoadedTranscriptState | null>(
    null,
  );
  if (!providedLoadedTranscript) {
    if (!providedSessionId) {
      throw new Error("A loaded transcript or session id is required");
    }
    if (
      !fallbackLoadedTranscriptRef.current ||
      fallbackLoadedTranscriptRef.current.sessionId !== providedSessionId ||
      fallbackLoadedTranscriptRef.current.sessionEpoch !== providedSessionEpoch
    ) {
      fallbackLoadedTranscriptRef.current = createLoadedTranscriptState(
        providedSessionId,
        providedSessionEpoch,
      );
    }
  }
  const loadedTranscript =
    providedLoadedTranscript ?? fallbackLoadedTranscriptRef.current;
  if (!loadedTranscript) {
    throw new Error("A loaded transcript is required");
  }
  const { sessionId, sessionEpoch } = loadedTranscript;
  const runtimeRef = useRef(loadedTranscript.virtualTimeline);
  const runtimeChanged =
    runtimeRef.current !== loadedTranscript.virtualTimeline;
  if (runtimeChanged) {
    runtimeRef.current = loadedTranscript.virtualTimeline;
  }
  useLayoutEffect(
    () => () => {
      const runtime = loadedTranscript.virtualTimeline;
      if (runtime.visibleMeasurementFrame !== null) {
        cancelAnimationFrame(runtime.visibleMeasurementFrame);
        runtime.visibleMeasurementFrame = null;
      }
      if (runtime.visibleMeasurementTimeout !== null) {
        window.clearTimeout(runtime.visibleMeasurementTimeout);
        runtime.visibleMeasurementTimeout = null;
      }
      runtime.measurementFlushScheduled = false;
      runtime.measurementScheduler?.cancelPendingWork(sessionId, sessionEpoch);
      loadedTranscript.projectionCache.cancelPendingWork(
        sessionId,
        sessionEpoch,
      );
    },
    [loadedTranscript, sessionEpoch, sessionId],
  );
  const normalizedProtectedRowIds = useMemo(
    () => normalizeProtectedRowIds(rows, protectedRowIds),
    [protectedRowIds, rows],
  );
  runtimeRef.current.rows = rows;
  runtimeRef.current.normalizedProtectedRowIds = normalizedProtectedRowIds;

  if (!runtimeRef.current.controller) {
    const container = containerRef.current;
    const controller = createController({
      sessionId,
      sessionEpoch,
      container,
      footerHeight,
      protectedRowIds: normalizedProtectedRowIds,
    });
    controller.setRows(rows);
    runtimeRef.current.controller = controller;
    runtimeRef.current.controllerScrollElement = container;
  }

  if (!runtimeRef.current.measurementScheduler) {
    const controllerState = (
      runtimeRef.current.controller as TranscriptVirtualEngine
    ).getState();
    runtimeRef.current.measurementScheduler =
      createTranscriptMeasurementScheduler({
        sessionId,
        sessionEpoch,
        widthScope: controllerState.widthScope,
        rows,
      });
  }

  const [snapshot, setSnapshot] = useState<TranscriptVirtualTimelineSnapshot>(
    () =>
      buildSnapshot({
        controller: runtimeRef.current.controller as TranscriptVirtualEngine,
        registry: runtimeRef.current.rowStateRegistry,
        rows,
        sessionId,
        sessionEpoch,
        suppressProtectedRowFailFallback: false,
      }),
  );
  let currentSnapshot = snapshot;
  if (runtimeChanged) {
    currentSnapshot = buildSnapshot({
      controller: runtimeRef.current.controller as TranscriptVirtualEngine,
      registry: runtimeRef.current.rowStateRegistry,
      rows,
      sessionId,
      sessionEpoch,
      suppressProtectedRowFailFallback: false,
    });
    setSnapshot(currentSnapshot);
  }
  runtimeRef.current.snapshot = currentSnapshot;

  const shouldPreserveLiveScrollPosition = useCallback(
    () => preserveScrollPosition || readLiveScrollOwnership?.() === true,
    [preserveScrollPosition, readLiveScrollOwnership],
  );

  const applyCorrection = useCallback(
    (
      correction: TranscriptScrollCorrection | null | undefined,
      source = "unknown",
    ) => {
      if (!correction) {
        return;
      }

      if (runtimeRef.current.deferDomCorrections) {
        runtimeRef.current.deferredCorrection = { correction, source };
        return;
      }

      const container = containerRef.current;
      if (!container) {
        return;
      }

      runtimeRef.current.controller?.writeScrollTop?.(
        correction.nextScrollTop,
        {
          source: "correction",
        },
      );
    },
    [containerRef],
  );

  const invalidateWidthScopedMeasurementReplay = useCallback(() => {
    // Controller heights are row-keyed while scheduler/cache entries are
    // width-scoped. Whenever the controller width changes, previously-applied
    // token records may no longer reflect the controller's current row height
    // (for visible or offscreen rows), so cached replay must be allowed to
    // restore the current width's measurement.
    runtimeRef.current.cachedHeightAppliedByToken.clear();
  }, []);

  const syncMeasurementScheduler = useCallback(
    (controller: TranscriptVirtualEngine) => {
      const scheduler = runtimeRef.current.measurementScheduler;
      if (!scheduler) {
        return null;
      }

      scheduler.setContext({
        sessionId,
        sessionEpoch,
        widthScope: controller.getState().widthScope,
        rows: runtimeRef.current.rows,
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

      // This is usually an internal coherence sync (controller vs live DOM),
      // not a user scroll: real user scrolls arrive through scroll events and
      // syncViewportFromDom before this runs. Treat ordinary drift (clamped
      // corrections, in-flight layout changes) as programmatic so the
      // controller reconciles its existing anchor instead of exiting bottom
      // follow or recapturing a row anchor at a transient position.
      //
      const preserveLiveViewport = shouldPreserveLiveScrollPosition();
      const previousWidthScope = controllerState.widthScope;
      const viewportResult = controller.syncViewport(liveViewport, {
        source: preserveLiveViewport ? "browser" : "programmatic",
        userScrollIntent: preserveLiveViewport,
        preserveScrollPosition: preserveLiveViewport,
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
      shouldPreserveLiveScrollPosition,
    ],
  );

  const flushMeasurementBatch = useCallback(
    (controller: TranscriptVirtualEngine) => {
      const scheduler = runtimeRef.current.measurementScheduler;
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
          runtimeRef.current.localMeasurementCounters
            .controllerUpdateBatchMaxSize
        ) {
          runtimeRef.current.localMeasurementCounters = {
            ...runtimeRef.current.localMeasurementCounters,
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
      const previousReplay = runtimeRef.current.cachedMeasurementReplay;
      if (
        previousReplay?.rows === runtimeRef.current.rows &&
        previousReplay.widthScope === state.widthScope &&
        previousReplay.protectedRowKey === runtimeRef.current.protectedRowKey
      ) {
        return false;
      }

      runtimeRef.current.cachedMeasurementReplay = {
        rows: runtimeRef.current.rows,
        widthScope: state.widthScope,
        protectedRowKey: runtimeRef.current.protectedRowKey,
      };

      let queued = false;
      for (const row of runtimeRef.current.rows) {
        const cached = scheduler.peekCachedMeasurement(row.rowId);
        if (!cached) {
          continue;
        }

        const tokenKey = getMeasurementTokenKey(cached.token);
        if (
          runtimeRef.current.cachedHeightAppliedByToken.get(tokenKey) ===
          cached.height
        ) {
          continue;
        }

        if (scheduler.queueCachedControllerUpdate(row.rowId)) {
          runtimeRef.current.cachedHeightAppliedByToken.set(
            tokenKey,
            cached.height,
          );
          queued = true;
        }
      }

      if (queued) {
        if (options.preserveLiveViewport) {
          // Controller rebuilds start from estimates; cached replay is an
          // internal warm-up, so recapture the browser's live viewport instead
          // of replaying estimate-based row-anchor corrections into the DOM.
          const wasDeferringCorrections =
            runtimeRef.current.deferDomCorrections;
          const previousDeferredCorrection =
            runtimeRef.current.deferredCorrection;

          runtimeRef.current.deferDomCorrections = true;
          runtimeRef.current.deferredCorrection = null;
          runtimeRef.current.controllerScrollWritesSuspended = true;
          controller.setScrollWritesSuspended?.(true);
          try {
            flushMeasurementBatch(controller);
          } finally {
            runtimeRef.current.deferDomCorrections = wasDeferringCorrections;
            runtimeRef.current.deferredCorrection = previousDeferredCorrection;
            runtimeRef.current.controllerScrollWritesSuspended = false;
            controller.setScrollWritesSuspended?.(false);
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
      syncMeasurementScheduler,
    ],
  );

  const commitSnapshot = useCallback(() => {
    const controller = runtimeRef.current.controller;
    if (!controller) {
      return null;
    }

    const registry = runtimeRef.current.rowStateRegistry;
    registry.setSessionEpoch(sessionId, sessionEpoch);
    syncControllerFromLiveViewport(controller);
    syncMeasurementScheduler(controller);
    queueCachedMeasurementsForController(controller);

    let nextSnapshot = buildSnapshot({
      controller,
      registry,
      rows: runtimeRef.current.rows,
      sessionId,
      sessionEpoch,
      measurementStats: getMeasurementStats(
        runtimeRef.current.measurementScheduler?.getDiagnostics(),
        runtimeRef.current.localMeasurementCounters,
      ),
    });

    const protectedRowIds = normalizeProtectedRowIds(runtimeRef.current.rows, [
      ...runtimeRef.current.normalizedProtectedRowIds,
      ...(nextSnapshot.keepAliveDecision?.protectedRowIds ?? []),
    ]);
    const nextProtectedRowKey = protectedRowIds.join("\u0000");
    if (nextProtectedRowKey !== runtimeRef.current.protectedRowKey) {
      const state = controller.getState();
      const replacement = createController({
        sessionId,
        sessionEpoch,
        container: containerRef.current,
        footerHeight: state.footerHeight,
        protectedRowIds,
        state,
      });
      runtimeRef.current.controller = replacement;
      runtimeRef.current.controllerScrollElement = containerRef.current;
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
      const preserveLiveViewport = shouldPreserveLiveScrollPosition();
      if (preserveLiveViewport) {
        replacement.syncViewport(liveViewportBeforeRows, {
          source: "browser",
          userScrollIntent: true,
          preserveScrollPosition: true,
        });
      }
      const shouldRestoreLiveViewport =
        preserveLiveViewport ||
        state.anchor.type === "row" ||
        !state.nearBottom ||
        liveDistanceFromBottom > 1;
      replacement.setScrollWritesSuspended?.(shouldRestoreLiveViewport);
      const rowsResult = replacement.setRows(runtimeRef.current.rows);
      if (shouldRestoreLiveViewport) {
        replacement.syncViewport(liveViewportBeforeRows, {
          source: "browser",
          userScrollIntent: true,
          preserveScrollPosition: preserveLiveViewport,
        });
      } else {
        applyCorrection(rowsResult.correction, "protected-rows-setRows");
      }
      replacement.setScrollWritesSuspended?.(false);
      runtimeRef.current.protectedRowKey = nextProtectedRowKey;
      runtimeRef.current.cachedMeasurementReplay = null;
      runtimeRef.current.cachedHeightAppliedByToken.clear();
      syncMeasurementScheduler(replacement);
      queueCachedMeasurementsForController(replacement, {
        preserveLiveViewport: true,
      });
      if (shouldRestoreLiveViewport) {
        replacement.writeScrollTop?.(liveViewportBeforeRows.scrollTop, {
          source: "browser",
          userScrollIntent: true,
        });
      }
      nextSnapshot = buildSnapshot({
        controller: replacement,
        registry,
        rows: runtimeRef.current.rows,
        sessionId,
        sessionEpoch,
        measurementStats: getMeasurementStats(
          runtimeRef.current.measurementScheduler?.getDiagnostics(),
          runtimeRef.current.localMeasurementCounters,
        ),
      });
    }

    const previousSnapshot = runtimeRef.current.snapshot;
    if (
      previousSnapshot === null ||
      !areTimelineSnapshotsEquivalent(previousSnapshot, nextSnapshot)
    ) {
      runtimeRef.current.snapshot = nextSnapshot;
      setSnapshot(nextSnapshot);
    }
    return nextSnapshot.controllerState;
  }, [
    applyCorrection,
    containerRef,
    footerHeight,
    queueCachedMeasurementsForController,
    sessionEpoch,
    sessionId,
    syncControllerFromLiveViewport,
    syncMeasurementScheduler,
    shouldPreserveLiveScrollPosition,
  ]);

  /**
   * Pin the transcript to where it currently sits, dropping bottom-follow.
   *
   * A row that expands or collapses in place changes the transcript's total
   * height. While the viewport is pinned to the bottom, that height change
   * reconciles by scrolling to the *new* bottom, which throws the reader past
   * the content they just revealed. Capturing an anchor first is the same thing
   * the engine does when a user scrolls up by hand, so an in-place expand keeps
   * the clicked row under the reader's eyes.
   */
  const pinScrollAnchor = useCallback(() => {
    const controller = runtimeRef.current.controller;
    if (!controller) {
      return;
    }

    const liveViewport = readViewportGeometry(
      containerRef.current,
      footerHeight,
    );
    const result = controller.syncViewport(liveViewport, {
      source: "browser",
      userScrollIntent: true,
      preserveScrollPosition: true,
    });
    applyCorrection(result.correction, "pin-scroll-anchor");
    commitSnapshot();
  }, [applyCorrection, commitSnapshot, containerRef, footerHeight]);

  const syncViewportFromDom = useCallback(
    (options: SyncViewportOptions = {}) => {
      const controller = runtimeRef.current.controller;
      if (!controller) {
        return null;
      }

      const liveViewport = readViewportGeometry(
        containerRef.current,
        footerHeight,
      );
      if (
        !options.forceRangeRefresh &&
        !shouldSyncViewport(controller.getState(), liveViewport)
      ) {
        return controller.getState();
      }

      const previousWidthScope = controller.getState().widthScope;
      const result = controller.syncViewport(liveViewport, options);
      if (controller.getState().widthScope !== previousWidthScope) {
        invalidateWidthScopedMeasurementReplay();
      }
      applyCorrection(result.correction, "sync-viewport-from-dom");
      const controllerState = commitSnapshot();
      if (options.forceRangeRefresh) {
        const refreshedSnapshot = buildSnapshot({
          controller: runtimeRef.current.controller ?? controller,
          registry: runtimeRef.current.rowStateRegistry,
          rows: runtimeRef.current.rows,
          sessionId,
          sessionEpoch,
          measurementStats: getMeasurementStats(
            runtimeRef.current.measurementScheduler?.getDiagnostics(),
            runtimeRef.current.localMeasurementCounters,
          ),
        });
        runtimeRef.current.snapshot = refreshedSnapshot;
        setSnapshot(refreshedSnapshot);
      }
      return controllerState;
    },
    [
      applyCorrection,
      commitSnapshot,
      containerRef,
      footerHeight,
      invalidateWidthScopedMeasurementReplay,
      sessionEpoch,
      sessionId,
    ],
  );

  useLayoutEffect(() => {
    const controller = runtimeRef.current.controller;
    const container = containerRef.current;
    const shouldBindRealContainer =
      container != null &&
      runtimeRef.current.controllerScrollElement !== container;
    const controllerState = controller?.getState();
    if (!controller || shouldBindRealContainer) {
      const previousState = controllerState ?? undefined;
      runtimeRef.current.controller = createController({
        sessionId,
        sessionEpoch,
        container,
        footerHeight,
        protectedRowIds: normalizedProtectedRowIds,
        state: previousState,
      });
      runtimeRef.current.controllerScrollElement = container;
      runtimeRef.current.measurementScheduler =
        createTranscriptMeasurementScheduler({
          sessionId,
          sessionEpoch,
          widthScope:
            runtimeRef.current.controller?.getState().widthScope ??
            getWidthScope(null),
          rows,
        });
      runtimeRef.current.cachedMeasurementReplay = null;
      runtimeRef.current.cachedHeightAppliedByToken.clear();
    }

    const currentController = runtimeRef.current.controller;
    if (!currentController) {
      return;
    }

    runtimeRef.current.rowStateRegistry.setSessionEpoch(
      sessionId,
      sessionEpoch,
    );
    syncMeasurementScheduler(currentController);
    const preserveLiveViewport = shouldPreserveLiveScrollPosition();
    applyCorrection(
      currentController.syncViewport(
        readViewportGeometry(containerRef.current, footerHeight),
        {
          source: preserveLiveViewport ? "browser" : "programmatic",
          userScrollIntent: preserveLiveViewport,
          preserveScrollPosition: preserveLiveViewport,
        },
      ).correction,
      "layout-sync-viewport",
    );
    currentController.setScrollWritesSuspended?.(preserveLiveViewport);
    let rowsCorrection: TranscriptScrollCorrection | null;
    try {
      rowsCorrection = currentController.setRows(rows).correction;
      if (preserveLiveViewport) {
        currentController.syncViewport(
          readViewportGeometry(containerRef.current, footerHeight),
          {
            source: "browser",
            userScrollIntent: true,
            preserveScrollPosition: true,
          },
        );
      }
    } finally {
      currentController.setScrollWritesSuspended?.(false);
    }
    if (!preserveLiveViewport) {
      applyCorrection(rowsCorrection, "layout-setRows");
    }
    syncMeasurementScheduler(currentController);
    commitSnapshot();
  }, [
    applyCorrection,
    commitSnapshot,
    containerRef,
    footerHeight,
    normalizedProtectedRowIds,
    rows,
    sessionEpoch,
    sessionId,
    shouldPreserveLiveScrollPosition,
    syncMeasurementScheduler,
  ]);

  const flushPendingMeasurementsInner = useCallback(() => {
    const runtime = runtimeRef.current;
    runtime.measurementFlushScheduled = false;
    // Either delivery may win. Cancel both handles before reading queued work
    // so a late callback cannot flush the same batch twice.
    if (runtime.visibleMeasurementFrame !== null) {
      cancelAnimationFrame(runtime.visibleMeasurementFrame);
      runtime.visibleMeasurementFrame = null;
    }
    if (runtime.visibleMeasurementTimeout !== null) {
      window.clearTimeout(runtime.visibleMeasurementTimeout);
      runtime.visibleMeasurementTimeout = null;
    }

    const controller = runtime.controller;
    if (!controller) {
      runtimeRef.current.pendingVisibleMeasurementElements.clear();
      runtimeRef.current.pendingOffscreenShellMeasurementElements.clear();
      runtimeRef.current.pendingOffscreenRealMeasurementElements.clear();
      return;
    }

    const scheduler = syncMeasurementScheduler(controller);
    if (!scheduler) {
      runtimeRef.current.pendingVisibleMeasurementElements.clear();
      runtimeRef.current.pendingOffscreenShellMeasurementElements.clear();
      runtimeRef.current.pendingOffscreenRealMeasurementElements.clear();
      return;
    }

    const visibleEntries = Array.from(
      runtimeRef.current.pendingVisibleMeasurementElements,
    );
    const offscreenEntries = Array.from(
      runtimeRef.current.pendingOffscreenShellMeasurementElements,
    );
    const offscreenRealEntries = Array.from(
      runtimeRef.current.pendingOffscreenRealMeasurementElements,
    );
    runtimeRef.current.pendingVisibleMeasurementElements.clear();
    runtimeRef.current.pendingOffscreenShellMeasurementElements.clear();
    runtimeRef.current.pendingOffscreenRealMeasurementElements.clear();

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
      const measuredBlockSize = measureElementBlockSize(element);

      if (measuredBlockSize <= 0) {
        if (
          !runtimeRef.current.skippedMeasurementByToken.has(`${tokenKey}:zero`)
        ) {
          runtimeRef.current.skippedMeasurementByToken.add(`${tokenKey}:zero`);
          runtimeRef.current.localMeasurementCounters = {
            ...runtimeRef.current.localMeasurementCounters,
            skippedZeroMeasurements:
              runtimeRef.current.localMeasurementCounters
                .skippedZeroMeasurements + 1,
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
      const previousHeight =
        runtimeRef.current.measuredHeightByToken.get(tokenKey);
      if (
        (finalization.canFinalize || shouldAcceptPendingAnimationMeasurement) &&
        previousHeight !== undefined &&
        Math.abs(previousHeight - finalization.blockSize) <=
          TRANSCRIPT_MEASUREMENT_STABILITY_EPSILON_PX
      ) {
        continue;
      }

      runtimeRef.current.localMeasurementCounters = {
        ...runtimeRef.current.localMeasurementCounters,
        visibleMeasurementAttempts:
          runtimeRef.current.localMeasurementCounters
            .visibleMeasurementAttempts + 1,
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
        if (!runtimeRef.current.deferredMeasurementByToken.has(skippedKey)) {
          runtimeRef.current.deferredMeasurementByToken.add(skippedKey);
          runtimeRef.current.localMeasurementCounters = {
            ...runtimeRef.current.localMeasurementCounters,
            reservedMeasurementsDeferred:
              runtimeRef.current.localMeasurementCounters
                .reservedMeasurementsDeferred +
              (finalization.source === "reserved" ? 1 : 0),
          };
          shouldCommitSnapshot = true;
        }
        continue;
      }

      if (result.status === "accepted" && result.queuedControllerUpdate) {
        runtimeRef.current.measuredHeightByToken.set(
          tokenKey,
          result.entry.height,
        );
        runtimeRef.current.cachedHeightAppliedByToken.set(
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

      const measuredBlockSize = measureElementBlockSize(element);
      if (measuredBlockSize <= 0) {
        continue;
      }

      const tokenKey = getMeasurementTokenKey(plan.token);
      if (
        isStableMeasurementHeight(
          runtimeRef.current.offscreenMeasuredHeightByToken.get(tokenKey),
          measuredBlockSize,
        )
      ) {
        continue;
      }

      runtimeRef.current.offscreenMeasuredHeightByToken.set(
        tokenKey,
        measuredBlockSize,
      );
      runtimeRef.current.localMeasurementCounters = {
        ...runtimeRef.current.localMeasurementCounters,
        offscreenShellMeasurementAttempts:
          runtimeRef.current.localMeasurementCounters
            .offscreenShellMeasurementAttempts + 1,
      };

      const result = scheduler.recordOffscreenMeasurement({
        token: plan.token,
        height: measuredBlockSize,
        source: "offscreen-shell",
      });
      if (result.status === "accepted" && result.queuedControllerUpdate) {
        runtimeRef.current.cachedHeightAppliedByToken.set(
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

      const measuredBlockSize = measureElementBlockSize(element);
      if (measuredBlockSize <= 0) {
        continue;
      }

      const tokenKey = getMeasurementTokenKey(plan.token);
      if (
        isStableMeasurementHeight(
          runtimeRef.current.offscreenMeasuredHeightByToken.get(tokenKey),
          measuredBlockSize,
        )
      ) {
        continue;
      }

      runtimeRef.current.offscreenMeasuredHeightByToken.set(
        tokenKey,
        measuredBlockSize,
      );
      runtimeRef.current.localMeasurementCounters = {
        ...runtimeRef.current.localMeasurementCounters,
        offscreenRealMeasurementAttempts:
          runtimeRef.current.localMeasurementCounters
            .offscreenRealMeasurementAttempts + 1,
      };

      const result = scheduler.recordOffscreenMeasurement({
        token: plan.token,
        height: measuredBlockSize,
        source: "offscreen-real",
      });
      if (result.status === "accepted" && result.queuedControllerUpdate) {
        runtimeRef.current.cachedHeightAppliedByToken.set(
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
      const deferredCorrection = runtimeRef.current.deferredCorrection;
      runtimeRef.current.deferredCorrection = null;
      return deferredCorrection;
    };

    // Measurement-driven scroll corrections must hit the DOM in the same
    // paint as the re-rendered row positions. Defer the scrollTop writes
    // while the controller updates run, commit the snapshot synchronously,
    // then apply the final correction against the new layout.
    runtimeRef.current.deferDomCorrections = true;
    runtimeRef.current.deferredCorrection = null;
    runtimeRef.current.controller?.setScrollWritesSuspended?.(true);
    try {
      flushSync(() => {
        flushPendingMeasurementsInner();
      });
    } finally {
      runtimeRef.current.deferDomCorrections = false;
      runtimeRef.current.controller?.setScrollWritesSuspended?.(false);
    }

    const deferredCorrection = takeDeferredCorrection();
    if (deferredCorrection) {
      applyCorrection(
        deferredCorrection.correction,
        `${deferredCorrection.source}:deferred`,
      );
    }
  }, [applyCorrection, flushPendingMeasurementsInner]);

  const scheduleMeasurementFlush = useCallback(() => {
    if (runtimeRef.current.measurementFlushScheduled) {
      return;
    }

    runtimeRef.current.measurementFlushScheduled = true;
    runtimeRef.current.visibleMeasurementFrame = requestAnimationFrame(
      flushPendingMeasurements,
    );
    runtimeRef.current.visibleMeasurementTimeout = window.setTimeout(
      flushPendingMeasurements,
      MEASUREMENT_FLUSH_FALLBACK_MS,
    );
  }, [flushPendingMeasurements]);

  const measureRowElement = useCallback(
    (rowId: string, element: HTMLElement | null) => {
      if (!element) {
        runtimeRef.current.pendingVisibleMeasurementElements.delete(rowId);
        runtimeRef.current.registeredVisibleRowElements.delete(rowId);
        return;
      }

      runtimeRef.current.registeredVisibleRowElements.set(rowId, element);
      runtimeRef.current.pendingVisibleMeasurementElements.set(rowId, element);
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
    for (const [rowId, element] of runtimeRef.current
      .registeredVisibleRowElements) {
      if (!element.isConnected) {
        runtimeRef.current.registeredVisibleRowElements.delete(rowId);
        continue;
      }
      const token =
        runtimeRef.current.measurementScheduler?.getMeasurementToken(rowId);
      if (token) {
        // Force the current-width visible measurement through even if this
        // exact token height was observed before. Controller measurements are
        // row-keyed, so an intervening width can overwrite the current row
        // height; on A → B → A resize, token A must be allowed to restore its
        // height even when the DOM height equals the previous A measurement.
        runtimeRef.current.measuredHeightByToken.delete(
          getMeasurementTokenKey(token),
        );
      }
      runtimeRef.current.pendingVisibleMeasurementElements.set(rowId, element);
    }

    if (runtimeRef.current.pendingVisibleMeasurementElements.size === 0) {
      return;
    }

    // The synchronous flush cancels any pending frame and timer itself, using
    // the same first-delivery-wins lifecycle as an async flush.
    flushPendingMeasurements();
  }, [flushPendingMeasurements]);

  const measureOffscreenShellElement = useCallback(
    (rowId: string, element: HTMLElement | null) => {
      if (!element) {
        runtimeRef.current.pendingOffscreenShellMeasurementElements.delete(
          rowId,
        );
        return;
      }

      runtimeRef.current.pendingOffscreenShellMeasurementElements.set(
        rowId,
        element,
      );
      scheduleMeasurementFlush();
    },
    [scheduleMeasurementFlush],
  );

  const measureOffscreenRealElement = useCallback(
    (rowId: string, element: HTMLElement | null) => {
      if (!element) {
        runtimeRef.current.pendingOffscreenRealMeasurementElements.delete(
          rowId,
        );
        return;
      }

      runtimeRef.current.pendingOffscreenRealMeasurementElements.set(
        rowId,
        element,
      );
      scheduleMeasurementFlush();
    },
    [scheduleMeasurementFlush],
  );

  const scrollToRow = useCallback(
    (rowId: string, align: TranscriptScrollAlign = "auto") => {
      const controller = runtimeRef.current.controller;
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
      const controller = runtimeRef.current.controller;
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

      controller.writeScrollTop?.(nextScrollTop, {
        behavior,
        source: "programmatic",
        userScrollIntent: true,
      });
      const nextLiveViewport = readViewportGeometry(container, footerHeight);
      const targetReachableInCurrentDom =
        nextScrollTop <= getBrowserBottomScrollTop(liveViewport) + 1;
      const result = controller.syncViewport(
        behavior !== "auto" && targetReachableInCurrentDom
          ? {
              ...nextLiveViewport,
              scrollTop: nextScrollTop,
            }
          : nextLiveViewport,
        { source: "browser", userScrollIntent: true },
      );
      applyCorrection(result.correction, "scroll-to-bottom-sync");
      commitSnapshot();
      return true;
    },
    [applyCorrection, commitSnapshot, containerRef, footerHeight],
  );

  const writeScrollTop = useCallback(
    (
      scrollTop: number,
      options: {
        behavior?: ScrollBehavior;
        source?: "browser" | "programmatic" | "correction";
        userScrollIntent?: boolean;
        preserveScrollPosition?: boolean;
      } = {},
    ) => {
      const controller = runtimeRef.current.controller;
      if (!controller?.writeScrollTop) {
        return null;
      }
      const accepted = controller.writeScrollTop(scrollTop, options);
      commitSnapshot();
      return accepted;
    },
    [commitSnapshot],
  );

  const readRealRowCoverage = useCallback(
    (transcriptRoot?: HTMLElement | null) => {
      const controller = runtimeRef.current.controller;
      return controller instanceof TranscriptViewportCoordinator
        ? controller.readRealRowCoverage(transcriptRoot)
        : null;
    },
    [],
  );

  const setRowFocused = useCallback<
    TranscriptVirtualTimelineRowStateControls["setRowFocused"]
  >(
    (rowId, focused, options = {}) => {
      runtimeRef.current.rowStateRegistry.setFocusedRow({
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
      runtimeRef.current.rowStateRegistry.setOpenOverlay({
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
      runtimeRef.current.rowStateRegistry.setMcpActivity({
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
      runtimeRef.current.rowStateRegistry.markRowInteracted({
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
    runtimeRef.current.rowStateRegistry.cleanupSession(sessionId);
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
        registry: runtimeRef.current.rowStateRegistry,
        sessionId,
        sessionEpoch,
        onRowStateChange: commitSnapshot,
        onPinScrollAnchor: pinScrollAnchor,
      }) satisfies TranscriptVirtualRowStateProviderConfig,
    [commitSnapshot, pinScrollAnchor, sessionEpoch, sessionId],
  );

  return {
    snapshot: currentSnapshot,
    rowStateProvider,
    rowStateControls,
    measureRowElement,
    measureOffscreenShellElement,
    measureOffscreenRealElement,
    remeasureVisibleRowsSync,
    syncViewportFromDom,
    scrollToRow,
    scrollToBottom,
    writeScrollTop,
    readRealRowCoverage,
    setRowFocused,
    markRowInteracted,
  };
}

function measureElementBlockSize(element: HTMLElement): number {
  const rectHeight = readTranscriptElementBlockSize(element);
  const layoutHeight = Math.max(
    element.scrollHeight,
    element.offsetHeight,
    element.clientHeight,
  );
  return Math.max(rectHeight, layoutHeight);
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
}: {
  sessionId: string;
  sessionEpoch: number;
  container: HTMLDivElement | null;
  footerHeight: number;
  protectedRowIds: readonly string[];
  state?: TranscriptVirtualControllerState;
}): TranscriptVirtualEngine {
  const engine = createTranscriptTanStackVirtualAdapter(
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
      viewportWidth: container?.clientWidth,
    },
  );

  return container
    ? new TranscriptViewportCoordinator({
        container,
        engine,
        getFooterHeight: () => footerHeight,
      })
    : engine;
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
  suppressProtectedRowFailFallback = false,
}: {
  controller: TranscriptVirtualEngine;
  registry: ReturnType<typeof createTranscriptRowStateRegistry>;
  rows: readonly TranscriptRowDescriptor[];
  sessionId: string;
  sessionEpoch: number;
  measurementStats?: TranscriptVirtualTimelineMeasurementStats;
  suppressProtectedRowFailFallback?: boolean;
}): TranscriptVirtualTimelineSnapshot {
  const range = controller.getRange();
  const keepAliveDecision = registry.evaluateKeepAlive({
    sessionId,
    sessionEpoch,
    rows,
    visibleRowIds: range.visibleRowIds,
  });
  const fallbackReasons = getFallbackReasons(rows, range, keepAliveDecision, {
    suppressProtectedRowFailFallback,
  });

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

function getBrowserBottomScrollTop(
  viewport: TranscriptViewportGeometry,
): number {
  return Math.max(
    0,
    (viewport.browserScrollHeight ?? 0) - viewport.viewportHeight,
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
  options: {
    suppressProtectedRowFailFallback?: boolean;
  } = {},
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
    !keepAliveDecision.diagnostics.failThresholdJustifiedByActiveInteraction &&
    !options.suppressProtectedRowFailFallback
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
    token.layoutRevision,
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

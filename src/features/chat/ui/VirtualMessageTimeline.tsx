import {
  Profiler,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ProfilerOnRenderCallback,
  type ReactNode,
  type Ref,
  type RefObject,
  type KeyboardEvent,
  type SyntheticEvent,
  type WheelEvent,
} from "react";
import { useTranslation } from "react-i18next";
import { cn } from "@/shared/lib/cn";
import { useLocaleFormatting } from "@/shared/i18n";
import type { Message } from "@/shared/types/messages";
import {
  createTranscriptProjectionCache,
  toDateBucket,
  type TranscriptProjectionCache,
  type TranscriptProjectionSnapshot,
  type TranscriptRowDescriptor,
} from "../transcript/projection";
import {
  createTranscriptShellBlockAttributes,
  createTranscriptShellMeasurementPlan,
  createTranscriptShellRootAttributes,
  type TranscriptMeasurementPolicyDecision,
} from "../transcript/measurement";
import {
  createTranscriptDiagnosticsFromVirtualTimelineDiagnostics,
  TRANSCRIPT_DIAGNOSTICS_EVENT,
  type TranscriptDiagnostics,
  type TranscriptTimingSample,
} from "../transcript/diagnostics";
import type {
  TranscriptCorrectionReason,
  TranscriptVirtualItem,
} from "../transcript/virtual";
import {
  useTranscriptVirtualTimeline,
  type TranscriptVirtualTimelineFallbackReason,
  type TranscriptVirtualTimelineMeasurementStats,
  type TranscriptVirtualTimelineMode,
} from "../transcript/virtual/react/useTranscriptVirtualTimeline";
import type { TranscriptSearchBackend } from "@/features/chat/lib/transcriptSearchBackend";
import { MessageTimelineScrollContainer } from "./MessageTimelineScrollContainer";
import { TranscriptSearchSkip } from "./TranscriptSearchSkip";
import { useVirtualTranscriptSearch } from "./useVirtualTranscriptSearch";
import { VirtualTranscriptRow } from "./VirtualTranscriptRow";
import {
  easeOutCubic,
  JUMP_TO_LATEST_SCROLL_MS,
  MessageTimelineEmptyState,
  MessageTimelineFooterControlRow,
  MessageTimelineJumpToLatestButton,
  REDUCED_MOTION_QUERY,
  type MessageBubbleCallbacks,
  type MessageTimelineBubbleCallbacks,
} from "./messageTimelineShared";
import { getVirtualTranscriptRowSpacingBlockSize } from "./virtualTranscriptRowSpacing";

const AUTO_SCROLL_THRESHOLD_PX = 180;
const MCP_APP_STICKY_SCROLL_MS = 1500;
const RESIZE_SCROLL_SUPPRESSION_MS = 250;
const FOOTER_DOCK_OVERLAP_PX = 28;
const FOOTER_DOCK_CLEARANCE_PX = 32;
const STREAMING_MESSAGE_TOP_OFFSET_PX = 16;
const STREAMING_BOTTOM_FOLLOW_MAX_STEP_PX = 48;

export const VIRTUAL_MESSAGE_TIMELINE_DIAGNOSTICS_EVENT =
  "goose:virtual-message-timeline-diagnostics";

const REMAINING_DEFAULT_ON_BLOCKERS = [
  "updated-tanstack-session-history-regression",
  "browser-validation-harness",
  "p2-visual-and-scroll-proof",
] as const;

const OFFSCREEN_MEASUREMENT_LOOKAHEAD_ROWS = 24;

export interface VirtualMessageTimelineDiagnostics {
  renderer: "virtual-message-timeline";
  engineKind: string;
  mode: TranscriptVirtualTimelineMode;
  sessionId: string;
  sessionEpoch: number;
  totalRows: number;
  mountedRows: number;
  virtualRangeMountedRows: number;
  offscreenShellMountedRows: number;
  protectedRows: number;
  protectedOffscreenRows: number;
  descriptorChurn: number;
  fragmentRowCount: number;
  completedFragmentRowCount: number;
  completedStreamingFragmentRowCount: number;
  streamingTailRowCount: number;
  wholeMessageFallbackRowCount: number;
  reusedPrefixCount: number;
  reusedSuffixCount: number;
  projectionDurationMs: number;
  projectionP95Ms: number;
  descriptorChurnPercent: number;
  blankViewportPixels: number;
  timeToFirstVisibleTailMs: number;
  restoreReplayDrainMs: number;
  heapGrowthMb: number;
  reactCommitP95Ms: number;
  scrollHandlerP95Ms: number;
  reactCommitSamples: readonly TranscriptTimingSample[];
  scrollHandlerSamples: readonly TranscriptTimingSample[];
  scrollCorrectionP95Px: number;
  scrollCorrectionCount: number;
  scrollCorrectionsPerSecond: number;
  measurementBatchSize: number;
  measurementAcceptedCount: number;
  measurementCacheHitRate: number;
  staleMeasurementDrops: number;
  staleMeasurementRejectCount: number;
  staleMeasurementSessionDrops: number;
  staleMeasurementEpochDrops: number;
  staleMeasurementWidthDrops: number;
  staleMeasurementRevisionDrops: number;
  staleMeasurementMissingRowDrops: number;
  virtualUnmountingEnabled: boolean;
  visibleRange: {
    startIndex: number;
    endIndex: number;
  };
  renderRange: {
    startIndex: number;
    endIndex: number;
  };
  virtualScrollHeight: number;
  controller: {
    corrections: number;
    bottomFollowExits: number;
    staleMeasurementsDropped: number;
    staleMeasurementSessionDrops: number;
    staleMeasurementEpochDrops: number;
    staleMeasurementWidthDrops: number;
    staleMeasurementRevisionDrops: number;
    staleMeasurementMissingRowDrops: number;
    staleAnchorsDropped: number;
    missingAnchorsDropped: number;
    recapturedAnchors: number;
    lastCorrectionDeltaPx: number;
    lastCorrectionReason: TranscriptCorrectionReason | null;
  };
  measurement: TranscriptVirtualTimelineMeasurementStats;
  keepAlive: {
    evictedMcpRowCount: number;
    evictedRecentRowCount: number;
    warnThresholdExceeded: boolean;
    failThresholdExceeded: boolean;
  };
  visibleRowIds: readonly string[];
  renderedRowIds: readonly string[];
  protectedRowIds: readonly string[];
  fallbackReasons: readonly TranscriptVirtualTimelineFallbackReason[];
  blockers: readonly string[];
  pr928SameIdStaleRevisionProofs: number;
  pr928WholeRowSplitProofs: number;
  pr928StreamingTailPromotionProofs: number;
  pr928RealFragmentTailBlockers: number;
}

declare global {
  interface Window {
    __GOOSE_TRANSCRIPT_VIRTUALIZATION_DIAGNOSTICS__?:
      | VirtualMessageTimelineDiagnostics
      | undefined;
    __GOOSE_TRANSCRIPT_DIAGNOSTICS__?: TranscriptDiagnostics | undefined;
  }
}

interface VirtualMessageTimelineProps extends MessageTimelineBubbleCallbacks {
  sessionId: string;
  messages: Message[];
  streamingMessageId?: string | null;
  scrollTargetMessageId?: string | null;
  scrollTargetQuery?: string | null;
  onScrollTargetHandled?: (messageId: string) => void;
  /** Receives the element wrapping the rendered transcript content, the
      search root for find-in-transcript (useChatTranscriptSearch). */
  searchContentRef?: Ref<HTMLDivElement>;
  /** Filled with the indexed search backend so find-in-transcript can match
      the full transcript without suspending row windowing. */
  searchBackendRef?: RefObject<TranscriptSearchBackend | null>;
  onDiagnostics?: (diagnostics: VirtualMessageTimelineDiagnostics) => void;
  onTranscriptDiagnostics?: (diagnostics: TranscriptDiagnostics) => void;
  className?: string;
  tailPaddingPx?: number;
  footer?: ReactNode;
  footerStatus?: ReactNode;
  placeholder?: ReactNode;
  showPlaceholder?: boolean;
}

type TranscriptShellMeasurementPlanForRow = ReturnType<
  typeof createTranscriptShellMeasurementPlan
>;

interface OffscreenShellMeasurementRow {
  index: number;
  previousRowKind?: TranscriptRowDescriptor["kind"];
  row: TranscriptRowDescriptor;
  measurementPlan: TranscriptShellMeasurementPlanForRow;
}

interface LiveStreamingTailSplit {
  historyRows: readonly TranscriptRowDescriptor[];
  liveRows: readonly TranscriptRowDescriptor[];
  startIndex: number;
}

function formatDateSeparator(
  snapshot: TranscriptProjectionSnapshot,
  rowIndex: number,
  labels: {
    today: string;
    yesterday: string;
    formatDate: (
      value: Date | string | number,
      options?: Intl.DateTimeFormatOptions,
    ) => string;
  },
): string {
  const row = snapshot.rows[rowIndex];
  const date = row?.date;
  if (!date) {
    return "";
  }

  if (date.labelKey === "today") {
    return labels.today;
  }

  if (date.labelKey === "yesterday") {
    return labels.yesterday;
  }

  return labels.formatDate(date.timestamp, {
    weekday: "long",
    month: "short",
    day: "numeric",
  });
}

function resolveScrollTargetMessageId(
  snapshot: TranscriptProjectionSnapshot,
  scrollTargetMessageId: string | null | undefined,
  scrollTargetQuery: string | null | undefined,
) {
  if (
    scrollTargetMessageId &&
    snapshot.rowByMessageId.has(scrollTargetMessageId)
  ) {
    return scrollTargetMessageId;
  }

  const trimmedQuery = scrollTargetQuery?.trim().toLocaleLowerCase();
  if (!trimmedQuery) {
    return null;
  }

  for (const [
    messageId,
    searchableText,
  ] of snapshot.searchableTextByMessageId) {
    if (searchableText.toLocaleLowerCase().includes(trimmedQuery)) {
      return messageId;
    }
  }

  return null;
}

function TranscriptOffscreenShellMeasurementHost({
  rows,
  onMeasureShellRow,
}: {
  rows: readonly OffscreenShellMeasurementRow[];
  onMeasureShellRow: (rowId: string, element: HTMLElement | null) => void;
}) {
  if (rows.length === 0) {
    return null;
  }

  return (
    <div
      aria-hidden="true"
      data-transcript-search-skip=""
      data-testid="virtual-offscreen-measurement-host"
      data-virtual-offscreen-shell-row-count={rows.length}
      style={{
        contain: "layout style paint",
        insetInlineStart: 0,
        pointerEvents: "none",
        position: "absolute",
        top: 0,
        transform: "translateY(-100000px)",
        visibility: "hidden",
        width: "100%",
      }}
    >
      {rows.map((row) => (
        <TranscriptOffscreenShellMeasurementBlock
          key={row.row.reactKey}
          row={row}
          onMeasureShellRow={onMeasureShellRow}
        />
      ))}
    </div>
  );
}

function TranscriptOffscreenShellMeasurementBlock({
  row,
  onMeasureShellRow,
}: {
  row: OffscreenShellMeasurementRow;
  onMeasureShellRow: (rowId: string, element: HTMLElement | null) => void;
}) {
  const elementRef = useRef<HTMLDivElement | null>(null);
  const spacingBlockSize = getVirtualTranscriptRowSpacingBlockSize({
    row: row.row,
    index: row.index,
    previousRowKind: row.previousRowKind,
  });
  const rootBlockSize =
    row.measurementPlan.estimatedBlockSize + spacingBlockSize;

  // biome-ignore lint/correctness/useExhaustiveDependencies: shell geometry revisions intentionally retrigger offscreen measurement.
  useLayoutEffect(() => {
    onMeasureShellRow(row.row.rowId, elementRef.current);
  }, [
    onMeasureShellRow,
    rootBlockSize,
    row.measurementPlan.blocks,
    row.row.heightRevision,
    row.row.rowId,
  ]);

  return (
    <div
      ref={elementRef}
      data-testid={`virtual-transcript-shell-row-${row.row.rowId}`}
      data-virtual-row-offscreen-shell-id={row.row.rowId}
      data-virtual-row-height-revision={row.row.heightRevision}
      data-virtual-row-render-revision={row.row.renderRevision}
      data-virtual-row-shell-estimated-block-size={
        row.measurementPlan.estimatedBlockSize
      }
      data-virtual-row-shell-spacing-block-size={spacingBlockSize}
      {...createTranscriptShellRootAttributes(row.measurementPlan)}
      style={{
        boxSizing: "border-box",
        height: rootBlockSize,
        overflow: "hidden",
        paddingTop: spacingBlockSize,
      }}
    >
      <div style={{ height: row.measurementPlan.estimatedBlockSize }}>
        {row.measurementPlan.blocks.map((block) => (
          <div
            key={block.key}
            {...createTranscriptShellBlockAttributes(block)}
            style={{
              height: block.estimatedBlockSize,
            }}
          />
        ))}
      </div>
    </div>
  );
}

function getDiagnosticsNowMs(): number {
  return typeof performance !== "undefined" ? performance.now() : Date.now();
}

const DIAGNOSTIC_SAMPLE_LIMIT = 240;
const BYTES_PER_MEBIBYTE = 1024 * 1024;

interface TimelineDiagnosticsAccumulator {
  projectionDurationsMs: number[];
  reactCommitDurationsMs: number[];
  scrollHandlerDurationsMs: number[];
  reactCommitSamples: TranscriptTimingSample[];
  scrollHandlerSamples: TranscriptTimingSample[];
  scrollCorrectionDeltasPx: number[];
  previousCorrectionCount: number;
  hasCorrectionBaseline: boolean;
  hasProjectionBaseline: boolean;
  firstVisibleTailMs: number | null;
  heapBaselineBytes: number | null;
  heapGrowthMb: number;
}

interface PerformanceMemory {
  usedJSHeapSize?: number;
}

function createTimelineDiagnosticsAccumulator(): TimelineDiagnosticsAccumulator {
  return {
    projectionDurationsMs: [],
    reactCommitDurationsMs: [],
    scrollHandlerDurationsMs: [],
    reactCommitSamples: [],
    scrollHandlerSamples: [],
    scrollCorrectionDeltasPx: [],
    previousCorrectionCount: 0,
    hasCorrectionBaseline: false,
    hasProjectionBaseline: false,
    firstVisibleTailMs: null,
    heapBaselineBytes: null,
    heapGrowthMb: 0,
  };
}

function recordDiagnosticsSample(samples: number[], value: number): void {
  if (!Number.isFinite(value) || value < 0) {
    return;
  }

  samples.push(value);
  if (samples.length > DIAGNOSTIC_SAMPLE_LIMIT) {
    samples.splice(0, samples.length - DIAGNOSTIC_SAMPLE_LIMIT);
  }
}

function recordTimingSample(
  samples: TranscriptTimingSample[],
  sample: TranscriptTimingSample,
): void {
  if (
    !Number.isFinite(sample.startTime) ||
    !Number.isFinite(sample.endTime) ||
    !Number.isFinite(sample.durationMs) ||
    sample.endTime < sample.startTime ||
    sample.durationMs < 0
  ) {
    return;
  }

  samples.push(sample);
  if (samples.length > DIAGNOSTIC_SAMPLE_LIMIT) {
    samples.splice(0, samples.length - DIAGNOSTIC_SAMPLE_LIMIT);
  }
}

function percentile(
  samples: readonly number[],
  percentileValue: number,
): number {
  if (samples.length === 0) {
    return 0;
  }

  const sorted = [...samples].sort((left, right) => left - right);
  const index = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil(sorted.length * percentileValue) - 1),
  );
  return sorted[index] ?? 0;
}

function percentOfTotal(count: number, total: number): number {
  return total <= 0 ? 0 : (count / total) * 100;
}

function cacheHitRate({
  hits,
  misses,
  writes,
}: {
  hits: number;
  misses: number;
  writes: number;
}): number {
  const warmMisses = Math.max(0, misses - writes);
  const total = hits + warmMisses;
  return total <= 0 ? 1 : hits / total;
}

function useStableTranscriptRows(
  rows: readonly TranscriptRowDescriptor[],
): readonly TranscriptRowDescriptor[] {
  const rowsRef = useRef(rows);
  const previousRows = rowsRef.current;
  if (
    previousRows.length === rows.length &&
    rows.every((row, index) => row === previousRows[index])
  ) {
    return previousRows;
  }

  rowsRef.current = rows;
  return rows;
}

function useStableMessageByRowId(
  rows: readonly TranscriptRowDescriptor[],
  messageById: ReadonlyMap<string, Message>,
): ReadonlyMap<string, Message> {
  const cacheRef = useRef(
    new Map<
      string,
      {
        message: Message;
        renderRevision: string;
      }
    >(),
  );
  const mapRef = useRef<ReadonlyMap<string, Message>>(new Map());

  return useMemo(() => {
    const next = new Map<string, Message>();
    const liveRowIds = new Set<string>();
    let changed = false;

    for (const row of rows) {
      if (!row.messageId) {
        continue;
      }

      const message = messageById.get(row.messageId);
      if (!message) {
        continue;
      }

      liveRowIds.add(row.rowId);
      const cached = cacheRef.current.get(row.rowId);
      const stableMessage =
        cached?.renderRevision === row.renderRevision
          ? cached.message
          : message;
      cacheRef.current.set(row.rowId, {
        message: stableMessage,
        renderRevision: row.renderRevision,
      });
      next.set(row.rowId, stableMessage);
      if (mapRef.current.get(row.rowId) !== stableMessage) {
        changed = true;
      }
    }

    for (const rowId of cacheRef.current.keys()) {
      if (!liveRowIds.has(rowId)) {
        cacheRef.current.delete(rowId);
      }
    }

    if (mapRef.current.size !== next.size) {
      changed = true;
    }

    if (!changed) {
      return mapRef.current;
    }

    mapRef.current = next;
    return next;
  }, [messageById, rows]);
}

function splitLiveStreamingTail({
  messages,
  rows,
  streamingMessageId,
}: {
  messages: readonly Message[];
  rows: readonly TranscriptRowDescriptor[];
  streamingMessageId: string | null | undefined;
}): LiveStreamingTailSplit | null {
  if (!streamingMessageId) {
    return null;
  }

  const streamingMessageIndex = messages.findIndex(
    (message) => message.id === streamingMessageId,
  );
  const streamingMessage = messages[streamingMessageIndex];
  if (!streamingMessage || streamingMessage.role !== "assistant") {
    return null;
  }

  const previousMessage = messages[streamingMessageIndex - 1];
  const liveStartMessageId =
    previousMessage?.role === "user" ? previousMessage.id : streamingMessage.id;
  let liveStartIndex = rows.findIndex(
    (row) =>
      row.messageId === liveStartMessageId &&
      (row.kind === "message" || row.kind === "assistant-content-fragment"),
  );
  if (liveStartIndex < 0) {
    return null;
  }

  if (rows[liveStartIndex - 1]?.kind === "date-separator") {
    liveStartIndex -= 1;
  }

  return {
    historyRows: rows.slice(0, liveStartIndex),
    liveRows: rows.slice(liveStartIndex),
    startIndex: liveStartIndex,
  };
}

function useStableMeasurementPlanByRowId(
  rows: readonly TranscriptRowDescriptor[],
  messageByRowId: ReadonlyMap<string, Message>,
): ReadonlyMap<string, TranscriptShellMeasurementPlanForRow> {
  const cacheRef = useRef(
    new Map<
      string,
      {
        cacheKey: string;
        plan: TranscriptShellMeasurementPlanForRow;
      }
    >(),
  );
  const mapRef = useRef<
    ReadonlyMap<string, TranscriptShellMeasurementPlanForRow>
  >(new Map());

  return useMemo(() => {
    const next = new Map<string, TranscriptShellMeasurementPlanForRow>();
    const liveRowIds = new Set<string>();
    let changed = mapRef.current.size !== rows.length;

    for (const row of rows) {
      liveRowIds.add(row.rowId);
      const cacheKey = [
        row.kind,
        row.renderRevision,
        row.heightRevision,
        String(row.estimatedHeight),
        row.measurementPolicy,
        row.layoutPendingPolicy,
        row.keepAlivePriority,
        row.measurementSafetyReasons?.join(",") ?? "",
      ].join("\u0000");
      const cached = cacheRef.current.get(row.rowId);
      const plan =
        cached?.cacheKey === cacheKey
          ? cached.plan
          : createTranscriptShellMeasurementPlan({
              rowKind: row.kind,
              message: row.messageId
                ? messageByRowId.get(row.rowId)
                : undefined,
              content: row.fragment?.content,
              estimatedBlockSize: row.estimatedHeight,
              policyDecision: createMeasurementPolicyDecisionFromRow(row),
            });

      cacheRef.current.set(row.rowId, { cacheKey, plan });
      next.set(row.rowId, plan);
      if (mapRef.current.get(row.rowId) !== plan) {
        changed = true;
      }
    }

    for (const rowId of cacheRef.current.keys()) {
      if (!liveRowIds.has(rowId)) {
        cacheRef.current.delete(rowId);
      }
    }

    if (!changed) {
      return mapRef.current;
    }

    mapRef.current = next;
    return next;
  }, [messageByRowId, rows]);
}

function createMeasurementPolicyDecisionFromRow(
  row: TranscriptRowDescriptor,
): TranscriptMeasurementPolicyDecision {
  return {
    policy: row.measurementPolicy,
    layoutPendingPolicy: row.layoutPendingPolicy,
    keepAlivePriority: row.keepAlivePriority,
    capabilities:
      row.capabilities as TranscriptMeasurementPolicyDecision["capabilities"],
    reasons: row.measurementSafetyReasons ?? [],
  };
}

function readUsedHeapBytes(): number | null {
  const memory = (
    globalThis.performance as Performance & {
      memory?: PerformanceMemory;
    }
  )?.memory;
  const usedHeapBytes = memory?.usedJSHeapSize;
  return typeof usedHeapBytes === "number" && Number.isFinite(usedHeapBytes)
    ? usedHeapBytes
    : null;
}

function updateHeapGrowthMetric(
  accumulator: TimelineDiagnosticsAccumulator,
): void {
  const usedHeapBytes = readUsedHeapBytes();
  if (usedHeapBytes == null) {
    accumulator.heapGrowthMb = 0;
    return;
  }

  accumulator.heapBaselineBytes ??= usedHeapBytes;
  accumulator.heapGrowthMb = Math.max(
    0,
    (usedHeapBytes - accumulator.heapBaselineBytes) / BYTES_PER_MEBIBYTE,
  );
}

function getRowsForMessage(
  rows: readonly TranscriptRowDescriptor[],
  messageId: string,
): readonly TranscriptRowDescriptor[] {
  return rows.filter(
    (row) =>
      row.messageId === messageId &&
      (row.kind === "message" || row.kind === "assistant-content-fragment"),
  );
}

function getActiveStreamingProtectedRowIds(
  rows: readonly TranscriptRowDescriptor[],
  streamingMessageId: string | null | undefined,
): readonly string[] {
  if (!streamingMessageId) {
    return [];
  }

  const activeRows = getRowsForMessage(rows, streamingMessageId);
  if (activeRows.length === 0) {
    return [];
  }

  const protectedRowIds = new Set<string>();
  const firstRow = activeRows[0];
  if (firstRow) {
    protectedRowIds.add(firstRow.rowId);
  }

  const tailIndex = activeRows.findIndex(
    (row) => row.fragment?.isStreamingTail,
  );
  if (tailIndex >= 0) {
    const previousRow = activeRows[tailIndex - 1];
    const tailRow = activeRows[tailIndex];
    if (previousRow) {
      protectedRowIds.add(previousRow.rowId);
    }
    if (tailRow) {
      protectedRowIds.add(tailRow.rowId);
    }
  } else if (activeRows.length === 1) {
    protectedRowIds.add(activeRows[0]?.rowId ?? "");
  }

  protectedRowIds.delete("");
  return Array.from(protectedRowIds);
}

function getMountedMessageRows(
  container: HTMLElement,
  messageId: string,
): HTMLElement[] {
  return Array.from(
    container.querySelectorAll<HTMLElement>("[data-virtual-row-message-id]"),
  ).filter(
    (element) =>
      element.getAttribute("data-virtual-row-message-id") === messageId,
  );
}

function isMessageVisibleInViewport(
  container: HTMLElement,
  messageId: string,
): boolean {
  const containerRect = container.getBoundingClientRect();
  return getMountedMessageRows(container, messageId).some((element) => {
    const rect = element.getBoundingClientRect();
    return (
      rect.bottom > containerRect.top + 1 && rect.top < containerRect.bottom - 1
    );
  });
}

function getStreamingMessageProjectedHeight({
  container,
  messageId,
  rows,
}: {
  container: HTMLElement;
  messageId: string;
  rows: readonly TranscriptRowDescriptor[];
}): number {
  const mountedHeight = getMountedMessageRows(container, messageId).reduce(
    (total, element) =>
      total + Math.max(0, element.getBoundingClientRect().height),
    0,
  );
  const estimatedHeight = rows.reduce(
    (total, row) => total + Math.max(0, row.estimatedHeight),
    0,
  );

  return Math.max(mountedHeight, estimatedHeight);
}

function applyTimelineDiagnosticSamples(
  diagnostics: VirtualMessageTimelineDiagnostics,
  accumulator: TimelineDiagnosticsAccumulator,
  elapsedMs: number,
): VirtualMessageTimelineDiagnostics {
  const measurement = diagnostics.measurement;
  const controller = diagnostics.controller;
  const correctionP95Px = percentile(
    accumulator.scrollCorrectionDeltasPx,
    0.95,
  );
  const correctionCount = controller.corrections;
  const measurementAcceptedCount =
    measurement.acceptedVisibleMeasurements +
    measurement.acceptedOffscreenShellMeasurements +
    measurement.acceptedOffscreenRealMeasurements;
  const staleMeasurementRejectCount =
    controller.staleMeasurementsDropped + measurement.staleMeasurementsDropped;
  const elapsedSeconds = elapsedMs > 0 ? elapsedMs / 1000 : 0;

  return {
    ...diagnostics,
    projectionP95Ms: percentile(accumulator.projectionDurationsMs, 0.95),
    descriptorChurnPercent: accumulator.hasProjectionBaseline
      ? percentOfTotal(diagnostics.descriptorChurn, diagnostics.totalRows)
      : 0,
    heapGrowthMb: accumulator.heapGrowthMb,
    reactCommitP95Ms: percentile(accumulator.reactCommitDurationsMs, 0.95),
    scrollHandlerP95Ms: percentile(accumulator.scrollHandlerDurationsMs, 0.95),
    reactCommitSamples: accumulator.reactCommitSamples,
    scrollHandlerSamples: accumulator.scrollHandlerSamples,
    scrollCorrectionP95Px: correctionP95Px,
    scrollCorrectionCount: correctionCount,
    scrollCorrectionsPerSecond:
      elapsedSeconds > 0 ? correctionCount / elapsedSeconds : 0,
    measurementBatchSize: measurement.controllerUpdateBatchMaxSize,
    measurementAcceptedCount,
    measurementCacheHitRate: cacheHitRate({
      hits: measurement.cacheHits,
      misses: measurement.cacheMisses,
      writes: measurement.cacheWrites,
    }),
    staleMeasurementDrops: staleMeasurementRejectCount,
    staleMeasurementRejectCount,
    staleMeasurementSessionDrops:
      controller.staleMeasurementSessionDrops +
      measurement.staleMeasurementSessionDrops,
    staleMeasurementEpochDrops:
      controller.staleMeasurementEpochDrops +
      measurement.staleMeasurementEpochDrops,
    staleMeasurementWidthDrops:
      controller.staleMeasurementWidthDrops +
      measurement.staleMeasurementWidthDrops,
    staleMeasurementRevisionDrops:
      controller.staleMeasurementRevisionDrops +
      measurement.staleMeasurementRevisionDrops,
    staleMeasurementMissingRowDrops:
      controller.staleMeasurementMissingRowDrops +
      measurement.staleMeasurementMissingRowDrops,
    timeToFirstVisibleTailMs: accumulator.firstVisibleTailMs ?? 0,
  };
}

export function VirtualMessageTimeline({
  sessionId,
  messages,
  streamingMessageId,
  scrollTargetMessageId,
  scrollTargetQuery,
  onScrollTargetHandled,
  searchContentRef,
  searchBackendRef,
  onRetryMessage,
  onEditMessage,
  onSendMcpAppMessage,
  onRunShellCommand,
  onEditProject,
  onOpenContextPanel,
  onDiagnostics,
  onTranscriptDiagnostics,
  className,
  tailPaddingPx,
  footer,
  footerStatus,
  placeholder,
  showPlaceholder,
}: VirtualMessageTimelineProps) {
  const { t, i18n } = useTranslation("chat");
  const { formatDate } = useLocaleFormatting();
  const projectionCacheRef = useRef<TranscriptProjectionCache | null>(null);
  const sessionLifecycleRef = useRef({ sessionId, sessionEpoch: 0 });
  const containerRef = useRef<HTMLDivElement>(null);
  const footerRef = useRef<HTMLDivElement>(null);
  const messageRefs = useRef<Record<string, HTMLDivElement | null>>({});
  const isNearBottomRef = useRef(true);
  const userDetachedRef = useRef(false);
  const userScrollIntentRef = useRef(false);
  const lastScrollTopRef = useRef(0);
  const suppressScrollDeltaDetachUntilRef = useRef(0);
  const stickyScrollUntilRef = useRef(0);
  const messageListBottomPaddingPxRef = useRef(0);
  // Scroll modes live in refs because they coordinate DOM scrollTop inside
  // layout effects without forcing a React render for every scroll frame.
  const streamingTopPinSuppressedMessageIdRef = useRef<string | null>(null);
  const streamingTopPinActiveMessageIdRef = useRef<string | null>(null);
  const streamingBottomFollowActiveRef = useRef(false);
  const streamingBottomFollowFrameRef = useRef<number | null>(null);
  const bottomScrollFrameRef = useRef<number | null>(null);
  const jumpToLatestFrameRef = useRef<number | null>(null);
  const scrollToBottomRef = useRef<(behavior: ScrollBehavior) => void>(
    () => undefined,
  );
  const resolvedScrollTargetMessageIdRef = useRef<string | null>(null);
  const scheduledBottomScrollSessionIdRef = useRef(sessionId);
  const lastAutoScrollMessagesRef = useRef<readonly Message[] | null>(null);
  const lastLatestUserAutoScrollKeyRef = useRef<string | null>(null);
  const detachedScrollTopRef = useRef<number | null>(null);
  const liveTailHandoffRef = useRef<{
    distanceFromBottom: number;
    scrollTop: number;
    scrollHeight: number;
  } | null>(null);
  const lastEffectiveVirtualScrollHeightRef = useRef<number | null>(null);
  const diagnosticsStartMsRef = useRef(getDiagnosticsNowMs());
  const diagnosticsAccumulatorRef = useRef(
    createTimelineDiagnosticsAccumulator(),
  );
  const [userDetached, setUserDetached] = useState(false);
  const [footerHeightPx, setFooterHeightPx] = useState(0);
  const [liveTailScrollHeightFloorPx, setLiveTailScrollHeightFloorPx] =
    useState(0);
  const [pulsingMessageId, setPulsingMessageId] = useState<string | null>(null);

  if (!projectionCacheRef.current) {
    projectionCacheRef.current = createTranscriptProjectionCache();
  }

  if (sessionLifecycleRef.current.sessionId !== sessionId) {
    sessionLifecycleRef.current = {
      sessionId,
      sessionEpoch: sessionLifecycleRef.current.sessionEpoch + 1,
    };
    messageRefs.current = {};
    isNearBottomRef.current = true;
    userDetachedRef.current = false;
    detachedScrollTopRef.current = null;
    liveTailHandoffRef.current = null;
    streamingTopPinSuppressedMessageIdRef.current = null;
    streamingTopPinActiveMessageIdRef.current = null;
    streamingBottomFollowActiveRef.current = false;
    lastAutoScrollMessagesRef.current = null;
    lastLatestUserAutoScrollKeyRef.current = null;
    diagnosticsStartMsRef.current = getDiagnosticsNowMs();
    diagnosticsAccumulatorRef.current = createTimelineDiagnosticsAccumulator();
  }

  const sessionEpoch = sessionLifecycleRef.current.sessionEpoch;
  const hasFooter = footer != null;
  const messageListBottomPaddingPx = hasFooter
    ? FOOTER_DOCK_OVERLAP_PX + FOOTER_DOCK_CLEARANCE_PX
    : (tailPaddingPx ?? 16);
  messageListBottomPaddingPxRef.current = messageListBottomPaddingPx;
  const nowBucket = toDateBucket(Date.now());
  const localeKey = i18n.resolvedLanguage ?? i18n.language ?? "default";
  const snapshot = useMemo(
    () =>
      projectionCacheRef.current?.update({
        sessionId,
        sessionEpoch,
        messages,
        streamingMessageId: streamingMessageId ?? null,
        nowBucket,
        localeKey,
      }) ??
      createTranscriptProjectionCache().update({
        sessionId,
        sessionEpoch,
        messages,
        streamingMessageId: streamingMessageId ?? null,
        nowBucket,
        localeKey,
      }),
    [
      localeKey,
      messages,
      nowBucket,
      sessionEpoch,
      sessionId,
      streamingMessageId,
    ],
  );
  const stableRows = useStableTranscriptRows(snapshot.rows);
  const liveStreamingTailSplit = useMemo(
    () =>
      splitLiveStreamingTail({
        messages,
        rows: stableRows,
        streamingMessageId,
      }),
    [messages, stableRows, streamingMessageId],
  );
  const virtualRows = useStableTranscriptRows(
    liveStreamingTailSplit?.historyRows ?? stableRows,
  );
  const liveStreamingTailRows = useStableTranscriptRows(
    liveStreamingTailSplit?.liveRows ?? [],
  );
  const liveStreamingTailStartIndex =
    liveStreamingTailSplit?.startIndex ?? stableRows.length;
  const hasLiveStreamingTail = liveStreamingTailRows.length > 0;
  const stableMessageByRowId = useStableMessageByRowId(
    stableRows,
    snapshot.messageById,
  );
  const activeStreamingProtectedRowIds = useMemo(
    () => getActiveStreamingProtectedRowIds(virtualRows, streamingMessageId),
    [virtualRows, streamingMessageId],
  );
  const virtualTimeline = useTranscriptVirtualTimeline({
    sessionId,
    sessionEpoch,
    rows: virtualRows,
    protectedRowIds: activeStreamingProtectedRowIds,
    containerRef,
    footerHeight: hasLiveStreamingTail ? 0 : messageListBottomPaddingPx,
    preserveScrollPosition: userDetached,
  });
  const {
    snapshot: virtualTimelineSnapshot,
    measureRowElement,
    measureOffscreenShellElement,
    remeasureVisibleRowsSync,
    scrollToBottom: scrollVirtualToBottom,
    scrollToRow: scrollVirtualToRow,
    syncViewportFromDom,
  } = virtualTimeline;
  const isBoundedVirtualMode =
    virtualTimelineSnapshot.mode === "bounded-controller";

  // Indexed find-in-transcript: exact counts over the full transcript with
  // windowing intact. The list-root ref is shared with the forwarded
  // searchContentRef (the classic-path search root).
  const searchListRootRef = useRef<HTMLDivElement | null>(null);
  const setSearchListRoot = useCallback(
    (element: HTMLDivElement | null) => {
      searchListRootRef.current = element;
      if (typeof searchContentRef === "function") {
        searchContentRef(element);
      } else if (searchContentRef) {
        searchContentRef.current = element;
      }
    },
    [searchContentRef],
  );
  const scrollRowForSearch = useCallback(
    (rowId: string) => scrollVirtualToRow(rowId, "center"),
    [scrollVirtualToRow],
  );
  const {
    registerRowElement: registerSearchRowElement,
    harvestHost: searchHarvestHost,
  } = useVirtualTranscriptSearch({
    rows: stableRows,
    messageByRowId: stableMessageByRowId,
    listRootRef: searchListRootRef,
    scrollToRow: scrollRowForSearch,
    backendRef: searchBackendRef,
  });
  const virtualRangeMountedRows = isBoundedVirtualMode
    ? virtualTimelineSnapshot.range.virtualItems.length
    : virtualRows.length;
  const measurementPlanByRowId = useStableMeasurementPlanByRowId(
    stableRows,
    stableMessageByRowId,
  );
  const offscreenShellMeasurementRows = useMemo(() => {
    if (!isBoundedVirtualMode) {
      return [];
    }

    const renderRange = virtualTimelineSnapshot.range.renderRange;
    const renderedRowIds = new Set(
      virtualTimelineSnapshot.range.renderedRowIds,
    );
    const startIndex = Math.max(
      0,
      renderRange.startIndex - OFFSCREEN_MEASUREMENT_LOOKAHEAD_ROWS,
    );
    const endIndex = Math.min(
      virtualRows.length - 1,
      renderRange.endIndex + OFFSCREEN_MEASUREMENT_LOOKAHEAD_ROWS,
    );
    const rows: OffscreenShellMeasurementRow[] = [];

    for (let index = startIndex; index <= endIndex; index += 1) {
      const row = virtualRows[index];
      if (!row || renderedRowIds.has(row.rowId)) {
        continue;
      }

      const measurementPlan = measurementPlanByRowId.get(row.rowId);
      if (
        row.measurementPolicy !== "measure-shell" ||
        !row.capabilities.canOffscreenRenderShell ||
        measurementPlan?.status !== "ready"
      ) {
        continue;
      }

      rows.push({
        index,
        previousRowKind: virtualRows[index - 1]?.kind,
        row,
        measurementPlan,
      });
    }

    return rows;
  }, [
    isBoundedVirtualMode,
    measurementPlanByRowId,
    virtualRows,
    virtualTimelineSnapshot.range.renderRange,
    virtualTimelineSnapshot.range.renderedRowIds,
  ]);
  const offscreenShellMountedRows = offscreenShellMeasurementRows.length;
  const mountedRows = isBoundedVirtualMode
    ? virtualRangeMountedRows +
      offscreenShellMountedRows +
      liveStreamingTailRows.length
    : stableRows.length;
  const protectedVisibleRowIds = new Set(
    virtualTimelineSnapshot.range.visibleRowIds,
  );
  const virtualProtectedOffscreenRows =
    virtualTimelineSnapshot.range.protectedRowIds.filter(
      (rowId) => !protectedVisibleRowIds.has(rowId),
    ).length;
  const hasMessageRows = stableRows.some(
    (row) =>
      row.kind === "message" || row.kind === "assistant-content-fragment",
  );
  const resolvedScrollTargetMessageId = useMemo(
    () =>
      resolveScrollTargetMessageId(
        snapshot,
        scrollTargetMessageId,
        scrollTargetQuery,
      ),
    [scrollTargetMessageId, scrollTargetQuery, snapshot],
  );
  const activeStreamingRowId = streamingMessageId
    ? (snapshot.rowByMessageId.get(streamingMessageId) ?? null)
    : null;
  const structuralDescriptorChurn =
    activeStreamingRowId && snapshot.changedRowIds.has(activeStreamingRowId)
      ? Math.max(0, snapshot.descriptorChurn - 1)
      : snapshot.descriptorChurn;
  const diagnostics = useMemo<VirtualMessageTimelineDiagnostics>(
    () =>
      applyTimelineDiagnosticSamples(
        {
          renderer: "virtual-message-timeline",
          engineKind: virtualTimelineSnapshot.engineKind,
          mode: virtualTimelineSnapshot.mode,
          sessionId,
          sessionEpoch,
          totalRows: stableRows.length,
          mountedRows,
          virtualRangeMountedRows,
          offscreenShellMountedRows,
          protectedRows: virtualTimelineSnapshot.range.protectedRowIds.length,
          protectedOffscreenRows: virtualProtectedOffscreenRows,
          descriptorChurn: structuralDescriptorChurn,
          fragmentRowCount: snapshot.fragmentRowCount,
          completedFragmentRowCount: snapshot.completedFragmentRowCount,
          completedStreamingFragmentRowCount:
            snapshot.completedStreamingFragmentRowCount,
          streamingTailRowCount: snapshot.streamingTailRowCount,
          wholeMessageFallbackRowCount: snapshot.wholeMessageFallbackRowCount,
          reusedPrefixCount: snapshot.reusedPrefixCount,
          reusedSuffixCount: snapshot.reusedSuffixCount,
          projectionDurationMs: snapshot.projectionDurationMs,
          projectionP95Ms: 0,
          descriptorChurnPercent: 0,
          blankViewportPixels: 0,
          timeToFirstVisibleTailMs: 0,
          restoreReplayDrainMs: 0,
          heapGrowthMb: 0,
          reactCommitP95Ms: 0,
          scrollHandlerP95Ms: 0,
          reactCommitSamples: [],
          scrollHandlerSamples: [],
          scrollCorrectionP95Px: 0,
          scrollCorrectionCount: 0,
          scrollCorrectionsPerSecond: 0,
          measurementBatchSize: 0,
          measurementAcceptedCount: 0,
          measurementCacheHitRate: 1,
          staleMeasurementDrops: 0,
          staleMeasurementRejectCount: 0,
          staleMeasurementSessionDrops: 0,
          staleMeasurementEpochDrops: 0,
          staleMeasurementWidthDrops: 0,
          staleMeasurementRevisionDrops: 0,
          staleMeasurementMissingRowDrops: 0,
          virtualUnmountingEnabled: isBoundedVirtualMode,
          visibleRange: {
            startIndex: virtualTimelineSnapshot.range.visibleRange.startIndex,
            endIndex: virtualTimelineSnapshot.range.visibleRange.endIndex,
          },
          renderRange: {
            startIndex: virtualTimelineSnapshot.range.renderRange.startIndex,
            endIndex: virtualTimelineSnapshot.range.renderRange.endIndex,
          },
          virtualScrollHeight: virtualTimelineSnapshot.range.scrollHeight,
          controller: {
            corrections:
              virtualTimelineSnapshot.controllerDiagnostics.corrections,
            bottomFollowExits:
              virtualTimelineSnapshot.controllerDiagnostics.bottomFollowExits,
            staleMeasurementsDropped:
              virtualTimelineSnapshot.controllerDiagnostics
                .staleMeasurementsDropped,
            staleMeasurementSessionDrops:
              virtualTimelineSnapshot.controllerDiagnostics
                .staleMeasurementSessionDrops,
            staleMeasurementEpochDrops:
              virtualTimelineSnapshot.controllerDiagnostics
                .staleMeasurementEpochDrops,
            staleMeasurementWidthDrops:
              virtualTimelineSnapshot.controllerDiagnostics
                .staleMeasurementWidthDrops,
            staleMeasurementRevisionDrops:
              virtualTimelineSnapshot.controllerDiagnostics
                .staleMeasurementRevisionDrops,
            staleMeasurementMissingRowDrops:
              virtualTimelineSnapshot.controllerDiagnostics
                .staleMeasurementMissingRowDrops,
            staleAnchorsDropped:
              virtualTimelineSnapshot.controllerDiagnostics.staleAnchorsDropped,
            missingAnchorsDropped:
              virtualTimelineSnapshot.controllerDiagnostics
                .missingAnchorsDropped,
            recapturedAnchors:
              virtualTimelineSnapshot.controllerDiagnostics.recapturedAnchors,
            lastCorrectionDeltaPx: Math.abs(
              virtualTimelineSnapshot.controllerDiagnostics.lastCorrection
                ?.delta ?? 0,
            ),
            lastCorrectionReason:
              virtualTimelineSnapshot.controllerDiagnostics.lastCorrection
                ?.reason ?? null,
          },
          measurement: virtualTimelineSnapshot.measurementStats,
          keepAlive: {
            evictedMcpRowCount:
              virtualTimelineSnapshot.keepAliveDecision?.diagnostics
                .evictedMcpRowCount ?? 0,
            evictedRecentRowCount:
              virtualTimelineSnapshot.keepAliveDecision?.diagnostics
                .evictedRecentRowCount ?? 0,
            warnThresholdExceeded:
              virtualTimelineSnapshot.keepAliveDecision?.diagnostics
                .warnThresholdExceeded ?? false,
            failThresholdExceeded:
              virtualTimelineSnapshot.keepAliveDecision?.diagnostics
                .failThresholdExceeded ?? false,
          },
          visibleRowIds: hasLiveStreamingTail
            ? [
                ...virtualTimelineSnapshot.range.visibleRowIds,
                ...liveStreamingTailRows.map((row) => row.rowId),
              ]
            : virtualTimelineSnapshot.range.visibleRowIds,
          renderedRowIds: isBoundedVirtualMode
            ? [
                ...virtualTimelineSnapshot.range.renderedRowIds,
                ...liveStreamingTailRows.map((row) => row.rowId),
              ]
            : [...virtualRows, ...liveStreamingTailRows].map(
                (row) => row.rowId,
              ),
          protectedRowIds: virtualTimelineSnapshot.range.protectedRowIds,
          fallbackReasons: virtualTimelineSnapshot.fallbackReasons,
          blockers: REMAINING_DEFAULT_ON_BLOCKERS,
          pr928SameIdStaleRevisionProofs:
            virtualTimelineSnapshot.controllerDiagnostics.staleAnchorsDropped >
            0
              ? 1
              : 0,
          pr928WholeRowSplitProofs:
            snapshot.completedFragmentRowCount > 0 ? 1 : 0,
          pr928StreamingTailPromotionProofs:
            snapshot.completedStreamingFragmentRowCount > 0 &&
            snapshot.streamingTailRowCount > 0
              ? 1
              : 0,
          pr928RealFragmentTailBlockers:
            snapshot.completedFragmentRowCount > 0 &&
            snapshot.completedStreamingFragmentRowCount > 0 &&
            snapshot.streamingTailRowCount > 0
              ? 0
              : 1,
        },
        diagnosticsAccumulatorRef.current,
        getDiagnosticsNowMs() - diagnosticsStartMsRef.current,
      ),
    [
      isBoundedVirtualMode,
      hasLiveStreamingTail,
      liveStreamingTailRows,
      mountedRows,
      offscreenShellMountedRows,
      sessionEpoch,
      sessionId,
      snapshot.fragmentRowCount,
      snapshot.completedFragmentRowCount,
      snapshot.completedStreamingFragmentRowCount,
      snapshot.streamingTailRowCount,
      snapshot.wholeMessageFallbackRowCount,
      snapshot.projectionDurationMs,
      snapshot.reusedPrefixCount,
      snapshot.reusedSuffixCount,
      structuralDescriptorChurn,
      stableRows,
      virtualRows,
      virtualRangeMountedRows,
      virtualProtectedOffscreenRows,
      virtualTimelineSnapshot,
    ],
  );
  useEffect(() => {
    const accumulator = diagnosticsAccumulatorRef.current;
    const elapsedMs = getDiagnosticsNowMs() - diagnosticsStartMsRef.current;
    recordDiagnosticsSample(
      accumulator.projectionDurationsMs,
      diagnostics.projectionDurationMs,
    );

    if (
      diagnostics.controller.corrections < accumulator.previousCorrectionCount
    ) {
      accumulator.previousCorrectionCount = diagnostics.controller.corrections;
      accumulator.scrollCorrectionDeltasPx = [];
      accumulator.hasCorrectionBaseline = false;
    }

    if (!accumulator.hasCorrectionBaseline) {
      accumulator.previousCorrectionCount = diagnostics.controller.corrections;
      accumulator.hasCorrectionBaseline = true;
    } else if (
      diagnostics.controller.corrections > accumulator.previousCorrectionCount
    ) {
      if (
        diagnostics.controller.lastCorrectionReason === "row-anchor" &&
        !virtualTimelineSnapshot.controllerState.nearBottom &&
        !streamingMessageId
      ) {
        recordDiagnosticsSample(
          accumulator.scrollCorrectionDeltasPx,
          diagnostics.controller.lastCorrectionDeltaPx,
        );
      }
      accumulator.previousCorrectionCount = diagnostics.controller.corrections;
    }

    const tailRowId = stableRows.at(-1)?.rowId;
    if (
      accumulator.firstVisibleTailMs == null &&
      tailRowId &&
      (hasLiveStreamingTail || diagnostics.visibleRowIds.includes(tailRowId))
    ) {
      accumulator.firstVisibleTailMs = elapsedMs;
    }

    updateHeapGrowthMetric(accumulator);

    const publishedDiagnostics = applyTimelineDiagnosticSamples(
      diagnostics,
      accumulator,
      elapsedMs,
    );
    const sharedDiagnostics =
      createTranscriptDiagnosticsFromVirtualTimelineDiagnostics(
        publishedDiagnostics,
        { elapsedMs },
      );

    onDiagnostics?.(publishedDiagnostics);
    onTranscriptDiagnostics?.(sharedDiagnostics);
    window.__GOOSE_TRANSCRIPT_VIRTUALIZATION_DIAGNOSTICS__ =
      publishedDiagnostics;
    window.__GOOSE_TRANSCRIPT_DIAGNOSTICS__ = sharedDiagnostics;
    window.dispatchEvent(
      new CustomEvent(VIRTUAL_MESSAGE_TIMELINE_DIAGNOSTICS_EVENT, {
        detail: publishedDiagnostics,
      }),
    );
    window.dispatchEvent(
      new CustomEvent(TRANSCRIPT_DIAGNOSTICS_EVENT, {
        detail: sharedDiagnostics,
      }),
    );

    accumulator.hasProjectionBaseline = true;
  }, [
    diagnostics,
    hasLiveStreamingTail,
    onDiagnostics,
    onTranscriptDiagnostics,
    stableRows,
    streamingMessageId,
    virtualTimelineSnapshot.controllerState.nearBottom,
  ]);

  useEffect(
    () => () => {
      projectionCacheRef.current?.cleanupSession(sessionId);
    },
    [sessionId],
  );

  // biome-ignore lint/correctness/useExhaustiveDependencies: sessionId is the reset signal for transient timeline UI state.
  useEffect(() => {
    setUserDetached(false);
    setLiveTailScrollHeightFloorPx(0);
    setPulsingMessageId(null);
  }, [sessionId]);

  const hasRealScrollableOverflow = useCallback((container: HTMLDivElement) => {
    return (
      Math.max(
        0,
        container.scrollHeight - messageListBottomPaddingPxRef.current,
      ) > container.clientHeight
    );
  }, []);

  const stopStreamingBottomFollow = useCallback(() => {
    streamingBottomFollowActiveRef.current = false;
    if (streamingBottomFollowFrameRef.current == null) {
      return;
    }

    cancelAnimationFrame(streamingBottomFollowFrameRef.current);
    streamingBottomFollowFrameRef.current = null;
  }, []);

  const setDetachedFromLatest = useCallback(
    (detached: boolean) => {
      // The jump-to-latest button is driven by this detached state. Only allow
      // the detached state when there is real content overflow to scroll to;
      // otherwise the docked composer's bottom padding can inflate scrollHeight
      // past clientHeight and surface the button with nothing to scroll to.
      if (detached) {
        const container = containerRef.current;
        if (!container || !hasRealScrollableOverflow(container)) {
          return;
        }
        stopStreamingBottomFollow();
        detachedScrollTopRef.current = container.scrollTop;
      } else {
        streamingTopPinActiveMessageIdRef.current = null;
        detachedScrollTopRef.current = null;
        liveTailHandoffRef.current = null;
        setLiveTailScrollHeightFloorPx(0);
      }

      if (userDetachedRef.current === detached) {
        return;
      }

      userDetachedRef.current = detached;
      setUserDetached(detached);
    },
    [hasRealScrollableOverflow, stopStreamingBottomFollow],
  );

  const getBottomScrollTop = useCallback((container: HTMLDivElement) => {
    return Math.max(0, container.scrollHeight - container.clientHeight);
  }, []);

  const scrollToBottom = useCallback(
    (behavior: ScrollBehavior = "smooth") => {
      const container = containerRef.current;
      if (!container) {
        return;
      }

      if (scrollVirtualToBottom(behavior)) {
        lastScrollTopRef.current = container.scrollTop;
        return;
      }

      const bottomScrollTop = getBottomScrollTop(container);
      if (typeof container.scrollTo === "function") {
        container.scrollTo({ top: bottomScrollTop, behavior });
        lastScrollTopRef.current = container.scrollTop;
        return;
      }

      container.scrollTop = bottomScrollTop;
      lastScrollTopRef.current = container.scrollTop;
    },
    [getBottomScrollTop, scrollVirtualToBottom],
  );

  useLayoutEffect(() => {
    scrollToBottomRef.current = scrollToBottom;
    resolvedScrollTargetMessageIdRef.current = resolvedScrollTargetMessageId;
    scheduledBottomScrollSessionIdRef.current = sessionId;
  });

  const cancelRequestedBottomScroll = useCallback(() => {
    if (bottomScrollFrameRef.current == null) {
      return;
    }

    cancelAnimationFrame(bottomScrollFrameRef.current);
    bottomScrollFrameRef.current = null;
  }, []);

  const cancelJumpToLatestAnimation = useCallback(() => {
    if (jumpToLatestFrameRef.current == null) {
      return;
    }

    cancelAnimationFrame(jumpToLatestFrameRef.current);
    jumpToLatestFrameRef.current = null;
  }, []);

  const requestBottomScroll = useCallback(() => {
    if (bottomScrollFrameRef.current != null) {
      return;
    }

    const requestedSessionId = scheduledBottomScrollSessionIdRef.current;
    bottomScrollFrameRef.current = requestAnimationFrame(() => {
      bottomScrollFrameRef.current = null;
      if (
        scheduledBottomScrollSessionIdRef.current !== requestedSessionId ||
        userDetachedRef.current ||
        resolvedScrollTargetMessageIdRef.current
      ) {
        return;
      }

      scrollToBottomRef.current("auto");
    });
  }, []);

  useLayoutEffect(
    () => () => {
      cancelRequestedBottomScroll();
      cancelJumpToLatestAnimation();
      stopStreamingBottomFollow();
    },
    [
      cancelRequestedBottomScroll,
      cancelJumpToLatestAnimation,
      stopStreamingBottomFollow,
    ],
  );

  const captureLiveTailHandoff = useCallback(
    (container: HTMLDivElement) => {
      if (!hasLiveStreamingTail) {
        return;
      }

      const distanceFromBottom = Math.max(
        0,
        getBottomScrollTop(container) - container.scrollTop,
      );
      liveTailHandoffRef.current =
        userDetachedRef.current ||
        distanceFromBottom >= AUTO_SCROLL_THRESHOLD_PX
          ? {
              distanceFromBottom,
              scrollHeight: container.scrollHeight,
              scrollTop: container.scrollTop,
            }
          : null;
    },
    [getBottomScrollTop, hasLiveStreamingTail],
  );

  const syncScrollState = useCallback(() => {
    const container = containerRef.current;
    if (!container) {
      return;
    }

    if (streamingMessageId && userScrollIntentRef.current) {
      streamingTopPinActiveMessageIdRef.current = null;
      streamingTopPinSuppressedMessageIdRef.current = streamingMessageId;
    }

    const preserveStreamingScrollPosition =
      streamingMessageId !== null && userDetachedRef.current;
    const virtualState = syncViewportFromDom({
      source: "browser",
      userScrollIntent: userScrollIntentRef.current,
      preserveScrollPosition: preserveStreamingScrollPosition,
    });
    if (virtualState) {
      const { scrollTop } = virtualState;
      isNearBottomRef.current = virtualState.nearBottom;

      if (
        streamingMessageId &&
        !userScrollIntentRef.current &&
        streamingTopPinActiveMessageIdRef.current === streamingMessageId &&
        !virtualState.nearBottom &&
        !isMessageVisibleInViewport(container, streamingMessageId)
      ) {
        streamingTopPinActiveMessageIdRef.current = null;
        streamingTopPinSuppressedMessageIdRef.current = streamingMessageId;
        stopStreamingBottomFollow();
      }

      const scrollDeltaDetached =
        scrollTop < lastScrollTopRef.current - 1 &&
        performance.now() > suppressScrollDeltaDetachUntilRef.current;
      if (
        virtualState.nearBottom &&
        (!userDetachedRef.current || scrollTop > lastScrollTopRef.current)
      ) {
        setDetachedFromLatest(false);
      } else if (userScrollIntentRef.current || scrollDeltaDetached) {
        // Explicit wheel/touch/pointer/keyboard intent detaches. Raw scrollTop
        // decreases also come from resize clamps and anchor corrections, so
        // the resize handler suppresses this fallback around geometry syncs.
        setDetachedFromLatest(true);
        stickyScrollUntilRef.current = 0;
      }

      lastScrollTopRef.current = scrollTop;
      userScrollIntentRef.current = false;
      captureLiveTailHandoff(container);
      return;
    }

    const { scrollTop, scrollHeight, clientHeight } = container;
    if (scrollHeight <= clientHeight) {
      isNearBottomRef.current = true;
      lastScrollTopRef.current = scrollTop;
      userScrollIntentRef.current = false;
      setDetachedFromLatest(false);
      return;
    }

    const distanceFromBottom = scrollHeight - scrollTop - clientHeight;
    isNearBottomRef.current = distanceFromBottom < AUTO_SCROLL_THRESHOLD_PX;

    const scrollDeltaDetached =
      scrollTop < lastScrollTopRef.current - 1 &&
      performance.now() > suppressScrollDeltaDetachUntilRef.current;
    if (
      isNearBottomRef.current &&
      (!userDetachedRef.current || scrollTop > lastScrollTopRef.current)
    ) {
      setDetachedFromLatest(false);
    } else if (userScrollIntentRef.current || scrollDeltaDetached) {
      // Mirrors the virtual path above.
      setDetachedFromLatest(true);
      stickyScrollUntilRef.current = 0;
    }

    lastScrollTopRef.current = scrollTop;
    userScrollIntentRef.current = false;
    captureLiveTailHandoff(container);
  }, [
    captureLiveTailHandoff,
    setDetachedFromLatest,
    streamingMessageId,
    stopStreamingBottomFollow,
    syncViewportFromDom,
  ]);

  const scrollToBottomIfNearBottom = useCallback(
    (behavior: ScrollBehavior = "smooth") => {
      const container = containerRef.current;
      if (!container || userDetachedRef.current) {
        return;
      }

      const distanceFromBottom = Math.max(
        0,
        virtualTimelineSnapshot.controllerState.distanceFromBottom,
      );
      const stickyActive = stickyScrollUntilRef.current > performance.now();

      if (
        !isNearBottomRef.current &&
        !stickyActive &&
        distanceFromBottom >= AUTO_SCROLL_THRESHOLD_PX
      ) {
        return;
      }

      scrollToBottom(behavior);
    },
    [
      scrollToBottom,
      virtualTimelineSnapshot.controllerState.distanceFromBottom,
    ],
  );

  const scheduleCappedStreamingBottomFollow = useCallback(() => {
    const container = containerRef.current;
    if (!container || userDetachedRef.current) {
      return;
    }

    const distanceFromBottom = Math.max(
      0,
      getBottomScrollTop(container) - container.scrollTop,
    );
    const stickyActive = stickyScrollUntilRef.current > performance.now();
    if (
      !streamingBottomFollowActiveRef.current &&
      !isNearBottomRef.current &&
      !stickyActive &&
      distanceFromBottom >= AUTO_SCROLL_THRESHOLD_PX
    ) {
      return;
    }

    streamingBottomFollowActiveRef.current = true;
    if (streamingBottomFollowFrameRef.current !== null) {
      return;
    }

    const step = () => {
      streamingBottomFollowFrameRef.current = null;

      const container = containerRef.current;
      if (
        !container ||
        userDetachedRef.current ||
        !streamingBottomFollowActiveRef.current
      ) {
        streamingBottomFollowActiveRef.current = false;
        return;
      }

      const bottomScrollTop = getBottomScrollTop(container);
      const distanceFromBottom = Math.max(
        0,
        bottomScrollTop - container.scrollTop,
      );
      if (distanceFromBottom <= 1) {
        streamingBottomFollowActiveRef.current = false;
        return;
      }

      container.scrollTop = Math.min(
        bottomScrollTop,
        container.scrollTop +
          Math.min(distanceFromBottom, STREAMING_BOTTOM_FOLLOW_MAX_STEP_PX),
      );
      lastScrollTopRef.current = container.scrollTop;

      if (bottomScrollTop - container.scrollTop > 1) {
        streamingBottomFollowFrameRef.current = requestAnimationFrame(step);
      } else {
        streamingBottomFollowActiveRef.current = false;
      }
    };

    streamingBottomFollowFrameRef.current = requestAnimationFrame(step);
  }, [getBottomScrollTop]);

  const preserveDetachedScrollPosition = useCallback(
    (container: HTMLDivElement) => {
      syncViewportFromDom({
        source: "browser",
        userScrollIntent: true,
        preserveScrollPosition: true,
      });
      lastScrollTopRef.current = container.scrollTop;
      isNearBottomRef.current = false;
      stickyScrollUntilRef.current = 0;
      setDetachedFromLatest(true);
    },
    [setDetachedFromLatest, syncViewportFromDom],
  );

  const activeStreamingMessage = streamingMessageId
    ? (snapshot.messageById.get(streamingMessageId) ?? null)
    : null;

  useLayoutEffect(() => {
    if (!activeStreamingMessage) {
      return;
    }

    if (activeStreamingMessage.role !== "assistant") {
      return;
    }

    const topPinActive =
      streamingTopPinActiveMessageIdRef.current === activeStreamingMessage.id;
    if (userDetachedRef.current && !topPinActive) {
      return;
    }

    if (
      streamingTopPinSuppressedMessageIdRef.current ===
        activeStreamingMessage.id &&
      !topPinActive
    ) {
      return;
    }

    const container = containerRef.current;
    if (!container) {
      return;
    }
    const liveDistanceFromBottom = Math.max(
      0,
      getBottomScrollTop(container) - container.scrollTop,
    );
    const stickyActive = stickyScrollUntilRef.current > performance.now();
    if (
      !topPinActive &&
      !stickyActive &&
      liveDistanceFromBottom >= AUTO_SCROLL_THRESHOLD_PX
    ) {
      return;
    }
    if (
      topPinActive &&
      !isMessageVisibleInViewport(container, activeStreamingMessage.id)
    ) {
      streamingTopPinActiveMessageIdRef.current = null;
      streamingTopPinSuppressedMessageIdRef.current = activeStreamingMessage.id;
      return;
    }

    const streamingRows = getRowsForMessage(
      stableRows,
      activeStreamingMessage.id,
    );
    const firstStreamingRow = streamingRows[0];
    if (!firstStreamingRow) {
      return;
    }

    const projectedHeight = getStreamingMessageProjectedHeight({
      container,
      messageId: activeStreamingMessage.id,
      rows: streamingRows,
    });
    if (
      projectedHeight <= container.clientHeight ||
      container.clientHeight <= 0
    ) {
      return;
    }

    stopStreamingBottomFollow();

    const scrolledVirtualRow = scrollVirtualToRow(
      firstStreamingRow.rowId,
      "start",
    );
    if (scrolledVirtualRow) {
      // Activate top-pin only after a real top-pin. The
      // live streaming tail can briefly be tall enough before its row is
      // scrollable/mounted; activating before success would skip the retry.
      streamingTopPinActiveMessageIdRef.current = activeStreamingMessage.id;
      container.scrollTop = Math.max(
        0,
        container.scrollTop - STREAMING_MESSAGE_TOP_OFFSET_PX,
      );
      preserveDetachedScrollPosition(container);
      return;
    }

    const firstMountedRow = getMountedMessageRows(
      container,
      activeStreamingMessage.id,
    ).at(0);
    if (firstMountedRow) {
      streamingTopPinActiveMessageIdRef.current = activeStreamingMessage.id;
      container.scrollTop = Math.max(
        0,
        firstMountedRow.offsetTop - STREAMING_MESSAGE_TOP_OFFSET_PX,
      );
      preserveDetachedScrollPosition(container);
    }
  }, [
    activeStreamingMessage,
    getBottomScrollTop,
    preserveDetachedScrollPosition,
    scrollVirtualToRow,
    stableRows,
    stopStreamingBottomFollow,
  ]);

  useLayoutEffect(() => {
    if (lastAutoScrollMessagesRef.current === messages) {
      return;
    }
    lastAutoScrollMessagesRef.current = messages;

    if (messages.length === 0) {
      return;
    }
    if (userDetachedRef.current) {
      return;
    }

    if (streamingMessageId) {
      scheduleCappedStreamingBottomFollow();
      return;
    }

    scrollToBottomIfNearBottom();
  }, [
    messages,
    scheduleCappedStreamingBottomFollow,
    scrollToBottomIfNearBottom,
    streamingMessageId,
  ]);

  useLayoutEffect(() => {
    if (!hasFooter) {
      setFooterHeightPx(0);
      return;
    }

    const footerElement = footerRef.current;
    if (!footerElement) {
      return;
    }

    const updateFooterHeight = () => {
      setFooterHeightPx(
        Math.ceil(footerElement.getBoundingClientRect().height),
      );
    };

    updateFooterHeight();

    if (typeof ResizeObserver === "undefined") {
      return;
    }

    const resizeObserver = new ResizeObserver(updateFooterHeight);
    resizeObserver.observe(footerElement);
    return () => resizeObserver.disconnect();
  }, [hasFooter]);

  useLayoutEffect(() => {
    const container = containerRef.current;
    if (!container) {
      return;
    }

    const syncAfterResize = () => {
      suppressScrollDeltaDetachUntilRef.current =
        performance.now() + RESIZE_SCROLL_SUPPRESSION_MS;
      const wasPinnedToLatest =
        !userDetachedRef.current &&
        (isNearBottomRef.current ||
          stickyScrollUntilRef.current > performance.now());

      // Remeasure every visible row at the new width and let the controller
      // reconcile the anchor against the rewrapped layout, all before this
      // frame paints. Partially remeasured layouts are what read as content
      // "jumping around" during continuous resizes.
      const scrollTopBeforeResize =
        detachedScrollTopRef.current ?? container.scrollTop;
      syncViewportFromDom({ source: "programmatic" });
      remeasureVisibleRowsSync();

      if (wasPinnedToLatest) {
        scrollToBottom("auto");
        syncScrollState();
        return;
      }

      let virtualState = syncViewportFromDom({ source: "programmatic" });
      if (
        virtualState &&
        userDetachedRef.current &&
        virtualState.anchor.type === "bottom" &&
        Math.abs(container.scrollTop - scrollTopBeforeResize) > 1
      ) {
        // The user detached through wheel intent before the controller
        // captured a row anchor, so bottom reconciliation dragged them along.
        // Restore the detached position and capture a row anchor there.
        container.scrollTop = scrollTopBeforeResize;
        virtualState =
          syncViewportFromDom({
            source: "browser",
            userScrollIntent: true,
          }) ?? virtualState;
      }
      if (!virtualState) {
        syncScrollState();
        return;
      }

      isNearBottomRef.current = virtualState.nearBottom;
      if (userDetachedRef.current) {
        detachedScrollTopRef.current = container.scrollTop;
        if (virtualState.pinnedToBottom) {
          setDetachedFromLatest(false);
        }
      }
      lastScrollTopRef.current = virtualState.scrollTop;
      userScrollIntentRef.current = false;
    };

    // ResizeObserver callbacks run after layout and before paint, so the
    // anchor reconciliation lands in the same frame as the resize itself.
    const resizeObserver =
      typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver(syncAfterResize);

    resizeObserver?.observe(container);
    window.addEventListener("resize", syncAfterResize);
    return () => {
      resizeObserver?.disconnect();
      window.removeEventListener("resize", syncAfterResize);
    };
  }, [
    remeasureVisibleRowsSync,
    scrollToBottom,
    setDetachedFromLatest,
    syncScrollState,
    syncViewportFromDom,
  ]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: footerHeightPx is the resize signal for this effect.
  useLayoutEffect(() => {
    if (!hasFooter && tailPaddingPx == null) {
      return;
    }
    if (userDetachedRef.current) {
      return;
    }
    requestBottomScroll();
  }, [footerHeightPx, hasFooter, requestBottomScroll, tailPaddingPx]);

  const latestMessage = useMemo(() => {
    for (let index = stableRows.length - 1; index >= 0; index -= 1) {
      const row = stableRows[index];
      if (
        (row.kind === "message" || row.kind === "assistant-content-fragment") &&
        row.messageId
      ) {
        return stableMessageByRowId.get(row.rowId) ?? null;
      }
    }
    return null;
  }, [stableMessageByRowId, stableRows]);
  const latestMessageId = latestMessage?.id;

  useEffect(() => {
    if (!resolvedScrollTargetMessageId) {
      return;
    }

    if (resolvedScrollTargetMessageId === latestMessageId) {
      setDetachedFromLatest(false);
    } else {
      setDetachedFromLatest(true);
      stickyScrollUntilRef.current = 0;
    }

    const currentTarget = messageRefs.current[resolvedScrollTargetMessageId];
    const targetRowId = snapshot.rowByMessageId.get(
      resolvedScrollTargetMessageId,
    );
    if (!currentTarget && targetRowId) {
      scrollVirtualToRow(targetRowId, "center");
    } else if (!currentTarget) {
      return;
    }

    const frame = requestAnimationFrame(() => {
      const target = messageRefs.current[resolvedScrollTargetMessageId];
      if (!target) {
        return;
      }
      target.scrollIntoView({
        block: "center",
        behavior: "smooth",
      });
      setPulsingMessageId(resolvedScrollTargetMessageId);
      onScrollTargetHandled?.(resolvedScrollTargetMessageId);
    });

    return () => cancelAnimationFrame(frame);
  }, [
    latestMessageId,
    onScrollTargetHandled,
    resolvedScrollTargetMessageId,
    scrollVirtualToRow,
    setDetachedFromLatest,
    snapshot.rowByMessageId,
  ]);

  useEffect(() => {
    if (!pulsingMessageId) {
      return;
    }

    const timer = window.setTimeout(() => {
      setPulsingMessageId((current) =>
        current === pulsingMessageId ? null : current,
      );
    }, 2000);

    return () => window.clearTimeout(timer);
  }, [pulsingMessageId]);

  useEffect(() => {
    if (!latestMessageId || latestMessage?.role !== "user") {
      return;
    }

    const latestUserKey = `${sessionId}\0${latestMessageId}`;
    if (lastLatestUserAutoScrollKeyRef.current === latestUserKey) {
      return;
    }
    lastLatestUserAutoScrollKeyRef.current = latestUserKey;

    setDetachedFromLatest(false);
    scrollToBottom("auto");
  }, [
    latestMessageId,
    latestMessage?.role,
    sessionId,
    scrollToBottom,
    setDetachedFromLatest,
  ]);

  const requestMcpAppAutoScroll = useCallback(
    (element: HTMLElement | null) => {
      const container = containerRef.current;
      if (!container || !element || userDetachedRef.current) {
        return;
      }

      const distanceFromBottom =
        container.scrollHeight - container.scrollTop - container.clientHeight;
      const shouldStick =
        isNearBottomRef.current ||
        distanceFromBottom < AUTO_SCROLL_THRESHOLD_PX ||
        stickyScrollUntilRef.current > performance.now();

      if (!shouldStick) {
        return;
      }

      stickyScrollUntilRef.current =
        performance.now() + MCP_APP_STICKY_SCROLL_MS;

      const alignElementBottom = () => {
        const nextContainer = containerRef.current;
        if (!nextContainer || !element.isConnected) {
          return;
        }
        if (userDetachedRef.current) {
          return;
        }

        if (nextContainer.scrollTop < lastScrollTopRef.current - 1) {
          stickyScrollUntilRef.current = 0;
          return;
        }

        const distanceFromBottom =
          nextContainer.scrollHeight -
          nextContainer.scrollTop -
          nextContainer.clientHeight;
        const shouldStillStick =
          isNearBottomRef.current ||
          distanceFromBottom < AUTO_SCROLL_THRESHOLD_PX ||
          stickyScrollUntilRef.current > performance.now();

        if (!shouldStillStick) {
          return;
        }

        const containerRect = nextContainer.getBoundingClientRect();
        const elementRect = element.getBoundingClientRect();
        const footerRect = footerRef.current?.getBoundingClientRect();
        const visibleBottom = footerRect
          ? Math.min(containerRect.bottom, footerRect.top)
          : containerRect.bottom;
        const delta = elementRect.bottom - visibleBottom + 16;

        if (delta > 0) {
          nextContainer.scrollBy({
            top: delta,
            behavior: "auto",
          });
          syncViewportFromDom({ source: "correction" });
        }
      };

      alignElementBottom();
      requestAnimationFrame(alignElementBottom);
    },
    [syncViewportFromDom],
  );

  const handleReactCommit = useCallback<ProfilerOnRenderCallback>(
    (_id, _phase, actualDuration, _baseDuration, startTime, commitTime) => {
      const measuredDuration = Number.isFinite(actualDuration)
        ? actualDuration
        : commitTime - startTime;
      recordDiagnosticsSample(
        diagnosticsAccumulatorRef.current.reactCommitDurationsMs,
        measuredDuration,
      );
      recordTimingSample(diagnosticsAccumulatorRef.current.reactCommitSamples, {
        startTime: Math.max(0, commitTime - measuredDuration),
        endTime: commitTime,
        durationMs: measuredDuration,
        source: "react-profiler",
      });
    },
    [],
  );

  const handleScroll = () => {
    const startedAt = getDiagnosticsNowMs();
    try {
      syncScrollState();
    } finally {
      const endedAt = getDiagnosticsNowMs();
      recordDiagnosticsSample(
        diagnosticsAccumulatorRef.current.scrollHandlerDurationsMs,
        endedAt - startedAt,
      );
      recordTimingSample(
        diagnosticsAccumulatorRef.current.scrollHandlerSamples,
        {
          startTime: startedAt,
          endTime: endedAt,
          durationMs: endedAt - startedAt,
          source: "virtual-timeline-scroll-handler",
        },
      );
    }
  };

  const handleStreamingUserScrollIntent = () => {
    if (!streamingMessageId) {
      return;
    }

    streamingTopPinSuppressedMessageIdRef.current = streamingMessageId;
    streamingTopPinActiveMessageIdRef.current = null;
    stopStreamingBottomFollow();
    stickyScrollUntilRef.current = 0;
    setDetachedFromLatest(true);
    syncViewportFromDom({
      source: "browser",
      userScrollIntent: true,
      preserveScrollPosition: true,
    });
  };

  const handleWheel = (event: WheelEvent<HTMLDivElement>) => {
    if (footerRef.current?.contains(event.target as Node)) {
      return;
    }

    const container = containerRef.current;
    if (!container) {
      return;
    }

    if (container.scrollHeight <= container.clientHeight) {
      syncScrollState();
      return;
    }

    userScrollIntentRef.current = true;
    handleStreamingUserScrollIntent();

    if (event.deltaY < 0) {
      setDetachedFromLatest(true);
      stickyScrollUntilRef.current = 0;
      // Push the detach into the controller immediately so it captures a row
      // anchor at the current position. Otherwise the controller can keep a
      // stale bottom anchor (the scroll event may not change scrollTop), and
      // the next geometry reconciliation would drag the user back to the
      // bottom they just scrolled away from.
      syncViewportFromDom({ source: "browser", userScrollIntent: true });
    }
  };

  const handleUserScrollIntent = (event: SyntheticEvent) => {
    if (footerRef.current?.contains(event.target as Node)) {
      return;
    }
    userScrollIntentRef.current = true;
    if (event.type !== "pointerdown") {
      handleStreamingUserScrollIntent();
    }
    // A real wheel/touch interrupts an in-flight jump-to-latest glide so the
    // user keeps control of the scroll position.
    cancelJumpToLatestAnimation();
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (footerRef.current?.contains(event.target as Node)) {
      return;
    }

    switch (event.key) {
      case "ArrowDown":
      case "ArrowUp":
      case "End":
      case "Home":
      case "PageDown":
      case "PageUp":
      case " ":
      case "Spacebar":
        userScrollIntentRef.current = true;
        handleStreamingUserScrollIntent();
        cancelJumpToLatestAnimation();
        break;
      default:
        break;
    }
  };

  const handleJumpToLatest = () => {
    if (streamingMessageId) {
      streamingTopPinSuppressedMessageIdRef.current = streamingMessageId;
    }
    streamingTopPinActiveMessageIdRef.current = null;
    setDetachedFromLatest(false);
    isNearBottomRef.current = true;

    const container = containerRef.current;
    cancelJumpToLatestAnimation();

    // While streaming the bottom is a moving target (the follow logic owns it),
    // and reduced-motion users want no glide — both take the instant path.
    if (
      streamingMessageId ||
      !container ||
      window.matchMedia(REDUCED_MOTION_QUERY).matches
    ) {
      scrollToBottom(streamingMessageId ? "auto" : "smooth");
      if (streamingMessageId) {
        scheduleCappedStreamingBottomFollow();
      }
      return;
    }

    const startScrollTop = container.scrollTop;
    const initialBottom = getBottomScrollTop(container);
    if (Math.abs(initialBottom - startScrollTop) <= 1) {
      scrollToBottom("auto");
      return;
    }

    // Drive scrollTop directly with an eased rAF loop (mirrors the classic
    // renderer). The native "smooth" path can't be used here because the
    // virtual controller synchronously corrects scrollTop, snapping the glide.
    let startTime: number | null = null;
    const animate = (now: number) => {
      const nextContainer = containerRef.current;
      if (!nextContainer) {
        jumpToLatestFrameRef.current = null;
        return;
      }
      startTime ??= now;
      const progress = Math.min(
        1,
        (now - startTime) / JUMP_TO_LATEST_SCROLL_MS,
      );
      const bottomScrollTop = getBottomScrollTop(nextContainer);
      nextContainer.scrollTop =
        startScrollTop +
        (bottomScrollTop - startScrollTop) * easeOutCubic(progress);
      if (progress < 1) {
        jumpToLatestFrameRef.current = requestAnimationFrame(animate);
        return;
      }
      jumpToLatestFrameRef.current = null;
      // Final exact landing through the controller so virtual state, position,
      // and detached flag all settle on the true bottom.
      scrollToBottom("auto");
    };
    jumpToLatestFrameRef.current = requestAnimationFrame(animate);
  };
  const registerMessageElement = useCallback(
    (messageId: string, element: HTMLDivElement | null) => {
      messageRefs.current[messageId] = element;
    },
    [],
  );

  const jumpToLatestLabel = t("timeline.jumpToLatest");
  const hasFooterStatus = footerStatus != null;
  const jumpToLatestButton = userDetached ? (
    <MessageTimelineJumpToLatestButton
      compact={hasFooterStatus}
      label={jumpToLatestLabel}
      onClick={handleJumpToLatest}
    />
  ) : null;
  const footerControlRow = footer ? (
    <MessageTimelineFooterControlRow
      footerStatus={footerStatus}
      jumpToLatestButton={jumpToLatestButton}
    />
  ) : null;
  const bubbleCallbacks = useMemo<MessageBubbleCallbacks>(
    () => ({
      onRetryMessage,
      onEditMessage,
      onSendMcpAppMessage,
      onMcpAppAutoScroll: requestMcpAppAutoScroll,
      onRunShellCommand,
      onEditProject,
      onOpenContextPanel,
    }),
    [
      onRetryMessage,
      onEditMessage,
      onSendMcpAppMessage,
      requestMcpAppAutoScroll,
      onRunShellCommand,
      onEditProject,
      onOpenContextPanel,
    ],
  );

  const renderRow = (
    row: TranscriptRowDescriptor,
    index: number,
    virtualItem?: TranscriptVirtualItem,
  ) => (
    <VirtualTranscriptRow
      key={row.reactKey}
      row={row}
      index={index}
      previousRowKind={stableRows[index - 1]?.kind}
      layoutMode={virtualItem ? "virtual" : "flow"}
      virtualItem={virtualItem}
      measurementPlan={measurementPlanByRowId.get(row.rowId)}
      dateLabel={formatDateSeparator(snapshot, index, {
        today: t("timeline.today"),
        yesterday: t("timeline.yesterday"),
        formatDate,
      })}
      message={row.messageId ? stableMessageByRowId.get(row.rowId) : undefined}
      isStreaming={
        streamingMessageId != null && row.messageId === streamingMessageId
      }
      isPulsing={row.messageId === pulsingMessageId}
      rowStateProvider={virtualTimeline.rowStateProvider}
      bubbleCallbacks={bubbleCallbacks}
      measureRowElement={
        virtualItem || !isBoundedVirtualMode ? measureRowElement : undefined
      }
      registerRowElement={registerSearchRowElement}
      registerMessageElement={registerMessageElement}
    />
  );
  const renderedVirtualRows = isBoundedVirtualMode
    ? virtualTimelineSnapshot.range.virtualItems.map((virtualItem) =>
        renderRow(virtualItem.row, virtualItem.index, virtualItem),
      )
    : virtualRows.map((row, index) => renderRow(row, index));
  const renderedLiveStreamingTailRows = liveStreamingTailRows.map(
    (row, tailIndex) => renderRow(row, liveStreamingTailStartIndex + tailIndex),
  );
  const lastRenderedVirtualItem = isBoundedVirtualMode
    ? virtualTimelineSnapshot.range.virtualItems.at(-1)
    : undefined;
  const measuredTailScrollHeight =
    !hasLiveStreamingTail &&
    lastRenderedVirtualItem?.index === virtualRows.length - 1
      ? lastRenderedVirtualItem.end + messageListBottomPaddingPx
      : null;
  const virtualScrollHeight = virtualTimelineSnapshot.range.scrollHeight;
  const measuredEffectiveVirtualScrollHeight =
    measuredTailScrollHeight == null
      ? virtualScrollHeight
      : Math.max(virtualScrollHeight, measuredTailScrollHeight);
  const effectiveVirtualScrollHeight = Math.max(
    measuredEffectiveVirtualScrollHeight,
    liveTailScrollHeightFloorPx,
  );
  const virtualHistoryStyle = isBoundedVirtualMode
    ? {
        height: effectiveVirtualScrollHeight,
        position: "relative" as const,
        overflowAnchor: "none" as const,
      }
    : undefined;
  const messageListStyle = isBoundedVirtualMode
    ? {
        paddingBottom: hasLiveStreamingTail ? messageListBottomPaddingPx : 0,
        overflowAnchor: "none" as const,
      }
    : { paddingBottom: messageListBottomPaddingPx };

  useLayoutEffect(() => {
    if (!isBoundedVirtualMode) {
      liveTailHandoffRef.current = null;
      setLiveTailScrollHeightFloorPx(0);
      return;
    }

    const container = containerRef.current;
    if (!container) {
      return;
    }

    if (hasLiveStreamingTail) {
      if (liveTailScrollHeightFloorPx !== 0) {
        setLiveTailScrollHeightFloorPx(0);
      }
      captureLiveTailHandoff(container);
      return;
    }

    const handoff = liveTailHandoffRef.current;
    if (
      !handoff ||
      handoff.distanceFromBottom < AUTO_SCROLL_THRESHOLD_PX ||
      streamingMessageId
    ) {
      if (
        liveTailScrollHeightFloorPx > 0 &&
        measuredEffectiveVirtualScrollHeight >= liveTailScrollHeightFloorPx
      ) {
        setLiveTailScrollHeightFloorPx(0);
      }
      return;
    }

    const nextScrollHeightFloor = Math.max(0, Math.ceil(handoff.scrollHeight));
    if (liveTailScrollHeightFloorPx < nextScrollHeightFloor) {
      setLiveTailScrollHeightFloorPx(nextScrollHeightFloor);
      return;
    }

    liveTailHandoffRef.current = null;

    const nextScrollTop = Math.min(
      getBottomScrollTop(container),
      Math.max(0, handoff.scrollTop),
    );
    container.scrollTop = nextScrollTop;
    const distanceFromBottom = Math.max(
      0,
      getBottomScrollTop(container) - container.scrollTop,
    );

    isNearBottomRef.current = distanceFromBottom < AUTO_SCROLL_THRESHOLD_PX;
    lastScrollTopRef.current = container.scrollTop;
    userScrollIntentRef.current = true;

    if (distanceFromBottom >= AUTO_SCROLL_THRESHOLD_PX) {
      stickyScrollUntilRef.current = 0;
      setDetachedFromLatest(true);
    } else {
      setDetachedFromLatest(false);
    }
    syncViewportFromDom({ source: "browser", userScrollIntent: true });
  }, [
    captureLiveTailHandoff,
    getBottomScrollTop,
    hasLiveStreamingTail,
    isBoundedVirtualMode,
    liveTailScrollHeightFloorPx,
    measuredEffectiveVirtualScrollHeight,
    setDetachedFromLatest,
    streamingMessageId,
    syncViewportFromDom,
  ]);

  useLayoutEffect(() => {
    if (!isBoundedVirtualMode || streamingMessageId) {
      lastEffectiveVirtualScrollHeightRef.current = null;
      return;
    }
    const previousHeight = lastEffectiveVirtualScrollHeightRef.current;
    lastEffectiveVirtualScrollHeightRef.current = effectiveVirtualScrollHeight;
    if (
      previousHeight != null &&
      Math.abs(previousHeight - effectiveVirtualScrollHeight) <= 1
    ) {
      return;
    }
    if (resolvedScrollTargetMessageId || userDetachedRef.current) {
      return;
    }
    requestBottomScroll();
  }, [
    effectiveVirtualScrollHeight,
    isBoundedVirtualMode,
    requestBottomScroll,
    resolvedScrollTargetMessageId,
    streamingMessageId,
  ]);

  const messageList = (
    <div
      data-testid="virtual-message-timeline-list"
      data-virtual-render-mode={virtualTimelineSnapshot.mode}
      data-virtual-engine={virtualTimelineSnapshot.engineKind}
      data-virtual-unmounting={
        isBoundedVirtualMode ? "enabled" : "safe-degraded"
      }
      data-virtual-total-rows={stableRows.length}
      data-virtual-fragment-rows={snapshot.fragmentRowCount}
      data-virtual-completed-fragment-rows={snapshot.completedFragmentRowCount}
      data-virtual-completed-streaming-fragment-rows={
        snapshot.completedStreamingFragmentRowCount
      }
      data-virtual-streaming-tail-rows={snapshot.streamingTailRowCount}
      data-virtual-live-tail-rows={liveStreamingTailRows.length}
      data-virtual-live-tail-start-index={
        hasLiveStreamingTail ? liveStreamingTailStartIndex : undefined
      }
      data-virtual-whole-message-fallback-rows={
        snapshot.wholeMessageFallbackRowCount
      }
      data-virtual-mounted-rows={mountedRows}
      data-virtual-range-mounted-rows={virtualRangeMountedRows}
      data-virtual-offscreen-shell-mounted-rows={offscreenShellMountedRows}
      data-virtual-protected-rows={
        virtualTimelineSnapshot.range.protectedRowIds.length
      }
      data-virtual-protected-offscreen-rows={virtualProtectedOffscreenRows}
      data-virtual-visible-start={
        virtualTimelineSnapshot.range.visibleRange.startIndex
      }
      data-virtual-visible-end={
        virtualTimelineSnapshot.range.visibleRange.endIndex
      }
      data-virtual-render-start={
        virtualTimelineSnapshot.range.renderRange.startIndex
      }
      data-virtual-render-end={
        virtualTimelineSnapshot.range.renderRange.endIndex
      }
      data-virtual-fallback-reasons={virtualTimelineSnapshot.fallbackReasons.join(
        ",",
      )}
      className={cn(
        "mx-auto w-full max-w-[var(--chat-transcript-container-max-width)] px-[var(--chat-transcript-inline-padding)] pt-4",
        isBoundedVirtualMode ? "shrink-0" : "flex-1",
      )}
      style={messageListStyle}
    >
      {isBoundedVirtualMode ? (
        <div
          data-testid="virtual-message-timeline-history"
          data-virtual-history-rows={virtualRows.length}
          style={virtualHistoryStyle}
        >
          <TranscriptOffscreenShellMeasurementHost
            rows={offscreenShellMeasurementRows}
            onMeasureShellRow={measureOffscreenShellElement}
          />
          {renderedVirtualRows}
        </div>
      ) : (
        renderedVirtualRows
      )}
      {hasLiveStreamingTail ? (
        <div
          data-testid="virtual-message-timeline-live-tail"
          data-virtual-live-tail-rows={liveStreamingTailRows.length}
        >
          {renderedLiveStreamingTailRows}
        </div>
      ) : null}
    </div>
  );

  const showPlaceholderContent = showPlaceholder || !hasMessageRows;
  const content = showPlaceholderContent ? (
    <TranscriptSearchSkip>
      {placeholder ?? <MessageTimelineEmptyState />}
    </TranscriptSearchSkip>
  ) : (
    messageList
  );

  return (
    <Profiler id="VirtualMessageTimeline" onRender={handleReactCommit}>
      <div
        data-testid="virtual-message-timeline"
        className={cn(
          "relative flex min-h-0 flex-1 flex-col overflow-visible",
          className,
        )}
      >
        {hasFooter ? (
          <div
            aria-hidden="true"
            data-testid="message-timeline-surface"
            className="pointer-events-none absolute inset-x-0 top-0 bottom-[calc(var(--chat-surface-bottom-gap)*2)] rounded-md bg-card"
          />
        ) : null}
        {searchHarvestHost}
        <MessageTimelineScrollContainer
          ref={containerRef}
          hasFooter={hasFooter}
          onScroll={handleScroll}
          onWheel={handleWheel}
          onTouchMove={handleUserScrollIntent}
          onPointerDown={handleUserScrollIntent}
          onKeyDown={handleKeyDown}
          style={{ overflowAnchor: "none" }}
        >
          <div className="flex min-h-full flex-col">
            <div
              ref={setSearchListRoot}
              className="flex min-h-0 flex-1 flex-col"
              role="log"
              aria-label={t("timeline.ariaLabel")}
              aria-live="polite"
            >
              {content}
            </div>
          </div>
        </MessageTimelineScrollContainer>
        {footer ? (
          <div
            ref={footerRef}
            data-testid="message-timeline-footer"
            className="pointer-events-none relative z-10 flex shrink-0 flex-col pb-[var(--chat-surface-bottom-gap)]"
          >
            {footerControlRow}
            {footer}
          </div>
        ) : null}
        {!footer && jumpToLatestButton ? (
          <div
            className="absolute left-1/2 -translate-x-1/2"
            style={{ bottom: (tailPaddingPx ?? 16) + 8 }}
          >
            {jumpToLatestButton}
          </div>
        ) : null}
      </div>
    </Profiler>
  );
}

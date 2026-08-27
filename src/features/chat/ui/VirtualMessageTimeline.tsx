import {
  Profiler,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type MutableRefObject,
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
import { selectResponseFeedbackRowIds } from "../response-feedback/responseFeedbackRows";
import type { ActiveSessionFeedbackSurvey } from "../response-feedback/sessionFeedbackSurveyState";
import { ASSISTIVE_UX_RULES } from "@/shared/assistive-ux/registry";
import {
  hasAssistiveMomentBeenShown,
  recordAssistiveMomentAccepted,
  recordAssistiveMomentRetired,
  recordAssistiveMomentShown,
  shouldShowAssistiveMoment,
} from "@/shared/assistive-ux/runtime";
import {
  toDateBucket,
  type TranscriptProjectionSnapshot,
  type TranscriptRowDescriptor,
} from "../transcript/projection";
import { useResponseStartGutterPreference } from "@/features/chat/lib/responseStartGutterPreference";
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
import {
  TRANSCRIPT_SELECTION_SURFACE_ATTRIBUTES,
  type TranscriptCorrectionReason,
  type TranscriptVirtualItem,
} from "../transcript/virtual";
import {
  createLoadedTranscriptState,
  useTranscriptVirtualTimeline,
  type LoadedTranscriptState,
  type TranscriptVirtualTimelineRowStateControls,
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
  MessageTimelineJumpToResponseStartGutterButton,
  REDUCED_MOTION_QUERY,
  RESPONSE_START_HINT_HIDE_DELAY_MS,
  getTimelineMessageIdentity,
  getVoiceSubmissionKey,
  isResponseStartHintInRelevanceBand,
  useStickyFlag,
  type MessageBubbleCallbacks,
  type MessageTimelineBubbleCallbacks,
} from "./messageTimelineShared";
import {
  getTimelineBottomScrollTop,
  hasTimelineRealScrollableOverflow,
  isTimelineNearLatest,
  isTimelinePinnedToLatest,
  shouldShowTimelineJumpToLatest,
  TIMELINE_AUTO_SCROLL_THRESHOLD_PX,
  TIMELINE_MCP_APP_STICKY_SCROLL_MS,
  type TimelineScrollIntent,
} from "./timelineScrollIntent";
import { getVirtualTranscriptRowSpacingBlockSize } from "./virtualTranscriptRowSpacing";
import {
  MAX_BLANK_VIEWPORT_RECOVERY_ATTEMPTS,
  type TranscriptBrowserRowCoverage,
} from "../transcript/virtual/browserViewport";

const RESIZE_SCROLL_SUPPRESSION_MS = 250;
const DOCKED_FOOTER_BOTTOM_PADDING_PX = 44;
const LIVE_TAIL_BOTTOM_PADDING_PX = 60;
const STREAMING_BOTTOM_FOLLOW_MAX_STEP_PX = 48;
const SCROLL_TARGET_MOUNT_RETRY_FRAMES = 120;
const SCROLL_TARGET_VISIBLE_SETTLE_FRAMES = 8;
const RESPONSE_START_HINT_VIEWPORT_SLOP_PX = 16;
// How far an assistant message's top must scroll above the viewport edge
// before the floating gutter chevron offers to jump back to its start.
const GUTTER_RESPONSE_START_THRESHOLD_PX = 16;

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
  offscreenRealMountedRows: number;
  offscreenShellMountedRows: number;
  protectedRows: number;
  protectedOffscreenRows: number;
  forcedProtectedRowCount: number;
  mcpCandidateCount: number;
  mcpProtectedRowCount: number;
  recentCandidateCount: number;
  recentProtectedRowCount: number;
  evictedMcpRowCount: number;
  evictedRecentRowCount: number;
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
  browserIntersectingRealRows: number;
  browserRealRows: number;
  blankViewportRecoveryAttempts: number;
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
  loadedTranscript?: LoadedTranscriptState;
  sessionId: string;
  messages: Message[];
  streamingMessageId?: string | null;
  sessionFeedbackSurvey?: ActiveSessionFeedbackSurvey | null;
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
  virtualTimelineControlsRef?: MutableRefObject<TranscriptVirtualTimelineRowStateControls | null>;
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

interface OffscreenRealMeasurementRow {
  index: number;
  row: TranscriptRowDescriptor;
}

interface LiveStreamingTailSplit {
  historyRows: readonly TranscriptRowDescriptor[];
  liveRows: readonly TranscriptRowDescriptor[];
  startIndex: number;
}

function rowOwnsSessionFeedbackSurvey(
  row: TranscriptRowDescriptor,
  responseFeedbackRowIds: ReadonlySet<string>,
  survey: ActiveSessionFeedbackSurvey | null | undefined,
): boolean {
  return Boolean(
    survey &&
      responseFeedbackRowIds.has(row.rowId) &&
      (row.responseStartMessageId ?? row.messageId) === survey.messageId,
  );
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
        // A fixed transform can leak content taller than its hoist into the
        // scroll range. A zero-height clipped host contains any content size
        // while its children still lay out for measurement.
        height: 0,
        insetInlineStart: 0,
        overflow: "clip",
        pointerEvents: "none",
        position: "absolute",
        top: 0,
        userSelect: "none",
        visibility: "hidden",
        WebkitUserSelect: "none",
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

function TranscriptOffscreenRealMeasurementHost({
  children,
  rowCount,
}: {
  children: ReactNode;
  rowCount: number;
}) {
  if (rowCount === 0) {
    return null;
  }

  return (
    <div
      aria-hidden="true"
      data-transcript-search-skip=""
      data-testid="virtual-offscreen-real-measurement-host"
      data-virtual-offscreen-real-row-count={rowCount}
      style={{
        contain: "layout style paint",
        // Match the shell host's content-height-independent containment.
        height: 0,
        insetInlineStart: 0,
        overflow: "clip",
        pointerEvents: "none",
        position: "absolute",
        top: 0,
        userSelect: "none",
        visibility: "hidden",
        WebkitUserSelect: "none",
        width: "100%",
      }}
    >
      {children}
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
      data-virtual-row-shell-unique-token={`offscreen-shell-token-${row.row.messageId ?? row.row.rowId}`}
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
  previousProjectionRowsById: ReadonlyMap<
    string,
    TranscriptRowDescriptor
  > | null;
  previousProjectionSessionId: string | null;
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
    previousProjectionRowsById: null,
    previousProjectionSessionId: null,
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
    (row) => row.messageId === liveStartMessageId && isMessageTurnRow(row),
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

function isMessageTurnRow(row: TranscriptRowDescriptor): boolean {
  return (
    Boolean(row.messageId) &&
    (row.kind === "message" ||
      row.kind === "assistant-content-fragment" ||
      row.kind === "agent-work")
  );
}

function getRowsForMessage(
  rows: readonly TranscriptRowDescriptor[],
  messageId: string,
): readonly TranscriptRowDescriptor[] {
  return rows.filter(
    (row) => row.messageId === messageId && isMessageTurnRow(row),
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
    descriptorChurnPercent:
      accumulator.previousProjectionRowsById == null ||
      accumulator.previousProjectionSessionId !== diagnostics.sessionId
        ? 0
        : percentOfTotal(diagnostics.descriptorChurn, diagnostics.totalRows),
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
  loadedTranscript: providedLoadedTranscript,
  ...props
}: VirtualMessageTimelineProps) {
  const fallbackLoadedTranscriptRef = useRef<LoadedTranscriptState | null>(
    null,
  );
  if (
    !fallbackLoadedTranscriptRef.current ||
    fallbackLoadedTranscriptRef.current.sessionId !== props.sessionId
  ) {
    fallbackLoadedTranscriptRef.current = createLoadedTranscriptState(
      props.sessionId,
    );
  }
  const loadedTranscript =
    providedLoadedTranscript ?? fallbackLoadedTranscriptRef.current;
  if (loadedTranscript.sessionId !== props.sessionId) {
    throw new Error("Loaded transcript does not match the rendered session");
  }
  return (
    <VirtualMessageTimelineSession
      key={loadedTranscript.id}
      loadedTranscript={loadedTranscript}
      {...props}
    />
  );
}

function VirtualMessageTimelineSession({
  loadedTranscript,
  sessionId,
  messages,
  streamingMessageId,
  sessionFeedbackSurvey,
  scrollTargetMessageId,
  scrollTargetQuery,
  onScrollTargetHandled,
  searchContentRef,
  searchBackendRef,
  onRetryMessage,
  onEditMessage,
  onForkFromMessage,
  onSendMcpAppMessage,
  onRunShellCommand,
  onEditProject,
  onChangeFolder,
  onOpenContextPanel,
  onDiagnostics,
  onTranscriptDiagnostics,
  virtualTimelineControlsRef,
  className,
  tailPaddingPx,
  footer,
  footerStatus,
  placeholder,
  showPlaceholder,
}: VirtualMessageTimelineProps & {
  loadedTranscript: LoadedTranscriptState;
}) {
  const { t, i18n } = useTranslation("chat");
  const { formatDate } = useLocaleFormatting();
  const responseStartGutterPreference = useResponseStartGutterPreference();
  const containerRef = useRef<HTMLDivElement>(null);
  const footerRef = useRef<HTMLDivElement>(null);
  const messageRefs = useRef<Record<string, HTMLDivElement | null>>({});
  const pointerScrollIntentActiveRef = useRef(false);
  const isNearBottomRef = useRef(true);
  const userDetachedRef = useRef(false);
  const userScrollIntentRef = useRef(false);
  const userScrollIntentExpiryFrameRef = useRef<number | null>(null);
  const userScrollDirectionRef = useRef<
    "toward-latest" | "away-from-latest" | null
  >(null);
  const lastScrollTopRef = useRef(0);
  const suppressScrollDeltaDetachUntilRef = useRef(0);
  const stickyScrollUntilRef = useRef(0);
  const messageListBottomPaddingPxRef = useRef(0);
  // Scroll modes live in refs because they coordinate DOM scrollTop inside
  // layout effects without forcing a React render for every scroll frame.
  const scrollIntentRef = useRef<TimelineScrollIntent>("following-latest");
  const streamingBottomFollowActiveRef = useRef(false);
  const streamingBottomFollowFrameRef = useRef<number | null>(null);
  const suppressFollowResumeFromProgrammaticScrollRef = useRef(false);
  const bottomScrollFrameRef = useRef<number | null>(null);
  const jumpToLatestFrameRef = useRef<number | null>(null);
  const scrollToBottomRef = useRef<(behavior: ScrollBehavior) => void>(
    () => undefined,
  );
  const resolvedScrollTargetMessageIdRef = useRef<string | null>(null);
  const scheduledBottomScrollSessionIdRef = useRef(sessionId);
  const lastAutoScrollMessagesRef = useRef<readonly Message[] | null>(null);
  const lastLatestUserAutoScrollKeyRef = useRef<string | null>(null);
  const responseStartRowRefs = useRef(new Map<string, HTMLElement>());
  const previousStreamingMessageIdRef = useRef<string | null>(null);
  const previousLatestAssistantCompletionStatusRef = useRef<string | null>(
    null,
  );
  const previousLatestCompletedAssistantMessageIdRef = useRef<string | null>(
    null,
  );
  const hasInitializedResponseStartHintRef = useRef(false);
  const responseStartHintCandidateMessageIdRef = useRef<string | null>(null);
  const responseStartHintAnimationFrameRef = useRef<number | null>(null);
  const responseStartHintSeenMessageIdsRef = useRef(new Set<string>());
  const responseStartHintRecordedMessageIdRef = useRef<string | null>(null);
  const detachedScrollTopRef = useRef<number | null>(null);
  const liveTailHandoffRef = useRef<{
    distanceFromBottom: number;
    scrollTop: number;
    scrollHeight: number;
    wasDetached: boolean;
  } | null>(null);
  const lastEffectiveVirtualScrollHeightRef = useRef<number | null>(null);
  const diagnosticsStartMsRef = useRef(getDiagnosticsNowMs());
  const diagnosticsAccumulatorRef = useRef(
    createTimelineDiagnosticsAccumulator(),
  );
  const [userDetached, setUserDetached] = useState(false);
  const [showJumpToLatest, setShowJumpToLatest] = useState(false);
  const [responseStartHintMessageId, setResponseStartHintMessageId] = useState<
    string | null
  >(null);
  const [responseStartHintInZone, setResponseStartHintInZone] = useState(false);
  const [footerHeightPx, setFooterHeightPx] = useState(0);
  const [liveTailScrollHeightFloorPx, setLiveTailScrollHeightFloorPx] =
    useState(0);
  const [pulsingMessageId, setPulsingMessageId] = useState<string | null>(null);
  const [browserRowCoverage, setBrowserRowCoverage] =
    useState<TranscriptBrowserRowCoverage | null>(null);
  const [blankViewportRecoveryAttempts, setBlankViewportRecoveryAttempts] =
    useState(0);
  const blankViewportRecoveryStateRef = useRef<{
    key: string;
    attempts: number;
  } | null>(null);
  const blankViewportRecoveryFrameRef = useRef<number | null>(null);
  const browserScrollOwnershipUntilRef = useRef(0);
  const requestBlankViewportInspectionRef = useRef<() => void>(() => undefined);

  const { sessionEpoch } = loadedTranscript;

  const hasFooter = footer != null;
  const nowBucket = toDateBucket(Date.now());
  const localeKey = i18n.resolvedLanguage ?? i18n.language ?? "default";
  const snapshot = useMemo(
    () =>
      loadedTranscript.projectionCache.update({
        sessionId,
        sessionEpoch,
        messages,
        streamingMessageId: streamingMessageId ?? null,
        nowBucket,
        localeKey,
      }),
    [
      loadedTranscript,
      localeKey,
      messages,
      nowBucket,
      sessionId,
      streamingMessageId,
      sessionEpoch,
    ],
  );
  const projectedRows = useStableTranscriptRows(snapshot.rows);
  const responseFeedbackRowIds = useMemo(
    () => selectResponseFeedbackRowIds(projectedRows),
    [projectedRows],
  );
  const stableRows = useMemo(() => {
    if (!sessionFeedbackSurvey) {
      return projectedRows;
    }

    return projectedRows.map((row) =>
      rowOwnsSessionFeedbackSurvey(
        row,
        responseFeedbackRowIds,
        sessionFeedbackSurvey,
      )
        ? {
            ...row,
            heightRevision: `${row.heightRevision}:session-survey:${sessionFeedbackSurvey.appearanceId}:${localeKey}`,
            measurementPolicy: "measure-real" as const,
            capabilities: {
              ...row.capabilities,
              canOffscreenRenderReal: true,
            },
          }
        : row,
    );
  }, [localeKey, projectedRows, responseFeedbackRowIds, sessionFeedbackSurvey]);
  const [settlingAgentWorkMessageId, setSettlingAgentWorkMessageId] = useState<
    string | null
  >(null);
  const settlingPreviousStreamingMessageIdRef = useRef<string | null>(
    streamingMessageId ?? null,
  );

  useEffect(() => {
    const previousStreamingMessageId =
      settlingPreviousStreamingMessageIdRef.current;
    const currentStreamingMessageId = streamingMessageId ?? null;

    if (currentStreamingMessageId) {
      settlingPreviousStreamingMessageIdRef.current = currentStreamingMessageId;
      setSettlingAgentWorkMessageId(null);
      return;
    }

    settlingPreviousStreamingMessageIdRef.current = null;
    if (!previousStreamingMessageId) {
      return;
    }

    setSettlingAgentWorkMessageId(previousStreamingMessageId);
    const clearSettlingState = window.setTimeout(() => {
      setSettlingAgentWorkMessageId((current) =>
        current === previousStreamingMessageId ? null : current,
      );
    }, 800);

    return () => window.clearTimeout(clearSettlingState);
  }, [streamingMessageId]);
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
  const messageListBottomPaddingPx = hasFooter
    ? hasLiveStreamingTail
      ? LIVE_TAIL_BOTTOM_PADDING_PX
      : DOCKED_FOOTER_BOTTOM_PADDING_PX
    : (tailPaddingPx ?? 16);
  messageListBottomPaddingPxRef.current = messageListBottomPaddingPx;
  const stableMessageByRowId = useStableMessageByRowId(
    stableRows,
    snapshot.messageById,
  );
  const activeStreamingProtectedRowIds = useMemo(
    () => getActiveStreamingProtectedRowIds(virtualRows, streamingMessageId),
    [virtualRows, streamingMessageId],
  );
  const shouldPreserveVirtualScrollPosition =
    userDetached && !isNearBottomRef.current;
  const shouldPreserveLiveVirtualScrollPosition = useCallback(
    () => pointerScrollIntentActiveRef.current || userScrollIntentRef.current,
    [],
  );
  const virtualTimeline = useTranscriptVirtualTimeline({
    loadedTranscript,
    rows: virtualRows,
    protectedRowIds: activeStreamingProtectedRowIds,
    containerRef,
    footerHeight: hasLiveStreamingTail ? 0 : messageListBottomPaddingPx,
    preserveScrollPosition: shouldPreserveVirtualScrollPosition,
    // React state trails refs by one render. Measurement flushes can run in
    // that gap immediately after wheel/pointer intent and must not replay the
    // old anchor over the browser-owned viewport.
    shouldPreserveLiveScrollPosition: shouldPreserveLiveVirtualScrollPosition,
  });
  const {
    snapshot: virtualTimelineSnapshot,
    measureRowElement,
    measureOffscreenShellElement,
    remeasureVisibleRowsSync,
    scrollToBottom: scrollVirtualToBottom,
    measureOffscreenRealElement,
    scrollToRow: scrollVirtualToRow,
    syncViewportFromDom,
    writeScrollTop: writeVirtualScrollTop,
    readRealRowCoverage,
  } = virtualTimeline;
  useEffect(() => {
    if (!virtualTimelineControlsRef) {
      return;
    }

    virtualTimelineControlsRef.current = virtualTimeline.rowStateControls;
    return () => {
      if (
        virtualTimelineControlsRef.current === virtualTimeline.rowStateControls
      ) {
        virtualTimelineControlsRef.current = null;
      }
    };
  }, [virtualTimeline.rowStateControls, virtualTimelineControlsRef]);
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
    rowStateProvider: virtualTimeline.rowStateProvider,
    backendRef: searchBackendRef,
  });
  const virtualRangeMountedRows = isBoundedVirtualMode
    ? virtualTimelineSnapshot.range.virtualItems.length
    : virtualRows.length;
  const measurementPlanByRowId = useStableMeasurementPlanByRowId(
    stableRows,
    stableMessageByRowId,
  );
  const offscreenRealMeasurementRows = useMemo(() => {
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
    const rows: OffscreenRealMeasurementRow[] = [];

    for (let index = startIndex; index <= endIndex; index += 1) {
      const row = virtualRows[index];
      if (!row || renderedRowIds.has(row.rowId)) {
        continue;
      }

      if (
        row.measurementPolicy !== "measure-real" ||
        !row.capabilities.canOffscreenRenderReal
      ) {
        continue;
      }

      rows.push({ index, row });
    }

    return rows;
  }, [
    isBoundedVirtualMode,
    virtualRows,
    virtualTimelineSnapshot.range.renderRange,
    virtualTimelineSnapshot.range.renderedRowIds,
  ]);
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
  const offscreenRealMountedRows = offscreenRealMeasurementRows.length;
  const offscreenShellMountedRows = offscreenShellMeasurementRows.length;
  const mountedRows = isBoundedVirtualMode
    ? virtualRangeMountedRows +
      offscreenRealMountedRows +
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
  const hasMessageRows = stableRows.some(isMessageTurnRow);
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
  const previousProjectionRowsById =
    diagnosticsAccumulatorRef.current.previousProjectionSessionId === sessionId
      ? diagnosticsAccumulatorRef.current.previousProjectionRowsById
      : null;
  const structuralDescriptorChurn = previousProjectionRowsById
    ? snapshot.rows.reduce((count, row) => {
        if (row.rowId === activeStreamingRowId) {
          return count;
        }
        const previousRow = previousProjectionRowsById.get(row.rowId);
        if (!previousRow || previousRow.kind !== row.kind) {
          return count + 1;
        }
        return previousRow.renderRevision === row.renderRevision
          ? count
          : count + 1;
      }, 0)
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
          offscreenRealMountedRows,
          protectedOffscreenRows: virtualProtectedOffscreenRows,
          forcedProtectedRowCount:
            virtualTimelineSnapshot.keepAliveDecision?.diagnostics
              .forcedProtectedRowCount ?? 0,
          mcpCandidateCount:
            virtualTimelineSnapshot.keepAliveDecision?.diagnostics
              .mcpCandidateCount ?? 0,
          mcpProtectedRowCount:
            virtualTimelineSnapshot.keepAliveDecision?.diagnostics
              .mcpProtectedRowCount ?? 0,
          recentCandidateCount:
            virtualTimelineSnapshot.keepAliveDecision?.diagnostics
              .recentCandidateCount ?? 0,
          recentProtectedRowCount:
            virtualTimelineSnapshot.keepAliveDecision?.diagnostics
              .recentProtectedRowCount ?? 0,
          evictedMcpRowCount:
            virtualTimelineSnapshot.keepAliveDecision?.diagnostics
              .evictedMcpRowCount ?? 0,
          evictedRecentRowCount:
            virtualTimelineSnapshot.keepAliveDecision?.diagnostics
              .evictedRecentRowCount ?? 0,
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
          blankViewportPixels: browserRowCoverage?.blankViewportPixels ?? 0,
          browserIntersectingRealRows:
            browserRowCoverage?.intersectingRealRowCount ?? 0,
          browserRealRows: browserRowCoverage?.realRowCount ?? 0,
          blankViewportRecoveryAttempts,
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
      browserRowCoverage,
      blankViewportRecoveryAttempts,
      hasLiveStreamingTail,
      liveStreamingTailRows,
      mountedRows,
      offscreenShellMountedRows,
      offscreenRealMountedRows,
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
      sessionEpoch,
    ],
  );
  // Capture the first committed tail before the browser can defer passive
  // effects behind unrelated work. At this point the tail is in the DOM, so
  // this remains a visibility measure rather than a frame-scheduling measure.
  useLayoutEffect(() => {
    const accumulator = diagnosticsAccumulatorRef.current;
    const elapsedMs = getDiagnosticsNowMs() - diagnosticsStartMsRef.current;
    const tailRowId = stableRows.at(-1)?.rowId;
    if (
      accumulator.firstVisibleTailMs == null &&
      tailRowId &&
      (hasLiveStreamingTail || diagnostics.visibleRowIds.includes(tailRowId))
    ) {
      accumulator.firstVisibleTailMs = elapsedMs;
    }
  }, [diagnostics.visibleRowIds, hasLiveStreamingTail, stableRows]);

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

    accumulator.previousProjectionRowsById = new Map(
      stableRows.map((row) => [row.rowId, row]),
    );
    accumulator.previousProjectionSessionId = sessionId;
  }, [
    diagnostics,
    onDiagnostics,
    onTranscriptDiagnostics,
    sessionId,
    stableRows,
    streamingMessageId,
    virtualTimelineSnapshot.controllerState.nearBottom,
  ]);

  const hasRealScrollableOverflow = useCallback((container: HTMLDivElement) => {
    return hasTimelineRealScrollableOverflow({
      metrics: container,
      bottomPaddingPx: messageListBottomPaddingPxRef.current,
    });
  }, []);

  const syncJumpToLatestVisibility = useCallback(
    (intent: TimelineScrollIntent = scrollIntentRef.current) => {
      const container = containerRef.current;
      if (!container) {
        setShowJumpToLatest(false);
        return;
      }

      setShowJumpToLatest(
        shouldShowTimelineJumpToLatest({
          intent,
          metrics: container,
          bottomPaddingPx: messageListBottomPaddingPxRef.current,
        }),
      );
    },
    [],
  );

  const stopStreamingBottomFollow = useCallback(() => {
    streamingBottomFollowActiveRef.current = false;
    if (streamingBottomFollowFrameRef.current == null) {
      return;
    }

    cancelAnimationFrame(streamingBottomFollowFrameRef.current);
    streamingBottomFollowFrameRef.current = null;
  }, []);

  const setDetachedFromLatest = useCallback(
    (
      detached: boolean,
      intent: TimelineScrollIntent = detached
        ? "user-detached"
        : "following-latest",
    ) => {
      if (detached) {
        const container = containerRef.current;
        if (!container || !hasRealScrollableOverflow(container)) {
          syncJumpToLatestVisibility("following-latest");
          return;
        }
        stopStreamingBottomFollow();
        detachedScrollTopRef.current = container.scrollTop;
      } else {
        userScrollDirectionRef.current = null;
        detachedScrollTopRef.current = null;
        liveTailHandoffRef.current = null;
        setLiveTailScrollHeightFloorPx(0);
      }

      scrollIntentRef.current = intent;
      syncJumpToLatestVisibility(intent);

      if (userDetachedRef.current === detached) {
        return;
      }

      userDetachedRef.current = detached;
      setUserDetached(detached);
    },
    [
      hasRealScrollableOverflow,
      stopStreamingBottomFollow,
      syncJumpToLatestVisibility,
    ],
  );

  const getBottomScrollTop = useCallback(
    (container: HTMLDivElement) => getTimelineBottomScrollTop(container),
    [],
  );

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
      writeVirtualScrollTop(bottomScrollTop, {
        behavior,
        source: "programmatic",
      });
      lastScrollTopRef.current = container.scrollTop;
    },
    [getBottomScrollTop, scrollVirtualToBottom, writeVirtualScrollTop],
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

  const clearProgrammaticFollowResumeSuppression = useCallback(() => {
    suppressFollowResumeFromProgrammaticScrollRef.current = false;
  }, []);

  const clearUserScrollIntent = useCallback(() => {
    userScrollIntentRef.current = false;
    userScrollDirectionRef.current = null;
    if (userScrollIntentExpiryFrameRef.current != null) {
      cancelAnimationFrame(userScrollIntentExpiryFrameRef.current);
      userScrollIntentExpiryFrameRef.current = null;
    }
  }, []);

  const markPendingScrollOwnership = useCallback(
    (direction: "toward-latest" | "away-from-latest" | null) => {
      if (userScrollIntentExpiryFrameRef.current != null) {
        cancelAnimationFrame(userScrollIntentExpiryFrameRef.current);
      }
      userScrollIntentRef.current = true;
      userScrollDirectionRef.current = direction;
      userScrollIntentExpiryFrameRef.current = requestAnimationFrame(() => {
        userScrollIntentExpiryFrameRef.current = null;
        userScrollIntentRef.current = false;
        userScrollDirectionRef.current = null;
        requestBlankViewportInspectionRef.current();
      });
    },
    [],
  );

  const markUserScrollIntent = useCallback(
    (direction: "toward-latest" | "away-from-latest" | null) => {
      clearProgrammaticFollowResumeSuppression();
      markPendingScrollOwnership(direction);
    },
    [clearProgrammaticFollowResumeSuppression, markPendingScrollOwnership],
  );

  const scrollToTargetWithControlledSmooth = useCallback(
    (
      targetScrollTop: number,
      {
        syncVirtualViewport = true,
        suppressFollowResume = false,
      }: {
        syncVirtualViewport?: boolean;
        suppressFollowResume?: boolean;
      } = {},
    ) => {
      const container = containerRef.current;
      if (!container) {
        return;
      }

      cancelJumpToLatestAnimation();
      if (suppressFollowResume) {
        suppressFollowResumeFromProgrammaticScrollRef.current = true;
      }

      const settle = () => {
        lastScrollTopRef.current = container.scrollTop;
        if (syncVirtualViewport) {
          syncViewportFromDom({ source: "browser", userScrollIntent: true });
        }
      };

      const startScrollTop = container.scrollTop;
      if (
        Math.abs(targetScrollTop - startScrollTop) <= 1 ||
        window.matchMedia(REDUCED_MOTION_QUERY).matches
      ) {
        writeVirtualScrollTop(targetScrollTop, {
          source: "programmatic",
          userScrollIntent: true,
        });
        settle();
        return;
      }

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
        writeVirtualScrollTop(
          startScrollTop +
            (targetScrollTop - startScrollTop) * easeOutCubic(progress),
          { source: "programmatic", userScrollIntent: true },
        );
        lastScrollTopRef.current = nextContainer.scrollTop;

        if (progress < 1) {
          jumpToLatestFrameRef.current = requestAnimationFrame(animate);
          return;
        }

        writeVirtualScrollTop(targetScrollTop, {
          source: "programmatic",
          userScrollIntent: true,
        });
        lastScrollTopRef.current = nextContainer.scrollTop;
        jumpToLatestFrameRef.current = null;
        if (syncVirtualViewport) {
          syncViewportFromDom({ source: "browser", userScrollIntent: true });
        }
      };

      jumpToLatestFrameRef.current = requestAnimationFrame(animate);
    },
    [cancelJumpToLatestAnimation, syncViewportFromDom, writeVirtualScrollTop],
  );

  const requestBottomScroll = useCallback(() => {
    if (bottomScrollFrameRef.current != null) {
      return;
    }

    const requestedSessionId = scheduledBottomScrollSessionIdRef.current;
    bottomScrollFrameRef.current = requestAnimationFrame(() => {
      bottomScrollFrameRef.current = null;
      if (
        scheduledBottomScrollSessionIdRef.current !== requestedSessionId ||
        pointerScrollIntentActiveRef.current ||
        userDetachedRef.current ||
        suppressFollowResumeFromProgrammaticScrollRef.current ||
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
      clearUserScrollIntent();
    },
    [
      cancelRequestedBottomScroll,
      cancelJumpToLatestAnimation,
      stopStreamingBottomFollow,
      clearUserScrollIntent,
    ],
  );

  const captureLiveTailHandoff = useCallback(
    (container: HTMLDivElement) => {
      if (!hasLiveStreamingTail) {
        return;
      }

      liveTailHandoffRef.current = {
        distanceFromBottom: Math.max(
          0,
          getBottomScrollTop(container) - container.scrollTop,
        ),
        scrollHeight: container.scrollHeight,
        scrollTop: container.scrollTop,
        wasDetached: userDetachedRef.current,
      };
    },
    [getBottomScrollTop, hasLiveStreamingTail],
  );

  const syncScrollState = useCallback(() => {
    const container = containerRef.current;
    if (!container) {
      return;
    }

    const domNearLatest = isTimelineNearLatest(container);
    const domPinnedToLatest = isTimelinePinnedToLatest(container);
    const rawScrollDelta = container.scrollTop - lastScrollTopRef.current;
    const userScrollDirection =
      userScrollDirectionRef.current ??
      (userScrollIntentRef.current && rawScrollDelta > 1
        ? "toward-latest"
        : userScrollIntentRef.current && rawScrollDelta < -1
          ? "away-from-latest"
          : null);
    const userIntendedTowardLatest =
      userScrollIntentRef.current && userScrollDirection === "toward-latest";
    const userIntendedAwayFromLatest =
      userScrollIntentRef.current && userScrollDirection === "away-from-latest";
    const hasScrollDetachIntent =
      userScrollIntentRef.current || pointerScrollIntentActiveRef.current;
    const shouldRestoreProgrammaticFollow =
      !hasScrollDetachIntent &&
      !userDetachedRef.current &&
      scrollIntentRef.current === "following-latest";
    const shouldResumeFromDom =
      !suppressFollowResumeFromProgrammaticScrollRef.current &&
      (domPinnedToLatest ||
        (Boolean(streamingMessageId) &&
          userIntendedTowardLatest &&
          domNearLatest));
    const preserveStreamingScrollPosition =
      streamingMessageId !== null &&
      userDetachedRef.current &&
      !shouldResumeFromDom;
    const virtualState = syncViewportFromDom({
      source: "browser",
      userScrollIntent: userScrollIntentRef.current,
      preserveScrollPosition: preserveStreamingScrollPosition,
    });
    if (virtualState) {
      const { scrollTop } = virtualState;
      const isNearLatest = domNearLatest || virtualState.nearBottom;
      const isPinnedToLatest = domPinnedToLatest || virtualState.pinnedToBottom;
      isNearBottomRef.current = isNearLatest;

      const scrollDeltaDetached =
        hasScrollDetachIntent &&
        scrollTop < lastScrollTopRef.current - 1 &&
        performance.now() > suppressScrollDeltaDetachUntilRef.current;
      const shouldResumeFollowing =
        !suppressFollowResumeFromProgrammaticScrollRef.current &&
        (isPinnedToLatest ||
          shouldRestoreProgrammaticFollow ||
          (Boolean(streamingMessageId) &&
            userIntendedTowardLatest &&
            isNearLatest));

      if (shouldResumeFollowing) {
        setDetachedFromLatest(false);
        if (
          !isPinnedToLatest &&
          (streamingMessageId || shouldRestoreProgrammaticFollow)
        ) {
          scrollToBottom("auto");
          isNearBottomRef.current = true;
        }
      } else if (userIntendedAwayFromLatest || scrollDeltaDetached) {
        // Explicit wheel/touch/pointer/keyboard intent detaches. Raw scrollTop
        // decreases also come from resize clamps and anchor corrections, so
        // the resize handler suppresses this fallback around geometry syncs.
        setDetachedFromLatest(true);
        stickyScrollUntilRef.current = 0;
      } else {
        syncJumpToLatestVisibility();
      }

      lastScrollTopRef.current = scrollTop;
      clearUserScrollIntent();
      captureLiveTailHandoff(container);
      return;
    }

    const { scrollTop, scrollHeight, clientHeight } = container;
    if (scrollHeight <= clientHeight) {
      isNearBottomRef.current = true;
      lastScrollTopRef.current = scrollTop;
      clearUserScrollIntent();
      setDetachedFromLatest(false);
      return;
    }

    isNearBottomRef.current = isTimelineNearLatest(container);

    const scrollDeltaDetached =
      hasScrollDetachIntent &&
      scrollTop < lastScrollTopRef.current - 1 &&
      performance.now() > suppressScrollDeltaDetachUntilRef.current;
    const isPinnedToLatest = isTimelinePinnedToLatest(container);
    const shouldResumeFollowing =
      !suppressFollowResumeFromProgrammaticScrollRef.current &&
      (isPinnedToLatest ||
        shouldRestoreProgrammaticFollow ||
        (Boolean(streamingMessageId) &&
          userIntendedTowardLatest &&
          isNearBottomRef.current));

    if (shouldResumeFollowing) {
      setDetachedFromLatest(false);
      if (
        !isPinnedToLatest &&
        (streamingMessageId || shouldRestoreProgrammaticFollow)
      ) {
        scrollToBottom("auto");
        isNearBottomRef.current = true;
      }
    } else if (userIntendedAwayFromLatest || scrollDeltaDetached) {
      // Mirrors the virtual path above.
      setDetachedFromLatest(true);
      stickyScrollUntilRef.current = 0;
    } else {
      syncJumpToLatestVisibility();
    }

    lastScrollTopRef.current = scrollTop;
    clearUserScrollIntent();
    captureLiveTailHandoff(container);
  }, [
    captureLiveTailHandoff,
    clearUserScrollIntent,
    scrollToBottom,
    setDetachedFromLatest,
    streamingMessageId,
    syncJumpToLatestVisibility,
    syncViewportFromDom,
  ]);

  const scrollToBottomIfNearBottom = useCallback(
    (behavior: ScrollBehavior = "smooth") => {
      const container = containerRef.current;
      if (
        !container ||
        userDetachedRef.current ||
        suppressFollowResumeFromProgrammaticScrollRef.current
      ) {
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
        distanceFromBottom >= TIMELINE_AUTO_SCROLL_THRESHOLD_PX
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
    if (
      !container ||
      pointerScrollIntentActiveRef.current ||
      userDetachedRef.current ||
      suppressFollowResumeFromProgrammaticScrollRef.current
    ) {
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
      distanceFromBottom >= TIMELINE_AUTO_SCROLL_THRESHOLD_PX
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
        pointerScrollIntentActiveRef.current ||
        userDetachedRef.current ||
        suppressFollowResumeFromProgrammaticScrollRef.current ||
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

      const nextScrollTop = Math.min(
        bottomScrollTop,
        container.scrollTop +
          Math.min(distanceFromBottom, STREAMING_BOTTOM_FOLLOW_MAX_STEP_PX),
      );
      writeVirtualScrollTop(nextScrollTop, { source: "programmatic" });
      lastScrollTopRef.current = container.scrollTop;

      if (bottomScrollTop - container.scrollTop > 1) {
        streamingBottomFollowFrameRef.current = requestAnimationFrame(step);
      } else {
        streamingBottomFollowActiveRef.current = false;
      }
    };

    streamingBottomFollowFrameRef.current = requestAnimationFrame(step);
  }, [getBottomScrollTop, writeVirtualScrollTop]);

  useLayoutEffect(() => {
    if (lastAutoScrollMessagesRef.current === messages) {
      return;
    }
    lastAutoScrollMessagesRef.current = messages;

    if (messages.length === 0) {
      return;
    }
    if (
      userDetachedRef.current ||
      suppressFollowResumeFromProgrammaticScrollRef.current
    ) {
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
        !pointerScrollIntentActiveRef.current &&
        !userDetachedRef.current &&
        (isNearBottomRef.current ||
          stickyScrollUntilRef.current > performance.now());

      // Remeasure every visible row at the new width and let the controller
      // reconcile the anchor against the rewrapped layout, all before this
      // frame paints. Partially remeasured layouts are what read as content
      // "jumping around" during continuous resizes.
      const scrollTopBeforeResize =
        detachedScrollTopRef.current ?? container.scrollTop;
      syncViewportFromDom({
        source: pointerScrollIntentActiveRef.current
          ? "browser"
          : "programmatic",
        userScrollIntent: pointerScrollIntentActiveRef.current,
        preserveScrollPosition: pointerScrollIntentActiveRef.current,
      });
      remeasureVisibleRowsSync();

      if (wasPinnedToLatest) {
        scrollToBottom("auto");
        syncScrollState();
        requestBlankViewportInspectionRef.current();
        return;
      }

      let virtualState = syncViewportFromDom({
        source: pointerScrollIntentActiveRef.current
          ? "browser"
          : "programmatic",
        userScrollIntent: pointerScrollIntentActiveRef.current,
        preserveScrollPosition: pointerScrollIntentActiveRef.current,
      });
      if (
        virtualState &&
        userDetachedRef.current &&
        virtualState.anchor.type === "bottom" &&
        Math.abs(container.scrollTop - scrollTopBeforeResize) > 1
      ) {
        // The user detached through wheel intent before the controller
        // captured a row anchor, so bottom reconciliation dragged them along.
        // Restore the detached position and capture a row anchor there.
        writeVirtualScrollTop(scrollTopBeforeResize, {
          source: "browser",
          userScrollIntent: true,
        });
        virtualState =
          syncViewportFromDom({
            source: "browser",
            userScrollIntent: true,
          }) ?? virtualState;
      }
      if (!virtualState) {
        syncScrollState();
        requestBlankViewportInspectionRef.current();
        return;
      }

      isNearBottomRef.current = virtualState.nearBottom;
      if (userDetachedRef.current) {
        detachedScrollTopRef.current = container.scrollTop;
        if (
          virtualState.pinnedToBottom &&
          !suppressFollowResumeFromProgrammaticScrollRef.current
        ) {
          setDetachedFromLatest(false);
        } else {
          syncJumpToLatestVisibility();
        }
      }
      lastScrollTopRef.current = virtualState.scrollTop;
      clearUserScrollIntent();
      requestBlankViewportInspectionRef.current();
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
    clearUserScrollIntent,
    remeasureVisibleRowsSync,
    scrollToBottom,
    setDetachedFromLatest,
    syncJumpToLatestVisibility,
    syncScrollState,
    syncViewportFromDom,
    writeVirtualScrollTop,
  ]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: footerHeightPx is the resize signal for this effect.
  useLayoutEffect(() => {
    if (!hasFooter && tailPaddingPx == null) {
      return;
    }
    if (
      userDetachedRef.current ||
      suppressFollowResumeFromProgrammaticScrollRef.current
    ) {
      return;
    }
    requestBottomScroll();
  }, [footerHeightPx, hasFooter, requestBottomScroll, tailPaddingPx]);

  const latestMessageEntry = useMemo(() => {
    for (let index = stableRows.length - 1; index >= 0; index -= 1) {
      const row = stableRows[index];
      if (!row?.messageId || !isMessageTurnRow(row)) {
        continue;
      }

      const message = stableMessageByRowId.get(row.rowId);
      if (message) {
        return { message, messageId: row.messageId };
      }
    }
    return null;
  }, [stableMessageByRowId, stableRows]);
  const latestMessage = latestMessageEntry?.message;
  const latestMessageId = latestMessageEntry?.messageId;
  const timelineMessages = useMemo(() => {
    const result: Message[] = [];
    for (const row of stableRows) {
      if (!isMessageTurnRow(row)) {
        continue;
      }
      const message = stableMessageByRowId.get(row.rowId);
      if (message) {
        result.push(message);
      }
    }
    return result;
  }, [stableMessageByRowId, stableRows]);
  const timelineMessageIdentities = useMemo(
    () => timelineMessages.map(getTimelineMessageIdentity),
    [timelineMessages],
  );
  const voiceSubmissionKeys = useMemo(
    () =>
      timelineMessages
        .map(getVoiceSubmissionKey)
        .filter((key): key is string => key !== null),
    [timelineMessages],
  );
  const seenVoiceSubmissionKeysRef = useRef(new Set(voiceSubmissionKeys));
  const previousTimelineTailIdentityRef = useRef(
    timelineMessageIdentities.at(-1),
  );
  const latestAssistantMessageEntry = useMemo(() => {
    for (let index = stableRows.length - 1; index >= 0; index -= 1) {
      const row = stableRows[index];
      if (!row?.messageId || !isMessageTurnRow(row)) {
        continue;
      }

      const message = stableMessageByRowId.get(row.rowId);
      if (message?.role === "assistant") {
        return { message, messageId: row.messageId };
      }
    }
    return null;
  }, [stableMessageByRowId, stableRows]);
  const latestAssistantMessage = latestAssistantMessageEntry?.message;
  const latestAssistantMessageId =
    latestAssistantMessageEntry?.messageId ?? null;

  // Derive which assistant message the floating gutter chevron should jump to.
  // The chevron floats near the bottom of the transcript (just above the
  // composer), so it must refer to the message sitting *at that bottom anchor
  // line* (not the topmost one) — otherwise it points at a message far above
  // where it's drawn. We only offer the jump once that message's start has
  // scrolled above the top edge, so there is genuinely somewhere to jump back
  // to. This reads the virtual snapshot (row offsets) rather than DOM rects so
  // it stays correct even when a long reply's first fragment row has unmounted
  // far above the viewport.
  const gutterResponseStartMessageId = useMemo<string | null>(() => {
    const { scrollTop, viewportHeight } =
      virtualTimelineSnapshot.controllerState;
    // Anchor at the visible bottom edge, lifted above the composer overlay so
    // it targets the message the reader is actually finishing. The button is
    // drawn a little higher than this line (see GUTTER_RESPONSE_START_LIFT_RATIO
    // in the shared component), but the target stays bottom-anchored.
    const anchorOffset =
      scrollTop +
      viewportHeight -
      messageListBottomPaddingPx -
      GUTTER_RESPONSE_START_THRESHOLD_PX;

    // Find the rendered row whose vertical span contains the anchor line.
    const anchorItem = virtualTimelineSnapshot.range.virtualItems.find(
      (item) => item.start <= anchorOffset && item.end > anchorOffset,
    );
    if (!anchorItem) {
      return null;
    }

    const anchorRow = stableRows[anchorItem.index];
    if (!anchorRow?.messageId) {
      return null;
    }
    if (!isMessageTurnRow(anchorRow)) {
      return null;
    }
    const message = stableMessageByRowId.get(anchorRow.rowId);
    if (message?.role !== "assistant") {
      return null;
    }
    const responseStartMessageId =
      anchorRow.responseStartMessageId ?? anchorRow.messageId;
    if (responseStartMessageId === streamingMessageId) {
      return null;
    }

    // Resolve the top of the whole message (its first row). Once that top has
    // scrolled above the viewport edge, the shared gutter button handles the
    // fade as a regular CSS visibility transition.
    const startRowId = snapshot.rowByMessageId.get(responseStartMessageId);
    const startIndex = startRowId
      ? snapshot.rowIndexById.get(startRowId)
      : undefined;
    const startItem =
      startIndex != null
        ? virtualTimelineSnapshot.range.virtualItems.find(
            (item) => item.index === startIndex,
          )
        : undefined;
    // The start row is mounted: compare its offset to the scroll position.
    if (startItem) {
      return scrollTop - startItem.start > GUTTER_RESPONSE_START_THRESHOLD_PX
        ? responseStartMessageId
        : null;
    }
    // The start row has scrolled out of the rendered window above us, so the
    // message's top is definitively above the viewport.
    if (startIndex != null && startIndex < anchorItem.index) {
      return responseStartMessageId;
    }

    return null;
  }, [
    messageListBottomPaddingPx,
    snapshot.rowByMessageId,
    snapshot.rowIndexById,
    stableMessageByRowId,
    stableRows,
    streamingMessageId,
    virtualTimelineSnapshot.controllerState,
    virtualTimelineSnapshot.range.virtualItems,
  ]);

  // Live, scroll-driven relevance gate for the per-message jump-to-response-
  // start hint. The hint popover anchors to the action chevron rendered on the
  // message's final fragment row, so it should only be visible while that
  // chevron sits inside the active reading band — below a generous top margin
  // (so a chevron parked near/above the top no longer counts as "being read")
  // and above the composer overlay. This single position check subsumes all
  // the off-zone cases: scrolled above the top, parked near the top, and pushed
  // below the composer all fail it. Mirrors gutterResponseStartMessageId by
  // reading virtual snapshot offsets rather than DOM rects, so it stays correct
  // even if a fragment row has unmounted. `wasActive` carries the previous gate
  // state so the top boundary can apply hysteresis and avoid restarting the
  // hint's fade on scroll jitter.
  const computeResponseStartHintActive = useCallback(
    (wasActive: boolean): boolean => {
      if (!responseStartHintMessageId) {
        return false;
      }
      const messageRows = getRowsForMessage(
        stableRows,
        responseStartHintMessageId,
      );
      const chevronRow = messageRows.at(-1);
      if (!chevronRow) {
        return false;
      }
      const chevronIndex = snapshot.rowIndexById.get(chevronRow.rowId);
      if (chevronIndex == null) {
        return false;
      }
      const chevronItem = virtualTimelineSnapshot.range.virtualItems.find(
        (item) => item.index === chevronIndex,
      );
      if (!chevronItem) {
        // The action row has scrolled out of the rendered window, so the reader
        // is far from this message and the hint is no longer relevant.
        return false;
      }

      const { scrollTop, viewportHeight } =
        virtualTimelineSnapshot.controllerState;
      const visibleBottom = Math.max(
        0,
        viewportHeight - messageListBottomPaddingPx,
      );
      // Viewport-relative coordinates: the viewport top is the origin (0) and the
      // chevron renders at the bottom edge of the message's final row.
      return isResponseStartHintInRelevanceBand({
        chevronY: chevronItem.end - scrollTop,
        containerTop: 0,
        visibleBottom,
        wasActive,
      });
    },
    [
      messageListBottomPaddingPx,
      responseStartHintMessageId,
      snapshot.rowIndexById,
      stableRows,
      virtualTimelineSnapshot.controllerState,
      virtualTimelineSnapshot.range.virtualItems,
    ],
  );

  useLayoutEffect(() => {
    setResponseStartHintInZone((wasInZone) =>
      computeResponseStartHintActive(wasInZone),
    );
  }, [computeResponseStartHintActive]);

  // Show the hint as soon as its chevron enters the band, but hold it briefly
  // after the gate drops so a scroll that sweeps the chevron out (or jitters at
  // an edge) doesn't tear the popover down mid-fade and restart it.
  const responseStartHintIsActive = useStickyFlag(
    responseStartHintInZone,
    RESPONSE_START_HINT_HIDE_DELAY_MS,
  );

  // Record the "shown" count the first time the hint is actually visible for a
  // message, not when it was merely scheduled. With maxShows = 1, recording at
  // schedule time could retire the moment as expired for a hint the user never
  // saw (e.g. the visibility band never opened before they switched sessions).
  useEffect(() => {
    if (
      responseStartHintMessageId &&
      responseStartHintIsActive &&
      responseStartHintRecordedMessageIdRef.current !==
        responseStartHintMessageId
    ) {
      responseStartHintRecordedMessageIdRef.current =
        responseStartHintMessageId;
      recordAssistiveMomentShown(ASSISTIVE_UX_RULES.chatJumpToResponseStart.id);
    }
  }, [responseStartHintMessageId, responseStartHintIsActive]);

  const isResponseStartHintEligible = useCallback(
    (messageId: string) => {
      const container = containerRef.current;
      if (!container) {
        return false;
      }

      const responseStartRowId = getRowsForMessage(stableRows, messageId)[0]
        ?.rowId;
      if (!responseStartRowId) {
        return false;
      }

      const target = responseStartRowRefs.current.get(responseStartRowId);
      if (!target?.isConnected) {
        return true;
      }

      const containerRect = container.getBoundingClientRect();
      const targetRect = target.getBoundingClientRect();
      const footerRect = footerRef.current?.getBoundingClientRect();
      const visibleBottom = footerRect
        ? Math.min(containerRect.bottom, footerRect.top)
        : containerRect.bottom;
      const visibleHeight = Math.max(0, visibleBottom - containerRect.top);

      return (
        targetRect.height >
          visibleHeight - RESPONSE_START_HINT_VIEWPORT_SLOP_PX ||
        targetRect.top <
          containerRect.top + RESPONSE_START_HINT_VIEWPORT_SLOP_PX
      );
    },
    [stableRows],
  );

  const scheduleResponseStartHint = useCallback(
    (messageId: string) => {
      if (responseStartHintAnimationFrameRef.current != null) {
        cancelAnimationFrame(responseStartHintAnimationFrameRef.current);
      }

      responseStartHintAnimationFrameRef.current = requestAnimationFrame(() => {
        responseStartHintAnimationFrameRef.current = null;

        if (responseStartHintSeenMessageIdsRef.current.has(messageId)) {
          responseStartHintCandidateMessageIdRef.current = null;
          return;
        }

        const completedMessage = messages.find(
          (message) => message.id === messageId,
        );
        const rejectionReason = !completedMessage
          ? "missing-message"
          : completedMessage.role !== "assistant"
            ? "not-assistant"
            : completedMessage.id !== latestAssistantMessageId
              ? "not-latest-assistant"
              : completedMessage.metadata?.completionStatus === "inProgress" &&
                  completedMessage.id === streamingMessageId
                ? "still-in-progress"
                : !shouldShowAssistiveMoment(
                      ASSISTIVE_UX_RULES.chatJumpToResponseStart.id,
                    )
                  ? "assistive-ux-not-eligible"
                  : !isResponseStartHintEligible(completedMessage.id)
                    ? "response-start-not-eligible"
                    : null;
        if (rejectionReason) {
          if (completedMessage) {
            responseStartHintCandidateMessageIdRef.current = null;
          }
          return;
        }
        if (!completedMessage) {
          return;
        }

        responseStartHintSeenMessageIdsRef.current.add(completedMessage.id);
        responseStartHintCandidateMessageIdRef.current = null;
        // Select the candidate here, but defer recording the "shown" count
        // until the hint actually becomes visible (see the effect that watches
        // responseStartHintIsActive). Counting at schedule time could spend the
        // single allowed show on a hint the user never saw if the visibility
        // band never opens before they move on.
        setResponseStartHintMessageId(completedMessage.id);
      });
    },
    [
      isResponseStartHintEligible,
      latestAssistantMessageId,
      messages,
      streamingMessageId,
    ],
  );

  useLayoutEffect(() => {
    const latestAssistantCompletionStatus =
      latestAssistantMessage?.metadata?.completionStatus ?? null;
    const previousLatestAssistantCompletionStatus =
      previousLatestAssistantCompletionStatusRef.current;
    previousLatestAssistantCompletionStatusRef.current =
      latestAssistantCompletionStatus;
    const latestCompletedAssistantMessageId =
      latestAssistantMessage?.id &&
      latestAssistantMessage.id !== streamingMessageId
        ? latestAssistantMessage.id
        : null;
    const previousLatestCompletedAssistantMessageId =
      previousLatestCompletedAssistantMessageIdRef.current;
    previousLatestCompletedAssistantMessageIdRef.current =
      latestCompletedAssistantMessageId;
    const hasInitializedResponseStartHint =
      hasInitializedResponseStartHintRef.current;
    hasInitializedResponseStartHintRef.current = true;

    if (streamingMessageId) {
      previousStreamingMessageIdRef.current = streamingMessageId;
      responseStartHintCandidateMessageIdRef.current = streamingMessageId;
      return;
    }

    if (
      latestAssistantMessage?.id &&
      latestAssistantCompletionStatus === "inProgress" &&
      latestAssistantMessage.id === streamingMessageId
    ) {
      responseStartHintCandidateMessageIdRef.current =
        latestAssistantMessage.id;
      return;
    }

    const completedCandidateMessageId =
      previousStreamingMessageIdRef.current ??
      (previousLatestAssistantCompletionStatus === "inProgress"
        ? latestAssistantMessage?.id
        : null) ??
      responseStartHintCandidateMessageIdRef.current ??
      (hasInitializedResponseStartHint &&
      latestCompletedAssistantMessageId &&
      latestCompletedAssistantMessageId !==
        previousLatestCompletedAssistantMessageId
        ? latestCompletedAssistantMessageId
        : null);
    previousStreamingMessageIdRef.current = null;

    if (!completedCandidateMessageId) {
      return;
    }

    scheduleResponseStartHint(completedCandidateMessageId);
  }, [
    latestAssistantMessage?.id,
    latestAssistantMessage?.metadata?.completionStatus,
    scheduleResponseStartHint,
    streamingMessageId,
  ]);

  useEffect(() => {
    return () => {
      if (responseStartHintAnimationFrameRef.current != null) {
        cancelAnimationFrame(responseStartHintAnimationFrameRef.current);
      }
    };
  }, []);

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

    const targetRowId = snapshot.rowByMessageId.get(
      resolvedScrollTargetMessageId,
    );
    const scrollMountedTargetIntoView = (target: HTMLElement | null) => {
      if (!target) {
        return false;
      }
      const container = containerRef.current;
      if (!container) {
        return false;
      }
      const containerRect = container.getBoundingClientRect();
      const targetRect = target.getBoundingClientRect();
      const targetCenterOffset =
        targetRect.top -
        containerRect.top -
        (container.clientHeight - targetRect.height) / 2;
      writeVirtualScrollTop(
        Math.max(0, container.scrollTop + targetCenterOffset),
        { source: "programmatic" },
      );
      return true;
    };
    const scrollTargetByBestAvailablePath = () => {
      if (targetRowId && scrollVirtualToRow(targetRowId, "center")) {
        return true;
      }
      return scrollMountedTargetIntoView(
        messageRefs.current[resolvedScrollTargetMessageId],
      );
    };

    const frames: number[] = [];
    const isTargetVisible = (target: HTMLElement) => {
      const container = containerRef.current;
      if (!container) {
        return false;
      }
      const containerRect = container.getBoundingClientRect();
      const targetRect = target.getBoundingClientRect();
      return (
        targetRect.bottom > containerRect.top + 1 &&
        targetRect.top < containerRect.bottom - 1
      );
    };
    const tryScrollToTarget = (remainingFrames: number, visibleFrames = 0) => {
      const frame = requestAnimationFrame(() => {
        scrollTargetByBestAvailablePath();
        const target = messageRefs.current[resolvedScrollTargetMessageId];
        if (!target || !isTargetVisible(target)) {
          if (remainingFrames > 0) {
            tryScrollToTarget(remainingFrames - 1, 0);
          }
          return;
        }

        if (visibleFrames < SCROLL_TARGET_VISIBLE_SETTLE_FRAMES) {
          scrollTargetByBestAvailablePath();
          tryScrollToTarget(remainingFrames, visibleFrames + 1);
          return;
        }

        setPulsingMessageId(resolvedScrollTargetMessageId);
        onScrollTargetHandled?.(resolvedScrollTargetMessageId);
      });
      frames.push(frame);
    };

    tryScrollToTarget(SCROLL_TARGET_MOUNT_RETRY_FRAMES);

    return () => {
      for (const frame of frames) {
        cancelAnimationFrame(frame);
      }
    };
  }, [
    latestMessageId,
    onScrollTargetHandled,
    resolvedScrollTargetMessageId,
    scrollVirtualToRow,
    setDetachedFromLatest,
    snapshot.rowByMessageId,
    writeVirtualScrollTop,
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
    if (
      !latestMessageId ||
      latestMessage?.role !== "user" ||
      latestMessage.metadata?.origin === "voice_conversation"
    ) {
      return;
    }

    const latestUserKey = `${sessionId}\0${latestMessageId}`;
    if (lastLatestUserAutoScrollKeyRef.current === latestUserKey) {
      return;
    }
    lastLatestUserAutoScrollKeyRef.current = latestUserKey;

    clearProgrammaticFollowResumeSuppression();
    setDetachedFromLatest(false);
    scrollToBottom("auto");
  }, [
    clearProgrammaticFollowResumeSuppression,
    latestMessageId,
    latestMessage?.metadata?.origin,
    latestMessage?.role,
    sessionId,
    scrollToBottom,
    setDetachedFromLatest,
  ]);

  useEffect(() => {
    let latestUnseenVoiceSubmissionIndex = -1;
    for (let index = 0; index < timelineMessages.length; index += 1) {
      const key = getVoiceSubmissionKey(timelineMessages[index]);
      if (key && !seenVoiceSubmissionKeysRef.current.has(key)) {
        latestUnseenVoiceSubmissionIndex = index;
      }
    }
    const previousTailIdentity = previousTimelineTailIdentityRef.current;
    const previousTailIndex = previousTailIdentity
      ? timelineMessageIdentities.indexOf(previousTailIdentity)
      : -1;
    for (const key of voiceSubmissionKeys) {
      seenVoiceSubmissionKeysRef.current.add(key);
    }
    previousTimelineTailIdentityRef.current = timelineMessageIdentities.at(-1);
    if (
      latestUnseenVoiceSubmissionIndex < 0 ||
      (previousTailIdentity &&
        (previousTailIndex < 0 ||
          latestUnseenVoiceSubmissionIndex <= previousTailIndex))
    ) {
      return;
    }
    clearProgrammaticFollowResumeSuppression();
    setDetachedFromLatest(false);
    scrollToBottom("auto");
    requestBottomScroll();
  }, [
    clearProgrammaticFollowResumeSuppression,
    requestBottomScroll,
    scrollToBottom,
    setDetachedFromLatest,
    timelineMessageIdentities,
    timelineMessages,
    voiceSubmissionKeys,
  ]);

  const requestMcpAppAutoScroll = useCallback(
    (element: HTMLElement | null) => {
      const container = containerRef.current;
      if (
        !container ||
        !element ||
        userDetachedRef.current ||
        suppressFollowResumeFromProgrammaticScrollRef.current
      ) {
        return;
      }

      const distanceFromBottom =
        container.scrollHeight - container.scrollTop - container.clientHeight;
      const shouldStick =
        isNearBottomRef.current ||
        distanceFromBottom < TIMELINE_AUTO_SCROLL_THRESHOLD_PX ||
        stickyScrollUntilRef.current > performance.now();

      if (!shouldStick) {
        return;
      }

      stickyScrollUntilRef.current =
        performance.now() + TIMELINE_MCP_APP_STICKY_SCROLL_MS;

      const alignElementBottom = () => {
        const nextContainer = containerRef.current;
        if (!nextContainer || !element.isConnected) {
          return;
        }
        if (
          userDetachedRef.current ||
          suppressFollowResumeFromProgrammaticScrollRef.current
        ) {
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
          distanceFromBottom < TIMELINE_AUTO_SCROLL_THRESHOLD_PX ||
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
          writeVirtualScrollTop(nextContainer.scrollTop + delta, {
            source: "correction",
          });
          syncViewportFromDom({ source: "correction" });
        }
      };

      alignElementBottom();
      requestAnimationFrame(alignElementBottom);
    },
    [syncViewportFromDom, writeVirtualScrollTop],
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
    browserScrollOwnershipUntilRef.current = startedAt + 100;
    requestBlankViewportInspectionRef.current();
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

  const detachFromBottomFollow = () => {
    stopStreamingBottomFollow();
    stickyScrollUntilRef.current = 0;
    setDetachedFromLatest(true);
    syncViewportFromDom({
      source: "browser",
      userScrollIntent: true,
      preserveScrollPosition: true,
    });
  };

  const handleStreamingUserScrollIntent = () => {
    if (!streamingMessageId) {
      return;
    }

    stopStreamingBottomFollow();
    stickyScrollUntilRef.current = 0;
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

    browserScrollOwnershipUntilRef.current = getDiagnosticsNowMs() + 100;
    markUserScrollIntent(
      event.deltaY < 0
        ? "away-from-latest"
        : event.deltaY > 0
          ? "toward-latest"
          : null,
    );

    if (event.deltaY < 0) {
      detachFromBottomFollow();
      // Push the detach into the controller immediately so it captures a row
      // anchor at the current position. Otherwise the controller can keep a
      // stale bottom anchor (the scroll event may not change scrollTop), and
      // the next geometry reconciliation would drag the user back to the
      // bottom they just scrolled away from.
      return;
    }

    if (streamingMessageId && isTimelinePinnedToLatest(container)) {
      setDetachedFromLatest(false);
      isNearBottomRef.current = true;
      liveTailHandoffRef.current = null;
      syncViewportFromDom({ source: "browser", userScrollIntent: true });
      return;
    }

    handleStreamingUserScrollIntent();
  };

  const handleUserScrollIntent = (event: SyntheticEvent) => {
    if (footerRef.current?.contains(event.target as Node)) {
      return;
    }
    const container = containerRef.current;
    browserScrollOwnershipUntilRef.current = getDiagnosticsNowMs() + 100;
    if (event.type === "pointerdown" && container) {
      pointerScrollIntentActiveRef.current = true;
    }
    markUserScrollIntent(null);
    if (event.type !== "pointerdown") {
      handleStreamingUserScrollIntent();
    }
    // A real wheel/touch interrupts an in-flight jump-to-latest glide so the
    // user keeps control of the scroll position.
    cancelJumpToLatestAnimation();
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    switch (event.key) {
      case "ArrowDown":
      case "ArrowUp":
      case "End":
      case "Home":
      case "PageDown":
      case "PageUp":
      case " ":
      case "Spacebar":
        markUserScrollIntent(
          event.key === "ArrowDown" ||
            event.key === "End" ||
            event.key === "PageDown" ||
            ((event.key === " " || event.key === "Spacebar") && !event.shiftKey)
            ? "toward-latest"
            : "away-from-latest",
        );
        handleStreamingUserScrollIntent();
        cancelJumpToLatestAnimation();
        break;
      default:
        break;
    }
  };

  useEffect(() => {
    if (typeof document === "undefined") {
      return;
    }

    const endPointerScrollIntent = () => {
      if (!pointerScrollIntentActiveRef.current) {
        return;
      }

      pointerScrollIntentActiveRef.current = false;
      requestBlankViewportInspectionRef.current();
    };

    document.addEventListener("pointerup", endPointerScrollIntent);
    document.addEventListener("pointercancel", endPointerScrollIntent);
    window.addEventListener("blur", endPointerScrollIntent);
    return () => {
      document.removeEventListener("pointerup", endPointerScrollIntent);
      document.removeEventListener("pointercancel", endPointerScrollIntent);
      window.removeEventListener("blur", endPointerScrollIntent);
    };
  }, []);

  const handleJumpToLatest = () => {
    clearProgrammaticFollowResumeSuppression();
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
      writeVirtualScrollTop(
        startScrollTop +
          (bottomScrollTop - startScrollTop) * easeOutCubic(progress),
        { source: "programmatic" },
      );
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

  const scrollResponseStartElement = useCallback(
    (
      rowId: string,
      {
        syncVirtualViewport = true,
      }: {
        syncVirtualViewport?: boolean;
      } = {},
    ) => {
      const container = containerRef.current;
      const target = responseStartRowRefs.current.get(rowId);
      if (!container || !target?.isConnected) {
        return false;
      }

      const containerRect = container.getBoundingClientRect();
      const targetRect = target.getBoundingClientRect();
      const targetScrollTop = Math.max(
        0,
        container.scrollTop + targetRect.top - containerRect.top - 16,
      );

      scrollToTargetWithControlledSmooth(targetScrollTop, {
        syncVirtualViewport,
        suppressFollowResume: true,
      });
      return true;
    },
    [scrollToTargetWithControlledSmooth],
  );

  const handleJumpToResponseStart = useCallback(
    (messageId: string) => {
      const rowId = getRowsForMessage(stableRows, messageId)[0]?.rowId;
      if (!rowId) {
        return;
      }

      cancelJumpToLatestAnimation();
      stopStreamingBottomFollow();
      responseStartHintSeenMessageIdsRef.current.add(messageId);
      if (
        responseStartHintMessageId === messageId &&
        hasAssistiveMomentBeenShown(
          ASSISTIVE_UX_RULES.chatJumpToResponseStart.id,
        )
      ) {
        recordAssistiveMomentAccepted(
          ASSISTIVE_UX_RULES.chatJumpToResponseStart.id,
        );
      }
      setResponseStartHintMessageId((current) =>
        current === messageId ? null : current,
      );
      setDetachedFromLatest(true);
      stickyScrollUntilRef.current = 0;
      isNearBottomRef.current = false;

      if (
        scrollResponseStartElement(rowId, {
          syncVirtualViewport: !hasLiveStreamingTail,
        })
      ) {
        return;
      }

      suppressFollowResumeFromProgrammaticScrollRef.current = true;
      if (scrollVirtualToRow(rowId, "start")) {
        lastScrollTopRef.current = containerRef.current?.scrollTop ?? 0;
        return;
      }

      scrollResponseStartElement(rowId);
    },
    [
      cancelJumpToLatestAnimation,
      hasLiveStreamingTail,
      scrollResponseStartElement,
      scrollVirtualToRow,
      setDetachedFromLatest,
      stableRows,
      stopStreamingBottomFollow,
      responseStartHintMessageId,
    ],
  );
  const handleResponseStartHintClose = useCallback((messageId: string) => {
    responseStartHintSeenMessageIdsRef.current.add(messageId);
    setResponseStartHintMessageId((current) =>
      current === messageId ? null : current,
    );
  }, []);
  const handleResponseStartHintDismiss = useCallback((messageId: string) => {
    responseStartHintSeenMessageIdsRef.current.add(messageId);
    recordAssistiveMomentRetired(
      ASSISTIVE_UX_RULES.chatJumpToResponseStart.id,
      "dismissed",
    );
    setResponseStartHintMessageId((current) =>
      current === messageId ? null : current,
    );
  }, []);
  const registerMessageElement = useCallback(
    (messageId: string, element: HTMLDivElement | null) => {
      messageRefs.current[messageId] = element;
    },
    [],
  );
  const registerTimelineRowElement = useCallback(
    (rowId: string, element: HTMLElement | null) => {
      if (element) {
        responseStartRowRefs.current.set(rowId, element);
      } else {
        responseStartRowRefs.current.delete(rowId);
      }
      registerSearchRowElement(rowId, element);
    },
    [registerSearchRowElement],
  );

  const jumpToLatestLabel = t("timeline.jumpToLatest");
  const jumpToResponseStartLabel = t("message.jumpToResponseStart");
  const jumpToFloatingResponseStartLabel = t(
    "message.jumpToFloatingResponseStart",
  );
  const hasFooterStatus = footerStatus != null;
  const jumpToLatestButton = (
    <MessageTimelineJumpToLatestButton
      compact={hasFooterStatus}
      label={jumpToLatestLabel}
      onClick={handleJumpToLatest}
      visible={showJumpToLatest}
    />
  );
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
      onForkFromMessage,
      onSendMcpAppMessage,
      onMcpAppAutoScroll: requestMcpAppAutoScroll,
      onRunShellCommand,
      onEditProject,
      onChangeFolder,
      onOpenContextPanel,
      onJumpToResponseStart: handleJumpToResponseStart,
      onJumpToResponseStartHintClose: handleResponseStartHintClose,
      onJumpToResponseStartHintDismiss: handleResponseStartHintDismiss,
    }),
    [
      onRetryMessage,
      onEditMessage,
      onForkFromMessage,
      onSendMcpAppMessage,
      requestMcpAppAutoScroll,
      onRunShellCommand,
      onEditProject,
      onChangeFolder,
      onOpenContextPanel,
      handleJumpToResponseStart,
      handleResponseStartHintClose,
      handleResponseStartHintDismiss,
    ],
  );

  const sessionFeedbackSurveyForRow = (row: TranscriptRowDescriptor) =>
    rowOwnsSessionFeedbackSurvey(
      row,
      responseFeedbackRowIds,
      sessionFeedbackSurvey,
    )
      ? (sessionFeedbackSurvey ?? undefined)
      : undefined;
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
      layoutMode="flow"
      virtualItem={virtualItem}
      measurementPlan={measurementPlanByRowId.get(row.rowId)}
      dateLabel={formatDateSeparator(snapshot, index, {
        today: t("timeline.today"),
        yesterday: t("timeline.yesterday"),
        formatDate,
      })}
      message={row.messageId ? stableMessageByRowId.get(row.rowId) : undefined}
      isStreaming={
        streamingMessageId != null &&
        (row.responseStartMessageId ?? row.messageId) === streamingMessageId
      }
      settleAgentWorkOnMount={
        row.kind === "agent-work" &&
        row.messageId === settlingAgentWorkMessageId &&
        row.agentWork?.isActiveWork === false
      }
      actionsAlwaysVisible={
        row.messageId === latestAssistantMessageId &&
        (row.responseStartMessageId ?? row.messageId) !== streamingMessageId
      }
      feedbackSessionId={
        responseFeedbackRowIds.has(row.rowId) ? sessionId : undefined
      }
      sessionFeedbackSurvey={sessionFeedbackSurveyForRow(row)}
      showJumpToResponseStartHint={
        row.messageId === responseStartHintMessageId &&
        responseStartHintIsActive
      }
      isPulsing={row.messageId === pulsingMessageId}
      rowStateProvider={virtualTimeline.rowStateProvider}
      bubbleCallbacks={bubbleCallbacks}
      measureRowElement={
        virtualItem || !isBoundedVirtualMode ? measureRowElement : undefined
      }
      registerRowElement={registerTimelineRowElement}
      registerMessageElement={registerMessageElement}
    />
  );
  const renderOffscreenRealRow = ({
    index,
    row,
  }: OffscreenRealMeasurementRow) => (
    <VirtualTranscriptRow
      key={`offscreen-real:${row.reactKey}`}
      row={row}
      index={index}
      previousRowKind={stableRows[index - 1]?.kind}
      layoutMode="virtual"
      offscreenMeasurementKind="real"
      measurementPlan={measurementPlanByRowId.get(row.rowId)}
      dateLabel={formatDateSeparator(snapshot, index, {
        today: t("timeline.today"),
        yesterday: t("timeline.yesterday"),
        formatDate,
      })}
      message={row.messageId ? stableMessageByRowId.get(row.rowId) : undefined}
      isStreaming={false}
      feedbackSessionId={
        responseFeedbackRowIds.has(row.rowId) ? sessionId : undefined
      }
      sessionFeedbackSurvey={sessionFeedbackSurveyForRow(row)}
      rowStateProvider={
        virtualTimeline.rowStateProvider
          ? {
              registry: virtualTimeline.rowStateProvider.registry,
              sessionId: virtualTimeline.rowStateProvider.sessionId,
              sessionEpoch: virtualTimeline.rowStateProvider.sessionEpoch,
              onRowStateChange:
                virtualTimeline.rowStateProvider.onRowStateChange,
            }
          : undefined
      }
      measureRowElement={measureOffscreenRealElement}
    />
  );
  const renderedOffscreenRealRows = offscreenRealMeasurementRows.map(
    renderOffscreenRealRow,
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
        overflowAnchor: "none" as const,
        position: "relative" as const,
      }
    : undefined;
  const messageListStyle = isBoundedVirtualMode
    ? {
        paddingBottom: hasLiveStreamingTail ? messageListBottomPaddingPx : 0,
        overflowAnchor: "none" as const,
      }
    : {
        paddingBottom: messageListBottomPaddingPx,
      };
  const renderVirtualFlowSpacerRows = () => {
    const nodes: ReactNode[] = [];
    const virtualItems = virtualTimelineSnapshot.range.virtualItems;
    let cursor = 0;

    // Keep mounted transcript text in normal document flow. The virtual engine
    // still owns the pixel model; inert spacers represent unmounted ranges.
    // The edge spacers keep stable identities as the rendered range changes so
    // WebKit can resize them without replacing the scroll-height endpoints.
    const leadingGapSize = Math.max(0, virtualItems[0]?.start ?? 0);
    nodes.push(
      <div
        key="virtual-flow-spacer-before"
        aria-hidden="true"
        data-testid="virtual-message-timeline-flow-spacer"
        data-virtual-flow-spacer="before"
        style={{ flexShrink: 0, height: leadingGapSize }}
      />,
    );

    for (const virtualItem of virtualItems) {
      const gapSize = Math.max(0, virtualItem.start - cursor);
      if (cursor > 0 && gapSize > 0) {
        nodes.push(
          <div
            key={`virtual-flow-spacer-gap:${virtualItem.key}`}
            aria-hidden="true"
            data-testid="virtual-message-timeline-flow-spacer"
            data-virtual-flow-spacer="gap"
            style={{ flexShrink: 0, height: gapSize }}
          />,
        );
      }

      nodes.push(renderRow(virtualItem.row, virtualItem.index, virtualItem));
      cursor = Math.max(cursor, virtualItem.end);
    }

    const trailingGapSize = Math.max(0, effectiveVirtualScrollHeight - cursor);
    nodes.push(
      <div
        key="virtual-flow-spacer-after"
        aria-hidden="true"
        data-testid="virtual-message-timeline-flow-spacer"
        data-virtual-flow-spacer="after"
        style={{ flexShrink: 0, height: trailingGapSize }}
      />,
    );

    return nodes;
  };
  const renderedVirtualRows = isBoundedVirtualMode
    ? renderVirtualFlowSpacerRows()
    : virtualRows.map((row, index) => renderRow(row, index));
  const renderedLiveStreamingTailRows = liveStreamingTailRows.map(
    (row, tailIndex) => renderRow(row, liveStreamingTailStartIndex + tailIndex),
  );
  const showPlaceholderContent = showPlaceholder || !hasMessageRows;
  const virtualRangeRevision = `${virtualTimelineSnapshot.range.renderRange.startIndex}:${virtualTimelineSnapshot.range.renderRange.endIndex}:${virtualTimelineSnapshot.range.virtualItems
    .map((item) => `${item.key}:${item.start}:${item.size}`)
    .join("|")}`;

  useLayoutEffect(() => {
    if (
      !isBoundedVirtualMode ||
      stableRows.length === 0 ||
      showPlaceholderContent
    ) {
      setBrowserRowCoverage(null);
      return;
    }

    const recoveryKey = `${sessionId}:${sessionEpoch}:${stableRows.length}:${virtualRangeRevision}`;
    if (blankViewportRecoveryStateRef.current?.key !== recoveryKey) {
      blankViewportRecoveryStateRef.current = { key: recoveryKey, attempts: 0 };
    }
    setBlankViewportRecoveryAttempts(
      blankViewportRecoveryStateRef.current.attempts,
    );

    const inspectAndRecover = () => {
      blankViewportRecoveryFrameRef.current = null;
      const container = containerRef.current;
      const transcriptRoot = searchListRootRef.current;
      if (!container || !transcriptRoot) {
        return;
      }

      const recoveryState = blankViewportRecoveryStateRef.current;
      if (!recoveryState || recoveryState.key !== recoveryKey) {
        return;
      }
      if (
        pointerScrollIntentActiveRef.current ||
        userScrollIntentRef.current ||
        recoveryState.attempts >= MAX_BLANK_VIEWPORT_RECOVERY_ATTEMPTS
      ) {
        return;
      }
      if (getDiagnosticsNowMs() < browserScrollOwnershipUntilRef.current) {
        blankViewportRecoveryFrameRef.current =
          requestAnimationFrame(inspectAndRecover);
        return;
      }

      const coverage = readRealRowCoverage?.(transcriptRoot);
      if (!coverage) {
        return;
      }
      setBrowserRowCoverage((current) =>
        current?.blankViewportPixels === coverage.blankViewportPixels &&
        current.intersectingRealRowCount ===
          coverage.intersectingRealRowCount &&
        current.realRowCount === coverage.realRowCount
          ? current
          : coverage,
      );
      if (coverage.intersectingRealRowCount > 0) {
        return;
      }

      recoveryState.attempts += 1;
      setBlankViewportRecoveryAttempts(recoveryState.attempts);

      // Refresh row geometry first, then reconcile from the browser's actual
      // viewport. Writing its current scrollTop through the adapter and reading
      // it back makes clamping/browser behavior authoritative without moving a
      // viewport owned by the user.
      remeasureVisibleRowsSync();
      writeVirtualScrollTop(container.scrollTop, {
        source: "browser",
        preserveScrollPosition: true,
      });
      syncViewportFromDom({
        source: "browser",
        preserveScrollPosition: true,
        forceRangeRefresh: true,
      });
      blankViewportRecoveryFrameRef.current =
        requestAnimationFrame(inspectAndRecover);
    };

    const requestInspection = () => {
      if (blankViewportRecoveryFrameRef.current == null) {
        blankViewportRecoveryFrameRef.current =
          requestAnimationFrame(inspectAndRecover);
      }
    };
    requestBlankViewportInspectionRef.current = requestInspection;
    requestInspection();
    return () => {
      requestBlankViewportInspectionRef.current = () => undefined;
      if (blankViewportRecoveryFrameRef.current != null) {
        cancelAnimationFrame(blankViewportRecoveryFrameRef.current);
        blankViewportRecoveryFrameRef.current = null;
      }
    };
  }, [
    isBoundedVirtualMode,
    remeasureVisibleRowsSync,
    sessionId,
    showPlaceholderContent,
    stableRows.length,
    syncViewportFromDom,
    readRealRowCoverage,
    virtualRangeRevision,
    writeVirtualScrollTop,
    sessionEpoch,
  ]);

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
    if (!handoff || streamingMessageId) {
      // Once no handoff remains, the temporary DOM-height floor has no owner
      // and must not survive as permanent empty space. This also covers a
      // handoff cleared by a prior restore before this effect runs again.
      if (!handoff && liveTailScrollHeightFloorPx > 0) {
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
    // The restore below reads the still-floored DOM geometry in this layout
    // pass. Release the floor for the next render after it has served that
    // purpose; detached readers keep their restored scrollTop, while the
    // existing height-change effect re-pins readers following latest.
    setLiveTailScrollHeightFloorPx(0);

    const nextBottomScrollTop = getBottomScrollTop(container);
    const wasNearLatest =
      !handoff.wasDetached &&
      handoff.distanceFromBottom < TIMELINE_AUTO_SCROLL_THRESHOLD_PX;
    const nextScrollTop = wasNearLatest
      ? nextBottomScrollTop
      : Math.min(nextBottomScrollTop, Math.max(0, handoff.scrollTop));
    if (Math.abs(container.scrollTop - nextScrollTop) > 1) {
      writeVirtualScrollTop(nextScrollTop, { source: "programmatic" });
    }
    const distanceFromBottom = Math.max(
      0,
      getBottomScrollTop(container) - container.scrollTop,
    );

    isNearBottomRef.current = isTimelineNearLatest(container);
    lastScrollTopRef.current = container.scrollTop;
    markPendingScrollOwnership(null);

    if (distanceFromBottom >= TIMELINE_AUTO_SCROLL_THRESHOLD_PX) {
      stickyScrollUntilRef.current = 0;
      setDetachedFromLatest(true);
    } else if (suppressFollowResumeFromProgrammaticScrollRef.current) {
      syncJumpToLatestVisibility();
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
    markPendingScrollOwnership,
    setDetachedFromLatest,
    streamingMessageId,
    syncJumpToLatestVisibility,
    syncViewportFromDom,
    writeVirtualScrollTop,
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
    if (
      resolvedScrollTargetMessageId ||
      userDetachedRef.current ||
      virtualTimelineSnapshot.controllerState.anchor.type !== "bottom"
    ) {
      return;
    }
    requestBottomScroll();
  }, [
    effectiveVirtualScrollHeight,
    isBoundedVirtualMode,
    requestBottomScroll,
    resolvedScrollTargetMessageId,
    streamingMessageId,
    virtualTimelineSnapshot.controllerState.anchor.type,
  ]);

  const messageList = (
    <div
      data-testid="virtual-message-timeline-list"
      {...TRANSCRIPT_SELECTION_SURFACE_ATTRIBUTES}
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
      data-virtual-blank-viewport-pixels={
        browserRowCoverage?.blankViewportPixels ?? 0
      }
      data-virtual-browser-intersecting-real-rows={
        browserRowCoverage?.intersectingRealRowCount ?? 0
      }
      data-virtual-blank-viewport-recovery-attempts={
        blankViewportRecoveryAttempts
      }
      data-virtual-range-mounted-rows={virtualRangeMountedRows}
      data-virtual-offscreen-real-mounted-rows={offscreenRealMountedRows}
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
          {...TRANSCRIPT_SELECTION_SURFACE_ATTRIBUTES}
          data-virtual-history-rows={virtualRows.length}
          style={virtualHistoryStyle}
        >
          <TranscriptOffscreenRealMeasurementHost
            rowCount={offscreenRealMountedRows}
          >
            {renderedOffscreenRealRows}
          </TranscriptOffscreenRealMeasurementHost>
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
        {!footer ? (
          <div
            className="pointer-events-none absolute left-1/2 flex -translate-x-1/2 gap-2"
            style={{ bottom: (tailPaddingPx ?? 16) + 8 }}
          >
            {jumpToLatestButton}
          </div>
        ) : null}
        {responseStartGutterPreference.enabled ? (
          <MessageTimelineJumpToResponseStartGutterButton
            label={jumpToResponseStartLabel}
            ariaLabel={jumpToFloatingResponseStartLabel}
            bottomOffsetPx={
              footer ? footerHeightPx + 8 : (tailPaddingPx ?? 16) + 8
            }
            visible={gutterResponseStartMessageId != null}
            messageId={gutterResponseStartMessageId}
            onJump={handleJumpToResponseStart}
          />
        ) : null}
      </div>
    </Profiler>
  );
}

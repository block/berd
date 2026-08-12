export const TRANSCRIPT_DIAGNOSTICS_SCHEMA_VERSION = "2026-06-04.v2";

export const TRANSCRIPT_DIAGNOSTICS_EVENT = "goose:transcript-diagnostics";

const LOGICAL_ROW_ESTIMATE_BLOCK_SIZE_PX = 1_400;

export const TRANSCRIPT_REQUIRED_NUMERIC_DIAGNOSTIC_KEYS = [
  "mountedRows",
  "protectedRows",
  "blankViewportPixels",
  "timeToFirstVisibleTailMs",
  "restoreReplayDrainMs",
  "projectionP95Ms",
  "projectionLastMs",
  "descriptorChurnPercent",
  "heapGrowthMb",
  "reactCommitP95Ms",
  "scrollHandlerP95Ms",
  "scrollCorrectionP95Px",
  "scrollCorrectionCount",
  "scrollCorrectionsPerSecond",
  "measurementBatchSize",
  "measurementAcceptedCount",
  "measurementCacheHitRate",
  "staleMeasurementDrops",
  "staleMeasurementRejectCount",
  "staleMeasurementSessionDrops",
  "staleMeasurementEpochDrops",
  "staleMeasurementWidthDrops",
  "staleMeasurementRevisionDrops",
  "staleMeasurementMissingRowDrops",
] as const;

export type TranscriptRequiredNumericDiagnosticKey =
  (typeof TRANSCRIPT_REQUIRED_NUMERIC_DIAGNOSTIC_KEYS)[number];

export type TranscriptDiagnosticsNumericValues = Record<
  TranscriptRequiredNumericDiagnosticKey,
  number
>;

export interface TranscriptTimingSample {
  startTime: number;
  endTime: number;
  durationMs: number;
  source?: string;
}

export const TRANSCRIPT_DIAGNOSTIC_NUMERIC_DEFAULTS = {
  mountedRows: 0,
  protectedRows: 0,
  blankViewportPixels: 0,
  timeToFirstVisibleTailMs: 0,
  restoreReplayDrainMs: 0,
  projectionP95Ms: 0,
  projectionLastMs: 0,
  descriptorChurnPercent: 0,
  heapGrowthMb: 0,
  reactCommitP95Ms: 0,
  scrollHandlerP95Ms: 0,
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
} satisfies TranscriptDiagnosticsNumericValues;

export interface TranscriptDiagnostics
  extends TranscriptDiagnosticsNumericValues {
  schemaVersion: typeof TRANSCRIPT_DIAGNOSTICS_SCHEMA_VERSION;
  bridgeKind?: string;
  rendererMode?: string;
  sessionId?: string;
  activeSessionId?: string;
  sessionEpoch?: number;
  totalRows?: number;
  logicalRows?: number;
  totalScrollHeight?: number;
  virtualUnmountingEnabled?: boolean;
  blockerIds?: readonly string[];
  offscreenRealMountedRows?: number;
  offscreenShellMountedRows?: number;
  staleAnchorsDropped?: number;
  missingAnchorsDropped?: number;
  recapturedAnchors?: number;
  pr928SameIdStaleRevisionProofs?: number;
  pr928WholeRowSplitProofs?: number;
  pr928StreamingTailPromotionProofs?: number;
  pr928RealFragmentTailBlockers?: number;
  reactCommitSamples?: readonly TranscriptTimingSample[];
  scrollHandlerSamples?: readonly TranscriptTimingSample[];
}

interface TranscriptVirtualTimelineControllerDiagnosticsInput {
  corrections?: number;
  bottomFollowExits?: number;
  staleMeasurementsDropped?: number;
  staleMeasurementSessionDrops?: number;
  staleMeasurementEpochDrops?: number;
  staleMeasurementWidthDrops?: number;
  staleMeasurementRevisionDrops?: number;
  staleMeasurementMissingRowDrops?: number;
  staleAnchorsDropped?: number;
  missingAnchorsDropped?: number;
  recapturedAnchors?: number;
  lastCorrectionDeltaPx?: number;
}

interface TranscriptVirtualTimelineMeasurementDiagnosticsInput {
  visibleMeasurementAttempts?: number;
  offscreenShellMeasurementAttempts?: number;
  acceptedOffscreenShellMeasurements?: number;
  acceptedOffscreenRealMeasurements?: number;
  acceptedVisibleMeasurements?: number;
  skippedPendingMeasurements?: number;
  skippedZeroMeasurements?: number;
  staleMeasurementsDropped?: number;
  staleMeasurementSessionDrops?: number;
  staleMeasurementEpochDrops?: number;
  staleMeasurementWidthDrops?: number;
  staleMeasurementRevisionDrops?: number;
  staleMeasurementMissingRowDrops?: number;
  reservedMeasurementsDeferred?: number;
  controllerUpdatesQueued?: number;
  controllerUpdateBatches?: number;
  controllerUpdateBatchMaxSize?: number;
  cacheHits?: number;
  cacheMisses?: number;
}

export interface TranscriptVirtualTimelineDiagnosticsInput {
  bridgeKind?: string;
  renderer?: string;
  mode?: string;
  rendererMode?: string;
  sessionId?: string;
  activeSessionId?: string;
  sessionEpoch?: number;
  totalRows?: number;
  logicalRows?: number;
  mountedRows?: number;
  offscreenRealMountedRows?: number;
  offscreenShellMountedRows?: number;
  protectedRows?: number;
  descriptorChurn?: number;
  descriptorChurnPercent?: number;
  projectionDurationMs?: number;
  projectionP95Ms?: number;
  projectionLastMs?: number;
  blankViewportPixels?: number;
  timeToFirstVisibleTailMs?: number;
  restoreReplayDrainMs?: number;
  heapGrowthMb?: number;
  reactCommitP95Ms?: number;
  scrollHandlerP95Ms?: number;
  scrollCorrectionP95Px?: number;
  scrollCorrectionCount?: number;
  scrollCorrectionsPerSecond?: number;
  measurementBatchSize?: number;
  measurementAcceptedCount?: number;
  measurementCacheHitRate?: number;
  staleMeasurementDrops?: number;
  staleMeasurementRejectCount?: number;
  staleMeasurementSessionDrops?: number;
  staleMeasurementEpochDrops?: number;
  staleMeasurementWidthDrops?: number;
  staleMeasurementRevisionDrops?: number;
  staleMeasurementMissingRowDrops?: number;
  virtualUnmountingEnabled?: boolean;
  virtualScrollHeight?: number;
  totalScrollHeight?: number;
  controller?: TranscriptVirtualTimelineControllerDiagnosticsInput;
  measurement?: TranscriptVirtualTimelineMeasurementDiagnosticsInput;
  blockers?: readonly string[];
  blockerIds?: readonly string[];
  staleAnchorsDropped?: number;
  missingAnchorsDropped?: number;
  recapturedAnchors?: number;
  pr928SameIdStaleRevisionProofs?: number;
  pr928WholeRowSplitProofs?: number;
  pr928StreamingTailPromotionProofs?: number;
  pr928RealFragmentTailBlockers?: number;
  reactCommitSamples?: readonly TranscriptTimingSample[];
  scrollHandlerSamples?: readonly TranscriptTimingSample[];
}

export interface CreateTranscriptDiagnosticsFromVirtualTimelineOptions {
  bridgeKind?: string;
  rendererMode?: string;
  elapsedMs?: number;
}

export interface TranscriptDiagnosticsValidationError {
  key: string;
  reason: "missing" | "non-finite-number" | "not-an-object";
}

export interface TranscriptDiagnosticsValidationResult {
  diagnostics: TranscriptDiagnostics;
  errors: readonly TranscriptDiagnosticsValidationError[];
}

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value != null && !Array.isArray(value);
}

function readOptionalString(
  record: UnknownRecord,
  key: string,
): string | undefined {
  const value = record[key];
  return typeof value === "string" ? value : undefined;
}

function readOptionalFiniteNumber(
  record: UnknownRecord,
  key: string,
): number | undefined {
  const value = record[key];
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

function readOptionalBoolean(
  record: UnknownRecord,
  key: string,
): boolean | undefined {
  const value = record[key];
  return typeof value === "boolean" ? value : undefined;
}

function readOptionalStringArray(
  record: UnknownRecord,
  key: string,
): readonly string[] | undefined {
  const value = record[key];
  return Array.isArray(value) && value.every((item) => typeof item === "string")
    ? value
    : undefined;
}

function normalizeTimingSamples(
  value: unknown,
): readonly TranscriptTimingSample[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }

  const samples: TranscriptTimingSample[] = [];
  for (const sample of value) {
    if (!isRecord(sample)) {
      return undefined;
    }

    const startTime = sample.startTime;
    const endTime = sample.endTime;
    const durationMs = sample.durationMs;
    if (
      typeof startTime !== "number" ||
      !Number.isFinite(startTime) ||
      typeof endTime !== "number" ||
      !Number.isFinite(endTime) ||
      typeof durationMs !== "number" ||
      !Number.isFinite(durationMs) ||
      endTime < startTime ||
      durationMs < 0
    ) {
      return undefined;
    }

    const source = sample.source;
    samples.push({
      startTime,
      endTime,
      durationMs,
      ...(typeof source === "string" ? { source } : {}),
    });
  }

  return samples;
}

function finiteNumberOrDefault(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function finiteNumberOrUndefined(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

function percentOfTotal(count: number, total: number): number {
  if (total <= 0) {
    return 0;
  }
  return (count / total) * 100;
}

function inferLogicalRows(
  input: TranscriptVirtualTimelineDiagnosticsInput,
  totalRows: number,
): number {
  const explicitLogicalRows = finiteNumberOrUndefined(input.logicalRows);
  if (explicitLogicalRows != null) {
    return Math.max(totalRows, explicitLogicalRows);
  }

  const totalScrollHeight = finiteNumberOrDefault(
    input.totalScrollHeight,
    finiteNumberOrDefault(input.virtualScrollHeight, 0),
  );
  if (totalScrollHeight <= 0) {
    return totalRows;
  }

  return Math.max(
    totalRows,
    Math.ceil(totalScrollHeight / LOGICAL_ROW_ESTIMATE_BLOCK_SIZE_PX),
  );
}

function ratePerSecond(count: number, elapsedMs: number | undefined): number {
  if (elapsedMs == null || elapsedMs <= 0) {
    return 0;
  }
  return count / (elapsedMs / 1000);
}

function cacheHitRate(
  hits: number | undefined,
  misses: number | undefined,
): number | undefined {
  if (hits == null && misses == null) {
    return undefined;
  }

  const hitCount = finiteNumberOrDefault(hits, 0);
  const missCount = finiteNumberOrDefault(misses, 0);
  const total = hitCount + missCount;
  return total <= 0 ? 1 : hitCount / total;
}

function sumFiniteNumbers(values: readonly unknown[]): number {
  return values.reduce<number>(
    (total, value) => total + finiteNumberOrDefault(value, 0),
    0,
  );
}

export function createTranscriptDiagnostics(
  overrides: Partial<TranscriptDiagnostics> = {},
): TranscriptDiagnostics {
  const staleMeasurementRejectCount = finiteNumberOrDefault(
    overrides.staleMeasurementRejectCount,
    TRANSCRIPT_DIAGNOSTIC_NUMERIC_DEFAULTS.staleMeasurementRejectCount,
  );

  return {
    schemaVersion: TRANSCRIPT_DIAGNOSTICS_SCHEMA_VERSION,
    ...TRANSCRIPT_DIAGNOSTIC_NUMERIC_DEFAULTS,
    staleMeasurementDrops: finiteNumberOrDefault(
      overrides.staleMeasurementDrops,
      staleMeasurementRejectCount,
    ),
    ...overrides,
  };
}

export function createTranscriptDiagnosticsFromVirtualTimelineDiagnostics(
  input: TranscriptVirtualTimelineDiagnosticsInput,
  options: CreateTranscriptDiagnosticsFromVirtualTimelineOptions = {},
): TranscriptDiagnostics {
  const totalRows = finiteNumberOrDefault(input.totalRows, 0);
  const logicalRows = inferLogicalRows(input, totalRows);
  const descriptorChurn = finiteNumberOrUndefined(input.descriptorChurn);
  const correctionCount = finiteNumberOrDefault(
    input.scrollCorrectionCount,
    finiteNumberOrDefault(input.controller?.corrections, 0),
  );
  const staleMeasurementRejectCount = finiteNumberOrDefault(
    input.staleMeasurementRejectCount,
    sumFiniteNumbers([
      input.controller?.staleMeasurementsDropped,
      input.measurement?.staleMeasurementsDropped,
    ]),
  );
  const measurementAcceptedCount = finiteNumberOrDefault(
    input.measurementAcceptedCount,
    sumFiniteNumbers([
      input.measurement?.acceptedVisibleMeasurements,
      input.measurement?.acceptedOffscreenShellMeasurements,
      input.measurement?.acceptedOffscreenRealMeasurements,
    ]),
  );
  const measurementBatchSize = finiteNumberOrDefault(
    input.measurementBatchSize,
    finiteNumberOrDefault(
      input.measurement?.controllerUpdateBatchMaxSize,
      input.measurement?.controllerUpdateBatches &&
        input.measurement.controllerUpdateBatches > 0
        ? finiteNumberOrDefault(input.measurement.controllerUpdatesQueued, 0) /
            input.measurement.controllerUpdateBatches
        : 0,
    ),
  );
  const projectionLastMs = finiteNumberOrDefault(
    input.projectionLastMs,
    finiteNumberOrDefault(input.projectionDurationMs, 0),
  );
  const mountedRows = finiteNumberOrDefault(input.mountedRows, totalRows);

  return createTranscriptDiagnostics({
    bridgeKind:
      options.bridgeKind ??
      input.bridgeKind ??
      "production-virtual-message-timeline",
    rendererMode: options.rendererMode ?? input.rendererMode ?? "virtual",
    sessionId: input.sessionId,
    activeSessionId: input.activeSessionId ?? input.sessionId,
    sessionEpoch: finiteNumberOrUndefined(input.sessionEpoch),
    totalRows,
    logicalRows,
    totalScrollHeight: finiteNumberOrDefault(
      input.totalScrollHeight,
      finiteNumberOrDefault(input.virtualScrollHeight, 0),
    ),
    virtualUnmountingEnabled: input.virtualUnmountingEnabled,
    blockerIds: input.blockerIds ?? input.blockers,
    offscreenRealMountedRows: finiteNumberOrUndefined(
      input.offscreenRealMountedRows,
    ),
    offscreenShellMountedRows: finiteNumberOrUndefined(
      input.offscreenShellMountedRows,
    ),
    staleAnchorsDropped: finiteNumberOrDefault(
      input.staleAnchorsDropped,
      finiteNumberOrDefault(input.controller?.staleAnchorsDropped, 0),
    ),
    missingAnchorsDropped: finiteNumberOrDefault(
      input.missingAnchorsDropped,
      finiteNumberOrDefault(input.controller?.missingAnchorsDropped, 0),
    ),
    recapturedAnchors: finiteNumberOrDefault(
      input.recapturedAnchors,
      finiteNumberOrDefault(input.controller?.recapturedAnchors, 0),
    ),
    pr928SameIdStaleRevisionProofs: finiteNumberOrUndefined(
      input.pr928SameIdStaleRevisionProofs,
    ),
    pr928WholeRowSplitProofs: finiteNumberOrUndefined(
      input.pr928WholeRowSplitProofs,
    ),
    pr928StreamingTailPromotionProofs: finiteNumberOrUndefined(
      input.pr928StreamingTailPromotionProofs,
    ),
    pr928RealFragmentTailBlockers: finiteNumberOrUndefined(
      input.pr928RealFragmentTailBlockers,
    ),
    reactCommitSamples: normalizeTimingSamples(input.reactCommitSamples),
    scrollHandlerSamples: normalizeTimingSamples(input.scrollHandlerSamples),
    mountedRows,
    protectedRows: finiteNumberOrDefault(input.protectedRows, 0),
    blankViewportPixels: finiteNumberOrDefault(input.blankViewportPixels, 0),
    timeToFirstVisibleTailMs: finiteNumberOrDefault(
      input.timeToFirstVisibleTailMs,
      0,
    ),
    restoreReplayDrainMs: finiteNumberOrDefault(input.restoreReplayDrainMs, 0),
    projectionP95Ms: finiteNumberOrDefault(
      input.projectionP95Ms,
      projectionLastMs,
    ),
    projectionLastMs,
    descriptorChurnPercent:
      descriptorChurn == null
        ? finiteNumberOrDefault(input.descriptorChurnPercent, 0)
        : percentOfTotal(descriptorChurn, Math.max(logicalRows, totalRows)),
    heapGrowthMb: finiteNumberOrDefault(input.heapGrowthMb, 0),
    reactCommitP95Ms: finiteNumberOrDefault(input.reactCommitP95Ms, 0),
    scrollHandlerP95Ms: finiteNumberOrDefault(input.scrollHandlerP95Ms, 0),
    scrollCorrectionP95Px: finiteNumberOrDefault(
      input.scrollCorrectionP95Px,
      finiteNumberOrDefault(input.controller?.lastCorrectionDeltaPx, 0),
    ),
    scrollCorrectionCount: correctionCount,
    scrollCorrectionsPerSecond: finiteNumberOrDefault(
      input.scrollCorrectionsPerSecond,
      ratePerSecond(correctionCount, options.elapsedMs),
    ),
    measurementBatchSize,
    measurementAcceptedCount,
    measurementCacheHitRate: finiteNumberOrDefault(
      input.measurementCacheHitRate,
      finiteNumberOrDefault(
        cacheHitRate(
          input.measurement?.cacheHits,
          input.measurement?.cacheMisses,
        ),
        TRANSCRIPT_DIAGNOSTIC_NUMERIC_DEFAULTS.measurementCacheHitRate,
      ),
    ),
    staleMeasurementDrops: finiteNumberOrDefault(
      input.staleMeasurementDrops,
      staleMeasurementRejectCount,
    ),
    staleMeasurementRejectCount,
    staleMeasurementSessionDrops: finiteNumberOrDefault(
      input.staleMeasurementSessionDrops,
      sumFiniteNumbers([
        input.controller?.staleMeasurementSessionDrops,
        input.measurement?.staleMeasurementSessionDrops,
      ]),
    ),
    staleMeasurementEpochDrops: finiteNumberOrDefault(
      input.staleMeasurementEpochDrops,
      sumFiniteNumbers([
        input.controller?.staleMeasurementEpochDrops,
        input.measurement?.staleMeasurementEpochDrops,
      ]),
    ),
    staleMeasurementWidthDrops: finiteNumberOrDefault(
      input.staleMeasurementWidthDrops,
      sumFiniteNumbers([
        input.controller?.staleMeasurementWidthDrops,
        input.measurement?.staleMeasurementWidthDrops,
      ]),
    ),
    staleMeasurementRevisionDrops: finiteNumberOrDefault(
      input.staleMeasurementRevisionDrops,
      sumFiniteNumbers([
        input.controller?.staleMeasurementRevisionDrops,
        input.measurement?.staleMeasurementRevisionDrops,
      ]),
    ),
    staleMeasurementMissingRowDrops: finiteNumberOrDefault(
      input.staleMeasurementMissingRowDrops,
      sumFiniteNumbers([
        input.controller?.staleMeasurementMissingRowDrops,
        input.measurement?.staleMeasurementMissingRowDrops,
      ]),
    ),
  });
}

export function validateTranscriptDiagnostics(
  value: unknown,
): TranscriptDiagnosticsValidationResult {
  const errors: TranscriptDiagnosticsValidationError[] = [];
  const diagnostics = createTranscriptDiagnostics();

  if (!isRecord(value)) {
    return {
      diagnostics,
      errors: [{ key: "$", reason: "not-an-object" }],
    };
  }

  for (const key of TRANSCRIPT_REQUIRED_NUMERIC_DIAGNOSTIC_KEYS) {
    const rawValue = value[key];
    if (rawValue == null) {
      errors.push({ key, reason: "missing" });
      continue;
    }

    if (typeof rawValue !== "number" || !Number.isFinite(rawValue)) {
      errors.push({ key, reason: "non-finite-number" });
      continue;
    }

    diagnostics[key] = rawValue;
  }

  return {
    diagnostics: {
      ...diagnostics,
      bridgeKind: readOptionalString(value, "bridgeKind"),
      rendererMode: readOptionalString(value, "rendererMode"),
      sessionId: readOptionalString(value, "sessionId"),
      activeSessionId: readOptionalString(value, "activeSessionId"),
      sessionEpoch: readOptionalFiniteNumber(value, "sessionEpoch"),
      totalRows: readOptionalFiniteNumber(value, "totalRows"),
      logicalRows: readOptionalFiniteNumber(value, "logicalRows"),
      totalScrollHeight: readOptionalFiniteNumber(value, "totalScrollHeight"),
      virtualUnmountingEnabled: readOptionalBoolean(
        value,
        "virtualUnmountingEnabled",
      ),
      blockerIds: readOptionalStringArray(value, "blockerIds"),
      staleAnchorsDropped: readOptionalFiniteNumber(
        value,
        "staleAnchorsDropped",
      ),
      missingAnchorsDropped: readOptionalFiniteNumber(
        value,
        "missingAnchorsDropped",
      ),
      recapturedAnchors: readOptionalFiniteNumber(value, "recapturedAnchors"),
      pr928SameIdStaleRevisionProofs: readOptionalFiniteNumber(
        value,
        "pr928SameIdStaleRevisionProofs",
      ),
      pr928WholeRowSplitProofs: readOptionalFiniteNumber(
        value,
        "pr928WholeRowSplitProofs",
      ),
      pr928StreamingTailPromotionProofs: readOptionalFiniteNumber(
        value,
        "pr928StreamingTailPromotionProofs",
      ),
      pr928RealFragmentTailBlockers: readOptionalFiniteNumber(
        value,
        "pr928RealFragmentTailBlockers",
      ),
      reactCommitSamples: normalizeTimingSamples(value.reactCommitSamples),
      scrollHandlerSamples: normalizeTimingSamples(value.scrollHandlerSamples),
    },
    errors,
  };
}

export function formatTranscriptDiagnosticsValidationErrors(
  errors: readonly TranscriptDiagnosticsValidationError[],
): string {
  return errors.map((error) => `${error.key}: ${error.reason}`).join("\n");
}

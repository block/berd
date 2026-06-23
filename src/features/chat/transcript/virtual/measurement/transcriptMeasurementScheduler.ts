import {
  getTranscriptRowEstimatedHeight,
  type TranscriptRowDescriptor,
} from "../../projection/transcriptItemTypes";
import { getMeasurementFinalizationDecision } from "../../measurement/transcriptLayoutPending";
import type { TranscriptMeasurementResult } from "../transcriptVirtualEngine";
import type {
  TranscriptMeasurementSource,
  TranscriptScrollCorrection,
  TranscriptVirtualMeasurementToken,
} from "../transcriptVirtualTypes";

const DEFAULT_MAX_CACHE_ENTRIES = 2000;

export type TranscriptOffscreenMeasurementSource =
  | "offscreen-real"
  | "offscreen-shell";

export interface TranscriptMeasurementSchedulerContext {
  sessionId: string;
  sessionEpoch: number;
  widthScope: string;
  rows?: readonly TranscriptRowDescriptor[];
}

export interface TranscriptMeasurementSchedulerOptions {
  maxCacheEntries?: number;
  now?: () => number;
  onControllerBatchQueued?: () => void;
}

export interface TranscriptMeasurementCacheEntry {
  token: TranscriptVirtualMeasurementToken;
  height: number;
  source: TranscriptMeasurementSource;
  finalized: boolean;
  updatedAt: number;
}

export interface TranscriptMeasurementCacheStats {
  size: number;
  hits: number;
  misses: number;
  writes: number;
  evictions: number;
}

export interface TranscriptMeasurementPlanBase {
  rowId: string;
  token: TranscriptVirtualMeasurementToken;
  estimatedHeight: number;
  cachedHeight: number | null;
  cachedSource: TranscriptMeasurementSource | null;
}

export type TranscriptMeasurementPlan =
  | (TranscriptMeasurementPlanBase & {
      kind: "mounted";
    })
  | (TranscriptMeasurementPlanBase & {
      kind: "offscreen-real";
    })
  | (TranscriptMeasurementPlanBase & {
      kind: "offscreen-shell";
    })
  | (TranscriptMeasurementPlanBase & {
      kind: "estimate-only";
    })
  | {
      kind: "missing-row";
      rowId: string;
    };

export type TranscriptMeasurementDropReason =
  | "stale-token"
  | "policy-blocked"
  | "layout-pending"
  | "missing-row";

export type TranscriptMeasurementRecordResult =
  | {
      status: "accepted";
      entry: TranscriptMeasurementCacheEntry;
      queuedControllerUpdate: boolean;
    }
  | {
      status: "pending";
      token: TranscriptVirtualMeasurementToken;
      blockSize: number;
      source: "measured" | "reserved";
      queuedControllerUpdate: false;
    }
  | {
      status: "dropped";
      reason: TranscriptMeasurementDropReason;
      token: TranscriptVirtualMeasurementToken;
      queuedControllerUpdate: false;
    };

export interface TranscriptMountedMeasurementInput {
  token: TranscriptVirtualMeasurementToken;
  measuredBlockSize: number;
  root?: Element;
  reservedBlockSize?: number | null;
}

export interface TranscriptOffscreenMeasurementInput {
  token: TranscriptVirtualMeasurementToken;
  height: number;
  source: TranscriptOffscreenMeasurementSource;
}

export interface TranscriptControllerMeasurementUpdate {
  token: TranscriptVirtualMeasurementToken;
  height: number;
  source: TranscriptMeasurementSource;
  finalized: boolean;
}

export interface TranscriptMeasurementControllerTarget {
  applyMeasuredHeight(input: {
    token: TranscriptVirtualMeasurementToken;
    height: number;
  }): TranscriptMeasurementResult;
  applyMeasuredHeights?(
    input: {
      token: TranscriptVirtualMeasurementToken;
      height: number;
    }[],
  ): {
    acceptedTokens: readonly TranscriptVirtualMeasurementToken[];
    rejected: number;
    correction: TranscriptScrollCorrection | null;
  };
}

export interface TranscriptControllerBatchFlushResult {
  updates: readonly TranscriptControllerMeasurementUpdate[];
  accepted: number;
  rejected: number;
  corrections: readonly TranscriptScrollCorrection[];
}

export interface TranscriptMeasurementSchedulerDiagnostics {
  mountedMeasurementsAccepted: number;
  offscreenRealMeasurementsAccepted: number;
  offscreenShellMeasurementsAccepted: number;
  estimateOnlyPlans: number;
  pendingMeasurementsCreated: number;
  pendingMeasurementsFinalized: number;
  pendingMeasurements: number;
  controllerUpdatesQueued: number;
  controllerUpdateBatches: number;
  controllerUpdatesFlushed: number;
  controllerUpdatesAccepted: number;
  controllerUpdatesRejected: number;
  staleMeasurementsDropped: number;
  staleMeasurementSessionDrops: number;
  staleMeasurementEpochDrops: number;
  staleMeasurementWidthDrops: number;
  staleMeasurementRevisionDrops: number;
  staleMeasurementMissingRowDrops: number;
  policyMeasurementsDropped: number;
  cache: TranscriptMeasurementCacheStats;
}

interface PendingMeasurementFinalization {
  token: TranscriptVirtualMeasurementToken;
  measuredBlockSize: number;
  reservedBlockSize: number | null;
  updatedAt: number;
}

interface TokenValidationResult {
  valid: boolean;
  row: TranscriptRowDescriptor | null;
}

interface AcceptMeasurementInput {
  token: TranscriptVirtualMeasurementToken;
  height: number;
  source: TranscriptMeasurementSource;
  finalized: boolean;
}

interface SchedulerCounters {
  mountedMeasurementsAccepted: number;
  offscreenRealMeasurementsAccepted: number;
  offscreenShellMeasurementsAccepted: number;
  estimateOnlyPlans: number;
  pendingMeasurementsCreated: number;
  pendingMeasurementsFinalized: number;
  controllerUpdatesQueued: number;
  controllerUpdateBatches: number;
  controllerUpdatesFlushed: number;
  controllerUpdatesAccepted: number;
  controllerUpdatesRejected: number;
  staleMeasurementsDropped: number;
  staleMeasurementSessionDrops: number;
  staleMeasurementEpochDrops: number;
  staleMeasurementWidthDrops: number;
  staleMeasurementRevisionDrops: number;
  staleMeasurementMissingRowDrops: number;
  policyMeasurementsDropped: number;
}

const EMPTY_COUNTERS: SchedulerCounters = {
  mountedMeasurementsAccepted: 0,
  offscreenRealMeasurementsAccepted: 0,
  offscreenShellMeasurementsAccepted: 0,
  estimateOnlyPlans: 0,
  pendingMeasurementsCreated: 0,
  pendingMeasurementsFinalized: 0,
  controllerUpdatesQueued: 0,
  controllerUpdateBatches: 0,
  controllerUpdatesFlushed: 0,
  controllerUpdatesAccepted: 0,
  controllerUpdatesRejected: 0,
  staleMeasurementsDropped: 0,
  staleMeasurementSessionDrops: 0,
  staleMeasurementEpochDrops: 0,
  staleMeasurementWidthDrops: 0,
  staleMeasurementRevisionDrops: 0,
  staleMeasurementMissingRowDrops: 0,
  policyMeasurementsDropped: 0,
};

export class TranscriptMeasurementCache {
  private readonly maxEntries: number;
  private entries = new Map<string, TranscriptMeasurementCacheEntry>();
  private hits = 0;
  private misses = 0;
  private writes = 0;
  private evictions = 0;

  constructor(maxEntries = DEFAULT_MAX_CACHE_ENTRIES) {
    this.maxEntries = Math.max(1, maxEntries);
  }

  get(
    token: TranscriptVirtualMeasurementToken,
  ): TranscriptMeasurementCacheEntry | null {
    const key = createMeasurementCacheKey(token);
    const entry = this.entries.get(key);

    if (!entry) {
      this.misses += 1;
      return null;
    }

    this.hits += 1;
    this.entries.delete(key);
    this.entries.set(key, entry);
    return cloneCacheEntry(entry);
  }

  peek(
    token: TranscriptVirtualMeasurementToken,
  ): TranscriptMeasurementCacheEntry | null {
    const entry = this.entries.get(createMeasurementCacheKey(token));
    return entry ? cloneCacheEntry(entry) : null;
  }

  set(entry: TranscriptMeasurementCacheEntry): void {
    const key = createMeasurementCacheKey(entry.token);
    this.entries.delete(key);
    this.entries.set(key, cloneCacheEntry(entry));
    this.writes += 1;

    while (this.entries.size > this.maxEntries) {
      const firstKey = this.entries.keys().next().value as string | undefined;
      if (firstKey === undefined) {
        return;
      }
      this.entries.delete(firstKey);
      this.evictions += 1;
    }
  }

  deleteSession(sessionId: string, sessionEpoch?: number): number {
    let deleted = 0;
    for (const [key, entry] of this.entries) {
      if (
        entry.token.sessionId === sessionId &&
        (sessionEpoch === undefined ||
          entry.token.sessionEpoch === sessionEpoch)
      ) {
        this.entries.delete(key);
        deleted += 1;
      }
    }
    return deleted;
  }

  clear(): void {
    this.entries.clear();
  }

  getStats(): TranscriptMeasurementCacheStats {
    return {
      size: this.entries.size,
      hits: this.hits,
      misses: this.misses,
      writes: this.writes,
      evictions: this.evictions,
    };
  }
}

export class TranscriptMeasurementScheduler {
  private sessionId: string;
  private sessionEpoch: number;
  private widthScope: string;
  private rows: readonly TranscriptRowDescriptor[];
  private rowById = new Map<string, TranscriptRowDescriptor>();
  private readonly cache: TranscriptMeasurementCache;
  private readonly now: () => number;
  private readonly onControllerBatchQueued: (() => void) | undefined;
  private pendingFinalizations = new Map<
    string,
    PendingMeasurementFinalization
  >();
  private controllerQueue = new Map<
    string,
    TranscriptControllerMeasurementUpdate
  >();
  private counters: SchedulerCounters = { ...EMPTY_COUNTERS };

  constructor(
    context: TranscriptMeasurementSchedulerContext,
    options: TranscriptMeasurementSchedulerOptions = {},
  ) {
    this.sessionId = context.sessionId;
    this.sessionEpoch = context.sessionEpoch;
    this.widthScope = context.widthScope;
    this.rows = context.rows ?? [];
    this.cache = new TranscriptMeasurementCache(options.maxCacheEntries);
    this.now = options.now ?? (() => Date.now());
    this.onControllerBatchQueued = options.onControllerBatchQueued;
    this.rebuildRowIndex();
  }

  setContext(context: TranscriptMeasurementSchedulerContext): void {
    this.sessionId = context.sessionId;
    this.sessionEpoch = context.sessionEpoch;
    this.widthScope = context.widthScope;
    if (context.rows !== undefined) {
      this.rows = context.rows;
      this.rebuildRowIndex();
    }
    this.pruneStalePendingWork();
  }

  setRows(rows: readonly TranscriptRowDescriptor[]): void {
    this.rows = rows;
    this.rebuildRowIndex();
    this.pruneStalePendingWork();
  }

  getMeasurementToken(rowId: string): TranscriptVirtualMeasurementToken | null {
    const row = this.rowById.get(rowId);
    if (!row) {
      return null;
    }

    return {
      sessionId: this.sessionId,
      sessionEpoch: this.sessionEpoch,
      widthScope: this.widthScope,
      rowId,
      heightRevision: row.heightRevision,
      layoutRevision: row.layoutRevision,
    };
  }

  planMountedMeasurement(rowId: string): TranscriptMeasurementPlan {
    return this.createMeasurementPlan(rowId, "mounted");
  }

  planOffscreenMeasurement(rowId: string): TranscriptMeasurementPlan {
    const row = this.rowById.get(rowId);
    if (!row) {
      return { kind: "missing-row", rowId };
    }

    switch (row.measurementPolicy) {
      case "measure-real":
        return this.createMeasurementPlan(rowId, "offscreen-real");
      case "measure-shell":
        return this.createMeasurementPlan(rowId, "offscreen-shell");
      case "estimate-only":
        this.counters.estimateOnlyPlans += 1;
        return this.createMeasurementPlan(rowId, "estimate-only");
      default:
        assertNever(row.measurementPolicy);
    }
  }

  getCachedMeasurement(rowId: string): TranscriptMeasurementCacheEntry | null {
    const token = this.getMeasurementToken(rowId);
    if (!token) {
      return null;
    }
    return this.cache.get(token);
  }

  peekCachedMeasurement(rowId: string): TranscriptMeasurementCacheEntry | null {
    const token = this.getMeasurementToken(rowId);
    if (!token) {
      return null;
    }
    return this.cache.peek(token);
  }

  queueCachedControllerUpdate(rowId: string): boolean {
    const cached = this.peekCachedMeasurement(rowId);
    if (!cached?.finalized || !this.validateToken(cached.token).valid) {
      return false;
    }

    this.queueControllerUpdate(cached);
    return true;
  }

  recordMountedMeasurement(
    input: TranscriptMountedMeasurementInput,
  ): TranscriptMeasurementRecordResult {
    const validation = this.validateToken(input.token);
    if (!validation.valid) {
      return this.createDroppedResult(input.token, "stale-token");
    }

    const finalization = input.root
      ? getMeasurementFinalizationDecision({
          root: input.root,
          measuredBlockSize: normalizeHeight(input.measuredBlockSize),
          reservedBlockSize: input.reservedBlockSize,
        })
      : {
          canFinalize: true,
          blockSize: normalizeHeight(input.measuredBlockSize),
          source: "measured" as const,
        };

    if (!finalization.canFinalize) {
      const key = createMeasurementCacheKey(input.token);
      const hadPending = this.pendingFinalizations.has(key);
      this.pendingFinalizations.set(key, {
        token: cloneToken(input.token),
        measuredBlockSize: normalizeHeight(input.measuredBlockSize),
        reservedBlockSize:
          finalization.source === "reserved" ? finalization.blockSize : null,
        updatedAt: this.now(),
      });
      if (!hadPending) {
        this.counters.pendingMeasurementsCreated += 1;
      }

      return {
        status: "pending",
        token: cloneToken(input.token),
        blockSize: finalization.blockSize,
        source: finalization.source,
        queuedControllerUpdate: false,
      };
    }

    return this.acceptMeasurement({
      token: input.token,
      height: finalization.blockSize,
      source: "visible",
      finalized: true,
    });
  }

  finalizePendingMeasurement(
    input: TranscriptMountedMeasurementInput,
  ): TranscriptMeasurementRecordResult {
    const key = createMeasurementCacheKey(input.token);
    const hadPending = this.pendingFinalizations.has(key);
    const result = this.recordMountedMeasurement(input);

    if (hadPending && result.status === "accepted") {
      this.counters.pendingMeasurementsFinalized += 1;
    }

    return result;
  }

  recordOffscreenMeasurement(
    input: TranscriptOffscreenMeasurementInput,
  ): TranscriptMeasurementRecordResult {
    const validation = this.validateToken(input.token);
    if (!validation.valid) {
      return this.createDroppedResult(input.token, "stale-token");
    }

    if (
      !validation.row ||
      !canAcceptOffscreenSource(validation.row, input.source)
    ) {
      this.counters.policyMeasurementsDropped += 1;
      return this.createDroppedResult(input.token, "policy-blocked");
    }

    if (input.source === "offscreen-shell") {
      return this.acceptShellEstimate(input);
    }

    return this.acceptMeasurement({
      token: input.token,
      height: input.height,
      source: input.source,
      finalized: true,
    });
  }

  drainControllerUpdateBatch(
    maxUpdates?: number,
  ): readonly TranscriptControllerMeasurementUpdate[] {
    if (this.controllerQueue.size === 0) {
      return [];
    }

    const limit =
      maxUpdates === undefined
        ? Number.POSITIVE_INFINITY
        : Math.max(1, Math.floor(maxUpdates));
    const queued: TranscriptControllerMeasurementUpdate[] = [];
    for (const [key, update] of this.controllerQueue) {
      if (queued.length >= limit) {
        break;
      }
      this.controllerQueue.delete(key);
      queued.push(update);
    }
    const valid: TranscriptControllerMeasurementUpdate[] = [];

    for (const update of queued) {
      if (this.validateToken(update.token).valid) {
        valid.push(cloneControllerUpdate(update));
      }
    }

    if (valid.length > 0) {
      this.counters.controllerUpdateBatches += 1;
    }

    return valid;
  }

  flushControllerUpdateBatch(
    controller: TranscriptMeasurementControllerTarget,
    maxUpdates?: number,
  ): TranscriptControllerBatchFlushResult {
    const updates = this.drainControllerUpdateBatch(maxUpdates);
    const corrections: TranscriptScrollCorrection[] = [];
    let accepted = 0;
    let rejected = 0;

    if (updates.length > 0 && controller.applyMeasuredHeights) {
      const result = controller.applyMeasuredHeights(
        updates.map((update) => ({
          token: update.token,
          height: update.height,
        })),
      );
      this.counters.controllerUpdatesFlushed += updates.length;
      accepted = result.acceptedTokens.length;
      rejected = result.rejected;
      this.counters.controllerUpdatesAccepted += accepted;
      this.counters.controllerUpdatesRejected += rejected;
      if (result.correction) {
        corrections.push(result.correction);
      }

      return {
        updates,
        accepted,
        rejected,
        corrections,
      };
    }

    for (const update of updates) {
      const result = controller.applyMeasuredHeight({
        token: update.token,
        height: update.height,
      });
      this.counters.controllerUpdatesFlushed += 1;
      if (result.accepted) {
        accepted += 1;
        this.counters.controllerUpdatesAccepted += 1;
        if (result.correction) {
          corrections.push(result.correction);
        }
      } else {
        rejected += 1;
        this.counters.controllerUpdatesRejected += 1;
      }
    }

    return {
      updates,
      accepted,
      rejected,
      corrections,
    };
  }

  cancelPendingWork(sessionId: string, sessionEpoch?: number): number {
    let canceled = 0;
    for (const [key, pending] of this.pendingFinalizations) {
      if (matchesSession(pending.token, sessionId, sessionEpoch)) {
        this.pendingFinalizations.delete(key);
        canceled += 1;
      }
    }

    for (const [key, update] of this.controllerQueue) {
      if (matchesSession(update.token, sessionId, sessionEpoch)) {
        this.controllerQueue.delete(key);
        canceled += 1;
      }
    }

    return canceled;
  }

  cleanupSession(sessionId: string, sessionEpoch?: number): number {
    const canceled = this.cancelPendingWork(sessionId, sessionEpoch);
    return canceled + this.cache.deleteSession(sessionId, sessionEpoch);
  }

  getDiagnostics(): TranscriptMeasurementSchedulerDiagnostics {
    return {
      ...this.counters,
      pendingMeasurements: this.pendingFinalizations.size,
      cache: this.cache.getStats(),
    };
  }

  private createMeasurementPlan(
    rowId: string,
    kind: Exclude<TranscriptMeasurementPlan["kind"], "missing-row">,
  ): TranscriptMeasurementPlan {
    const row = this.rowById.get(rowId);
    const token = this.getMeasurementToken(rowId);

    if (!row || !token) {
      return { kind: "missing-row", rowId };
    }

    const cached = this.cache.get(token);
    return {
      kind,
      rowId,
      token,
      estimatedHeight: normalizeHeight(getTranscriptRowEstimatedHeight(row)),
      cachedHeight: cached?.height ?? null,
      cachedSource: cached?.source ?? null,
    };
  }

  private acceptMeasurement(
    input: AcceptMeasurementInput,
  ): TranscriptMeasurementRecordResult {
    const existing = this.cache.peek(input.token);
    if (
      existing &&
      getMeasurementSourcePriority(existing.source) >
        getMeasurementSourcePriority(input.source)
    ) {
      return {
        status: "accepted",
        entry: existing,
        queuedControllerUpdate: false,
      };
    }

    const entry: TranscriptMeasurementCacheEntry = {
      token: cloneToken(input.token),
      height: normalizeHeight(input.height),
      source: input.source,
      finalized: input.finalized,
      updatedAt: this.now(),
    };

    this.cache.set(entry);
    this.pendingFinalizations.delete(createMeasurementCacheKey(input.token));
    this.queueControllerUpdate(entry);

    switch (input.source) {
      case "visible":
        this.counters.mountedMeasurementsAccepted += 1;
        break;
      case "offscreen-real":
        this.counters.offscreenRealMeasurementsAccepted += 1;
        break;
      case "offscreen-shell":
        this.counters.offscreenShellMeasurementsAccepted += 1;
        break;
      case "reserved":
      case "estimate":
        break;
      default:
        assertNever(input.source);
    }

    return {
      status: "accepted",
      entry: cloneCacheEntry(entry),
      queuedControllerUpdate: true,
    };
  }

  private acceptShellEstimate(
    input: TranscriptOffscreenMeasurementInput,
  ): TranscriptMeasurementRecordResult {
    const existing = this.cache.peek(input.token);
    if (
      existing &&
      getMeasurementSourcePriority(existing.source) >
        getMeasurementSourcePriority("estimate")
    ) {
      return {
        status: "accepted",
        entry: existing,
        queuedControllerUpdate: false,
      };
    }

    const entry: TranscriptMeasurementCacheEntry = {
      token: cloneToken(input.token),
      height: normalizeHeight(input.height),
      source: "estimate",
      finalized: false,
      updatedAt: this.now(),
    };

    this.cache.set(entry);
    return {
      status: "accepted",
      entry: cloneCacheEntry(entry),
      queuedControllerUpdate: false,
    };
  }

  private queueControllerUpdate(entry: TranscriptMeasurementCacheEntry): void {
    const wasEmpty = this.controllerQueue.size === 0;
    this.controllerQueue.set(createMeasurementCacheKey(entry.token), {
      token: cloneToken(entry.token),
      height: entry.height,
      source: entry.source,
      finalized: entry.finalized,
    });
    this.counters.controllerUpdatesQueued += 1;

    if (wasEmpty) {
      this.onControllerBatchQueued?.();
    }
  }

  private validateToken(
    token: TranscriptVirtualMeasurementToken,
  ): TokenValidationResult {
    const row = this.rowById.get(token.rowId) ?? null;
    let valid = true;

    if (token.sessionId !== this.sessionId) {
      this.counters.staleMeasurementSessionDrops += 1;
      valid = false;
    }
    if (token.sessionEpoch !== this.sessionEpoch) {
      this.counters.staleMeasurementEpochDrops += 1;
      valid = false;
    }
    if (token.widthScope !== this.widthScope) {
      this.counters.staleMeasurementWidthDrops += 1;
      valid = false;
    }
    if (!row) {
      this.counters.staleMeasurementMissingRowDrops += 1;
      valid = false;
    } else if (
      row.heightRevision !== token.heightRevision ||
      row.layoutRevision !== token.layoutRevision
    ) {
      this.counters.staleMeasurementRevisionDrops += 1;
      valid = false;
    }

    if (!valid) {
      this.counters.staleMeasurementsDropped += 1;
    }

    return { valid, row };
  }

  private isTokenCurrent(token: TranscriptVirtualMeasurementToken): boolean {
    const row = this.rowById.get(token.rowId);
    return (
      token.sessionId === this.sessionId &&
      token.sessionEpoch === this.sessionEpoch &&
      token.widthScope === this.widthScope &&
      row !== undefined &&
      row.heightRevision === token.heightRevision &&
      row.layoutRevision === token.layoutRevision
    );
  }

  private pruneStalePendingWork(): void {
    for (const [key, pending] of this.pendingFinalizations) {
      if (!this.isTokenCurrent(pending.token)) {
        this.pendingFinalizations.delete(key);
      }
    }

    for (const [key, update] of this.controllerQueue) {
      if (!this.isTokenCurrent(update.token)) {
        this.controllerQueue.delete(key);
      }
    }
  }

  private createDroppedResult(
    token: TranscriptVirtualMeasurementToken,
    reason: TranscriptMeasurementDropReason,
  ): TranscriptMeasurementRecordResult {
    return {
      status: "dropped",
      reason,
      token: cloneToken(token),
      queuedControllerUpdate: false,
    };
  }

  private rebuildRowIndex(): void {
    this.rowById = new Map(this.rows.map((row) => [row.rowId, row]));
  }
}

export function createTranscriptMeasurementScheduler(
  context: TranscriptMeasurementSchedulerContext,
  options?: TranscriptMeasurementSchedulerOptions,
): TranscriptMeasurementScheduler {
  return new TranscriptMeasurementScheduler(context, options);
}

export function createMeasurementCacheKey(
  token: TranscriptVirtualMeasurementToken,
): string {
  return [
    token.sessionId,
    String(token.sessionEpoch),
    token.widthScope,
    token.rowId,
    token.heightRevision,
    token.layoutRevision,
  ].join("\u0000");
}

function canAcceptOffscreenSource(
  row: TranscriptRowDescriptor,
  source: TranscriptOffscreenMeasurementSource,
): boolean {
  switch (source) {
    case "offscreen-real":
      return (
        row.measurementPolicy === "measure-real" &&
        row.capabilities.canOffscreenRenderReal
      );
    case "offscreen-shell":
      return (
        row.measurementPolicy === "measure-shell" &&
        row.capabilities.canOffscreenRenderShell
      );
    default:
      assertNever(source);
  }
}

function matchesSession(
  token: TranscriptVirtualMeasurementToken,
  sessionId: string,
  sessionEpoch: number | undefined,
): boolean {
  return (
    token.sessionId === sessionId &&
    (sessionEpoch === undefined || token.sessionEpoch === sessionEpoch)
  );
}

function cloneControllerUpdate(
  update: TranscriptControllerMeasurementUpdate,
): TranscriptControllerMeasurementUpdate {
  return {
    token: cloneToken(update.token),
    height: update.height,
    source: update.source,
    finalized: update.finalized,
  };
}

function cloneCacheEntry(
  entry: TranscriptMeasurementCacheEntry,
): TranscriptMeasurementCacheEntry {
  return {
    token: cloneToken(entry.token),
    height: entry.height,
    source: entry.source,
    finalized: entry.finalized,
    updatedAt: entry.updatedAt,
  };
}

function cloneToken(
  token: TranscriptVirtualMeasurementToken,
): TranscriptVirtualMeasurementToken {
  return {
    sessionId: token.sessionId,
    sessionEpoch: token.sessionEpoch,
    widthScope: token.widthScope,
    rowId: token.rowId,
    heightRevision: token.heightRevision,
    layoutRevision: token.layoutRevision,
  };
}

function normalizeHeight(height: number): number {
  return Number.isFinite(height) ? Math.max(0, height) : 0;
}

function getMeasurementSourcePriority(source: TranscriptMeasurementSource) {
  switch (source) {
    case "visible":
      return 3;
    case "offscreen-real":
      return 2;
    case "offscreen-shell":
      return 1;
    case "reserved":
    case "estimate":
      return 0;
    default:
      assertNever(source);
  }
}

function assertNever(value: never): never {
  throw new Error(`Unhandled value: ${JSON.stringify(value)}`);
}

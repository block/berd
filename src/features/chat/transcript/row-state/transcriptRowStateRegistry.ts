import type {
  TranscriptKeepAlivePriority,
  TranscriptRowDescriptor,
} from "../projection/transcriptItemTypes";

export type TranscriptRowProtectionReason =
  | "focused"
  | "selection"
  | "open-overlay"
  | "active-mcp"
  | "active-stream"
  | "recent";

export type TranscriptOpenOverlayKind =
  | "menu"
  | "dialog"
  | "popover"
  | "lightbox"
  | "context-menu"
  | "other";

export type TranscriptMcpActivityKind =
  | "host-request"
  | "nested-tool-request"
  | "recent-message"
  | "recent-resize";

export interface TranscriptKeepAlivePolicyOptions {
  activeStreamRowsPerSessionCap: number;
  mcpRowsPerSessionCap: number;
  recentRowsPerSessionCap: number;
  recentTtlMs: number;
  protectedRowsWarnThreshold: number;
  protectedRowsFailThreshold: number;
}

export const DEFAULT_TRANSCRIPT_KEEP_ALIVE_POLICY: TranscriptKeepAlivePolicyOptions =
  {
    // Active-stream rows are capped so a leaked or runaway stream signal cannot
    // accumulate past the fail threshold and disable windowing. Genuine
    // interaction rows (focused/selection/open-ui) remain protected without a
    // cap; the newest streams fill the bounded stream budget.
    activeStreamRowsPerSessionCap: 40,
    mcpRowsPerSessionCap: 8,
    recentRowsPerSessionCap: 20,
    recentTtlMs: 60_000,
    protectedRowsWarnThreshold: 40,
    protectedRowsFailThreshold: 80,
  };

export const TRANSCRIPT_KEEP_ALIVE_PRIORITY_WEIGHT: Record<
  TranscriptKeepAlivePriority,
  number
> = {
  none: 0,
  recent: 10,
  "active-mcp": 30,
  "active-stream": 40,
  "open-ui": 70,
  selection: 80,
  focused: 90,
};

export interface TranscriptToolChainRowState {
  chainExpanded?: boolean;
  showInternalSteps?: boolean;
  userInteracted?: boolean;
  expandedToolKeys?: readonly string[];
}

export interface TranscriptReasoningRowState {
  open?: boolean;
  userControlled?: boolean;
  autoCloseCompletedAtMs?: number;
  durationMs?: number;
}

export interface TranscriptMcpAppRowState {
  lifecycle?:
    | "visible"
    | "focused"
    | "active-host-request"
    | "recently-resized"
    | "recently-messaged"
    | "suspended"
    | "destroyed";
  inlineHeightPx?: number;
  activeHostRequestIds?: readonly string[];
  activeNestedToolRequestIds?: readonly string[];
  lastMessageAtMs?: number;
  lastResizeAtMs?: number;
}

export interface TranscriptOverlayRowState {
  openOverlayIds?: readonly string[];
  openMenuIds?: readonly string[];
  openDialogIds?: readonly string[];
  openPopoverIds?: readonly string[];
  openLightboxIds?: readonly string[];
}

export interface TranscriptDurableRowState {
  toolChain?: TranscriptToolChainRowState;
  toolChains?: Readonly<Record<string, TranscriptToolChainRowState>>;
  reasoning?: TranscriptReasoningRowState;
  reasoningBlocks?: Readonly<Record<string, TranscriptReasoningRowState>>;
  mcpApp?: TranscriptMcpAppRowState;
  pathNoticeText?: string;
  artifactOpenError?: string;
  moreOutputsOpen?: boolean;
  /**
   * Whether a clamped long user message has been expanded to full height.
   * Durable so expanding survives the row being recycled out of the
   * virtualized viewport and scrolled back into it.
   */
  userMessageExpanded?: boolean;
  userMessageExpandedBlocks?: Readonly<Record<string, boolean>>;
  copyConfirmedUntilMs?: number;
  embeddedScrollTopByKey?: Readonly<Record<string, number>>;
  activeFocusTargetId?: string;
  selectionProtected?: boolean;
  overlays?: TranscriptOverlayRowState;
  custom?: Readonly<Record<string, unknown>>;
}

export interface TranscriptRowStateLookupInput {
  sessionId: string;
  rowId: string;
  sessionEpoch?: number;
  nowMs?: number;
}

export interface TranscriptRowStateUpdateInput
  extends TranscriptRowStateLookupInput {
  markRecent?: boolean;
  updater: (
    current: Readonly<TranscriptDurableRowState>,
  ) => TranscriptDurableRowState;
}

export interface TranscriptRowStatePatchInput
  extends TranscriptRowStateLookupInput {
  markRecent?: boolean;
  patch: Partial<TranscriptDurableRowState>;
}

export interface TranscriptFocusProtectionInput
  extends TranscriptRowStateLookupInput {
  focused: boolean;
  sourceId?: string;
  focusTargetId?: string;
}

export interface TranscriptSelectionProtectionInput {
  sessionId: string;
  rowIds: readonly string[];
  active: boolean;
  sessionEpoch?: number;
  nowMs?: number;
  sourceId?: string;
  contextMenuOpen?: boolean;
}

export interface TranscriptOpenOverlayProtectionInput
  extends TranscriptRowStateLookupInput {
  open: boolean;
  overlayId?: string;
  overlayKind: TranscriptOpenOverlayKind;
}

export interface TranscriptMcpActivityInput
  extends TranscriptRowStateLookupInput {
  active: boolean;
  kind: TranscriptMcpActivityKind;
  sourceId?: string;
  ttlMs?: number;
}

export interface TranscriptActiveStreamInput
  extends TranscriptRowStateLookupInput {
  active: boolean;
  sourceId?: string;
}

export interface TranscriptRowInteractionInput
  extends TranscriptRowStateLookupInput {
  sourceId?: string;
  ttlMs?: number;
}

export interface TranscriptKeepAliveEvaluationInput {
  sessionId: string;
  sessionEpoch?: number;
  rows: readonly TranscriptRowDescriptor[];
  visibleRowIds?: Iterable<string>;
  nowMs?: number;
}

export interface TranscriptProtectedRowDiagnostic {
  rowId: string;
  priorities: readonly TranscriptKeepAlivePriority[];
  reasons: readonly TranscriptRowProtectionReason[];
  isVisible: boolean;
  protected: boolean;
  evicted: boolean;
  expiresAtMs?: number;
}

export interface TranscriptKeepAliveDiagnostics {
  sessionId: string;
  sessionEpoch: number;
  rowStateCount: number;
  protectedRowCount: number;
  protectedOffscreenRowCount: number;
  forcedProtectedRowCount: number;
  mcpProtectedRowCount: number;
  recentProtectedRowCount: number;
  mcpCandidateCount: number;
  recentCandidateCount: number;
  evictedMcpRowCount: number;
  evictedRecentRowCount: number;
  expiredSignalCount: number;
  warnThresholdExceeded: boolean;
  failThresholdExceeded: boolean;
  failThresholdJustifiedByActiveInteraction: boolean;
  policy: TranscriptKeepAlivePolicyOptions;
  rows: readonly TranscriptProtectedRowDiagnostic[];
}

export interface TranscriptKeepAliveDecision {
  protectedRowIds: readonly string[];
  protectedOffscreenRowIds: readonly string[];
  evictedRowIds: readonly string[];
  diagnostics: TranscriptKeepAliveDiagnostics;
}

export interface TranscriptSessionCleanupResult {
  sessionId: string;
  removedRowStateCount: number;
  removedProtectionSignalCount: number;
}

export interface TranscriptSessionPromotionResult {
  oldSessionId: string;
  newSessionId: string;
  promotedRowStateCount: number;
  promotedProtectionSignalCount: number;
  mergedIntoExistingSession: boolean;
}

interface ProtectionSignal {
  reason: TranscriptRowProtectionReason;
  sourceId: string;
  activatedAtMs: number;
  updatedAtMs: number;
  expiresAtMs?: number;
}

interface RowRecord {
  rowId: string;
  state: TranscriptDurableRowState;
  createdAtMs: number;
  updatedAtMs: number;
  lastAccessedAtMs: number;
  protectionSignals: Map<string, ProtectionSignal>;
}

interface SessionRecord {
  sessionId: string;
  sessionEpoch: number;
  rows: Map<string, RowRecord>;
}

interface Candidate {
  rowId: string;
  priorities: Set<TranscriptKeepAlivePriority>;
  reasons: Set<TranscriptRowProtectionReason>;
  activatedAtMs: number;
  updatedAtMs: number;
  expiresAtMs?: number;
}

interface CandidateSelection {
  forced: readonly Candidate[];
  mcp: readonly Candidate[];
  recent: readonly Candidate[];
  evictedActiveStream: readonly Candidate[];
  evictedMcp: readonly Candidate[];
  evictedRecent: readonly Candidate[];
}

const DEFAULT_SOURCE_ID = "default";

export class TranscriptRowStateRegistry {
  private sessions = new Map<string, SessionRecord>();
  private lastDiagnosticsBySession = new Map<
    string,
    TranscriptKeepAliveDiagnostics
  >();
  private readonly policy: TranscriptKeepAlivePolicyOptions;
  private readonly stateChangeListeners = new Set<() => void>();

  constructor(policy: Partial<TranscriptKeepAlivePolicyOptions> = {}) {
    this.policy = {
      ...DEFAULT_TRANSCRIPT_KEEP_ALIVE_POLICY,
      ...policy,
    };
  }

  setSessionEpoch(sessionId: string, sessionEpoch: number): void {
    const session = this.getOrCreateSession(sessionId, sessionEpoch);
    session.sessionEpoch = sessionEpoch;
  }

  getOrCreateRowState(
    input: TranscriptRowStateLookupInput,
  ): TranscriptDurableRowState | undefined {
    const nowMs = getNowMs(input.nowMs);
    const record = this.getOrCreateRowRecord(input, nowMs);
    if (!record) {
      return undefined;
    }
    record.lastAccessedAtMs = nowMs;
    return record.state;
  }

  getRowState(
    input: TranscriptRowStateLookupInput,
  ): TranscriptDurableRowState | undefined {
    const session = this.getReadableSession(input);
    if (!session) {
      return undefined;
    }
    const record = session.rows.get(input.rowId);
    if (!record) {
      return undefined;
    }
    record.lastAccessedAtMs = getNowMs(input.nowMs);
    return record.state;
  }

  updateRowState(
    input: TranscriptRowStateUpdateInput,
  ): TranscriptDurableRowState | undefined {
    const nowMs = getNowMs(input.nowMs);
    const record = this.getOrCreateRowRecord(input, nowMs);
    if (!record) {
      return undefined;
    }

    record.state = input.updater(record.state);
    record.updatedAtMs = nowMs;
    record.lastAccessedAtMs = nowMs;

    if (input.markRecent ?? true) {
      this.setProtectionSignal(record, {
        reason: "recent",
        sourceId: "row-state-update",
        activatedAtMs: nowMs,
        updatedAtMs: nowMs,
        expiresAtMs: nowMs + this.policy.recentTtlMs,
      });
    }

    this.notifyStateChange();
    return record.state;
  }

  subscribeToStateChanges(callback: () => void): () => void {
    this.stateChangeListeners.add(callback);
    return () => {
      this.stateChangeListeners.delete(callback);
    };
  }

  private notifyStateChange(): void {
    for (const cb of this.stateChangeListeners) {
      cb();
    }
  }

  patchRowState(
    input: TranscriptRowStatePatchInput,
  ): TranscriptDurableRowState | undefined {
    return this.updateRowState({
      sessionId: input.sessionId,
      rowId: input.rowId,
      sessionEpoch: input.sessionEpoch,
      nowMs: input.nowMs,
      markRecent: input.markRecent,
      updater: (current) => ({ ...current, ...input.patch }),
    });
  }

  setFocusedRow(input: TranscriptFocusProtectionInput): boolean {
    const nowMs = getNowMs(input.nowMs);
    const record = this.getOrCreateRowRecord(input, nowMs);
    if (!record) {
      return false;
    }

    const sourceId = input.sourceId ?? DEFAULT_SOURCE_ID;
    if (input.focused) {
      this.setProtectionSignal(record, {
        reason: "focused",
        sourceId,
        activatedAtMs: nowMs,
        updatedAtMs: nowMs,
      });
      record.state = {
        ...record.state,
        activeFocusTargetId: input.focusTargetId,
      };
    } else {
      this.clearProtectionSignal(record, "focused", sourceId);
      if (
        input.focusTargetId === undefined ||
        record.state.activeFocusTargetId === input.focusTargetId
      ) {
        record.state = {
          ...record.state,
          activeFocusTargetId: undefined,
        };
      }
    }
    record.updatedAtMs = nowMs;
    return true;
  }

  setSelectionProtection(input: TranscriptSelectionProtectionInput): boolean {
    const nowMs = getNowMs(input.nowMs);
    if (!this.getWritableSession(input.sessionId, input.sessionEpoch)) {
      return false;
    }

    const sourceId = input.sourceId ?? DEFAULT_SOURCE_ID;
    for (const rowId of input.rowIds) {
      const record = this.getOrCreateRowRecord(
        {
          sessionId: input.sessionId,
          sessionEpoch: input.sessionEpoch,
          rowId,
        },
        nowMs,
      );
      if (!record) {
        continue;
      }

      if (input.active) {
        this.setProtectionSignal(record, {
          reason: "selection",
          sourceId,
          activatedAtMs: nowMs,
          updatedAtMs: nowMs,
        });
        record.state = {
          ...record.state,
          selectionProtected: true,
          custom: input.contextMenuOpen
            ? {
                ...record.state.custom,
                selectedTextContextMenuOpen: true,
              }
            : record.state.custom,
        };
      } else {
        this.clearProtectionSignal(record, "selection", sourceId);
        record.state = {
          ...record.state,
          selectionProtected: false,
          custom: input.contextMenuOpen
            ? record.state.custom
            : omitCustomKey(record.state.custom, "selectedTextContextMenuOpen"),
        };
      }
      record.updatedAtMs = nowMs;
    }

    return true;
  }

  clearSelectionProtection(
    sessionId: string,
    sourceId: string = DEFAULT_SOURCE_ID,
  ): void {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return;
    }

    for (const record of session.rows.values()) {
      this.clearProtectionSignal(record, "selection", sourceId);
      record.state = {
        ...record.state,
        selectionProtected: false,
        custom: omitCustomKey(
          record.state.custom,
          "selectedTextContextMenuOpen",
        ),
      };
    }
  }

  setOpenOverlay(input: TranscriptOpenOverlayProtectionInput): boolean {
    const nowMs = getNowMs(input.nowMs);
    const record = this.getOrCreateRowRecord(input, nowMs);
    if (!record) {
      return false;
    }

    const overlayId = input.overlayId ?? DEFAULT_SOURCE_ID;
    const sourceId = `${input.overlayKind}:${overlayId}`;
    if (input.open) {
      this.setProtectionSignal(record, {
        reason: "open-overlay",
        sourceId,
        activatedAtMs: nowMs,
        updatedAtMs: nowMs,
      });
    } else {
      this.clearProtectionSignal(record, "open-overlay", sourceId);
    }
    record.state = {
      ...record.state,
      overlays: updateOverlayState(
        record.state.overlays,
        input.overlayKind,
        overlayId,
        input.open,
      ),
    };
    record.updatedAtMs = nowMs;
    return true;
  }

  setMcpActivity(input: TranscriptMcpActivityInput): boolean {
    const nowMs = getNowMs(input.nowMs);
    const record = this.getOrCreateRowRecord(input, nowMs);
    if (!record) {
      return false;
    }

    const sourceId = input.sourceId ?? input.kind;
    const expiresAtMs = isExpiringMcpActivity(input.kind)
      ? nowMs + (input.ttlMs ?? this.policy.recentTtlMs)
      : undefined;
    if (input.active) {
      this.setProtectionSignal(record, {
        reason: "active-mcp",
        sourceId,
        activatedAtMs: nowMs,
        updatedAtMs: nowMs,
        expiresAtMs,
      });
    } else {
      this.clearProtectionSignal(record, "active-mcp", sourceId);
    }
    record.state = {
      ...record.state,
      mcpApp: updateMcpState(
        record.state.mcpApp,
        input.kind,
        input.active,
        nowMs,
        sourceId,
      ),
    };
    record.updatedAtMs = nowMs;
    return true;
  }

  setActiveStreamingRow(input: TranscriptActiveStreamInput): boolean {
    const nowMs = getNowMs(input.nowMs);
    const record = this.getOrCreateRowRecord(input, nowMs);
    if (!record) {
      return false;
    }

    const sourceId = input.sourceId ?? DEFAULT_SOURCE_ID;
    if (input.active) {
      this.setProtectionSignal(record, {
        reason: "active-stream",
        sourceId,
        activatedAtMs: nowMs,
        updatedAtMs: nowMs,
      });
    } else {
      this.clearProtectionSignal(record, "active-stream", sourceId);
    }
    record.updatedAtMs = nowMs;
    return true;
  }

  markRowInteracted(input: TranscriptRowInteractionInput): boolean {
    const nowMs = getNowMs(input.nowMs);
    const record = this.getOrCreateRowRecord(input, nowMs);
    if (!record) {
      return false;
    }

    this.setProtectionSignal(record, {
      reason: "recent",
      sourceId: input.sourceId ?? DEFAULT_SOURCE_ID,
      activatedAtMs: nowMs,
      updatedAtMs: nowMs,
      expiresAtMs: nowMs + (input.ttlMs ?? this.policy.recentTtlMs),
    });
    record.updatedAtMs = nowMs;
    return true;
  }

  evaluateKeepAlive(
    input: TranscriptKeepAliveEvaluationInput,
  ): TranscriptKeepAliveDecision {
    const nowMs = getNowMs(input.nowMs);
    const session = this.getWritableSession(
      input.sessionId,
      input.sessionEpoch,
    );
    const visibleRowIds = new Set(input.visibleRowIds ?? []);
    const expiredSignalCount = session
      ? this.pruneExpiredSignals(session, nowMs)
      : 0;
    const candidates = this.collectCandidates(session, input.rows, nowMs);
    const selection = selectCandidates(candidates, this.policy);
    const protectedCandidates = [
      ...selection.forced,
      ...selection.mcp,
      ...selection.recent,
    ];
    const evictedCandidates = [
      ...selection.evictedActiveStream,
      ...selection.evictedMcp,
      ...selection.evictedRecent,
    ];
    const protectedRowIds = uniqueSortedRowIds(protectedCandidates);
    const evictedRowIds = uniqueSortedRowIds(evictedCandidates);
    const protectedOffscreenRowIds = protectedRowIds.filter(
      (rowId) => !visibleRowIds.has(rowId),
    );
    const diagnostics = buildDiagnostics({
      sessionId: input.sessionId,
      sessionEpoch: session?.sessionEpoch ?? input.sessionEpoch ?? 0,
      rowStateCount: session?.rows.size ?? 0,
      visibleRowIds,
      candidates,
      selection,
      protectedRowIds,
      protectedOffscreenRowIds,
      expiredSignalCount,
      policy: this.policy,
    });

    this.lastDiagnosticsBySession.set(input.sessionId, diagnostics);
    return {
      protectedRowIds,
      protectedOffscreenRowIds,
      evictedRowIds,
      diagnostics,
    };
  }

  cleanupExpired(nowMs: number = getNowMs()): number {
    let expiredSignalCount = 0;
    for (const session of this.sessions.values()) {
      expiredSignalCount += this.pruneExpiredSignals(session, nowMs);
    }
    return expiredSignalCount;
  }

  cleanupSession(sessionId: string): TranscriptSessionCleanupResult {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return {
        sessionId,
        removedRowStateCount: 0,
        removedProtectionSignalCount: 0,
      };
    }

    const removedProtectionSignalCount = countProtectionSignals(session);
    const removedRowStateCount = session.rows.size;
    this.sessions.delete(sessionId);
    this.lastDiagnosticsBySession.delete(sessionId);
    return {
      sessionId,
      removedRowStateCount,
      removedProtectionSignalCount,
    };
  }

  promoteSession(
    oldSessionId: string,
    newSessionId: string,
    options: { newSessionEpoch?: number } = {},
  ): TranscriptSessionPromotionResult {
    const source = this.sessions.get(oldSessionId);
    if (!source) {
      return {
        oldSessionId,
        newSessionId,
        promotedRowStateCount: 0,
        promotedProtectionSignalCount: 0,
        mergedIntoExistingSession: this.sessions.has(newSessionId),
      };
    }

    const promotedRowStateCount = source.rows.size;
    const promotedProtectionSignalCount = countProtectionSignals(source);
    const target = this.sessions.get(newSessionId);
    if (!target) {
      this.sessions.delete(oldSessionId);
      this.sessions.set(newSessionId, {
        sessionId: newSessionId,
        sessionEpoch: options.newSessionEpoch ?? source.sessionEpoch,
        rows: source.rows,
      });
      this.promoteStoredDiagnostics(oldSessionId, newSessionId);
      return {
        oldSessionId,
        newSessionId,
        promotedRowStateCount,
        promotedProtectionSignalCount,
        mergedIntoExistingSession: false,
      };
    }

    for (const [rowId, record] of source.rows) {
      if (!target.rows.has(rowId)) {
        target.rows.set(rowId, record);
      }
    }
    target.sessionEpoch = options.newSessionEpoch ?? target.sessionEpoch;
    this.sessions.delete(oldSessionId);
    this.lastDiagnosticsBySession.delete(oldSessionId);
    return {
      oldSessionId,
      newSessionId,
      promotedRowStateCount,
      promotedProtectionSignalCount,
      mergedIntoExistingSession: true,
    };
  }

  getDiagnostics(
    sessionId: string,
  ): TranscriptKeepAliveDiagnostics | undefined {
    return this.lastDiagnosticsBySession.get(sessionId);
  }

  private getReadableSession(
    input: Pick<TranscriptRowStateLookupInput, "sessionId" | "sessionEpoch">,
  ): SessionRecord | undefined {
    const session = this.sessions.get(input.sessionId);
    if (!session) {
      return undefined;
    }
    if (
      input.sessionEpoch !== undefined &&
      input.sessionEpoch < session.sessionEpoch
    ) {
      return undefined;
    }
    return session;
  }

  private getWritableSession(
    sessionId: string,
    sessionEpoch: number | undefined,
  ): SessionRecord | undefined {
    const session = this.getOrCreateSession(sessionId, sessionEpoch);
    if (sessionEpoch !== undefined && sessionEpoch < session.sessionEpoch) {
      return undefined;
    }
    if (sessionEpoch !== undefined && sessionEpoch > session.sessionEpoch) {
      session.sessionEpoch = sessionEpoch;
    }
    return session;
  }

  private getOrCreateSession(
    sessionId: string,
    sessionEpoch: number | undefined,
  ): SessionRecord {
    const existing = this.sessions.get(sessionId);
    if (existing) {
      return existing;
    }

    const session: SessionRecord = {
      sessionId,
      sessionEpoch: sessionEpoch ?? 0,
      rows: new Map(),
    };
    this.sessions.set(sessionId, session);
    return session;
  }

  private getOrCreateRowRecord(
    input: TranscriptRowStateLookupInput,
    nowMs: number,
  ): RowRecord | undefined {
    const session = this.getWritableSession(
      input.sessionId,
      input.sessionEpoch,
    );
    if (!session) {
      return undefined;
    }

    const existing = session.rows.get(input.rowId);
    if (existing) {
      return existing;
    }

    const record: RowRecord = {
      rowId: input.rowId,
      state: {},
      createdAtMs: nowMs,
      updatedAtMs: nowMs,
      lastAccessedAtMs: nowMs,
      protectionSignals: new Map(),
    };
    session.rows.set(input.rowId, record);
    return record;
  }

  private setProtectionSignal(
    record: RowRecord,
    signal: ProtectionSignal,
  ): void {
    const key = getSignalKey(signal.reason, signal.sourceId);
    const existing = record.protectionSignals.get(key);
    record.protectionSignals.set(key, {
      ...signal,
      activatedAtMs: existing?.activatedAtMs ?? signal.activatedAtMs,
    });
  }

  private clearProtectionSignal(
    record: RowRecord,
    reason: TranscriptRowProtectionReason,
    sourceId: string,
  ): void {
    record.protectionSignals.delete(getSignalKey(reason, sourceId));
  }

  private pruneExpiredSignals(session: SessionRecord, nowMs: number): number {
    let expiredSignalCount = 0;
    for (const record of session.rows.values()) {
      for (const [key, signal] of record.protectionSignals) {
        if (signal.expiresAtMs !== undefined && signal.expiresAtMs <= nowMs) {
          record.protectionSignals.delete(key);
          expiredSignalCount += 1;
        }
      }
    }
    return expiredSignalCount;
  }

  private collectCandidates(
    session: SessionRecord | undefined,
    rows: readonly TranscriptRowDescriptor[],
    nowMs: number,
  ): readonly Candidate[] {
    const candidates = new Map<string, Candidate>();

    if (session) {
      for (const record of session.rows.values()) {
        for (const signal of record.protectionSignals.values()) {
          const priority = priorityForReason(signal.reason);
          upsertCandidate(candidates, {
            rowId: record.rowId,
            priority,
            reason: signal.reason,
            activatedAtMs: signal.activatedAtMs,
            updatedAtMs: signal.updatedAtMs,
            expiresAtMs: signal.expiresAtMs,
          });
        }
      }
    }

    for (const [rowIndex, row] of rows.entries()) {
      if (row.keepAlivePriority === "none") {
        continue;
      }
      // Projection-only active rows share one evaluation timestamp. Preserve
      // transcript order as their recency tie-breaker so the bounded stream
      // budget keeps the live tail instead of lexicographically smallest IDs.
      const projectionOrderMs = nowMs + rowIndex;
      upsertCandidate(candidates, {
        rowId: row.rowId,
        priority: row.keepAlivePriority,
        reason: reasonForPriority(row.keepAlivePriority),
        activatedAtMs: projectionOrderMs,
        updatedAtMs: projectionOrderMs,
      });
    }

    return [...candidates.values()];
  }

  private promoteStoredDiagnostics(
    oldSessionId: string,
    newSessionId: string,
  ): void {
    const diagnostics = this.lastDiagnosticsBySession.get(oldSessionId);
    if (!diagnostics) {
      return;
    }
    this.lastDiagnosticsBySession.delete(oldSessionId);
    this.lastDiagnosticsBySession.set(newSessionId, {
      ...diagnostics,
      sessionId: newSessionId,
    });
  }
}

export function createTranscriptRowStateRegistry(
  policy?: Partial<TranscriptKeepAlivePolicyOptions>,
): TranscriptRowStateRegistry {
  return new TranscriptRowStateRegistry(policy);
}

function getNowMs(nowMs?: number): number {
  return nowMs ?? globalThis.performance?.now() ?? Date.now();
}

function getSignalKey(
  reason: TranscriptRowProtectionReason,
  sourceId: string,
): string {
  return `${reason}:${sourceId}`;
}

function priorityForReason(
  reason: TranscriptRowProtectionReason,
): TranscriptKeepAlivePriority {
  switch (reason) {
    case "focused":
      return "focused";
    case "selection":
      return "selection";
    case "open-overlay":
      return "open-ui";
    case "active-mcp":
      return "active-mcp";
    case "active-stream":
      return "active-stream";
    case "recent":
      return "recent";
    default:
      return assertNever(reason);
  }
}

function reasonForPriority(
  priority: TranscriptKeepAlivePriority,
): TranscriptRowProtectionReason {
  switch (priority) {
    case "focused":
      return "focused";
    case "selection":
      return "selection";
    case "open-ui":
      return "open-overlay";
    case "active-mcp":
      return "active-mcp";
    case "active-stream":
      return "active-stream";
    case "recent":
    case "none":
      return "recent";
    default:
      return assertNever(priority);
  }
}

function upsertCandidate(
  candidates: Map<string, Candidate>,
  input: {
    rowId: string;
    priority: TranscriptKeepAlivePriority;
    reason: TranscriptRowProtectionReason;
    activatedAtMs: number;
    updatedAtMs: number;
    expiresAtMs?: number;
  },
): void {
  const existing = candidates.get(input.rowId);
  if (!existing) {
    candidates.set(input.rowId, {
      rowId: input.rowId,
      priorities: new Set([input.priority]),
      reasons: new Set([input.reason]),
      activatedAtMs: input.activatedAtMs,
      updatedAtMs: input.updatedAtMs,
      expiresAtMs: input.expiresAtMs,
    });
    return;
  }

  existing.priorities.add(input.priority);
  existing.reasons.add(input.reason);
  existing.activatedAtMs = Math.min(
    existing.activatedAtMs,
    input.activatedAtMs,
  );
  existing.updatedAtMs = Math.max(existing.updatedAtMs, input.updatedAtMs);
  existing.expiresAtMs = minDefined(existing.expiresAtMs, input.expiresAtMs);
}

function selectCandidates(
  candidates: readonly Candidate[],
  policy: TranscriptKeepAlivePolicyOptions,
): CandidateSelection {
  const interactionCandidates = candidates
    .filter(hasInteractionPriority)
    .sort(compareCandidatePriority);
  const interactionRowIds = new Set(
    interactionCandidates.map((candidate) => candidate.rowId),
  );
  const activeStreamCandidates = candidates
    .filter(
      (candidate) =>
        !interactionRowIds.has(candidate.rowId) &&
        candidate.priorities.has("active-stream"),
    )
    .sort(compareCandidatePriority);
  const protectedActiveStream = activeStreamCandidates.slice(
    0,
    policy.activeStreamRowsPerSessionCap,
  );
  const activeStreamOverflow = activeStreamCandidates.slice(
    policy.activeStreamRowsPerSessionCap,
  );
  const forced = [...interactionCandidates, ...protectedActiveStream];
  // Exclude only selected forced rows from the MCP/recent categories. Stream
  // overflow can still be protected by an active MCP signal; otherwise a stale
  // stream bit could evict live embedded app state.
  const forcedRowIds = new Set(
    [...interactionCandidates, ...protectedActiveStream].map(
      (candidate) => candidate.rowId,
    ),
  );
  const mcpCandidates = candidates
    .filter(
      (candidate) =>
        !forcedRowIds.has(candidate.rowId) &&
        candidate.priorities.has("active-mcp"),
    )
    .sort(compareCandidatePriority);
  const mcp = mcpCandidates.slice(0, policy.mcpRowsPerSessionCap);
  const evictedMcp = mcpCandidates.slice(policy.mcpRowsPerSessionCap);
  const selectedMcpRowIds = new Set(mcp.map((candidate) => candidate.rowId));
  const evictedActiveStream = activeStreamOverflow.filter(
    (candidate) => !selectedMcpRowIds.has(candidate.rowId),
  );
  const activeStreamRowIds = new Set(
    activeStreamCandidates.map((candidate) => candidate.rowId),
  );
  const recentCandidates = candidates
    .filter(
      (candidate) =>
        !forcedRowIds.has(candidate.rowId) &&
        !activeStreamRowIds.has(candidate.rowId) &&
        !selectedMcpRowIds.has(candidate.rowId) &&
        !candidate.priorities.has("active-mcp") &&
        candidate.priorities.has("recent"),
    )
    .sort(compareCandidatePriority);
  const recent = recentCandidates.slice(0, policy.recentRowsPerSessionCap);
  const evictedRecent = recentCandidates.slice(policy.recentRowsPerSessionCap);

  return {
    forced,
    mcp,
    recent,
    evictedActiveStream,
    evictedMcp,
    evictedRecent,
  };
}

function hasInteractionPriority(candidate: Candidate): boolean {
  return (
    candidate.priorities.has("focused") ||
    candidate.priorities.has("selection") ||
    candidate.priorities.has("open-ui")
  );
}

function compareCandidatePriority(left: Candidate, right: Candidate): number {
  const priorityDelta =
    highestPriorityWeight(right) - highestPriorityWeight(left);
  if (priorityDelta !== 0) {
    return priorityDelta;
  }

  const updatedDelta = right.updatedAtMs - left.updatedAtMs;
  if (updatedDelta !== 0) {
    return updatedDelta;
  }

  return left.rowId.localeCompare(right.rowId);
}

function highestPriorityWeight(candidate: Candidate): number {
  let weight = 0;
  for (const priority of candidate.priorities) {
    weight = Math.max(weight, TRANSCRIPT_KEEP_ALIVE_PRIORITY_WEIGHT[priority]);
  }
  return weight;
}

function uniqueSortedRowIds(
  candidates: readonly Candidate[],
): readonly string[] {
  return [...new Set(candidates.map((candidate) => candidate.rowId))].sort();
}

function buildDiagnostics(input: {
  sessionId: string;
  sessionEpoch: number;
  rowStateCount: number;
  visibleRowIds: ReadonlySet<string>;
  candidates: readonly Candidate[];
  selection: CandidateSelection;
  protectedRowIds: readonly string[];
  protectedOffscreenRowIds: readonly string[];
  expiredSignalCount: number;
  policy: TranscriptKeepAlivePolicyOptions;
}): TranscriptKeepAliveDiagnostics {
  const protectedRowIdSet = new Set(input.protectedRowIds);
  const evictedRowIdSet = new Set(
    uniqueSortedRowIds([
      ...input.selection.evictedActiveStream,
      ...input.selection.evictedMcp,
      ...input.selection.evictedRecent,
    ]),
  );
  const protectedRows = input.candidates.map((candidate) => ({
    rowId: candidate.rowId,
    priorities: [...candidate.priorities].sort(comparePriority),
    reasons: [...candidate.reasons].sort(),
    isVisible: input.visibleRowIds.has(candidate.rowId),
    protected: protectedRowIdSet.has(candidate.rowId),
    evicted: evictedRowIdSet.has(candidate.rowId),
    expiresAtMs: candidate.expiresAtMs,
  }));
  const hasActiveInteractionExemption = input.candidates.some(
    (candidate) =>
      protectedRowIdSet.has(candidate.rowId) &&
      (candidate.priorities.has("focused") ||
        candidate.priorities.has("selection") ||
        candidate.priorities.has("open-ui")),
  );
  const exceedsFailThreshold =
    input.protectedRowIds.length > input.policy.protectedRowsFailThreshold;

  return {
    sessionId: input.sessionId,
    sessionEpoch: input.sessionEpoch,
    rowStateCount: input.rowStateCount,
    protectedRowCount: input.protectedRowIds.length,
    protectedOffscreenRowCount: input.protectedOffscreenRowIds.length,
    forcedProtectedRowCount: input.selection.forced.length,
    mcpProtectedRowCount: input.selection.mcp.length,
    recentProtectedRowCount: input.selection.recent.length,
    mcpCandidateCount:
      input.selection.mcp.length + input.selection.evictedMcp.length,
    recentCandidateCount:
      input.selection.recent.length + input.selection.evictedRecent.length,
    evictedMcpRowCount: input.selection.evictedMcp.length,
    evictedRecentRowCount: input.selection.evictedRecent.length,
    expiredSignalCount: input.expiredSignalCount,
    warnThresholdExceeded:
      input.protectedRowIds.length > input.policy.protectedRowsWarnThreshold,
    failThresholdExceeded:
      exceedsFailThreshold && !hasActiveInteractionExemption,
    failThresholdJustifiedByActiveInteraction:
      exceedsFailThreshold && hasActiveInteractionExemption,
    policy: input.policy,
    rows: protectedRows,
  };
}

function comparePriority(
  left: TranscriptKeepAlivePriority,
  right: TranscriptKeepAlivePriority,
): number {
  const delta =
    TRANSCRIPT_KEEP_ALIVE_PRIORITY_WEIGHT[right] -
    TRANSCRIPT_KEEP_ALIVE_PRIORITY_WEIGHT[left];
  if (delta !== 0) {
    return delta;
  }
  return left.localeCompare(right);
}

function countProtectionSignals(session: SessionRecord): number {
  let count = 0;
  for (const record of session.rows.values()) {
    count += record.protectionSignals.size;
  }
  return count;
}

function minDefined(
  left: number | undefined,
  right: number | undefined,
): number | undefined {
  if (left === undefined) {
    return right;
  }
  if (right === undefined) {
    return left;
  }
  return Math.min(left, right);
}

function omitCustomKey(
  custom: Readonly<Record<string, unknown>> | undefined,
  key: string,
): Readonly<Record<string, unknown>> | undefined {
  if (!custom || !(key in custom)) {
    return custom;
  }

  const next = { ...custom };
  delete next[key];
  return Object.keys(next).length > 0 ? next : undefined;
}

function updateOverlayState(
  current: TranscriptOverlayRowState | undefined,
  kind: TranscriptOpenOverlayKind,
  overlayId: string,
  open: boolean,
): TranscriptOverlayRowState | undefined {
  const next: TranscriptOverlayRowState = current ? { ...current } : {};
  next.openOverlayIds = updateStringList(next.openOverlayIds, overlayId, open);

  switch (kind) {
    case "menu":
    case "context-menu":
      next.openMenuIds = updateStringList(next.openMenuIds, overlayId, open);
      break;
    case "dialog":
      next.openDialogIds = updateStringList(
        next.openDialogIds,
        overlayId,
        open,
      );
      break;
    case "popover":
      next.openPopoverIds = updateStringList(
        next.openPopoverIds,
        overlayId,
        open,
      );
      break;
    case "lightbox":
      next.openLightboxIds = updateStringList(
        next.openLightboxIds,
        overlayId,
        open,
      );
      break;
    case "other":
      break;
    default:
      assertNever(kind);
  }

  return hasOverlayState(next) ? next : undefined;
}

function updateStringList(
  values: readonly string[] | undefined,
  value: string,
  include: boolean,
): readonly string[] | undefined {
  const set = new Set(values ?? []);
  if (include) {
    set.add(value);
  } else {
    set.delete(value);
  }
  return set.size > 0 ? [...set].sort() : undefined;
}

function hasOverlayState(state: TranscriptOverlayRowState): boolean {
  return Boolean(
    state.openOverlayIds?.length ||
      state.openMenuIds?.length ||
      state.openDialogIds?.length ||
      state.openPopoverIds?.length ||
      state.openLightboxIds?.length,
  );
}

function updateMcpState(
  current: TranscriptMcpAppRowState | undefined,
  kind: TranscriptMcpActivityKind,
  active: boolean,
  nowMs: number,
  sourceId: string,
): TranscriptMcpAppRowState {
  const next: TranscriptMcpAppRowState = current ? { ...current } : {};

  switch (kind) {
    case "host-request":
      next.lifecycle = active ? "active-host-request" : next.lifecycle;
      next.activeHostRequestIds = updateStringList(
        next.activeHostRequestIds,
        sourceId,
        active,
      );
      break;
    case "nested-tool-request":
      next.lifecycle = active ? "active-host-request" : next.lifecycle;
      next.activeNestedToolRequestIds = updateStringList(
        next.activeNestedToolRequestIds,
        sourceId,
        active,
      );
      break;
    case "recent-message":
      next.lifecycle = active ? "recently-messaged" : next.lifecycle;
      next.lastMessageAtMs = active ? nowMs : next.lastMessageAtMs;
      break;
    case "recent-resize":
      next.lifecycle = active ? "recently-resized" : next.lifecycle;
      next.lastResizeAtMs = active ? nowMs : next.lastResizeAtMs;
      break;
    default:
      assertNever(kind);
  }

  return next;
}

function isExpiringMcpActivity(kind: TranscriptMcpActivityKind): boolean {
  return kind === "recent-message" || kind === "recent-resize";
}

function assertNever(value: never): never {
  throw new Error(`Unexpected transcript row-state value: ${String(value)}`);
}

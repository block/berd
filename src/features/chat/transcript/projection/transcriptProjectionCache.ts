import { buildTranscriptArtifactIndex } from "./transcriptArtifactIndex";
import {
  buildTranscriptItems,
  invalidateTranscriptItemDescriptorCache,
} from "./buildTranscriptItems";
import {
  buildTranscriptRows,
  canReuseTranscriptRowDescriptor,
  invalidateTranscriptRowDescriptorCache,
} from "./buildTranscriptRows";
import type { Message } from "@/shared/types/messages";
import type {
  TranscriptProjectionCache,
  TranscriptProjectionCacheUpdateInput,
  TranscriptProjectionSnapshot,
  TranscriptRowDescriptor,
} from "./transcriptItemTypes";

export class DefaultTranscriptProjectionCache
  implements TranscriptProjectionCache
{
  private snapshotsBySession = new Map<string, TranscriptProjectionSnapshot>();
  private calendarGeneration = 0;
  private calendarInvalidationToken = "";

  update(
    input: TranscriptProjectionCacheUpdateInput,
  ): TranscriptProjectionSnapshot {
    const startedAt = nowMs();
    const previous =
      input.previous ?? this.snapshotsBySession.get(input.sessionId);
    const items = buildTranscriptItems({
      messages: input.messages,
      streamingMessageId: input.streamingMessageId,
      nowBucket: input.nowBucket,
      localeKey: input.localeKey,
      calendarRevisionToken: this.getCalendarRevisionToken(),
    });
    const artifactIndex = buildTranscriptArtifactIndex({
      sessionId: input.sessionId,
      items,
      previous: previous?.artifactIndex,
    });
    const builtRows = buildTranscriptRows(items);
    const { rows, changedRowIds } = reuseRows(previous?.rows, builtRows);
    const rowByMessageId = new Map<string, string>();
    const rowIndexById = new Map<string, number>();
    const messageById = new Map<string, Message>();
    const searchableTextByMessageId = new Map<string, string>();

    rows.forEach((row, index) => {
      rowIndexById.set(row.rowId, index);
      if (
        row.messageId &&
        (row.fragment?.messageScrollTarget ||
          !rowByMessageId.has(row.messageId))
      ) {
        rowByMessageId.set(row.messageId, row.rowId);
      }
    });

    for (const item of items) {
      if (
        item.kind === "message" ||
        item.kind === "assistant-content-fragment"
      ) {
        messageById.set(item.messageId, item.message);
        if (!searchableTextByMessageId.has(item.messageId)) {
          searchableTextByMessageId.set(item.messageId, item.searchableText);
        }
      } else if (item.kind === "agent-work") {
        messageById.set(item.messageId, item.message);
      }
    }

    if (previous) {
      for (const row of previous.rows) {
        if (!rowIndexById.has(row.rowId)) {
          changedRowIds.add(row.rowId);
        }
      }
    }

    const snapshot: TranscriptProjectionSnapshot = {
      sessionId: input.sessionId,
      sessionEpoch: input.sessionEpoch,
      items,
      rows,
      rowByMessageId,
      rowIndexById,
      messageById,
      searchableTextByMessageId,
      artifactIndex,
      changedRowIds,
      descriptorChurn: previous ? changedRowIds.size : 0,
      ...countFragmentRows(rows),
      reusedPrefixCount: countReusedPrefix(previous?.rows, rows),
      reusedSuffixCount: countReusedSuffix(previous?.rows, rows),
      projectionDurationMs: nowMs() - startedAt,
    };

    this.snapshotsBySession.set(input.sessionId, snapshot);
    return snapshot;
  }

  promoteSession(oldSessionId: string, newSessionId: string): void {
    const snapshot = this.snapshotsBySession.get(oldSessionId);
    if (!snapshot) {
      return;
    }

    this.snapshotsBySession.delete(oldSessionId);
    this.snapshotsBySession.set(newSessionId, {
      ...snapshot,
      sessionId: newSessionId,
      artifactIndex: buildTranscriptArtifactIndex({
        sessionId: newSessionId,
        items: snapshot.items,
      }),
      changedRowIds: new Set(),
      descriptorChurn: 0,
      fragmentRowCount: snapshot.fragmentRowCount,
      completedFragmentRowCount: snapshot.completedFragmentRowCount,
      completedStreamingFragmentRowCount:
        snapshot.completedStreamingFragmentRowCount,
      streamingTailRowCount: snapshot.streamingTailRowCount,
      wholeMessageFallbackRowCount: snapshot.wholeMessageFallbackRowCount,
    });
  }

  cleanupSession(sessionId: string): void {
    this.snapshotsBySession.delete(sessionId);
    invalidateTranscriptItemDescriptorCache();
    invalidateTranscriptRowDescriptorCache();
  }

  cancelPendingWork(sessionId: string, sessionEpoch: number): void {
    void sessionId;
    void sessionEpoch;
  }

  invalidateCalendarLabels(nowBucket: string, localeKey: string): void {
    this.calendarGeneration += 1;
    this.calendarInvalidationToken = `${nowBucket}:${localeKey}`;
  }

  private getCalendarRevisionToken(): string {
    return `${this.calendarGeneration}:${this.calendarInvalidationToken}`;
  }
}

function countFragmentRows(rows: readonly TranscriptRowDescriptor[]): {
  fragmentRowCount: number;
  completedFragmentRowCount: number;
  completedStreamingFragmentRowCount: number;
  streamingTailRowCount: number;
  wholeMessageFallbackRowCount: number;
} {
  let fragmentRowCount = 0;
  let completedFragmentRowCount = 0;
  let completedStreamingFragmentRowCount = 0;
  let streamingTailRowCount = 0;
  let wholeMessageFallbackRowCount = 0;

  for (const row of rows) {
    if (row.kind !== "assistant-content-fragment") {
      if (row.kind === "message") {
        wholeMessageFallbackRowCount += 1;
      }
      continue;
    }

    fragmentRowCount += 1;
    if (row.fragment?.isStreamingTail) {
      streamingTailRowCount += 1;
    } else {
      completedFragmentRowCount += 1;
      if (row.fragment?.fragmentId.startsWith("stream-block-")) {
        completedStreamingFragmentRowCount += 1;
      }
    }
  }

  return {
    fragmentRowCount,
    completedFragmentRowCount,
    completedStreamingFragmentRowCount,
    streamingTailRowCount,
    wholeMessageFallbackRowCount,
  };
}

export function createTranscriptProjectionCache(): TranscriptProjectionCache {
  return new DefaultTranscriptProjectionCache();
}

function reuseRows(
  previousRows: readonly TranscriptRowDescriptor[] | undefined,
  nextRows: readonly TranscriptRowDescriptor[],
): {
  rows: readonly TranscriptRowDescriptor[];
  changedRowIds: Set<string>;
} {
  if (!previousRows || previousRows.length === 0) {
    return {
      rows: nextRows,
      changedRowIds: new Set(nextRows.map((row) => row.rowId)),
    };
  }

  const previousById = new Map<string, TranscriptRowDescriptor>();
  for (const row of previousRows) {
    previousById.set(row.rowId, row);
  }
  const changedRowIds = new Set<string>();
  const rows = nextRows.map((nextRow) => {
    const previous = previousById.get(nextRow.rowId);
    if (previous && canReuseTranscriptRowDescriptor(previous, nextRow)) {
      return previous;
    }
    changedRowIds.add(nextRow.rowId);
    return nextRow;
  });

  return { rows, changedRowIds };
}

function countReusedPrefix(
  previousRows: readonly TranscriptRowDescriptor[] | undefined,
  rows: readonly TranscriptRowDescriptor[],
): number {
  if (!previousRows) {
    return 0;
  }

  let count = 0;
  while (
    count < previousRows.length &&
    count < rows.length &&
    previousRows[count] === rows[count]
  ) {
    count += 1;
  }
  return count;
}

function countReusedSuffix(
  previousRows: readonly TranscriptRowDescriptor[] | undefined,
  rows: readonly TranscriptRowDescriptor[],
): number {
  if (!previousRows) {
    return 0;
  }

  let count = 0;
  while (
    count < previousRows.length &&
    count < rows.length &&
    previousRows[previousRows.length - 1 - count] ===
      rows[rows.length - 1 - count]
  ) {
    count += 1;
  }
  return count;
}

function nowMs(): number {
  return globalThis.performance?.now() ?? Date.now();
}

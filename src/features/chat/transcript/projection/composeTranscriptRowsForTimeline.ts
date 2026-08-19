import type { Message } from "@/shared/types/messages";
import type { TranscriptRowDescriptor } from "./transcriptItemTypes";

export interface TranscriptRowActiveRange {
  /** Inclusive index of the first active-turn row. */
  start: number;
  /** Exclusive index immediately after the active-turn rows. */
  end: number;
}

export interface TranscriptRowComposition {
  /** The canonical ordered descriptors, preserved by identity. */
  rows: readonly TranscriptRowDescriptor[];
  /** The active turn's interval in `rows`, or null when no valid turn exists. */
  activeRange: TranscriptRowActiveRange | null;
}

export interface ComposeTranscriptRowsForTimelineInput {
  rows: readonly TranscriptRowDescriptor[];
  messages: readonly Message[];
  streamingMessageId: string | null | undefined;
}

/**
 * Composes the one row list consumed by the future virtual timeline seam.
 *
 * The active-turn boundary intentionally follows the current split-tail
 * contract: a valid streaming assistant starts at its preceding user turn
 * when that user exists, and the date separator immediately before that turn
 * belongs to the active interval too. The descriptors themselves are not
 * copied or filtered here; the range is only an index view over `rows`.
 */
export function composeTranscriptRowsForTimeline({
  rows,
  messages,
  streamingMessageId,
}: ComposeTranscriptRowsForTimelineInput): TranscriptRowComposition {
  const activeStart = findActiveTurnStart({
    rows,
    messages,
    streamingMessageId,
  });

  return {
    rows,
    activeRange:
      activeStart === null ? null : { start: activeStart, end: rows.length },
  };
}

function findActiveTurnStart({
  rows,
  messages,
  streamingMessageId,
}: ComposeTranscriptRowsForTimelineInput): number | null {
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
  const activeStartMessageId =
    previousMessage?.role === "user" ? previousMessage.id : streamingMessage.id;
  let activeStart = rows.findIndex(
    (row) => row.messageId === activeStartMessageId && isMessageTurnRow(row),
  );
  if (activeStart < 0) {
    return null;
  }

  if (rows[activeStart - 1]?.kind === "date-separator") {
    activeStart -= 1;
  }

  return activeStart;
}

function isMessageTurnRow(row: TranscriptRowDescriptor): boolean {
  return (
    Boolean(row.messageId) &&
    (row.kind === "message" ||
      row.kind === "assistant-content-fragment" ||
      row.kind === "agent-work")
  );
}

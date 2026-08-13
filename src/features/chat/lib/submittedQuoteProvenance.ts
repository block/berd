import type { Message, StagedItem } from "@/shared/types/messages";
import { getTextContent } from "@/shared/types/messages";
import { isStagedItem } from "../stores/draftPersistence";

/**
 * Durable Berd-owned provenance for submitted staged quotes (Option A of the
 * quote-provenance decision: Berd-local persistence, no backend change).
 *
 * Goose persists user messages with server-generated ids that are never
 * echoed to the client during the live turn, so submitted quote metadata
 * stored on the locally created user message cannot be joined back to a
 * replayed turn by id. It can be joined by content: the exact prompt text
 * Berd dispatches is what Goose persists and replays as the turn's
 * user-visible text (assistant-audience blocks are filtered to chips on
 * replay), and replay preserves send order. Each submitted quote is
 * therefore recorded with its dispatched prompt text, and on replay the
 * records are re-attached to user turns by ordered text matching —
 * duplicate texts consume records in order.
 *
 * When a turn disappears entirely (compaction summarized it away), its
 * record simply finds no match: the quote card is gone exactly when the
 * turn itself is gone.
 */

const STORAGE_KEY = "chat-submitted-staged-items";

/** Upper bound per session; oldest records are dropped first. */
const MAX_RECORDS_PER_SESSION = 100;

export interface SubmittedStagedItemRecord {
  /** The exact prompt text dispatched over ACP for this turn. */
  matchText: string;
  stagedItems: StagedItem[];
  recordedAt: number;
}

type RecordsBySession = Record<string, SubmittedStagedItemRecord[]>;

function isSubmittedRecord(value: unknown): value is SubmittedStagedItemRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    typeof record.matchText === "string" &&
    typeof record.recordedAt === "number" &&
    Array.isArray(record.stagedItems) &&
    record.stagedItems.every(isStagedItem)
  );
}

export function loadSubmittedStagedItemRecords(): RecordsBySession {
  if (typeof window === "undefined") return {};
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    if (!stored) return {};
    const parsed: unknown = JSON.parse(stored);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {};
    }
    return Object.fromEntries(
      Object.entries(parsed).flatMap(([sessionId, value]) => {
        if (!Array.isArray(value)) return [];
        const records = value.filter(isSubmittedRecord);
        return records.length > 0 ? [[sessionId, records]] : [];
      }),
    );
  } catch {
    return {};
  }
}

function persist(records: RecordsBySession): void {
  if (typeof window === "undefined") return;
  try {
    const nonEmpty = Object.fromEntries(
      Object.entries(records).filter(([, list]) => list.length > 0),
    );
    if (Object.keys(nonEmpty).length === 0) {
      window.localStorage.removeItem(STORAGE_KEY);
    } else {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(nonEmpty));
    }
  } catch {
    // localStorage may be unavailable
  }
}

/** Records the staged quotes of a dispatched user turn so their receipt and
 * source coordinates survive replay, window reopen, and compaction. */
export function recordSubmittedStagedItems(
  sessionId: string,
  matchText: string,
  stagedItems: readonly StagedItem[],
): void {
  const quotes = stagedItems.filter((item) => item.kind === "quote");
  if (quotes.length === 0) return;
  const records = loadSubmittedStagedItemRecords();
  const sessionRecords = records[sessionId] ?? [];
  sessionRecords.push({
    matchText,
    stagedItems: [...quotes],
    recordedAt: Date.now(),
  });
  records[sessionId] = sessionRecords.slice(-MAX_RECORDS_PER_SESSION);
  persist(records);
}

/** Drops all records for a session (session deleted/archived). */
export function clearSubmittedStagedItems(sessionId: string): void {
  const records = loadSubmittedStagedItemRecords();
  if (!records[sessionId]) return;
  delete records[sessionId];
  persist(records);
}

function normalizedMatchText(value: string): string {
  return value.trim();
}

/** Re-attaches submitted staged quotes to replayed user turns by ordered
 * prompt-text matching. Pure with respect to the input array: returns new
 * message objects where metadata was attached, and never overwrites
 * staged items a message already carries. */
export function withRestoredStagedItems(
  sessionId: string,
  messages: readonly Message[],
): Message[] {
  const records = loadSubmittedStagedItemRecords()[sessionId];
  if (!records || records.length === 0) return [...messages];

  const unconsumed = [...records];
  return messages.map((message) => {
    if (message.role !== "user") return message;
    if (message.metadata?.stagedItems?.length) return message;
    const messageText = normalizedMatchText(getTextContent(message));
    if (!messageText) return message;
    const index = unconsumed.findIndex(
      (record) => normalizedMatchText(record.matchText) === messageText,
    );
    if (index < 0) return message;
    const [record] = unconsumed.splice(index, 1);
    return {
      ...message,
      metadata: {
        ...message.metadata,
        stagedItems: [...record.stagedItems],
      },
    };
  });
}

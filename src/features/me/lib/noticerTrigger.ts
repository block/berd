import { logRendererEvent } from "@/shared/api/rendererTelemetry";
import { isTextContent, type Message } from "@/shared/types/messages";
import { noticeFromTranscript } from "./memoryNoticer";

/**
 * Idle trigger for the memory noticer.
 *
 * Each completed turn schedules a debounced pass; another send in the
 * same session resets the timer, so the extraction runs once per lull
 * rather than once per message. Passes only cover user messages that
 * arrived since the session's last pass — nothing is re-extracted, and
 * a session with no new user text schedules nothing.
 */

// Dev builds use a short debounce so the loop is testable without a
// 90-second wait; packaged builds keep the real lull.
const IDLE_DELAY_MS = import.meta.env.DEV ? 15_000 : 90_000;

const idleTimers = new Map<string, ReturnType<typeof setTimeout>>();
const noticedCounts = new Map<string, number>();

/** The user's own words from a slice of messages, one line per message. */
export function userTranscript(messages: Message[]): string {
  return messages
    .filter((message) => message.role === "user")
    .map((message) =>
      message.content
        .filter(isTextContent)
        .map((content) => content.text.trim())
        .filter(Boolean)
        .join("\n"),
    )
    .filter(Boolean)
    .join("\n");
}

/**
 * Called after a turn completes. Schedules (or reschedules) the idle
 * pass for this session. `getMessages` is read at fire time, so the
 * pass sees the conversation as it is after the lull, not as it was
 * when scheduled.
 */
export function scheduleNoticerPass(
  sessionId: string,
  getMessages: () => Message[],
  options?: { delayMs?: number },
): void {
  const existing = idleTimers.get(sessionId);
  if (existing) {
    clearTimeout(existing);
  }
  const timer = setTimeout(() => {
    idleTimers.delete(sessionId);
    void runPass(sessionId, getMessages);
  }, options?.delayMs ?? IDLE_DELAY_MS);
  idleTimers.set(sessionId, timer);
}

async function runPass(
  sessionId: string,
  getMessages: () => Message[],
): Promise<void> {
  try {
    const messages = getMessages();
    const already = noticedCounts.get(sessionId) ?? 0;
    const fresh = messages.slice(already);
    const freshText = userTranscript(fresh);
    // Mark before extracting: a failed pass skips these messages rather
    // than retrying them forever on every subsequent lull.
    noticedCounts.set(sessionId, messages.length);
    if (!freshText) {
      void logRendererEvent(
        "info",
        `[me:noticer] pass skipped for ${sessionId}: no new user text (${fresh.length} new messages)`,
      );
      return;
    }
    // New user text is only the *trigger*. Extract from the whole
    // conversation: a single message in isolation ("I like small venues")
    // reads as nothing worth keeping, which is exactly how early passes
    // returned NONE on conversations full of durable facts. Re-seeing old
    // messages is harmless — the queue and dismissal tombstones dedupe.
    const transcript = userTranscript(messages);
    void logRendererEvent(
      "info",
      `[me:noticer] pass starting for ${sessionId}: ${fresh.length} new messages, ${transcript.length} chars of user text (whole conversation)`,
    );
    const queued = await noticeFromTranscript(transcript, sessionId);
    void logRendererEvent(
      "info",
      `[me:noticer] pass finished for ${sessionId}: queued ${queued} proposal(s)`,
    );
  } catch (error) {
    void logRendererEvent("warn", `[me:noticer] pass failed: ${error}`);
    console.warn("[me] noticer pass failed", error);
  }
}

/** Test/cleanup hook: drop any pending timer and state for a session. */
export function cancelNoticerPass(sessionId: string): void {
  const timer = idleTimers.get(sessionId);
  if (timer) {
    clearTimeout(timer);
    idleTimers.delete(sessionId);
  }
}

/** Test hook. */
export function resetNoticerTracking(): void {
  for (const timer of idleTimers.values()) {
    clearTimeout(timer);
  }
  idleTimers.clear();
  noticedCounts.clear();
}

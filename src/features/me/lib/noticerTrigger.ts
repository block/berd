import { logRendererEvent } from "@/shared/api/rendererTelemetry";
import { isTextContent, type Message } from "@/shared/types/messages";
import { noticeFromTranscript } from "./memoryNoticer";
import type { OneShotExecutionTarget } from "@/shared/api/zeroToolOneShot";

/**
 * Idle trigger for the memory noticer.
 *
 * Each completed turn schedules a debounced pass; another send in the
 * same session resets the timer, so extraction runs once per lull rather than
 * once per message. Progress is tracked by stable user-message ids, not array
 * offsets, so replay or history replacement cannot slice away later messages.
 */

// Dev builds use a short debounce so the loop is testable without a
// 90-second wait; packaged builds keep the real lull.
const IDLE_DELAY_MS = import.meta.env.DEV ? 15_000 : 90_000;

const idleTimers = new Map<string, ReturnType<typeof setTimeout>>();
const watermarks = new Map<string, string | null>();
const inFlightRuns = new Map<string, Promise<void>>();
const pendingRuns = new Map<
  string,
  {
    getMessages: () => Message[];
    target: OneShotExecutionTarget;
  }
>();

/**
 * The user's visible text content, one line per message. Hidden steering,
 * assistant/tool/system/thinking content, and attachments/non-text blocks stay
 * out of the extractor input.
 */
export function userTranscript(messages: Message[]): string {
  return messages.map(userMessageText).filter(Boolean).join("\n");
}

function userMessageText(message: Message): string {
  if (message.role !== "user" || message.metadata?.userVisible === false) {
    return "";
  }
  return message.content
    .filter(isTextContent)
    .filter((content) => isUserVisibleContent(content))
    .map((content) => content.text.trim())
    .filter(Boolean)
    .join("\n");
}

function isUserVisibleContent(content: {
  annotations?: { audience?: string[] | null } | null;
}) {
  const audience = content.annotations?.audience;
  return !audience || audience.length === 0 || audience.includes("user");
}

function userMessagesWithText(messages: Message[]): Message[] {
  return messages.filter((message) => userMessageText(message));
}

function messagesAfterWatermark(
  messages: Message[],
  watermarkId: string | null,
): Message[] {
  if (!watermarkId) return messages;
  const watermarkIndex = messages.findIndex(
    (message) => message.id === watermarkId,
  );
  if (watermarkIndex === -1) {
    // The loaded history was replaced by a replay or cleanup. Reconcile by
    // treating the current user-text messages as unseen instead of trusting a
    // stale array offset that may be beyond the new history length.
    return messages;
  }
  return messages.slice(watermarkIndex + 1);
}

function latestMessageId(messages: Message[]): string | null {
  return messages.at(-1)?.id ?? null;
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
  target: OneShotExecutionTarget,
  options?: { delayMs?: number },
): void {
  const existing = idleTimers.get(sessionId);
  if (existing) {
    clearTimeout(existing);
  }
  const timer = setTimeout(() => {
    idleTimers.delete(sessionId);
    startRun(sessionId, getMessages, target);
  }, options?.delayMs ?? IDLE_DELAY_MS);
  idleTimers.set(sessionId, timer);
}

function startRun(
  sessionId: string,
  getMessages: () => Message[],
  target: OneShotExecutionTarget,
): void {
  if (inFlightRuns.has(sessionId)) {
    pendingRuns.set(sessionId, { getMessages, target });
    void logRendererEvent(
      "info",
      `[me:noticer] pass deferred for ${sessionId}: previous pass still running`,
    );
    return;
  }
  const run: Promise<void> = runPass(sessionId, getMessages, target).finally(
    () => {
      if (inFlightRuns.get(sessionId) !== run) {
        return;
      }
      inFlightRuns.delete(sessionId);
      const pending = pendingRuns.get(sessionId);
      if (pending) {
        pendingRuns.delete(sessionId);
        startRun(sessionId, pending.getMessages, pending.target);
      }
    },
  );
  inFlightRuns.set(sessionId, run);
  void run;
}

async function runPass(
  sessionId: string,
  getMessages: () => Message[],
  target: OneShotExecutionTarget,
): Promise<void> {
  try {
    const messages = getMessages();
    const userMessages = userMessagesWithText(messages);
    const watermark = watermarks.get(sessionId) ?? null;
    const fresh = messagesAfterWatermark(userMessages, watermark);
    const freshText = userTranscript(fresh);
    const nextWatermark = latestMessageId(userMessages);
    // Mark before extracting: a failed pass skips these messages rather
    // than retrying them forever on every subsequent lull. Because the marker
    // is an id, a replaced shorter replay reconciles safely on the next pass.
    watermarks.set(sessionId, nextWatermark);
    if (!freshText) {
      void logRendererEvent(
        "info",
        `[me:noticer] pass skipped for ${sessionId}: no new user text (${fresh.length} new messages)`,
      );
      return;
    }
    // New user text is only the *trigger*. Extract from the whole visible
    // user-authored conversation; the queue and dismissal tombstones dedupe.
    const transcript = userTranscript(messages);
    void logRendererEvent(
      "info",
      `[me:noticer] pass starting for ${sessionId}: ${fresh.length} new messages, ${transcript.length} chars of user text (whole conversation)`,
    );
    const queued = await noticeFromTranscript(transcript, sessionId, target);
    void logRendererEvent(
      "info",
      `[me:noticer] pass finished for ${sessionId}: queued ${queued} candidate(s)`,
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
  watermarks.delete(sessionId);
  pendingRuns.delete(sessionId);
}

/** Test hook. */
export function resetNoticerTracking(): void {
  for (const timer of idleTimers.values()) {
    clearTimeout(timer);
  }
  idleTimers.clear();
  watermarks.clear();
  inFlightRuns.clear();
  pendingRuns.clear();
}

/**
 * Typed completion-notification events.
 *
 * This is the minimal renderer-side contract for "an agent turn finished and
 * the user was notified about it". It gives future consumers (e.g. a
 * notification center) a stable, typed source of truth instead of scraping
 * toast text.
 *
 * Scope and deliberate non-goals, matching current architecture:
 * - Not a universal completion history. Events are emitted only when a
 *   completion passes the notification eligibility gates (notifications
 *   enabled, not suppressed, not an actively viewed focused session).
 *   Completions that never become notification-eligible are not captured.
 * - No persistence. Durable notification history belongs in Goose core
 *   behind a typed ACP method, not in renderer storage.
 * - No delivery logic. Delivery policy stays in useCompletionNotifications;
 *   this module only describes and broadcasts what happened.
 */

export type CompletionNotificationEventOutcome =
  | "completed"
  | "error"
  | "stopped";

/** Where activating the notification should take the user. */
export interface SessionNavigationTarget {
  kind: "session";
  sessionId: string;
}

export type NotificationNavigationTarget = SessionNavigationTarget;

export interface CompletionNotificationEvent {
  /**
   * Renderer-emission identifier: unique per emitted event within this
   * renderer process (`completion:<sessionId>:<emission ms>`). It is NOT a
   * durable identity — it is minted at emission time, so the same underlying
   * completion re-observed later (or in another process) gets a different id.
   * Consumers may use it to key UI lists, not to deduplicate across restarts.
   */
  id: string;
  sessionId: string;
  /** Owning project when the session is attached to one. */
  projectId: string | null;
  outcome: CompletionNotificationEventOutcome;
  /** The user-facing notification body (same text toast/desktop delivery uses). */
  body: string;
  /** ISO-8601 timestamp of the completion. */
  occurredAt: string;
  navigation: NotificationNavigationTarget;
}

export function createCompletionNotificationEvent({
  sessionId,
  projectId,
  outcome,
  body,
  occurredAtMs,
}: {
  sessionId: string;
  projectId?: string | null;
  outcome: CompletionNotificationEventOutcome;
  body: string;
  occurredAtMs: number;
}): CompletionNotificationEvent {
  return {
    id: `completion:${sessionId}:${occurredAtMs}`,
    sessionId,
    projectId: projectId ?? null,
    outcome,
    body,
    occurredAt: new Date(occurredAtMs).toISOString(),
    navigation: { kind: "session", sessionId },
  };
}

type CompletionNotificationEventListener = (
  event: CompletionNotificationEvent,
) => void;

const listeners = new Set<CompletionNotificationEventListener>();

/** Subscribe to completion notification events. Returns an unsubscribe fn. */
export function subscribeToCompletionNotificationEvents(
  listener: CompletionNotificationEventListener,
): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * Broadcast a completion notification event to all subscribers. A throwing
 * listener must not break delivery or other listeners.
 */
export function emitCompletionNotificationEvent(
  event: CompletionNotificationEvent,
): void {
  for (const listener of listeners) {
    try {
      listener(event);
    } catch (error) {
      console.error("completion notification listener failed", error);
    }
  }
}

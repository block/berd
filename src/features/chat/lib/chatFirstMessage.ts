/**
 * Replay-aware `is_first_message` read for the `berd_chat` send events.
 *
 * Both send-telemetry sites — the foreground controller's
 * `fireChatSendTelemetry` and the background released-deferred leg in
 * `queuedSessionSend` — fire from the send's user-message-commit callback and
 * ask the same question: is the user message that just committed the session's
 * first? `is_first_message` carries the answer, and `Session Started` fires
 * only when it is true.
 *
 * Reading that answer straight off the transcript ("it holds exactly one user
 * message, and that is the one just committed") is only sound while the
 * transcript is complete — and it is not complete while a session's history is
 * replaying. Replayed messages accumulate in a module-level buffer and reach
 * the store as a single flush when the load finishes
 * (`sessionActivation.performSessionMessagesLoad`), so a just-opened old
 * session shows an *empty* transcript until then. Nothing gates sending on that
 * load: the queue drain only requires an idle runtime
 * (`queuedMessageReadiness`), and a popped-out session window renders its
 * composer while its own load is still in flight. Typing into an old session
 * right after opening it would therefore report a long-running conversation as
 * brand new.
 *
 * So the transcript read only stands once the session's history is accounted
 * for: no load in flight, and a session record that positively reports an empty
 * session. Anything else — a replay still landing, a pinned placeholder or a
 * failed pinned hydration, a backend message count above zero — is read as "the
 * session already had messages". That direction is deliberate: suppressing the
 * event costs one session's `Session Started`, while emitting it falsely
 * reports a resumed conversation as a new one.
 *
 * App-restart queue restore never reaches the unresolved case: restored records
 * are skipped by the drain (`useMessageQueue`) until `markQueuedMessagesReady`
 * runs, which `loadSessionMessages` only calls after the replay has landed.
 */
import { useChatSessionStore } from "@/features/chat/stores/chatSessionStore";
import { useChatStore } from "@/features/chat/stores/chatStore";

/**
 * True when the user message a send just committed is the session's first.
 *
 * Call from the send's `onUserMessageCommitted` callback: the committed message
 * is already in the transcript, so "first" means it is the only user message
 * there *and* the session is known to have had none before it.
 */
export function isFirstCommittedUserMessage(sessionId: string): boolean {
  const transcript = useChatStore.getState().messagesBySession[sessionId] ?? [];
  const committedUserMessages = transcript.filter(
    (message) => message.role === "user",
  ).length;
  if (committedUserMessages !== 1) {
    return false;
  }
  return isSessionHistoryAccountedFor(sessionId);
}

/**
 * True when the store's view of the session's history is both settled and
 * empty, so a lone user message in the transcript really is the first one.
 */
function isSessionHistoryAccountedFor(sessionId: string): boolean {
  // A replay in flight flushes the session's history into the transcript when
  // it lands; until then an empty transcript proves nothing about the session.
  if (useChatStore.getState().loadingSessionIds.has(sessionId)) {
    return false;
  }
  const session = useChatSessionStore.getState().getSession(sessionId);
  // No record to vouch for the session, or only the placeholder a pinned Home
  // widget inserts for a session missing from the list — its zero count is a
  // default, not backend metadata, and "failed" means the load never resolved.
  if (!session || session.pinnedLoadState) {
    return false;
  }
  // The backend's own count of the session's persisted messages, carried on the
  // session list/info. The local commit above does not touch it, so it still
  // describes the session as it was before this send.
  return session.messageCount === 0;
}

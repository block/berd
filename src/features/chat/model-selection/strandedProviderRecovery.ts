import { isProviderNotSetError } from "@/shared/api/acpErrors";
import { isTextContent, type Message } from "@/shared/types/messages";
import { useChatSessionStore } from "../stores/chatSessionStore";
import { useChatStore } from "../stores/chatStore";
import type { PreferredModelSelection } from "./modelSelectionIntent";

/**
 * Recreate the current session on a fresh provider. Implemented by
 * useChatSessionController; resolves true when the recreate navigated onto the
 * fresh session, false when a newer pick superseded it mid-flight.
 */
export type RecreateSessionForProvider = (
  providerId: string,
  modelSelection?: PreferredModelSelection | null,
  isSelectionCurrent?: () => boolean,
) => Promise<boolean>;

/**
 * True when the session can be recreated on a fresh provider without losing
 * conversation content.
 *
 * A session is recoverable when the backend never committed a turn
 * (messageCount 0) and the local message store holds no assistant content.
 * Local user messages do NOT block recovery: on a stranded provider the
 * prompt send fails immediately, leaving the optimistic user message and an
 * error notification in the local store while messageCount stays 0 — the
 * exact state the trap produces. Refusing to recover here (as the original
 * guard did) permanently strands the most common discovery path: chat first
 * on the dead default provider, then try to switch away. The typed text is
 * not discarded — collectStrandedComposerText carries it into the recreated
 * session's composer.
 *
 * Any assistant message means a provider was alive at some point and real
 * conversation happened; never discard that — surface the switch failure
 * normally instead.
 */
export function isRecoverableStrandedSession(
  sessionId: string | null,
): boolean {
  if (!sessionId) {
    // No session yet — nothing to lose by recreating.
    return true;
  }
  const session = useChatSessionStore.getState().getSession(sessionId);
  if ((session?.messageCount ?? 0) > 0) {
    return false;
  }
  const localMessages = useChatStore.getState().messagesBySession[sessionId];
  return !localMessages?.some((message) => message.role === "assistant");
}

function messageText(message: Message): string {
  return message.content
    .filter(isTextContent)
    .map((content) => content.text)
    .join("\n")
    .trim();
}

/**
 * Gather the user's typed-but-unsent content from a stranded session so a
 * recovery recreate can seed it into the fresh session's composer: the text of
 * locally-buffered user messages whose send failed (backend committed
 * nothing), followed by any in-progress composer draft. Attachments are not
 * carried — only text survives the hop.
 */
export function collectStrandedComposerText(sessionId: string): string {
  const chatStore = useChatStore.getState();
  const failedPromptTexts = (chatStore.messagesBySession[sessionId] ?? [])
    .filter((message) => message.role === "user")
    .map(messageText)
    .filter((text) => text.length > 0);
  const draft = chatStore.draftsBySession[sessionId]?.trim() ?? "";
  return [...failedPromptTexts, ...(draft ? [draft] : [])].join("\n\n");
}

export interface RecoverStrandedProviderSessionOptions {
  error: unknown;
  sessionId: string | null;
  providerId: string;
  modelSelection?: PreferredModelSelection | null;
  recreateSessionForProvider?: RecreateSessionForProvider;
  /**
   * Re-checked inside the recreate right before it navigates: a newer
   * provider/model pick during the recreate's createSession await must own
   * navigation, not this stale recovery.
   */
  isSelectionCurrent?: () => boolean;
  /**
   * Runs only if the recreate actually navigated onto the fresh session (not
   * superseded, not failed). Callers use it to persist the recovered choice;
   * without it the success-path persistence is skipped by the recovery
   * early-return, so the next new session would fall back to the old (likely
   * dead) preference and re-enter the trap.
   */
  onRecovered?: () => void;
}

/**
 * Escape hatch for the "Provider not set" trap, shared by every surface that
 * switches a session's provider or model in place (picker, persona change,
 * Home pending-model sync).
 *
 * When an in-place switch fails because the session's live provider never
 * constructed, the backend's switch handlers reject before they can install
 * the target provider — they read the current (dead) provider first. Rather
 * than roll back onto the corpse, recreate the session directly on the target
 * provider: newSession installs the provider at birth, bypassing the
 * read-current gate.
 *
 * Returns true when it took over handling the error by resolving a recreate
 * (including a superseded recreate); returns false when the caller should
 * continue through its normal failure and rollback path.
 */
export async function recoverStrandedProviderSession({
  error,
  sessionId,
  providerId,
  modelSelection,
  recreateSessionForProvider,
  isSelectionCurrent,
  onRecovered,
}: RecoverStrandedProviderSessionOptions): Promise<boolean> {
  if (!recreateSessionForProvider || !isProviderNotSetError(error)) {
    return false;
  }
  if (!isRecoverableStrandedSession(sessionId)) {
    return false;
  }
  try {
    const recovered = await recreateSessionForProvider(
      providerId,
      modelSelection ?? null,
      isSelectionCurrent,
    );
    // Persist only when this selection's recreate is the one that navigated.
    // A superseded recreate resolves false, so the newer pick owns both
    // navigation and its own preference — running onRecovered here would
    // clobber it with the stale choice.
    if (recovered) {
      onRecovered?.();
    }
    return true;
  } catch (recreateError) {
    console.error(
      "Failed to recreate session after provider-not-set error:",
      recreateError,
    );
    return false;
  }
}

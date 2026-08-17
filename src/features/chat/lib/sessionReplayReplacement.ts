import { getAndDeleteReplayBuffer } from "@/features/chat/hooks/replayBuffer";
import { sanitizeReplayMessages } from "@/features/chat/lib/replaySanitizer";
import { useChatStore } from "@/features/chat/stores/chatStore";
import type { Message } from "@/shared/types/messages";

export type SessionReplayReplacementResult =
  | { status: "replaced"; messages: Message[] }
  | { status: "not-required"; messages: [] }
  | { status: "invalid"; reason: "missing" | "empty" };

export function hasConversationMessages(
  messages: Message[] | undefined,
): boolean {
  return messages?.some((message) => message.role !== "system") ?? false;
}

/**
 * Consumes a session replay and replaces the visible transcript only when the
 * replay is authoritative for the current operation. Empty history is valid
 * for an empty transcript, but cannot replace conversation messages already
 * on screen or satisfy an operation that requires replacement history.
 */
export function replaceMessagesFromSessionReplay(
  sessionId: string,
  options: {
    historyExpectation?: "empty" | "nonempty" | "unknown";
    trailingMessages?: Message[];
  } = {},
): SessionReplayReplacementResult {
  const existingMessages =
    useChatStore.getState().messagesBySession[sessionId] ?? [];
  const existingConversation = hasConversationMessages(existingMessages);
  const historyExpectation = options.historyExpectation ?? "unknown";
  const replacementRequired =
    historyExpectation !== "empty" || existingConversation;
  const buffer = getAndDeleteReplayBuffer(sessionId);
  if (!buffer) {
    if (replacementRequired) {
      return { status: "invalid", reason: "missing" };
    }
    useChatStore.getState().setMessages(sessionId, []);
    return { status: "not-required", messages: [] };
  }

  const messages = sanitizeReplayMessages(buffer);
  if (!hasConversationMessages(messages)) {
    if (replacementRequired) {
      return { status: "invalid", reason: "empty" };
    }
    useChatStore.getState().setMessages(sessionId, []);
    return { status: "not-required", messages: [] };
  }

  useChatStore
    .getState()
    .setMessages(sessionId, [...messages, ...(options.trailingMessages ?? [])]);
  return { status: "replaced", messages };
}

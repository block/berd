import type { Message } from "@/shared/types/messages";
import { getUserVisibleMessageContent } from "@/features/chat/transcript/projection";

/** Home canvas shows this many complete user-led conversation exchanges. */
export const HOME_CANVAS_RECENT_EXCHANGE_LIMIT = 10;

export interface BoundedConversationProjection {
  messages: Message[];
  omittedExchangeCount: number;
  hasOmittedExchanges: boolean;
  earliestVisibleMessageId: string | null;
}

/**
 * A real user-authored message starts an exchange. Everything after it belongs
 * to that exchange until the next real user-authored message. Invisible and
 * assistant-only user records are transcript events, not exchange boundaries.
 *
 * Messages before the first real user-authored message are a prelude. The
 * prelude is retained only when no complete exchange is omitted, so omission
 * always removes whole exchanges and never leaves detached old context.
 */
export function projectRecentConversationExchanges(
  messages: readonly Message[],
): BoundedConversationProjection {
  const exchangeStarts: number[] = [];

  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index];
    if (message && isRealUserAuthoredMessage(message)) {
      exchangeStarts.push(index);
    }
  }

  const omittedExchangeCount = Math.max(
    0,
    exchangeStarts.length - HOME_CANVAS_RECENT_EXCHANGE_LIMIT,
  );
  const firstVisibleExchangeStart = exchangeStarts[omittedExchangeCount];
  const startIndex =
    omittedExchangeCount > 0
      ? (firstVisibleExchangeStart ?? messages.length)
      : 0;
  const projectedMessages = messages.slice(startIndex);

  return {
    messages: projectedMessages,
    omittedExchangeCount,
    hasOmittedExchanges: omittedExchangeCount > 0,
    earliestVisibleMessageId: projectedMessages[0]?.id ?? null,
  };
}

function isRealUserAuthoredMessage(message: Message): boolean {
  if (message.role !== "user" || message.metadata?.userVisible === false) {
    return false;
  }

  return getUserVisibleMessageContent(message.content).some(
    (content) => content.type === "text" || content.type === "image",
  );
}

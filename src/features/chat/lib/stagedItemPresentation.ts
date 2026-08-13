import type { StagedQuoteItem } from "@/shared/types/messages";

const SHORT_QUOTE_CHARACTER_LIMIT = 72;

function compactWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function wordCount(value: string): number {
  return compactWhitespace(value).split(" ").filter(Boolean).length;
}

export function stagedQuoteLabel(quote: StagedQuoteItem): string {
  const excerpt = compactWhitespace(quote.excerpt);
  if (excerpt.length <= SHORT_QUOTE_CHARACTER_LIMIT) return excerpt;
  return `${excerpt.slice(0, SHORT_QUOTE_CHARACTER_LIMIT).trimEnd()}…`;
}

export type StagedQuoteSourceKind =
  | "agentResponse"
  | "yourMessage"
  | "systemMessage"
  | "multipleMessages";

/** Distinct messages the quote draws from; multiple blocks of one message
 * still count as one message. */
export function stagedQuoteMessageCount(quote: StagedQuoteItem): number {
  return new Set(quote.sources.map((source) => source.messageId)).size;
}

export function stagedQuoteSourceKind(
  quote: StagedQuoteItem,
): StagedQuoteSourceKind {
  if (stagedQuoteMessageCount(quote) > 1) return "multipleMessages";
  switch (quote.sources[0]?.role) {
    case "user":
      return "yourMessage";
    case "system":
      return "systemMessage";
    default:
      return "agentResponse";
  }
}

export function stagedQuoteWordCount(quote: StagedQuoteItem): number {
  return wordCount(quote.excerpt);
}

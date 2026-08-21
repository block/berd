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

export type StagedQuoteSourceKind = "agentResponse" | "yourMessage";

export function stagedQuoteMessageCount(_quote: StagedQuoteItem): number {
  return 1;
}

export function stagedQuoteSourceKind(
  quote: StagedQuoteItem,
): StagedQuoteSourceKind {
  switch (quote.source.role) {
    case "user":
      return "yourMessage";
    default:
      return "agentResponse";
  }
}

export function stagedQuoteWordCount(quote: StagedQuoteItem): number {
  return wordCount(quote.excerpt);
}

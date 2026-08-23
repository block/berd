import type {
  StagedItem,
  StagedQuoteItem,
  StagedQuoteSource,
} from "./messages";

export function isStagedQuoteSource(
  value: unknown,
): value is StagedQuoteSource {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const source = value as Record<string, unknown>;
  return (
    typeof source.messageId === "string" &&
    source.messageId.length > 0 &&
    (source.role === "user" || source.role === "assistant")
  );
}

export function isStagedQuoteItem(value: unknown): value is StagedQuoteItem {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  return (
    item.kind === "quote" &&
    typeof item.id === "string" &&
    item.id.length > 0 &&
    typeof item.excerpt === "string" &&
    item.excerpt.length > 0 &&
    isStagedQuoteSource(item.source)
  );
}

export function isStagedItem(value: unknown): value is StagedItem {
  return isStagedQuoteItem(value);
}

import type {
  StagedItem,
  StagedQuoteSourceRange,
} from "@/shared/types/messages";

const DRAFTS_STORAGE_KEY = "goose:chat-drafts";
const STAGED_ITEMS_STORAGE_KEY = "goose:chat-staged-items:v1";

export function loadCachedDrafts(): Record<string, string> {
  if (typeof window === "undefined") return {};
  try {
    const stored = window.localStorage.getItem(DRAFTS_STORAGE_KEY);
    if (!stored) return {};
    const parsed = JSON.parse(stored);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {};
    }
    return Object.fromEntries(
      Object.entries(parsed).filter(
        (entry): entry is [string, string] => typeof entry[1] === "string",
      ),
    );
  } catch {
    return {};
  }
}

export function persistDrafts(drafts: Record<string, string>): void {
  if (typeof window === "undefined") return;
  try {
    const nonEmpty = Object.fromEntries(
      Object.entries(drafts).filter(
        ([, v]) => typeof v === "string" && v.length > 0,
      ),
    );
    if (Object.keys(nonEmpty).length === 0) {
      window.localStorage.removeItem(DRAFTS_STORAGE_KEY);
    } else {
      window.localStorage.setItem(DRAFTS_STORAGE_KEY, JSON.stringify(nonEmpty));
    }
  } catch {
    // localStorage may be unavailable
  }
}

function isStagedQuoteSourceRange(
  value: unknown,
): value is StagedQuoteSourceRange {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const source = value as Record<string, unknown>;
  return (
    typeof source.messageId === "string" &&
    (source.role === undefined ||
      source.role === "user" ||
      source.role === "assistant" ||
      source.role === "system") &&
    Number.isInteger(source.contentBlockIndex) &&
    (source.contentBlockIndex as number) >= 0 &&
    Number.isInteger(source.start) &&
    (source.start as number) >= 0 &&
    Number.isInteger(source.end) &&
    (source.end as number) > (source.start as number)
  );
}

export function isStagedItem(value: unknown): value is StagedItem {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  return (
    item.kind === "quote" &&
    typeof item.id === "string" &&
    item.id.length > 0 &&
    typeof item.excerpt === "string" &&
    item.excerpt.length > 0 &&
    Array.isArray(item.sources) &&
    item.sources.length > 0 &&
    item.sources.every(isStagedQuoteSourceRange)
  );
}

export function loadCachedStagedItems(): Record<string, StagedItem[]> {
  if (typeof window === "undefined") return {};
  try {
    const stored = window.localStorage.getItem(STAGED_ITEMS_STORAGE_KEY);
    if (!stored) return {};
    const parsed: unknown = JSON.parse(stored);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {};
    }
    return Object.fromEntries(
      Object.entries(parsed).flatMap(([sessionId, value]) => {
        if (!Array.isArray(value)) return [];
        const items = value.filter(isStagedItem);
        return items.length > 0 ? [[sessionId, items]] : [];
      }),
    );
  } catch {
    return {};
  }
}

export function persistStagedItems(
  stagedItemsBySession: Record<string, StagedItem[]>,
): void {
  if (typeof window === "undefined") return;
  try {
    const nonEmpty = Object.fromEntries(
      Object.entries(stagedItemsBySession).filter(
        ([, items]) => items.length > 0,
      ),
    );
    if (Object.keys(nonEmpty).length === 0) {
      window.localStorage.removeItem(STAGED_ITEMS_STORAGE_KEY);
    } else {
      window.localStorage.setItem(
        STAGED_ITEMS_STORAGE_KEY,
        JSON.stringify(nonEmpty),
      );
    }
  } catch {
    // localStorage may be unavailable
  }
}

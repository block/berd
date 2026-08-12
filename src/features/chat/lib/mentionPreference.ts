import { useCallback, useSyncExternalStore } from "react";

export type AtMentionDefaultCategory = "agents" | "files";

export const AT_MENTION_DEFAULT_CATEGORY_STORAGE_KEY =
  "goose:at-mention-default-category";
export const DEFAULT_AT_MENTION_DEFAULT_CATEGORY: AtMentionDefaultCategory =
  "agents";

const AT_MENTION_DEFAULT_CATEGORY_CHANGED_EVENT =
  "goose:at-mention-default-category-changed";

function normalizeAtMentionDefaultCategory(
  value: unknown,
): AtMentionDefaultCategory {
  return value === "files" || value === "agents"
    ? value
    : DEFAULT_AT_MENTION_DEFAULT_CATEGORY;
}

function readAtMentionDefaultCategory(): AtMentionDefaultCategory {
  try {
    return normalizeAtMentionDefaultCategory(
      localStorage.getItem(AT_MENTION_DEFAULT_CATEGORY_STORAGE_KEY),
    );
  } catch {
    return DEFAULT_AT_MENTION_DEFAULT_CATEGORY;
  }
}

const listeners = new Set<() => void>();
let removeWindowListener: (() => void) | undefined;

function notifyListeners() {
  for (const listener of listeners) {
    listener();
  }
}

function subscribe(onStoreChange: () => void) {
  listeners.add(onStoreChange);

  if (!removeWindowListener) {
    window.addEventListener(
      AT_MENTION_DEFAULT_CATEGORY_CHANGED_EVENT,
      notifyListeners,
    );
    removeWindowListener = () => {
      window.removeEventListener(
        AT_MENTION_DEFAULT_CATEGORY_CHANGED_EVENT,
        notifyListeners,
      );
    };
  }

  return () => {
    listeners.delete(onStoreChange);
    if (listeners.size === 0) {
      removeWindowListener?.();
      removeWindowListener = undefined;
    }
  };
}

export function getAtMentionDefaultCategory(): AtMentionDefaultCategory {
  return readAtMentionDefaultCategory();
}

export function setAtMentionDefaultCategory(
  category: AtMentionDefaultCategory,
): void {
  const normalized = normalizeAtMentionDefaultCategory(category);
  try {
    localStorage.setItem(AT_MENTION_DEFAULT_CATEGORY_STORAGE_KEY, normalized);
  } catch {
    // localStorage can be unavailable in restricted contexts.
  }
  window.dispatchEvent(
    new CustomEvent(AT_MENTION_DEFAULT_CATEGORY_CHANGED_EVENT, {
      detail: { category: normalized },
    }),
  );
}

export function useAtMentionDefaultCategoryPreference() {
  const category = useSyncExternalStore(
    subscribe,
    readAtMentionDefaultCategory,
    () => DEFAULT_AT_MENTION_DEFAULT_CATEGORY,
  );
  const setCategory = useCallback((nextCategory: AtMentionDefaultCategory) => {
    setAtMentionDefaultCategory(nextCategory);
  }, []);

  return { category, setCategory };
}

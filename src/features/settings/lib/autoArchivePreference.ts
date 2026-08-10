import { useCallback, useSyncExternalStore } from "react";

export const AUTO_ARCHIVE_STORAGE_KEY = "goose:auto-archive-unpinned-after";
export const AUTO_ARCHIVE_CHANGED_EVENT =
  "goose:auto-archive-unpinned-after-changed";
export const AUTO_ARCHIVE_CONSENT_STORAGE_KEY =
  "goose:auto-archive-unpinned-consented";

export type AutoArchiveAfter =
  | "never"
  | "1-day"
  | "7-days"
  | "14-days"
  | "30-days"
  | "90-days";

export const AUTO_ARCHIVE_OPTIONS: ReadonlyArray<{
  value: AutoArchiveAfter;
  days: number | null;
}> = [
  { value: "never", days: null },
  { value: "1-day", days: 1 },
  { value: "7-days", days: 7 },
  { value: "14-days", days: 14 },
  { value: "30-days", days: 30 },
  { value: "90-days", days: 90 },
];

const AUTO_ARCHIVE_VALUES = new Set<AutoArchiveAfter>(
  AUTO_ARCHIVE_OPTIONS.map((option) => option.value),
);
const DEFAULT_AUTO_ARCHIVE_AFTER: AutoArchiveAfter = "never";
const DAY_MS = 24 * 60 * 60 * 1000;

function isAutoArchiveAfter(value: string | null): value is AutoArchiveAfter {
  return value !== null && AUTO_ARCHIVE_VALUES.has(value as AutoArchiveAfter);
}

export function getAutoArchiveAfter(): AutoArchiveAfter {
  if (typeof window === "undefined") return DEFAULT_AUTO_ARCHIVE_AFTER;

  try {
    // A duration alone is not consent. This separate marker prevents stale or
    // experimental local values from ever enabling destructive behavior on a
    // user's first run of the shipped feature.
    if (
      window.localStorage.getItem(AUTO_ARCHIVE_CONSENT_STORAGE_KEY) !== "true"
    ) {
      return DEFAULT_AUTO_ARCHIVE_AFTER;
    }
    const stored = window.localStorage.getItem(AUTO_ARCHIVE_STORAGE_KEY);
    return isAutoArchiveAfter(stored) ? stored : DEFAULT_AUTO_ARCHIVE_AFTER;
  } catch {
    return DEFAULT_AUTO_ARCHIVE_AFTER;
  }
}

export function getAutoArchiveAfterMs(
  value: AutoArchiveAfter = getAutoArchiveAfter(),
): number | null {
  const option = AUTO_ARCHIVE_OPTIONS.find(
    (candidate) => candidate.value === value,
  );
  return option?.days == null ? null : option.days * DAY_MS;
}

function persistAutoArchivePreference(
  value: AutoArchiveAfter,
  consented: boolean,
): void {
  if (typeof window === "undefined") return;

  try {
    window.localStorage.setItem(AUTO_ARCHIVE_STORAGE_KEY, value);
    window.localStorage.setItem(
      AUTO_ARCHIVE_CONSENT_STORAGE_KEY,
      String(consented),
    );
  } catch {
    // localStorage can be unavailable in restricted contexts.
  }
  window.dispatchEvent(
    new CustomEvent(AUTO_ARCHIVE_CHANGED_EVENT, { detail: { value } }),
  );
}

export function setAutoArchiveAfter(value: AutoArchiveAfter): void {
  persistAutoArchivePreference(value, true);
}

export function resetAutoArchiveAfter(): void {
  persistAutoArchivePreference(DEFAULT_AUTO_ARCHIVE_AFTER, false);
}

const listeners = new Set<() => void>();
let removeWindowListeners: (() => void) | undefined;

function notifyListeners() {
  for (const listener of listeners) listener();
}

function handleStorageChange(event: StorageEvent) {
  if (event.key === AUTO_ARCHIVE_STORAGE_KEY || event.key === null) {
    notifyListeners();
  }
}

function subscribe(onStoreChange: () => void) {
  if (typeof window === "undefined") return () => {};

  listeners.add(onStoreChange);
  if (!removeWindowListeners) {
    window.addEventListener(AUTO_ARCHIVE_CHANGED_EVENT, notifyListeners);
    window.addEventListener("storage", handleStorageChange);
    removeWindowListeners = () => {
      window.removeEventListener(AUTO_ARCHIVE_CHANGED_EVENT, notifyListeners);
      window.removeEventListener("storage", handleStorageChange);
    };
  }

  return () => {
    listeners.delete(onStoreChange);
    if (listeners.size === 0) {
      removeWindowListeners?.();
      removeWindowListeners = undefined;
    }
  };
}

export function useAutoArchivePreference() {
  const value = useSyncExternalStore(
    subscribe,
    getAutoArchiveAfter,
    () => DEFAULT_AUTO_ARCHIVE_AFTER,
  );
  const setValue = useCallback((nextValue: AutoArchiveAfter) => {
    setAutoArchiveAfter(nextValue);
  }, []);

  return { value, setValue, afterMs: getAutoArchiveAfterMs(value) };
}

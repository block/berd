import { useCallback, useSyncExternalStore } from "react";

export const TERMINAL_FALLBACK_CWD_STORAGE_KEY = "goose:terminal-fallback-cwd";
const TERMINAL_FALLBACK_CWD_CHANGED_EVENT =
  "goose:terminal-fallback-cwd-changed";

function trimValue(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

export function getTerminalFallbackCwdPreference(): string | null {
  if (typeof window === "undefined") {
    return null;
  }

  try {
    return trimValue(
      window.localStorage.getItem(TERMINAL_FALLBACK_CWD_STORAGE_KEY),
    );
  } catch {
    return null;
  }
}

export function setTerminalFallbackCwdPreference(path: string | null): void {
  if (typeof window === "undefined") {
    return;
  }

  try {
    const trimmed = trimValue(path);
    if (trimmed) {
      window.localStorage.setItem(TERMINAL_FALLBACK_CWD_STORAGE_KEY, trimmed);
    } else {
      window.localStorage.removeItem(TERMINAL_FALLBACK_CWD_STORAGE_KEY);
    }
    window.dispatchEvent(new Event(TERMINAL_FALLBACK_CWD_CHANGED_EVENT));
  } catch {
    // localStorage can be unavailable in restricted contexts.
  }
}

export function useTerminalFallbackCwdPreference() {
  const fallbackCwd = useSyncExternalStore(
    (onStoreChange) => {
      window.addEventListener(
        TERMINAL_FALLBACK_CWD_CHANGED_EVENT,
        onStoreChange,
      );
      return () => {
        window.removeEventListener(
          TERMINAL_FALLBACK_CWD_CHANGED_EVENT,
          onStoreChange,
        );
      };
    },
    getTerminalFallbackCwdPreference,
    () => null,
  );

  const setFallbackCwd = useCallback((nextFallbackCwd: string) => {
    setTerminalFallbackCwdPreference(nextFallbackCwd);
  }, []);

  const resetFallbackCwd = useCallback(() => {
    setTerminalFallbackCwdPreference(null);
  }, []);

  return {
    fallbackCwd,
    hasCustomFallbackCwd: fallbackCwd !== null,
    setFallbackCwd,
    resetFallbackCwd,
  };
}

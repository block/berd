import { useCallback, useSyncExternalStore } from "react";

export type StreamingShortcutMode = "cmd-enter-steers" | "enter-steers";
export type StreamingShortcutAction = "queue" | "steer";

export const STREAMING_SHORTCUT_MODE_STORAGE_KEY =
  "goose:streaming-shortcut-mode";
export const DEFAULT_STREAMING_SHORTCUT_MODE: StreamingShortcutMode =
  "cmd-enter-steers";

const STREAMING_SHORTCUT_MODE_CHANGED_EVENT =
  "goose:streaming-shortcut-mode-changed";

function normalizeStreamingShortcutMode(value: unknown): StreamingShortcutMode {
  return value === "enter-steers" || value === "cmd-enter-steers"
    ? value
    : DEFAULT_STREAMING_SHORTCUT_MODE;
}

function readStreamingShortcutMode(): StreamingShortcutMode {
  try {
    return normalizeStreamingShortcutMode(
      localStorage.getItem(STREAMING_SHORTCUT_MODE_STORAGE_KEY),
    );
  } catch {
    return DEFAULT_STREAMING_SHORTCUT_MODE;
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
      STREAMING_SHORTCUT_MODE_CHANGED_EVENT,
      notifyListeners,
    );
    removeWindowListener = () => {
      window.removeEventListener(
        STREAMING_SHORTCUT_MODE_CHANGED_EVENT,
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

export function getStreamingShortcutMode(): StreamingShortcutMode {
  return readStreamingShortcutMode();
}

export function setStreamingShortcutMode(mode: StreamingShortcutMode): void {
  const normalized = normalizeStreamingShortcutMode(mode);
  try {
    localStorage.setItem(STREAMING_SHORTCUT_MODE_STORAGE_KEY, normalized);
  } catch {
    // localStorage can be unavailable in restricted contexts.
  }
  window.dispatchEvent(
    new CustomEvent(STREAMING_SHORTCUT_MODE_CHANGED_EVENT, {
      detail: { mode: normalized },
    }),
  );
}

export function getStreamingShortcutAction(
  mode: StreamingShortcutMode,
  hasCommandModifier: boolean,
): StreamingShortcutAction {
  if (mode === "cmd-enter-steers") {
    return hasCommandModifier ? "steer" : "queue";
  }
  return hasCommandModifier ? "queue" : "steer";
}

export function useStreamingShortcutPreference() {
  const mode = useSyncExternalStore(
    subscribe,
    readStreamingShortcutMode,
    () => DEFAULT_STREAMING_SHORTCUT_MODE,
  );
  const setMode = useCallback((nextMode: StreamingShortcutMode) => {
    setStreamingShortcutMode(nextMode);
  }, []);

  return { mode, setMode };
}

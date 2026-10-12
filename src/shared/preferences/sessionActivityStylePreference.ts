import { useCallback, useSyncExternalStore } from "react";

import {
  DEFAULT_SESSION_ACTIVITY_STYLE,
  SESSION_ACTIVITY_STYLES,
  type SessionActivityStyle,
} from "@/shared/ui/session-activity-motion";

export const SESSION_ACTIVITY_STYLE_STORAGE_KEY =
  "goose:session-activity-style";
const CHANGED_EVENT = "goose:session-activity-style-changed";

function isStyle(value: unknown): value is SessionActivityStyle {
  return SESSION_ACTIVITY_STYLES.includes(value as SessionActivityStyle);
}

export function getSessionActivityStyle(): SessionActivityStyle {
  if (typeof window === "undefined") return DEFAULT_SESSION_ACTIVITY_STYLE;
  try {
    const stored = window.localStorage.getItem(
      SESSION_ACTIVITY_STYLE_STORAGE_KEY,
    );
    return isStyle(stored) ? stored : DEFAULT_SESSION_ACTIVITY_STYLE;
  } catch {
    return DEFAULT_SESSION_ACTIVITY_STYLE;
  }
}

export function setSessionActivityStyle(style: SessionActivityStyle): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(SESSION_ACTIVITY_STYLE_STORAGE_KEY, style);
  } catch {
    // localStorage can be unavailable in restricted contexts.
  }
  window.dispatchEvent(new CustomEvent(CHANGED_EVENT));
}

function subscribe(onStoreChange: () => void) {
  if (typeof window === "undefined") return () => {};
  const onStorage = (event: StorageEvent) => {
    if (event.key === SESSION_ACTIVITY_STYLE_STORAGE_KEY || event.key === null)
      onStoreChange();
  };
  window.addEventListener(CHANGED_EVENT, onStoreChange);
  window.addEventListener("storage", onStorage);
  return () => {
    window.removeEventListener(CHANGED_EVENT, onStoreChange);
    window.removeEventListener("storage", onStorage);
  };
}

export function useSessionActivityStylePreference() {
  const style = useSyncExternalStore(
    subscribe,
    getSessionActivityStyle,
    () => DEFAULT_SESSION_ACTIVITY_STYLE,
  );
  const setStyle = useCallback(setSessionActivityStyle, []);
  return { style, setStyle };
}

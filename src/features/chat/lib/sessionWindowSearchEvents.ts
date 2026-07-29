import { emitTo, listen, type UnlistenFn } from "@tauri-apps/api/event";

export const SESSION_WINDOW_SEARCH_TARGET = "session-window-search-target";

export interface SessionWindowSearchTarget {
  sessionId: string;
  messageId: string;
  query?: string;
}

export function sendSessionWindowSearchTarget(
  windowLabel: string,
  target: SessionWindowSearchTarget,
): Promise<void> {
  return emitTo(windowLabel, SESSION_WINDOW_SEARCH_TARGET, target);
}

export function listenSessionWindowSearchTarget(
  handler: (target: SessionWindowSearchTarget) => void,
): Promise<UnlistenFn> {
  return listen<SessionWindowSearchTarget>(
    SESSION_WINDOW_SEARCH_TARGET,
    (event) => handler(event.payload),
  );
}

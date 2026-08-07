import { useCallback, useEffect, useRef } from "react";
import { useChatSessionStore } from "@/features/chat/stores/chatSessionStore";

/**
 * Periodically refreshes the session list from ACP and on window focus.
 *
 * Sessions can be created over ACP by clients other than the desktop UI
 * (for example, automation that calls `session/new` directly). Without this
 * hook, those sessions are invisible in the sidebar until the next app
 * restart, because `loadSessions()` is only called at startup
 * (`chatRuntimeStartup.ts`) and `session_info_update` notifications are
 * dropped on the floor for sessions that are not already in the store
 * (`features/chat/acp/acpSessionInfoUpdate.ts`).
 *
 * Mirrors the periodic + focus pattern used by `usePersonas` for persona
 * disk refresh.
 *
 * `loadSessions()` merges by session id. ACP refreshes update persisted
 * metadata, while the renderer-owned provider/model selection remains
 * authoritative for sessions already present in memory.
 */
const REFRESH_INTERVAL_MS = 60_000;

export function useSessionListRefresh(): void {
  const refreshTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const refresh = useCallback(async () => {
    try {
      await useChatSessionStore.getState().loadSessions();
    } catch (error) {
      // `loadSessions` already logs its own failures; we swallow here so the
      // timer keeps firing on the next tick instead of getting torn down.
      console.error("Failed to refresh session list:", error);
    }
  }, []);

  useEffect(() => {
    refreshTimerRef.current = setInterval(refresh, REFRESH_INTERVAL_MS);

    const handleFocus = () => {
      void refresh();
    };
    window.addEventListener("focus", handleFocus);

    return () => {
      if (refreshTimerRef.current) {
        clearInterval(refreshTimerRef.current);
      }
      window.removeEventListener("focus", handleFocus);
    };
  }, [refresh]);
}

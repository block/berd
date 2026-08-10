import { useEffect } from "react";
import {
  AUTO_ARCHIVE_CHANGED_EVENT,
  getAutoArchiveAfterMs,
} from "@/features/settings/lib/autoArchivePreference";
import { useHomeWidgetStore } from "@/features/home/stores/homeWidgetStore";
import { getLayout, HOME_LAYOUT_ID } from "@/features/layout/api/layout";
import { loadAllSessionsForWorkspaceCleanup } from "@/features/chat/lib/sessionWorkspaceCleanup";
import {
  type ChatSession,
  useChatSessionStore,
} from "@/features/chat/stores/chatSessionStore";
import { getAutoArchiveSessionCandidates } from "../lib/autoArchiveSessions";

const AUTO_ARCHIVE_SWEEP_INTERVAL_MS = 60 * 60 * 1000;

interface AutoArchiveResult {
  ok: boolean;
}

interface RunAutoArchiveSweepOptions {
  archiveSession: (sessionId: string) => Promise<AutoArchiveResult>;
  nowMs?: number;
}

let sweepPromise: Promise<void> | null = null;

export async function runAutoArchiveSweep({
  archiveSession,
  nowMs = Date.now(),
}: RunAutoArchiveSweepOptions): Promise<void> {
  const afterMs = getAutoArchiveAfterMs();
  if (afterMs === null) return;

  // Pins live in the Home layout rather than on session metadata. Read the
  // durable layout so pins remain protected even when Home has not been opened
  // during this app launch, then include any optimistic in-memory pins too.
  const [sessions, homeLayout] = await Promise.all([
    loadAllSessionsForWorkspaceCleanup(),
    getLayout(HOME_LAYOUT_ID),
  ]);
  const persistedPinWidgets = homeLayout.items
    .filter((item) => item.kind === "session")
    .map((item) => ({ type: "chatPin", state: { sessionId: item.targetId } }));
  const homeWidgets = [
    ...persistedPinWidgets,
    ...useHomeWidgetStore.getState().instances,
  ];
  const sessionStore = useChatSessionStore.getState();
  const activeSessionId = sessionStore.activeSessionId;
  const localSessionsById = new Map(
    sessionStore.sessions.map((session) => [session.id, session]),
  );
  const candidates = getAutoArchiveSessionCandidates({
    sessions: sessions.map((session) => {
      const localSession = localSessionsById.get(session.id);
      return localSession
        ? ({ ...session, ...localSession } satisfies ChatSession)
        : session;
    }),
    homeWidgets,
    afterMs,
    nowMs,
  }).filter((session) => session.id !== activeSessionId);

  // Use the same serialized archive transaction as manual actions. The
  // noninteractive policy safely skips running chats and workspaces that would
  // require confirmation rather than interrupting work or discarding files.
  for (const session of candidates) {
    // The complete ACP list can include a paged-out session that is not yet in
    // the renderer store. Add its metadata so the shared archive transaction
    // can inspect and mutate it exactly like a currently visible chat.
    if (!useChatSessionStore.getState().getSession(session.id)) {
      useChatSessionStore.getState().addSession(session);
    }
    await archiveSession(session.id);
  }
}

export function useAutoArchiveSessions(
  archiveSession: (sessionId: string) => Promise<AutoArchiveResult>,
): void {
  useEffect(() => {
    let cancelled = false;

    const sweep = () => {
      if (cancelled || document.visibilityState === "hidden") return;
      if (sweepPromise) return;

      sweepPromise = runAutoArchiveSweep({ archiveSession })
        .catch((error) => {
          console.error(
            "Failed to automatically archive inactive chats:",
            error,
          );
        })
        .finally(() => {
          sweepPromise = null;
        });
    };
    const handleVisibilityChange = () => {
      if (document.visibilityState === "visible") sweep();
    };

    sweep();
    const intervalId = window.setInterval(
      sweep,
      AUTO_ARCHIVE_SWEEP_INTERVAL_MS,
    );
    window.addEventListener(AUTO_ARCHIVE_CHANGED_EVENT, sweep);
    document.addEventListener("visibilitychange", handleVisibilityChange);

    return () => {
      cancelled = true;
      window.clearInterval(intervalId);
      window.removeEventListener(AUTO_ARCHIVE_CHANGED_EVENT, sweep);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, [archiveSession]);
}

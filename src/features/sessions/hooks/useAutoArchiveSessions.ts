import { useEffect } from "react";
import { acpSessionToChatSession } from "@/features/chat/lib/acpSessionMapping";
import { useChatStore } from "@/features/chat/stores/chatStore";
import { useSessionWindowStore } from "@/features/chat/stores/sessionWindowStore";
import {
  isSessionRunning,
  sessionActivityAt,
} from "@/features/chat/lib/sessionActivity";
import { loadAllSessionsForWorkspaceCleanup } from "@/features/chat/lib/sessionWorkspaceCleanup";
import { acpGetSessionInfo } from "@/shared/api/acp";
import {
  type ChatSession,
  useChatSessionStore,
} from "@/features/chat/stores/chatSessionStore";
import { useHomeWidgetStore } from "@/features/home/stores/homeWidgetStore";
import { getLayout, HOME_LAYOUT_ID } from "@/features/layout/api/layout";
import {
  AUTO_ARCHIVE_CHANGED_EVENT,
  getAutoArchiveAfterMs,
} from "@/features/settings/lib/autoArchivePreference";
import {
  getAutoArchiveSessionCandidates,
  getPinnedChatSessionIds,
} from "../lib/autoArchiveSessions";

const AUTO_ARCHIVE_SWEEP_INTERVAL_MS = 60 * 60 * 1000;

interface AutoArchiveResult {
  ok: boolean;
}

type RevalidateAutoArchive = () => Promise<boolean>;

interface RunAutoArchiveSweepOptions {
  archiveSession: (
    session: ChatSession,
    revalidate: RevalidateAutoArchive,
  ) => Promise<AutoArchiveResult>;
  nowMs?: number;
}

interface PersistedChatPin {
  type: "chatPin";
  state: { sessionId: string };
}

let sweepPromise: Promise<void> | null = null;

function persistedChatPins(
  items: Awaited<ReturnType<typeof getLayout>>["items"],
): PersistedChatPin[] {
  return items
    .filter((item) => item.kind === "session")
    .map((item) => ({ type: "chatPin", state: { sessionId: item.targetId } }));
}

function hasLocalAutoArchiveBlocker(sessionId: string): boolean {
  const chatState = useChatStore.getState();
  const windowState = useSessionWindowStore.getState();
  const runtime = chatState.getSessionRuntime(sessionId);
  return (
    !windowState.hasLoadedSnapshot ||
    windowState.isOpenInWindow(sessionId) ||
    isSessionRunning(runtime.chatState) ||
    runtime.isRunCancellationPending ||
    chatState.nonEmptyDraftSessionIds.has(sessionId) ||
    (chatState.queuedMessageBySession[sessionId]?.length ?? 0) > 0 ||
    (chatState.skillDraftsBySession[sessionId]?.length ?? 0) > 0 ||
    (chatState.draftAttachmentsBySession[sessionId]?.length ?? 0) > 0
  );
}

async function revalidateAutoArchiveCandidate(
  originalSession: ChatSession,
): Promise<ChatSession | null> {
  const afterMs = getAutoArchiveAfterMs();
  if (afterMs === null) return null;

  const sessionStore = useChatSessionStore.getState();
  if (!useChatStore.getState().hasHydratedMessageQueues) return null;
  if (sessionStore.activeSessionId === originalSession.id) return null;
  if (sessionStore.archiveMutationBySessionId[originalSession.id]) return null;
  if (hasLocalAutoArchiveBlocker(originalSession.id)) return null;

  const sessionInfo = await acpGetSessionInfo(originalSession.id);
  const refreshedSession = sessionInfo
    ? acpSessionToChatSession(sessionInfo)
    : undefined;
  const localSession = sessionStore.getSession(originalSession.id);
  const latestSession = localSession
    ? ({ ...refreshedSession, ...localSession } satisfies ChatSession)
    : refreshedSession;
  if (!latestSession || latestSession.archivedAt) return null;

  const activityMs = Math.max(
    ...[refreshedSession, localSession]
      .filter((session): session is ChatSession => session !== undefined)
      .map((session) => Date.parse(sessionActivityAt(session)))
      .filter(Number.isFinite),
  );
  if (
    !Number.isFinite(activityMs) ||
    activityMs > Date.now() - afterMs ||
    getAutoArchiveAfterMs() === null
  ) {
    return null;
  }

  // Re-read both durable and optimistic pin state immediately before the
  // mutation. This closes the window where a user pins a later candidate while
  // an earlier archive transaction is still running.
  const latestHomeLayout = await getLayout(HOME_LAYOUT_ID);
  if (getAutoArchiveAfterMs() === null) return null;
  const pinnedSessionIds = getPinnedChatSessionIds([
    ...persistedChatPins(latestHomeLayout.items),
    ...useHomeWidgetStore.getState().instances,
  ]);
  if (pinnedSessionIds.has(originalSession.id)) return null;

  const latestSessionStore = useChatSessionStore.getState();
  if (
    latestSessionStore.activeSessionId === originalSession.id ||
    hasLocalAutoArchiveBlocker(originalSession.id) ||
    getAutoArchiveAfterMs() === null
  ) {
    return null;
  }

  return latestSessionStore.getSession(originalSession.id) ?? latestSession;
}

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
  if (getAutoArchiveAfterMs() === null) return;

  if (!useChatStore.getState().hasHydratedMessageQueues) return;
  const sessionStore = useChatSessionStore.getState();
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
    homeWidgets: [
      ...persistedChatPins(homeLayout.items),
      ...useHomeWidgetStore.getState().instances,
    ],
    afterMs,
    nowMs,
  });

  // Use the same serialized archive transaction as manual actions. Revalidate
  // every safety invariant at each turn because earlier candidates can spend
  // time in Git inspection and cleanup while the user keeps interacting.
  for (const candidate of candidates) {
    try {
      const currentSession = await revalidateAutoArchiveCandidate(candidate);
      if (!currentSession) continue;
      await archiveSession(currentSession, async () => {
        const revalidated =
          await revalidateAutoArchiveCandidate(currentSession);
        return revalidated !== null;
      });
    } catch (error) {
      console.error(
        `Failed to automatically archive chat ${candidate.id}:`,
        error,
      );
    }
  }
}

export function useAutoArchiveSessions(
  archiveSession: (
    session: ChatSession,
    revalidate: RevalidateAutoArchive,
  ) => Promise<AutoArchiveResult>,
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

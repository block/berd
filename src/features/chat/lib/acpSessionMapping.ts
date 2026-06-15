import type { AcpSessionInfo, AcpSessionsPage } from "@/shared/api/acp";
import type { ChatSession } from "@/features/chat/stores/chatSessionStore";
import { normalizeAcpTitle } from "@/features/chat/lib/sessionTitle";

interface SessionPageState {
  sessions: ChatSession[];
  sessionPageCursor: string | null;
  hasMoreSessions: boolean;
}

export function acpSessionToChatSession(session: AcpSessionInfo): ChatSession {
  const now = new Date().toISOString();
  return {
    id: session.sessionId,
    title: normalizeAcpTitle(session.title) ?? "Untitled",
    projectId: session.projectId ?? undefined,
    providerId: session.providerId ?? undefined,
    personaId: session.personaId ?? undefined,
    modelId: session.modelId ?? undefined,
    workingDir: session.workingDir ?? undefined,
    createdAt: session.createdAt ?? session.updatedAt ?? now,
    updatedAt: session.updatedAt ?? now,
    archivedAt: session.archivedAt ?? undefined,
    messageCount: session.messageCount,
    subtitle: session.subtitle ?? undefined,
    userSetName: session.userSetName,
  };
}

function sortByUpdatedAtDesc(sessions: ChatSession[]): ChatSession[] {
  return [...sessions].sort(
    (a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime(),
  );
}

function mergeSessionMetadata(
  existingSessions: ChatSession[],
  loadedSessions: ChatSession[],
): ChatSession[] {
  const byId = new Map<string, ChatSession>();

  for (const session of existingSessions) {
    byId.set(session.id, session);
  }

  for (const session of loadedSessions) {
    const existing = byId.get(session.id);
    const modelName =
      existing?.modelId === session.modelId ? existing?.modelName : undefined;
    byId.set(session.id, {
      ...existing,
      ...session,
      modelName,
      creationState: undefined,
      creationError: undefined,
    });
  }

  return sortByUpdatedAtDesc([...byId.values()]);
}

export function mergeAcpSessionPage(
  state: Pick<SessionPageState, "sessions">,
  page: AcpSessionsPage,
  previousCursor: string | null,
): SessionPageState {
  const { nextCursor } = page;
  const repeatedCursor =
    nextCursor != null &&
    previousCursor != null &&
    nextCursor === previousCursor;
  if (repeatedCursor) {
    console.warn(
      "ACP session/list returned the same pagination cursor; stopping pagination to avoid an infinite loop.",
    );
  }
  const hasMoreSessions = nextCursor != null && !repeatedCursor;

  return {
    sessions: mergeSessionMetadata(
      state.sessions,
      page.sessions.map(acpSessionToChatSession),
    ),
    sessionPageCursor: hasMoreSessions ? nextCursor : null,
    hasMoreSessions,
  };
}

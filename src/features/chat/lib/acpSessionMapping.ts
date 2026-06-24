import type { AcpSessionInfo, AcpSessionsPage } from "@/shared/api/acp";
import type {
  ArchiveMutationBySessionId,
  ArchiveSessionMutation,
  ChatSession,
} from "@/features/chat/stores/chatSessionStore";
import { normalizeAcpTitle } from "@/features/chat/lib/sessionTitle";

interface SessionPageState {
  sessions: ChatSession[];
  archiveMutationBySessionId: ArchiveMutationBySessionId;
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
  archiveMutationBySessionId: ArchiveMutationBySessionId,
): Pick<SessionPageState, "sessions" | "archiveMutationBySessionId"> {
  const byId = new Map<string, ChatSession>();
  const mutationConfirmationBySessionId = new Map<string, boolean>();

  for (const session of existingSessions) {
    byId.set(session.id, session);
  }

  for (const loadedSession of loadedSessions) {
    const mutation = archiveMutationBySessionId[loadedSession.id];
    const confirmed = mutation
      ? isArchiveMutationConfirmed(loadedSession, mutation)
      : false;
    const session = mutation
      ? reconcileArchiveMutation(loadedSession, mutation, confirmed)
      : loadedSession;
    if (mutation) {
      mutationConfirmationBySessionId.set(session.id, confirmed);
    }

    const existing = byId.get(loadedSession.id);
    const modelName =
      existing?.modelId === session.modelId ? existing?.modelName : undefined;
    const personaId = session.personaId ?? existing?.personaId;
    byId.set(session.id, {
      ...existing,
      ...session,
      personaId,
      modelName,
      creationState: undefined,
      creationError: undefined,
    });
  }

  let nextArchiveMutationBySessionId = archiveMutationBySessionId;
  for (const [sessionId, confirmed] of mutationConfirmationBySessionId) {
    if (!confirmed) continue;
    // Succeeded mutations stay until this exact row confirms, so paged-out
    // sessions remain protected from later stale loadMore rows.
    if (nextArchiveMutationBySessionId === archiveMutationBySessionId) {
      nextArchiveMutationBySessionId = { ...archiveMutationBySessionId };
    }
    delete nextArchiveMutationBySessionId[sessionId];
  }

  return {
    sessions: sortByUpdatedAtDesc([...byId.values()]),
    archiveMutationBySessionId: nextArchiveMutationBySessionId,
  };
}

function isArchiveMutationConfirmed(
  session: ChatSession,
  mutation: ArchiveSessionMutation,
): boolean {
  if (mutation.status !== "succeeded") {
    return false;
  }
  if (mutation.desiredState === "archived") {
    return session.archivedAt !== undefined;
  }
  return session.archivedAt === undefined;
}

function reconcileArchiveMutation(
  session: ChatSession,
  mutation: ArchiveSessionMutation,
  confirmed: boolean,
): ChatSession {
  if (confirmed) {
    return session;
  }
  // Local intent wins over conflicting ACP list data; ACP does not expose a
  // version that distinguishes stale pages from another client flipping state.
  return {
    ...session,
    archivedAt:
      mutation.desiredState === "archived"
        ? mutation.optimisticArchivedAt
        : undefined,
  };
}

export function mergeAcpSessionPage(
  state: Pick<SessionPageState, "sessions" | "archiveMutationBySessionId">,
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
  const merged = mergeSessionMetadata(
    state.sessions,
    page.sessions.map(acpSessionToChatSession),
    state.archiveMutationBySessionId,
  );

  return {
    sessions: merged.sessions,
    archiveMutationBySessionId: merged.archiveMutationBySessionId,
    sessionPageCursor: hasMoreSessions ? nextCursor : null,
    hasMoreSessions,
  };
}

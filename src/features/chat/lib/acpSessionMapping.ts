import type { AcpSessionInfo, AcpSessionsPage } from "@/shared/api/acp";
import type {
  ArchiveMutationBySessionId,
  ArchiveSessionMutation,
  ChatSession,
} from "@/features/chat/stores/chatSessionStore";
import { compareSessionsByActivityDesc } from "@/features/chat/lib/sessionActivity";
import { normalizeAcpTitle } from "@/features/chat/lib/sessionTitle";
import { withWorkspaceBackfill } from "@/features/chat/lib/workspaceAttachments";
import { loadPersistedChatWorkspaceMetadata } from "@/features/chat/stores/workspaceAttachmentPersistence";
import { executionTargetFromGooseServeSession } from "@/features/chat/lib/gooseServeExecutionTarget";

interface SessionPageState {
  sessions: ChatSession[];
  archiveMutationBySessionId: ArchiveMutationBySessionId;
  sessionPageCursor: string | null;
  hasMoreSessions: boolean;
}

export function acpSessionToChatSession(session: AcpSessionInfo): ChatSession {
  const persistedWorkspaceMetadata = loadPersistedChatWorkspaceMetadata(
    session.sessionId,
  );
  return withWorkspaceBackfill({
    ...chatSessionFromAcpInfo(session),
    workspaceAttachments: persistedWorkspaceMetadata?.workspaceAttachments,
    activeWorkspaceId: persistedWorkspaceMetadata?.activeWorkspaceId,
  });
}

/**
 * The ACP→ChatSession field mapping without workspace hydration or backfill.
 * Transient rows (server-discovered search results) skip both: the
 * localStorage read is wasted on sessions this renderer never opened, and the
 * workingDir backfill invents attachments for sessions that exist only as
 * search rows.
 */
export function chatSessionFromAcpInfo(session: AcpSessionInfo): ChatSession {
  const now = new Date().toISOString();
  const executionTarget = executionTargetFromGooseServeSession({
    providerId: session.providerId ?? undefined,
    modelId: session.modelId ?? undefined,
  });
  return {
    id: session.sessionId,
    title: normalizeAcpTitle(session.title) ?? "Untitled",
    projectId: session.projectId ?? undefined,
    executionTarget,
    executionTargetSource: executionTarget ? "acp" : undefined,
    personaId: session.personaId ?? undefined,
    workingDir: session.workingDir ?? undefined,
    createdAt: session.createdAt ?? session.updatedAt ?? now,
    updatedAt: session.updatedAt ?? now,
    lastMessageAt: session.lastMessageAt ?? undefined,
    archivedAt: session.archivedAt ?? undefined,
    messageCount: session.messageCount,
    subtitle: session.subtitle ?? undefined,
    userSetName: session.userSetName,
  };
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
    // ACP list/get metadata is discovery state. Once the renderer owns a
    // provider/model selection, preserve the complete tuple so an older list
    // response cannot replace a newer picker choice. A selection-less pinned
    // placeholder still hydrates from ACP on first resolution.
    const preserveUiTarget = existing?.executionTargetSource === "ui";
    const executionTarget = preserveUiTarget
      ? existing.executionTarget
      : session.executionTarget;
    const executionTargetSource = preserveUiTarget
      ? existing.executionTargetSource
      : session.executionTargetSource;
    const personaId = session.personaId ?? existing?.personaId;
    byId.set(
      session.id,
      withWorkspaceBackfill({
        ...existing,
        ...session,
        executionTarget,
        executionTargetSource,
        personaId,
        workspaceAttachments:
          existing?.workspaceAttachments ?? session.workspaceAttachments,
        activeWorkspaceId:
          existing?.activeWorkspaceId ?? session.activeWorkspaceId,
        creationState: undefined,
        creationError: undefined,
      }),
    );
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
    sessions: [...byId.values()].sort(compareSessionsByActivityDesc),
    archiveMutationBySessionId: nextArchiveMutationBySessionId,
  };
}

export function mergeAcpSessionInfo(
  state: Pick<SessionPageState, "sessions" | "archiveMutationBySessionId">,
  session: AcpSessionInfo,
): Pick<SessionPageState, "sessions" | "archiveMutationBySessionId"> {
  return mergeSessionMetadata(
    state.sessions,
    [acpSessionToChatSession(session)],
    state.archiveMutationBySessionId,
  );
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

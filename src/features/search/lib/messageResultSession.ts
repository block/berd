import {
  remoteHostFromBackendId,
  splitCompositeSessionId,
} from "@/shared/api/acpBackendId";
import type {
  ArchiveMutationBySessionId,
  ChatSession,
} from "@/features/chat/stores/chatSessionStore";
import type { MessageSearchResult } from "@/shared/api/messageSearch";

/** Keep local workspace fields, refreshed archive metadata and current archive
 * mutation intent when hydrating a message result into the native session UI. */
export function messageResultSession(
  result: MessageSearchResult,
  sessions: ChatSession[],
  archiveMutations: ArchiveMutationBySessionId = {},
): ChatSession {
  const loaded = sessions.find((session) => session.id === result.sessionId);
  if (loaded)
    return {
      ...loaded,
      archivedAt: archiveMutations[result.sessionId]
        ? loaded.archivedAt
        : (result.archivedAt ?? undefined),
    };
  const composite = splitCompositeSessionId(result.sessionId);
  return {
    id: result.sessionId,
    title: result.title,
    archivedAt: result.archivedAt ?? undefined,
    workingDir: result.workingDir,
    remoteHost: composite
      ? (remoteHostFromBackendId(composite.backendId) ?? undefined)
      : undefined,
    createdAt: result.messageCreatedAt,
    updatedAt: result.updatedAt,
    lastMessageAt: result.lastMessageAt ?? result.updatedAt,
    messageCount: result.messageIndex + 1,
  };
}

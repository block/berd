import { useMemo } from "react";
import { useAgentStore } from "@/features/agents/stores/agentStore";
import { useProjectStore } from "@/features/projects/stores/projectStore";
import { selectProjects } from "@/features/projects/stores/projectSelectors";
import { resolveProjectDefaultArtifactRoot } from "@/features/projects/lib/chatProjectContext";
import { useWorkspaceRepository } from "@/features/workspaces/workspaceRepository";
import { useChatStore } from "@/features/chat/stores/chatStore";
import { useChatSessionStore } from "@/features/chat/stores/chatSessionStore";
import { INITIAL_SESSION_CHAT_RUNTIME } from "@/shared/types/chat";
import type { Message } from "@/shared/types/messages";

const EMPTY_MESSAGES: Message[] = [];

/**
 * Read-only, session-addressed data for transcript presentations.
 * This deliberately excludes preparation, queue, draft, and dispatch behavior.
 */
export function useChatTranscriptReadModel(sessionId: string) {
  const session = useChatSessionStore((state) => state.getSession(sessionId));
  const activeWorkspace = useChatSessionStore(
    (state) => state.activeWorkspaceBySession[sessionId],
  );
  const messages = useChatStore(
    (state) => state.messagesBySession[sessionId] ?? EMPTY_MESSAGES,
  );
  const runtime = useChatStore(
    (state) =>
      state.sessionStateById[sessionId] ?? INITIAL_SESSION_CHAT_RUNTIME,
  );
  const isLoadingHistory = useChatStore((state) =>
    state.loadingSessionIds.has(sessionId),
  );
  const selectedPersona = useAgentStore((state) =>
    session?.personaId ? state.getPersonaById(session.personaId) : undefined,
  );
  const projects = useProjectStore(selectProjects);
  const project = session?.projectId
    ? projects.find((candidate) => candidate.id === session.projectId)
    : undefined;
  const workspaceRepository = useWorkspaceRepository();
  const sessionArtifactCwd = useMemo(() => {
    const workspacePath = workspaceRepository.chatWorkspaces(session, {
      activePath: activeWorkspace?.path,
    }).primary?.path;
    return (
      workspacePath?.trim() ||
      resolveProjectDefaultArtifactRoot(project)?.trim() ||
      null
    );
  }, [activeWorkspace?.path, project, session, workspaceRepository]);

  return {
    session,
    messages,
    runtime,
    isLoadingHistory,
    selectedPersona,
    sessionArtifactCwd,
  };
}

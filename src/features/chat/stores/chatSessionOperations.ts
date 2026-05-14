import {
  DEFAULT_PROVIDER,
  renameSession,
  updateSessionProject as updateSessionProjectApi,
} from "@/shared/api/acpApi";
import type { ProjectInfo } from "@/features/projects/api/projects";
import { useProjectStore } from "@/features/projects/stores/projectStore";
import { resolveSessionCwd } from "@/features/projects/lib/sessionCwdSelection";
import { applyLatestSessionConfig } from "@/features/chat/lib/sessionConfigRequests";
import {
  useChatSessionStore,
  type ChatSession,
  type ModelSelectionIntent,
} from "./chatSessionStore";

export async function updateSessionTitle(
  sessionId: string,
  title: string,
): Promise<void> {
  await renameSession(sessionId, title);

  useChatSessionStore.getState().patchSession(sessionId, {
    title,
    userSetName: true,
  });
}

export async function updateSessionProject(
  sessionId: string,
  projectId: string | null,
): Promise<void> {
  await updateSessionProjectApi(sessionId, projectId);

  useChatSessionStore.getState().patchSession(sessionId, {
    projectId,
  });
}

interface MoveSessionToProjectOptions {
  providerId?: string | null;
  activeWorkspacePath?: string | null;
  modelId?: string | null;
}

interface SessionModelConfig {
  id: string;
  name: string;
  providerId?: string;
  requestId?: string;
}

let nextProjectMoveSequence = 0;
const projectMoveSequenceBySession = new Map<string, number>();

function findProject(projectId: string | null): ProjectInfo | null {
  if (projectId == null) {
    return null;
  }

  return (
    useProjectStore
      .getState()
      .projects.find((project) => project.id === projectId) ?? null
  );
}

function beginProjectMove(sessionId: string): number {
  nextProjectMoveSequence += 1;
  projectMoveSequenceBySession.set(sessionId, nextProjectMoveSequence);
  return nextProjectMoveSequence;
}

function isCurrentProjectMove(sessionId: string, sequence: number): boolean {
  return projectMoveSequenceBySession.get(sessionId) === sequence;
}

function completeProjectMove(sessionId: string, sequence: number): void {
  if (isCurrentProjectMove(sessionId, sequence)) {
    projectMoveSequenceBySession.delete(sessionId);
  }
}

function getSessionModelConfig(
  session: ChatSession,
  intent: ModelSelectionIntent | undefined,
  fallbackModelId: string | null | undefined,
): SessionModelConfig | null {
  if (intent?.kind === "model" && intent.modelId) {
    return {
      id: intent.modelId,
      name: intent.modelName ?? intent.modelId,
      providerId: intent.providerId,
      requestId: intent.requestId,
    };
  }

  const modelId = fallbackModelId ?? session.modelId;
  if (!modelId) {
    return null;
  }

  return {
    id: modelId,
    name: session.modelName ?? modelId,
    providerId: session.providerId,
  };
}

function isCurrentModelConfig(
  sessionId: string,
  providerId: string,
  modelConfig: SessionModelConfig | null,
): boolean {
  if (!modelConfig) {
    return true;
  }

  const store = useChatSessionStore.getState();
  const liveIntent = store.getModelSelectionIntent(sessionId);
  if (modelConfig.requestId) {
    if (liveIntent) {
      return liveIntent.requestId === modelConfig.requestId;
    }
    const liveSession = store.getSession(sessionId);
    return (
      liveSession?.providerId === providerId &&
      liveSession.modelId === modelConfig.id
    );
  }

  if (liveIntent) {
    return false;
  }

  const liveSession = store.getSession(sessionId);
  return (
    liveSession?.providerId === providerId &&
    liveSession.modelId === modelConfig.id
  );
}

export async function moveSessionToProject(
  sessionId: string,
  projectId: string | null,
  options: MoveSessionToProjectOptions = {},
): Promise<void> {
  const moveSequence = beginProjectMove(sessionId);
  const sessionStore = useChatSessionStore.getState();
  const session = sessionStore.getSession(sessionId);
  if (!session) {
    completeProjectMove(sessionId, moveSequence);
    return;
  }

  const nextProject = findProject(projectId);

  try {
    await updateSessionProjectApi(sessionId, projectId);
    if (!isCurrentProjectMove(sessionId, moveSequence)) {
      return;
    }

    const liveSession = useChatSessionStore.getState().getSession(sessionId);
    if (!liveSession) {
      return;
    }
    const providerId =
      liveSession.providerId ?? options.providerId ?? DEFAULT_PROVIDER.id;
    const modelConfig = getSessionModelConfig(
      liveSession,
      useChatSessionStore.getState().getModelSelectionIntent(sessionId),
      options.modelId,
    );
    const modelId =
      modelConfig?.providerId && modelConfig.providerId !== providerId
        ? undefined
        : modelConfig?.id;
    const appliedModelConfig = modelId ? modelConfig : null;

    useChatSessionStore.getState().patchSession(sessionId, { projectId });

    const workingDir = await resolveSessionCwd(
      nextProject,
      options.activeWorkspacePath,
    );
    if (
      !isCurrentProjectMove(sessionId, moveSequence) ||
      !isCurrentModelConfig(sessionId, providerId, appliedModelConfig)
    ) {
      return;
    }

    const result = await applyLatestSessionConfig({
      sessionId,
      providerId,
      workingDir,
      modelId,
    });

    if (
      !result.applied ||
      !isCurrentProjectMove(sessionId, moveSequence) ||
      !isCurrentModelConfig(sessionId, providerId, appliedModelConfig)
    ) {
      return;
    }

    useChatSessionStore.getState().patchSession(
      sessionId,
      modelId
        ? {
            workingDir,
            modelId,
            modelName: appliedModelConfig?.name ?? modelId,
          }
        : { workingDir },
    );
  } finally {
    completeProjectMove(sessionId, moveSequence);
  }
}

import {
  renameSession,
  updateSessionProject as updateSessionProjectApi,
} from "@/shared/api/acpApi";
import { useChatSessionStore } from "./chatSessionStore";

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

let nextProjectMoveSequence = 0;
const projectMoveSequenceBySession = new Map<string, number>();

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

export async function moveSessionToProject(
  sessionId: string,
  projectId: string | null,
): Promise<void> {
  const moveSequence = beginProjectMove(sessionId);
  const sessionStore = useChatSessionStore.getState();
  const session = sessionStore.getSession(sessionId);
  if (!session) {
    completeProjectMove(sessionId, moveSequence);
    return;
  }

  try {
    await updateSessionProjectApi(sessionId, projectId);
    if (!isCurrentProjectMove(sessionId, moveSequence)) {
      return;
    }

    const liveSession = useChatSessionStore.getState().getSession(sessionId);
    if (!liveSession) {
      return;
    }

    useChatSessionStore.getState().patchSession(sessionId, { projectId });
  } finally {
    completeProjectMove(sessionId, moveSequence);
  }
}

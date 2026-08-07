import { useAgentStore } from "@/features/agents/stores/agentStore";
import { listPersonas } from "@/shared/api/agents";
import type { Persona } from "@/shared/types/agents";
import { listProjects } from "@/features/projects/api/projects";
import { useProjectStore } from "@/features/projects/stores/projectStore";
import { resolveSessionCwd } from "@/features/projects/lib/sessionCwdSelection";
import { listSkills } from "@/features/skills/api/skills";
import { formatAvailableSkillsCatalogPrompt } from "@/features/skills/lib/skillChatPrompt";
import { composeSystemPrompt } from "@/features/projects/lib/chatProjectContext";

import { loadWorkspaceInstructionFiles } from "@/features/chat/api/workspaceContext";
import { sendPromptInBackground } from "@/features/chat/lib/backgroundSend";
import { loadSessionMessages } from "@/features/chat/lib/sessionActivation";
import { transitionSessionTarget } from "@/features/chat/lib/sessionTargetCoordinator";
import { applyPendingSessionWorkspaceActivation } from "@/features/chat/lib/sessionWorkspaceActivation";
import {
  formatIncludedWorkspacesPrompt,
  getWorkspaceAttachments,
} from "@/features/chat/lib/workspaceAttachments";
import { formatWorkspaceInstructionsPrompt } from "@/features/chat/lib/workspaceContextPrompt";
import {
  type ChatSession,
  useChatSessionStore,
} from "@/features/chat/stores/chatSessionStore";
import type { QueuedMessageRecord } from "@/features/chat/stores/chatStore";
import {
  sameSessionExecutionTarget,
  type SessionExecutionTarget,
} from "@/features/chat/lib/sessionExecutionTarget";
import { gooseServeSelectionFromExecutionTarget } from "@/features/chat/lib/gooseServeExecutionTarget";

async function findPersona(personaId: string): Promise<Persona> {
  const cached = useAgentStore.getState().getPersonaById(personaId);
  if (cached) {
    return cached;
  }

  const personas = await listPersonas();
  useAgentStore.getState().setPersonas(personas);
  const persona = personas.find((candidate) => candidate.id === personaId);
  if (!persona) {
    throw new Error(`No agent "${personaId}".`);
  }
  return persona;
}

function targetMatchesOrMaterializes(
  actual: SessionExecutionTarget | undefined,
  expected: SessionExecutionTarget,
): boolean {
  return (
    sameSessionExecutionTarget(actual, expected) ||
    (expected.modelId === undefined &&
      actual?.harnessId === expected.harnessId &&
      actual.modelProviderId === expected.modelProviderId)
  );
}

function assertSessionExecutionTarget(
  sessionId: string,
  expectedTarget: SessionExecutionTarget,
): void {
  if (
    targetMatchesOrMaterializes(
      useChatSessionStore.getState().getSession(sessionId)?.executionTarget,
      expectedTarget,
    )
  ) {
    return;
  }
  throw new Error("Session preparation was superseded by a newer selection.");
}

function hasUiOwnedUnresolvedTarget(session?: ChatSession): boolean {
  return session?.executionTargetSource === "ui" && !session.executionTarget;
}

export async function prepareExistingSessionForBackgroundSend(
  sessionId: string,
  options: {
    preserveWorkingDir?: boolean;
    executionTarget?: SessionExecutionTarget;
  } = {},
): Promise<{
  providerId: string;
  executionTarget: SessionExecutionTarget;
  persona?: Pick<Persona, "id" | "displayName" | "systemPrompt">;
}> {
  const loaded = await loadSessionMessages(sessionId);
  if (!loaded) {
    throw new Error("Failed to load the target session before sending.");
  }

  await applyPendingSessionWorkspaceActivation(sessionId);
  const session = useChatSessionStore.getState().getSession(sessionId);
  if (!session) {
    throw new Error(`No session "${sessionId}".`);
  }
  const [project, persona] = await Promise.all([
    session.projectId
      ? listProjects().then((projects) => {
          useProjectStore.getState().replaceProjectsFromBackend(projects);
          const match = projects.find(
            (candidate) => candidate.id === session.projectId,
          );
          if (!match) {
            throw new Error(`No project "${session.projectId}".`);
          }
          return match;
        })
      : null,
    session.personaId ? findPersona(session.personaId) : null,
  ]);
  const activeWorkspacePath = options.preserveWorkingDir
    ? session.workingDir
    : (useChatSessionStore.getState().activeWorkspaceBySession[sessionId]
        ?.path ?? session.workingDir);
  const workingDir = await resolveSessionCwd(project, activeWorkspacePath);
  const liveSessionAtSubmit = useChatSessionStore
    .getState()
    .getSession(sessionId);
  const liveTargetAtSubmit = liveSessionAtSubmit?.executionTarget;
  if (
    options.executionTarget &&
    (hasUiOwnedUnresolvedTarget(liveSessionAtSubmit) ||
      (liveTargetAtSubmit &&
        !sameSessionExecutionTarget(
          options.executionTarget,
          liveTargetAtSubmit,
        )))
  ) {
    throw new Error("Session preparation was superseded by a newer selection.");
  }
  const executionTarget = options.executionTarget ?? liveTargetAtSubmit;
  if (!executionTarget) {
    throw new Error(
      "Select a model before sending to this unresolved session.",
    );
  }
  const { providerId } =
    gooseServeSelectionFromExecutionTarget(executionTarget);
  if (!providerId) {
    throw new Error("Session execution target requires a provider boundary.");
  }

  const result = await transitionSessionTarget({
    sessionId,
    target: executionTarget,
    workingDir,
  });
  if (!result.applied) {
    throw new Error("Session preparation was superseded by a newer selection.");
  }
  const preparedExecutionTarget = result.target;
  const { providerId: resolvedProviderId } =
    gooseServeSelectionFromExecutionTarget(preparedExecutionTarget);
  if (!resolvedProviderId) {
    throw new Error("Session execution target requires a provider boundary.");
  }
  return {
    providerId: resolvedProviderId,
    executionTarget: preparedExecutionTarget,
    persona: persona ?? undefined,
  };
}

export async function sendQueuedPromptToExistingSessionInBackground(
  sessionId: string,
  queuedMessage: QueuedMessageRecord & { kind: "transport-ready" },
  beforeUserMessageCommitted?: () => void,
  onUserMessageCommitted?: () => void,
): Promise<void> {
  const { payload } = queuedMessage;
  const payloadPersona = payload.personaId
    ? await findPersona(payload.personaId)
    : undefined;
  const {
    providerId,
    executionTarget: preparedExecutionTarget,
    persona: sessionPersona,
  } = await prepareExistingSessionForBackgroundSend(sessionId, {
    preserveWorkingDir: queuedMessage.releasedFromDeferred,
    ...(payload.executionTarget
      ? { executionTarget: payload.executionTarget }
      : {}),
  });
  const persona = payloadPersona ?? sessionPersona;
  const session = useChatSessionStore.getState().getSession(sessionId);
  const sendOptions = payload.sendOptions ?? {};
  const workspacePaths = session
    ? getWorkspaceAttachments(session)
        .filter((attachment) => attachment.source !== "excluded")
        .map((attachment) => attachment.path)
    : [];
  const [instructionFiles, skills] = await Promise.all([
    loadWorkspaceInstructionFiles(workspacePaths).catch((error) => {
      console.warn(
        "Failed to load workspace instructions for queued send:",
        error,
      );
      return [];
    }),
    listSkills(workspacePaths, { providerId }).catch((error) => {
      console.warn("Failed to list skills for queued send:", error);
      return [];
    }),
  ]);
  const workspaceContextPrompt = session
    ? composeSystemPrompt(
        formatIncludedWorkspacesPrompt(session),
        formatWorkspaceInstructionsPrompt(instructionFiles),
        formatAvailableSkillsCatalogPrompt(skills),
      )
    : undefined;
  assertSessionExecutionTarget(sessionId, preparedExecutionTarget);
  await sendPromptInBackground(
    sessionId,
    payload.text,
    providerId,
    persona ?? undefined,
    {
      ...sendOptions,
      systemPrompt: sendOptions.systemPrompt ?? workspaceContextPrompt,
    },
    payload.attachments,
    beforeUserMessageCommitted,
    onUserMessageCommitted,
    () => assertSessionExecutionTarget(sessionId, preparedExecutionTarget),
  );
}

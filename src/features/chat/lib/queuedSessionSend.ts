import { resolvePersonaProvider } from "@/features/agents/lib/resolvePersonaProvider";
import { useAgentStore } from "@/features/agents/stores/agentStore";
import { listPersonas } from "@/shared/api/agents";
import type { Persona } from "@/shared/types/agents";
import { listProjects } from "@/features/projects/api/projects";
import { useProjectStore } from "@/features/projects/stores/projectStore";
import { resolveSessionCwd } from "@/features/projects/lib/sessionCwdSelection";
import { GOOSE_PROVIDER_ID } from "@/shared/api/acpPersonaHandoff";
import { listSkills } from "@/features/skills/api/skills";
import { formatAvailableSkillsCatalogPrompt } from "@/features/skills/lib/skillChatPrompt";
import { composeSystemPrompt } from "@/features/projects/lib/chatProjectContext";

import { loadWorkspaceInstructionFiles } from "@/features/chat/api/workspaceContext";
import { sendPromptInBackground } from "@/features/chat/lib/backgroundSend";
import { loadSessionMessages } from "@/features/chat/lib/sessionActivation";
import { applyLatestSessionConfig } from "@/features/chat/lib/sessionConfigRequests";
import {
  formatIncludedWorkspacesPrompt,
  getWorkspaceAttachments,
} from "@/features/chat/lib/workspaceAttachments";
import { formatWorkspaceInstructionsPrompt } from "@/features/chat/lib/workspaceContextPrompt";
import { useChatSessionStore } from "@/features/chat/stores/chatSessionStore";
import type { QueuedMessageRecord } from "@/features/chat/stores/chatStore";

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

export async function prepareExistingSessionForBackgroundSend(
  sessionId: string,
  options: {
    preserveWorkingDir?: boolean;
    providerId?: string;
    modelId?: string;
  } = {},
): Promise<{
  providerId: string;
  persona?: Pick<Persona, "id" | "displayName" | "systemPrompt">;
}> {
  const loaded = await loadSessionMessages(sessionId);
  if (!loaded) {
    throw new Error("Failed to load the target session before sending.");
  }

  const session = useChatSessionStore.getState().getSession(sessionId);
  if (!session) {
    throw new Error(`No session "${sessionId}".`);
  }
  const providerId =
    options.providerId ?? session.providerId ?? GOOSE_PROVIDER_ID;
  const modelId = options.modelId ?? session.modelId;
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

  const result = await applyLatestSessionConfig({
    sessionId,
    providerId,
    workingDir,
    modelId,
  });
  if (!result.applied) {
    throw new Error("Session preparation was superseded by a newer request.");
  }
  useChatSessionStore.getState().patchSession(sessionId, {
    workingDir,
    providerId,
    ...(modelId ? { modelId, modelName: modelId } : {}),
  });
  return { providerId, persona: persona ?? undefined };
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
  const personaProvider = resolvePersonaProvider(
    payloadPersona,
    useAgentStore.getState().providers,
  );
  const { providerId, persona: sessionPersona } =
    await prepareExistingSessionForBackgroundSend(sessionId, {
      preserveWorkingDir: queuedMessage.releasedFromDeferred,
      ...(personaProvider ? { providerId: personaProvider.id } : {}),
      ...(personaProvider && payloadPersona?.model
        ? { modelId: payloadPersona.model }
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
  );
}

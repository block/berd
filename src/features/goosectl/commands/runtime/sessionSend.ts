import { applyLatestSessionConfig } from "@/features/chat/lib/sessionConfigRequests";
import { sendPromptInBackground } from "@/features/chat/lib/backgroundSend";
import type { QueuedMessage } from "@/features/chat/stores/chatStore";
import { useChatSessionStore } from "@/features/chat/stores/chatSessionStore";
import { resolveSessionCwd } from "@/features/projects/lib/sessionCwdSelection";
import { GOOSE_PROVIDER_ID } from "@/shared/api/acpPersonaHandoff";
import type { Persona } from "@/shared/types/agents";
import type { MessageMetadata } from "@/shared/types/messages";
import type { ChatSendOptions } from "@/features/chat/types";

import { findPersonaOrThrow } from "./agents";
import { findProjectOrThrow } from "./projects";
import { requireSession } from "./sessions";

export const GOOSECTL_CROSS_SESSION_ORIGIN =
  "goosectl_cross_session" satisfies NonNullable<MessageMetadata["origin"]>;

export function goosectlCrossSessionSendOptions(): ChatSendOptions {
  return {
    userMessageMetadata: {
      origin: GOOSECTL_CROSS_SESSION_ORIGIN,
    },
    acpGooseMetadata: {
      origin: GOOSECTL_CROSS_SESSION_ORIGIN,
    },
  };
}

export function isGoosectlCrossSessionQueuedMessage(
  message: QueuedMessage | undefined,
): boolean {
  return (
    message?.sendOptions?.userMessageMetadata?.origin ===
    GOOSECTL_CROSS_SESSION_ORIGIN
  );
}

async function prepareExistingSessionForGoosectlSend(
  sessionId: string,
): Promise<{
  providerId: string;
  persona?: Pick<Persona, "id" | "displayName" | "systemPrompt">;
}> {
  const session = requireSession(sessionId);
  const providerId = session.providerId ?? GOOSE_PROVIDER_ID;

  const [project, persona] = await Promise.all([
    session.projectId ? findProjectOrThrow(session.projectId) : null,
    session.personaId ? findPersonaOrThrow(session.personaId) : null,
  ]);

  const activeWorkspacePath =
    useChatSessionStore.getState().activeWorkspaceBySession[sessionId]?.path ??
    session.workingDir;
  const workingDir = await resolveSessionCwd(project, activeWorkspacePath);
  const result = await applyLatestSessionConfig({
    sessionId,
    providerId,
    workingDir,
    modelId: session.modelId,
  });
  if (!result.applied) {
    throw new Error("Session preparation was superseded by a newer request.");
  }
  useChatSessionStore.getState().patchSession(sessionId, { workingDir });
  return {
    providerId,
    persona: persona ?? undefined,
  };
}

export async function sendPromptToExistingSessionInBackground(
  sessionId: string,
  prompt: string,
): Promise<void> {
  const { providerId, persona } =
    await prepareExistingSessionForGoosectlSend(sessionId);
  sendPromptInBackground(
    sessionId,
    prompt,
    providerId,
    persona,
    goosectlCrossSessionSendOptions(),
  );
}

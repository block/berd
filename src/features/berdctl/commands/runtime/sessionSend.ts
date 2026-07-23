import { sendPromptInBackground } from "@/features/chat/lib/backgroundSend";
import { loadSessionMessages } from "@/features/chat/lib/sessionActivation";
import { applyLatestSessionConfig } from "@/features/chat/lib/sessionConfigRequests";
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

export const BERDCTL_CROSS_SESSION_ORIGIN =
  "berdctl_cross_session" satisfies NonNullable<MessageMetadata["origin"]>;

export function berdctlCrossSessionSendOptions(): ChatSendOptions {
  return {
    userMessageMetadata: {
      origin: BERDCTL_CROSS_SESSION_ORIGIN,
    },
    acpGooseMetadata: {
      origin: BERDCTL_CROSS_SESSION_ORIGIN,
    },
  };
}

export function isBerdctlCrossSessionQueuedMessage(
  message: QueuedMessage | undefined,
): boolean {
  return (
    message?.sendOptions?.userMessageMetadata?.origin ===
    BERDCTL_CROSS_SESSION_ORIGIN
  );
}

async function prepareExistingSessionForBerdctlSend(
  sessionId: string,
): Promise<{
  providerId: string;
  persona?: Pick<Persona, "id" | "displayName" | "systemPrompt">;
}> {
  // The first preparation of an existing ACP session replays its persisted
  // transcript. Use the normal history loader so those notifications stay in
  // the replay buffer and are committed atomically before the injected prompt.
  // Preparing directly would classify them as live updates and make an old
  // session visibly replay at streaming speed when berd-monitor wakes it.
  const loaded = await loadSessionMessages(sessionId);
  if (!loaded) {
    throw new Error("Failed to load the target session before sending.");
  }

  // Pinned history loading can refresh the session's provider, model, persona,
  // project, and cwd. Resolve all preparation inputs from that refreshed row.
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
    await prepareExistingSessionForBerdctlSend(sessionId);
  sendPromptInBackground(
    sessionId,
    prompt,
    providerId,
    persona,
    berdctlCrossSessionSendOptions(),
  );
}

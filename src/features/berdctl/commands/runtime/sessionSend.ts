import { sendPromptInBackground } from "@/features/chat/lib/backgroundSend";
import { prepareExistingSessionForBackgroundSend } from "@/features/chat/lib/queuedSessionSend";
import { useChatSessionStore } from "@/features/chat/stores/chatSessionStore";
export { sendQueuedPromptToExistingSessionInBackground } from "@/features/chat/lib/queuedSessionSend";
import { formatIncludedWorkspacesPrompt } from "@/features/chat/lib/workspaceAttachments";
import type { QueuedMessageRecord } from "@/features/chat/stores/chatStore";
import type { MessageMetadata } from "@/shared/types/messages";
import type { ChatSendOptions } from "@/features/chat/types";

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
  message: QueuedMessageRecord | undefined,
): boolean {
  return (
    message?.kind === "transport-ready" &&
    message.payload.sendOptions?.userMessageMetadata?.origin ===
      BERDCTL_CROSS_SESSION_ORIGIN
  );
}

export async function sendPromptToExistingSessionInBackground(
  sessionId: string,
  prompt: string,
  beforeUserMessageCommitted?: () => void,
): Promise<void> {
  const { providerId, persona } =
    await prepareExistingSessionForBackgroundSend(sessionId);
  const session = useChatSessionStore.getState().getSession(sessionId);
  void sendPromptInBackground(
    sessionId,
    prompt,
    providerId,
    persona,
    {
      ...berdctlCrossSessionSendOptions(),
      systemPrompt: session
        ? formatIncludedWorkspacesPrompt(session)
        : undefined,
    },
    undefined,
    beforeUserMessageCommitted,
  ).catch(() => {
    // Background transport records and logs the failure. The direct Berdctl
    // command intentionally returns once dispatch begins, not after the turn.
  });
}

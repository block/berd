import { dispatchPrompt } from "@/features/chat/lib/sendCore";
import { PreCommitSendRejectedError } from "@/features/chat/lib/preCommitSendRejection";
import {
  composeSystemPrompt,
  formatPersonaSystemPrompt,
} from "@/features/projects/lib/chatProjectContext";
import type { ChatAttachmentDraft } from "@/shared/types/messages";
import type { Persona } from "@/shared/types/agents";
import type { ChatSendOptions } from "../types";

/**
 * Sends a prompt to a session that has no mounted ChatView, fire-and-forget.
 * The response streams into the store through the global notification handler
 * exactly like an unfocused tab; the user message is recorded locally so the
 * conversation is complete when the user opens the session.
 *
 * Returns once the send is dispatched, not when the turn completes — the
 * caller (berdctl sessions.create) must not block on the agent's answer.
 *
 * `providerId` is the target session's provider (callers have it from
 * session creation); it stamps the pending-assistant hint for the response.
 */
export function sendPromptInBackground(
  sessionId: string,
  prompt: string,
  providerId: string,
  persona?: Pick<Persona, "id" | "displayName" | "systemPrompt">,
  sendOptions: ChatSendOptions = {},
  attachments?: ChatAttachmentDraft[],
  beforeUserMessageCommitted?: () => void,
  onUserMessageCommitted?: () => void,
  validateExecutionTarget?: () => void,
  onPromptDispatched?: () => void,
): Promise<void> {
  const systemPrompt =
    sendOptions.executionSystemPrompt ??
    composeSystemPrompt(
      formatPersonaSystemPrompt(persona),
      sendOptions.systemPrompt,
    );
  return dispatchPrompt(sessionId, prompt, {
    persona: persona
      ? { id: persona.id, name: persona.displayName }
      : undefined,
    attachments,
    assistantPrompt: sendOptions.assistantPrompt,
    displayText: sendOptions.displayText,
    chips: sendOptions.chips,
    userMessageMetadata: sendOptions.userMessageMetadata,
    acpGooseMetadata: sendOptions.acpGooseMetadata,
    // Compose only caller-provided target-session context and the requested
    // persona, never foreground UI state.
    systemPrompt,
    // Same isolation rule: the target session's provider, never the
    // foreground active agent's (dispatchPrompt's default).
    providerId,
    beforeUserMessageCommitted,
    onUserMessageCommitted,
    onPromptDispatched,
    prepare: validateExecutionTarget,
    background: true,
  }).catch((error) => {
    // Readiness changed at the final reversible boundary. The intent owner
    // classifies this expected race (retain, queue, or refuse) deterministically.
    if (error instanceof PreCommitSendRejectedError) throw error;
    // dispatchPrompt has already recorded the failure in the session
    // transcript and the chat-state stores; this log is diagnostics only.
    console.error(
      `[background-send] prompt failed for session ${sessionId}`,
      error,
    );
    throw error;
  });
}

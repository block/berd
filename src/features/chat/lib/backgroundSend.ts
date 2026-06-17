import { dispatchPrompt } from "@/features/chat/lib/sendCore";
import type { Persona } from "@/shared/types/agents";
import type { ChatSendOptions } from "../types";

/**
 * Sends a prompt to a session that has no mounted ChatView, fire-and-forget.
 * The response streams into the store through the global notification handler
 * exactly like an unfocused tab; the user message is recorded locally so the
 * conversation is complete when the user opens the session.
 *
 * Returns once the send is dispatched, not when the turn completes — the
 * caller (goosectl sessions.create) must not block on the agent's answer.
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
): void {
  void dispatchPrompt(sessionId, prompt, {
    persona: persona
      ? { id: persona.id, name: persona.displayName }
      : undefined,
    assistantPrompt: sendOptions.assistantPrompt,
    displayText: sendOptions.displayText,
    chips: sendOptions.chips,
    userMessageMetadata: sendOptions.userMessageMetadata,
    acpGooseMetadata: sendOptions.acpGooseMetadata,
    // Exactly the persona's prompt (or none) — a background send must not
    // pick up whatever agent happens to be active in the foreground UI.
    systemPrompt: persona?.systemPrompt,
    // Same isolation rule: the target session's provider, never the
    // foreground active agent's (dispatchPrompt's default).
    providerId,
    background: true,
  }).catch((error) => {
    // dispatchPrompt has already recorded the failure in the session
    // transcript and the chat-state stores; this log is diagnostics only.
    console.error(
      `[background-send] prompt failed for session ${sessionId}`,
      error,
    );
  });
}

export const VOICE_CONVERSATION_EMPTY_RESPONSE =
  "The model returned an empty response. Please resend your message to continue.";

const VOICE_CONVERSATION_EMPTY_RESPONSES = new Set([
  VOICE_CONVERSATION_EMPTY_RESPONSE,
  "Le modèle a renvoyé une réponse vide. Veuillez renvoyer votre message pour continuer.",
]);

export function isVoiceConversationEmptyResponse(text: string): boolean {
  return VOICE_CONVERSATION_EMPTY_RESPONSES.has(text.trim());
}

export function stripVoiceConversationEmptyResponseSuffix(
  text: string,
): string {
  const trimmedEnd = text.trimEnd();
  for (const fallback of VOICE_CONVERSATION_EMPTY_RESPONSES) {
    if (trimmedEnd.endsWith(fallback)) {
      return trimmedEnd.slice(0, -fallback.length).trimEnd();
    }
  }
  return text;
}

import type { Message } from "@/shared/types/messages";
import type { RealtimePresentationMode } from "./realtimeVoicePreference";

export function presentRealtimeVoiceMessages(
  messages: Message[],
  mode: RealtimePresentationMode,
): Message[] {
  if (mode === "debug") return messages;
  if (
    !messages.some((message) => {
      const event = message.metadata?.voiceConversationDebugEvent;
      return event && event !== "emissarySpeech";
    })
  ) {
    return messages;
  }

  return messages.filter((message) => {
    const event = message.metadata?.voiceConversationDebugEvent;
    return !event || event === "emissarySpeech";
  });
}

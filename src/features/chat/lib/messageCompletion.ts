import type { Message } from "@/shared/types/messages";

export function completeAssistantMessage(message: Message): Message {
  if (
    message.role !== "assistant" ||
    message.metadata?.completionStatus !== "inProgress"
  ) {
    return message;
  }

  return {
    ...message,
    metadata: {
      ...message.metadata,
      completionStatus: "completed",
    },
  };
}

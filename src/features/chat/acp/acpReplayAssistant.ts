import {
  ensureReplayBuffer,
  getBufferedMessage,
} from "@/features/chat/hooks/replayBuffer";
import { completeAssistantMessage } from "@/features/chat/lib/messageCompletion";
import { useChatStore } from "@/features/chat/stores/chatStore";
import type { Message } from "@/shared/types/messages";
import type { ReplayAssistantMetadata } from "@/shared/api/acpReplayMetadata";

const replayAssistantMessageIds = new Map<string, string>();

export function getTrackedReplayAssistantMessageId(
  sessionId: string,
): string | null {
  return replayAssistantMessageIds.get(sessionId) ?? null;
}

export function ensureReplayAssistantMessage(
  sessionId: string,
  preferredMessageId?: string | null,
  created?: number,
  metadata?: ReplayAssistantMetadata,
): Message {
  const trackedMessageId = replayAssistantMessageIds.get(sessionId);

  if (preferredMessageId) {
    const preferredMessage = getBufferedMessage(sessionId, preferredMessageId);
    if (preferredMessage?.role === "assistant") {
      if (created !== undefined) {
        preferredMessage.created = created;
      }
      mergeAssistantMetadata(preferredMessage, metadata);
      replayAssistantMessageIds.set(sessionId, preferredMessageId);
      return preferredMessage;
    }
  }

  if (trackedMessageId) {
    const trackedMessage = getBufferedMessage(sessionId, trackedMessageId);
    if (trackedMessage?.role === "assistant") {
      if (preferredMessageId && trackedMessage.id !== preferredMessageId) {
        trackedMessage.id = preferredMessageId;
        replayAssistantMessageIds.set(sessionId, preferredMessageId);
      }
      if (created !== undefined) {
        trackedMessage.created = created;
      }
      mergeAssistantMetadata(trackedMessage, metadata);
      return trackedMessage;
    }
  }

  const messageId = preferredMessageId ?? crypto.randomUUID();
  const buffer = ensureReplayBuffer(sessionId);
  const message: Message = {
    id: messageId,
    role: "assistant",
    created: created ?? Date.now(),
    content: [],
    metadata: {
      userVisible: true,
      agentVisible: true,
      completionStatus: "inProgress",
      ...metadata,
    },
  };
  buffer.push(message);
  replayAssistantMessageIds.set(sessionId, messageId);
  return message;
}

function mergeAssistantMetadata(
  message: Message,
  metadata: ReplayAssistantMetadata | undefined,
): void {
  if (!metadata) {
    return;
  }

  message.metadata = {
    ...message.metadata,
    ...metadata,
  };
}

export function completeReplayAssistantMessage(sessionId: string): boolean {
  const trackedMessageId = replayAssistantMessageIds.get(sessionId);
  if (!trackedMessageId) return false;

  const bufferedMessage = getBufferedMessage(sessionId, trackedMessageId);
  if (bufferedMessage) {
    const completed = completeAssistantMessage(bufferedMessage);
    if (completed !== bufferedMessage) {
      Object.assign(bufferedMessage, completed);
      replayAssistantMessageIds.delete(sessionId);
      return true;
    }
  }

  let completedStoredMessage = false;
  useChatStore
    .getState()
    .updateMessage(sessionId, trackedMessageId, (message) => {
      const completed = completeAssistantMessage(message);
      completedStoredMessage = completed !== message;
      return completed;
    });
  replayAssistantMessageIds.delete(sessionId);
  return completedStoredMessage;
}

export function clearReplayAssistantTracking(): void {
  replayAssistantMessageIds.clear();
}

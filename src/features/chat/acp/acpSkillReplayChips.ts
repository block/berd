import { parseSkillInstructionPrompt } from "@/features/skills/lib/skillChatPrompt";
import {
  ensureReplayBuffer,
  getBufferedMessage,
} from "@/features/chat/hooks/replayBuffer";
import type {
  ImageContent,
  MessageChip,
  MessageMetadata,
  TextContent,
} from "@/shared/types/messages";

const pendingReplayChips = new Map<string, Map<string, MessageChip[]>>();

export function getPendingReplayChips(sessionId: string, messageId: string) {
  const byMessage = pendingReplayChips.get(sessionId);
  return byMessage?.get(messageId) ?? [];
}

export function setPendingReplayChips(
  sessionId: string,
  messageId: string,
  chips: MessageChip[],
) {
  if (chips.length === 0) return;
  const byMessage = pendingReplayChips.get(sessionId) ?? new Map();
  byMessage.set(messageId, chips);
  pendingReplayChips.set(sessionId, byMessage);
}

export function clearPendingReplayChips(sessionId: string, messageId: string) {
  const byMessage = pendingReplayChips.get(sessionId);
  if (!byMessage) return;
  byMessage.delete(messageId);
  if (byMessage.size === 0) {
    pendingReplayChips.delete(sessionId);
  }
}

export function skillInstructionToChips(text: string): MessageChip[] {
  return parseSkillInstructionPrompt(text).map((label) => ({
    label,
    type: "skill" as const,
  }));
}

export function handleReplayUserMessageChunk(
  sessionId: string,
  messageId: string,
  content: TextContent | ImageContent,
  created?: number,
  metadata?: Pick<
    MessageMetadata,
    "delivery" | "origin" | "userVisible" | "agentVisible"
  >,
): void {
  const buffer = ensureReplayBuffer(sessionId);
  const existing = getBufferedMessage(sessionId, messageId);

  if (content.type === "text" && isAssistantOnly(content.annotations)) {
    const chips = skillInstructionToChips(content.text);
    if (chips.length > 0) {
      attachReplayChips(sessionId, messageId, existing, chips);
    }
    return;
  }

  const contentBlock = makeContentBlock(content);
  const chips = getPendingReplayChips(sessionId, messageId);
  if (!existing) {
    buffer.push({
      id: messageId,
      role: "user",
      created: created ?? Date.now(),
      content: [contentBlock],
      metadata: {
        userVisible: true,
        agentVisible: true,
        ...metadata,
        ...(chips.length > 0 ? { chips } : {}),
      },
    });
  } else {
    if (created !== undefined) {
      existing.created = created;
    }
    if (metadata) {
      existing.metadata = {
        ...existing.metadata,
        ...metadata,
      };
    }
    existing.content.push(contentBlock);
    attachReplayChips(sessionId, messageId, existing, chips);
  }
  clearPendingReplayChips(sessionId, messageId);
}

export function clearSkillReplayChips(): void {
  pendingReplayChips.clear();
}

function isAssistantOnly(ann?: TextContent["annotations"]) {
  return Boolean(
    ann?.audience && ann.audience.length > 0 && !ann.audience.includes("user"),
  );
}

function attachReplayChips(
  sessionId: string,
  messageId: string,
  existing: ReturnType<typeof getBufferedMessage>,
  chips: MessageChip[],
) {
  if (chips.length === 0) return;
  if (existing) {
    existing.metadata = {
      ...existing.metadata,
      chips: [...(existing.metadata?.chips ?? []), ...chips],
    };
  } else {
    setPendingReplayChips(sessionId, messageId, chips);
  }
}

function makeContentBlock(content: TextContent | ImageContent) {
  return content.type === "text" ? makeTextBlock(content) : { ...content };
}

function makeTextBlock(content: TextContent): TextContent {
  return content.annotations
    ? { type: "text", text: content.text, annotations: content.annotations }
    : { type: "text", text: content.text };
}

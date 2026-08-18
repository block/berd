import { isAgentBuilderSkillSendOptions } from "@/features/chat/lib/agentBuilderSkill";
import type { ChatSession } from "@/features/chat/stores/chatSessionStore";
import type { QueuedMessageRecord } from "@/features/chat/stores/chatStore";

/**
 * Agent Builder queue records are dispatchable only after a foreground owner
 * has created and adopted the final-session-owned draft target. The background
 * drain must not bypass that preparation when no chat is mounted.
 */
export function getAgentBuilderQueuePreparedTargetPath(
  record: QueuedMessageRecord & { kind: "transport-ready" },
  session: ChatSession | null | undefined,
): string | null | undefined {
  if (!isAgentBuilderSkillSendOptions(record.payload.sendOptions)) {
    return undefined;
  }
  if (
    session?.intent !== "build-agent" ||
    session.agentBuilderOpen === false ||
    !session.targetAgentPath
  ) {
    return null;
  }
  return session.targetAgentPath;
}

export function isAgentBuilderQueuePreparationReady(
  record: QueuedMessageRecord & { kind: "transport-ready" },
  session: ChatSession | null | undefined,
): boolean {
  return getAgentBuilderQueuePreparedTargetPath(record, session) !== null;
}

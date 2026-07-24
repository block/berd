import type { SessionUpdate } from "@agentclientprotocol/sdk";
import { useChatStore } from "@/features/chat/stores/chatStore";
import { useChatSessionStore } from "@/features/chat/stores/chatSessionStore";
import { completeReplayAssistantMessage } from "./acpReplayAssistant";
import { flushBufferedStreamingUpdatesForSession } from "./liveStreamingUpdates";

type SessionInfoUpdate = SessionUpdate & {
  sessionUpdate: "session_info_update";
  title?: unknown;
  updatedAt?: unknown;
  meta?: unknown;
  _meta?: unknown;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function handleSessionInfoUpdate(
  sessionId: string,
  update: SessionUpdate,
): void {
  const info = update as SessionInfoUpdate;
  const sessionStore = useChatSessionStore.getState();
  const meta = isRecord(info._meta)
    ? info._meta
    : isRecord(info.meta)
      ? info.meta
      : {};
  const gooseMeta = isRecord(meta.goose) ? meta.goose : null;
  if (gooseMeta && "activeRunId" in gooseMeta) {
    const activeRunId =
      typeof gooseMeta.activeRunId === "string" ? gooseMeta.activeRunId : null;
    const chatStore = useChatStore.getState();
    if (activeRunId === null) {
      flushBufferedStreamingUpdatesForSession(sessionId, {
        flushSubtitle: true,
      });
      completeReplayAssistantMessage(sessionId);
      chatStore.settleActiveRun(sessionId);
    } else {
      chatStore.setActiveRunId(sessionId, activeRunId);
    }
  }

  const session = sessionStore.getSession(sessionId);
  if (!session) {
    return;
  }

  const patch: Parameters<typeof sessionStore.patchSession>[1] = {};

  if (typeof info.title === "string" && info.title && !session.userSetName) {
    patch.title = info.title;
  }
  if (typeof info.updatedAt === "string" && info.updatedAt) {
    patch.updatedAt = info.updatedAt;
  }
  if (typeof meta.messageCount === "number") {
    patch.messageCount = meta.messageCount;
  }
  if (typeof meta.lastMessageAt === "string" && meta.lastMessageAt) {
    patch.lastMessageAt = meta.lastMessageAt;
  }
  if (typeof meta.userSetName === "boolean") {
    patch.userSetName = meta.userSetName;
  }

  if (Object.keys(patch).length > 0) {
    sessionStore.patchSession(sessionId, patch);
  }
}

import {
  clearReplayBuffer,
  getAndDeleteReplayBuffer,
} from "@/features/chat/hooks/replayBuffer";
import { sanitizeReplayMessages } from "@/features/chat/lib/replaySanitizer";
import { useChatStore } from "@/features/chat/stores/chatStore";
import {
  type ChatSession,
  useChatSessionStore,
} from "@/features/chat/stores/chatSessionStore";
import { useProjectStore } from "@/features/projects/stores/projectStore";
import { resolveSessionCwd } from "@/features/projects/lib/sessionCwdSelection";
import { perfLog } from "@/shared/lib/perfLog";
import { isDefaultChatTitle } from "@/features/chat/lib/sessionTitle";
import { getTextContent, type Message } from "@/shared/types/messages";

function fallbackTitleFromReplay(messages: Message[]): string | null {
  for (const message of messages) {
    if (message.role !== "user") {
      continue;
    }

    try {
      const text = getTextContent(message).trim();
      if (text) {
        return text.replace(/\s+/g, " ").slice(0, 80);
      }
    } catch {}
  }

  return null;
}

interface LoadSessionMessagesOptions {
  force?: boolean;
}

export async function loadSessionMessages(
  sessionId: string,
  options: LoadSessionMessagesOptions = {},
): Promise<boolean> {
  const sid = sessionId.slice(0, 8);
  const existingMsgs = useChatStore.getState().messagesBySession[sessionId];
  if (!options.force && (existingMsgs?.length ?? 0) > 0) {
    perfLog(`[perf:load] ${sid} skip — has messages`);
    useChatSessionStore
      .getState()
      .patchSession(sessionId, { pinnedLoadState: undefined });
    return true;
  }

  const t0 = performance.now();
  perfLog(`[perf:load] ${sid} start`);
  useChatStore.getState().setSessionLoading(sessionId, true);
  try {
    const [{ acpLoadSession }, { getReplayPerf, clearReplayPerf }] =
      await Promise.all([
        import("@/shared/api/acp"),
        import("@/shared/api/acpNotificationHandler"),
      ]);
    const t1 = performance.now();
    perfLog(`[perf:load] ${sid} import in ${(t1 - t0).toFixed(1)}ms`);
    const session = useChatSessionStore.getState().getSession(sessionId);
    const project = session?.projectId
      ? (useProjectStore
          .getState()
          .projects.find((p) => p.id === session.projectId) ?? null)
      : null;
    const activeWorkspace =
      session?.id != null
        ? useChatSessionStore.getState().activeWorkspaceBySession[session.id]
        : undefined;
    const workingDir = await resolveSessionCwd(
      project,
      activeWorkspace?.path ?? session?.workingDir,
    );
    await acpLoadSession(sessionId, workingDir);
    const tFlush = performance.now();
    useChatStore.getState().setSessionLoading(sessionId, false);
    const buffer = getAndDeleteReplayBuffer(sessionId);
    const replayMessages = buffer ? sanitizeReplayMessages(buffer) : undefined;
    const replayStats = getReplayPerf(sessionId);
    clearReplayPerf(sessionId);
    if (replayMessages) {
      useChatStore.getState().setMessages(sessionId, replayMessages);
      const latestSession = useChatSessionStore
        .getState()
        .getSession(sessionId);
      const sessionPatch: Partial<ChatSession> = {
        messageCount: replayMessages.length,
      };
      if (
        latestSession &&
        !latestSession.userSetName &&
        isDefaultChatTitle(latestSession.title)
      ) {
        const fallbackTitle = fallbackTitleFromReplay(replayMessages);
        if (fallbackTitle) {
          sessionPatch.title = fallbackTitle;
        }
      }
      useChatSessionStore.getState().patchSession(sessionId, sessionPatch);
    }
    useChatSessionStore
      .getState()
      .patchSession(sessionId, { pinnedLoadState: undefined });
    const t2 = performance.now();
    perfLog(
      `[perf:load] ${sid} replay: notifs=${replayStats?.count ?? 0} span=${replayStats?.spanMs.toFixed(1) ?? "0"}ms msgs=${replayMessages?.length ?? 0} flush=${(t2 - tFlush).toFixed(1)}ms total=${(t2 - t0).toFixed(1)}ms`,
    );
    return true;
  } catch (err) {
    console.error("Failed to load session messages:", err);
    clearReplayBuffer(sessionId);
    useChatStore.getState().setSessionLoading(sessionId, false);
    return false;
  }
}

export function activateSession(sessionId: string): void {
  useChatSessionStore.getState().setActiveSession(sessionId);
  useChatStore.getState().setActiveSession(sessionId);
  useChatStore.getState().markSessionRead(sessionId);
}

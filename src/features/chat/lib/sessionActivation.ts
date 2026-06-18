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
import { checkDirectory } from "@/features/projects/lib/missingProjectDirs";
import type { ProjectInfo } from "@/features/projects/api/projects";
import { useProjectStore } from "@/features/projects/stores/projectStore";
import {
  type ExplicitCwdSource,
  getExplicitCwdSource,
} from "@/features/projects/lib/sessionCwdSelection";
import { resolveSessionArtifactCwd } from "@/shared/artifacts/sessionArtifactLocation";
import { perfLog } from "@/shared/lib/perfLog";
import { isDefaultChatTitle } from "@/features/chat/lib/sessionTitle";
import { formatAcpErrorMessage } from "@/shared/api/acpErrors";
import { i18n } from "@/shared/i18n";
import {
  createSystemNotificationMessage,
  getTextContent,
  type Message,
  type SystemNotificationAction,
} from "@/shared/types/messages";

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

interface SessionLoadWorkingDir {
  workingDir: string;
  missingCwdWarning?: {
    source: ExplicitCwdSource;
    missingPath: string;
  };
}

async function resolveWorkingDirForSessionLoad(
  session: ChatSession | undefined,
  project: ProjectInfo | null,
): Promise<SessionLoadWorkingDir> {
  const activeWorkspace =
    session?.id != null
      ? useChatSessionStore.getState().activeWorkspaceBySession[session.id]
      : undefined;
  const explicitCwdSource = getExplicitCwdSource(
    project,
    activeWorkspace?.path,
    session?.workingDir,
  );
  const explicitCwd = explicitCwdSource
    ? await checkDirectory(explicitCwdSource.path)
    : null;

  if (!explicitCwdSource || !explicitCwd) {
    return { workingDir: await resolveSessionArtifactCwd() };
  }
  if (!explicitCwd.missing) {
    return { workingDir: explicitCwd.resolvedPath };
  }

  const fallbackPath = await resolveSessionArtifactCwd();
  // resolveSessionArtifactCwd recreates the artifact directory, so a deleted
  // artifact root is already repaired — warning about it would tell the
  // user their folder was replaced by itself.
  if (fallbackPath === explicitCwd.resolvedPath) {
    return { workingDir: fallbackPath };
  }

  return {
    workingDir: fallbackPath,
    missingCwdWarning: {
      source: explicitCwdSource,
      missingPath: explicitCwd.resolvedPath,
    },
  };
}

function buildMissingCwdWarning(
  source: ExplicitCwdSource,
  missingPath: string,
  fallbackPath: string,
): Message {
  const action: SystemNotificationAction =
    source.type === "project"
      ? { type: "editProject", projectId: source.projectId }
      : { type: "openContextPanel" };
  const key =
    source.type === "project"
      ? "chat:toolbar.sessionLoadMissingProjectDir"
      : "chat:toolbar.sessionLoadMissingWorkingDir";

  return createSystemNotificationMessage(
    i18n.t(key, { missingPath, fallbackPath }),
    "warning",
    action,
  );
}

// Deterministic ids so reloads replace the loader's own notifications
// instead of stacking duplicates.
function loaderNoticeMessageId(
  sessionId: string,
  kind: "warning" | "error",
): string {
  return `session-load-${kind}:${sessionId}`;
}

/**
 * True when the session holds replayed conversation history. Loader-added
 * system notifications don't count: treating them as "loaded" would make a
 * single failed load (whose error notification is the only message)
 * permanently block retries through the has-messages skip guard.
 */
export function hasConversationMessages(
  messages: Message[] | undefined,
): boolean {
  return messages?.some((message) => message.role !== "system") ?? false;
}

export async function loadSessionMessages(
  sessionId: string,
  options: LoadSessionMessagesOptions = {},
): Promise<boolean> {
  const sid = sessionId.slice(0, 8);
  const existingMsgs = useChatStore.getState().messagesBySession[sessionId];
  if (!options.force && hasConversationMessages(existingMsgs)) {
    perfLog(`[perf:load] ${sid} skip — has messages`);
    useChatSessionStore
      .getState()
      .patchSession(sessionId, { pinnedLoadState: undefined });
    return true;
  }

  const sessionStore = useChatSessionStore.getState();
  const sessionAtRequest = sessionStore.getSession(sessionId);
  if (sessionAtRequest?.creationState === "pending") {
    perfLog(`[perf:load] ${sid} skip — session creation pending`);
    useChatStore.getState().setSessionLoading(sessionId, false);
    return true;
  }

  if (sessionAtRequest?.creationState === "failed") {
    perfLog(`[perf:load] ${sid} skip — session creation failed`);
    useChatStore.getState().setSessionLoading(sessionId, false);
    return false;
  }

  if (
    !sessionAtRequest &&
    sessionStore.sessions.some(
      (session) => session.clientSessionId === sessionId,
    )
  ) {
    perfLog(`[perf:load] ${sid} skip — stale client session id`);
    useChatStore.getState().setSessionLoading(sessionId, false);
    return true;
  }

  const t0 = performance.now();
  perfLog(`[perf:load] ${sid} start`);
  useChatStore.getState().setSessionLoading(sessionId, true);
  try {
    const [{ acpLoadSession }, { getReplayPerf, clearReplayPerf }] =
      await Promise.all([
        import("@/shared/api/acp"),
        import("@/features/chat/acp/acpNotificationHandler"),
      ]);
    const t1 = performance.now();
    perfLog(`[perf:load] ${sid} import in ${(t1 - t0).toFixed(1)}ms`);
    const session = useChatSessionStore.getState().getSession(sessionId);
    const project = session?.projectId
      ? (useProjectStore
          .getState()
          .projects.find((p) => p.id === session.projectId) ?? null)
      : null;
    const { workingDir, missingCwdWarning } =
      await resolveWorkingDirForSessionLoad(session, project);
    await acpLoadSession(sessionId, workingDir);
    const tFlush = performance.now();
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
    const chatStore = useChatStore.getState();
    const sessionStore = useChatSessionStore.getState();
    chatStore.removeMessage(
      sessionId,
      loaderNoticeMessageId(sessionId, "error"),
    );
    chatStore.removeMessage(
      sessionId,
      loaderNoticeMessageId(sessionId, "warning"),
    );
    if (missingCwdWarning) {
      chatStore.addMessage(sessionId, {
        ...buildMissingCwdWarning(
          missingCwdWarning.source,
          missingCwdWarning.missingPath,
          workingDir,
        ),
        id: loaderNoticeMessageId(sessionId, "warning"),
      });
      if (missingCwdWarning.source.type === "workspace") {
        // The dead workspace path would otherwise keep winning cwd
        // resolution (loads, compaction, model changes) over the patched
        // workingDir, re-triggering the same fallback on every pass.
        sessionStore.clearActiveWorkspace(sessionId);
      }
    }
    chatStore.setError(sessionId, null);
    sessionStore.patchSession(sessionId, {
      pinnedLoadState: undefined,
      ...(missingCwdWarning ? { workingDir } : {}),
    });
    chatStore.setSessionLoading(sessionId, false);
    const t2 = performance.now();
    perfLog(
      `[perf:load] ${sid} replay: notifs=${replayStats?.count ?? 0} span=${replayStats?.spanMs.toFixed(1) ?? "0"}ms msgs=${replayMessages?.length ?? 0} flush=${(t2 - tFlush).toFixed(1)}ms total=${(t2 - t0).toFixed(1)}ms`,
    );
    return true;
  } catch (err) {
    console.error("Failed to load session messages:", err);
    const errorMessage = formatAcpErrorMessage(
      err,
      i18n.t("chat:toolbar.sessionLoadFailed"),
    );
    clearReplayBuffer(sessionId);
    const chatStore = useChatStore.getState();
    chatStore.setSessionLoading(sessionId, false);
    chatStore.removeMessage(
      sessionId,
      loaderNoticeMessageId(sessionId, "error"),
    );
    chatStore.addMessage(sessionId, {
      ...createSystemNotificationMessage(errorMessage, "error"),
      id: loaderNoticeMessageId(sessionId, "error"),
    });
    // Deliberately no setError here: parking chatState at "error" would
    // route the next send into a queue that never flushes, and the inline
    // notification already reports the failure. Re-opening the session
    // retries the load because the guard ignores system-only messages.
    return false;
  }
}

export function activateSession(sessionId: string): void {
  useChatSessionStore.getState().setActiveSession(sessionId);
  useChatStore.getState().setActiveSession(sessionId);
  useChatStore.getState().markSessionRead(sessionId);
}

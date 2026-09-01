import { isSessionRunning } from "@/features/chat/lib/sessionActivity";
import {
  acpSessionToChatSession,
  mergeAcpSessionInfo,
  mergeAcpSessionPage,
} from "@/features/chat/lib/acpSessionMapping";
import {
  type ChatSession,
  useChatSessionStore,
} from "@/features/chat/stores/chatSessionStore";
import { useChatStore } from "@/features/chat/stores/chatStore";
import { useSessionWindowStore } from "@/features/chat/stores/sessionWindowStore";
import { acpGetSessionInfo, acpListSessionsPage } from "@/shared/api/acp";
import { berdctlErrorDetail, sessionNotFoundMessage } from "../helpers";
import { CommandError } from "../types";

export async function loadAllSessionsForBerdctl(): Promise<void> {
  try {
    await loadSessionsForBerdctlUntil(() => false, { exhaust: true });
  } catch (error) {
    throw new CommandError(
      "backend_read_failed",
      `Failed to read sessions from the app backend: ${berdctlErrorDetail(error)}`,
    );
  }
}

export async function loadSessionForBerdctl(sessionId: string): Promise<void> {
  try {
    const session = await acpGetSessionInfo(sessionId);
    useChatSessionStore.setState((state) =>
      mergeAcpSessionInfo(state, session),
    );
  } catch (error) {
    if (isAcpResourceNotFound(error)) {
      throw new CommandError(
        "session_not_found",
        sessionNotFoundMessage(sessionId),
      );
    }
    throw new CommandError(
      "backend_read_failed",
      `Failed to read session from the app backend: ${berdctlErrorDetail(error)}`,
    );
  }
}

function isAcpResourceNotFound(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === -32002
  );
}

async function loadSessionsForBerdctlUntil(
  shouldStop: (session: ChatSession) => boolean,
  options: { exhaust?: boolean } = {},
): Promise<boolean> {
  let cursor: string | null = null;
  let previousCursor: string | null = null;

  for (;;) {
    const page = await acpListSessionsPage({ cursor });
    const fetchedTarget = page.sessions
      .map((session) => acpSessionToChatSession(session))
      .some(shouldStop);
    useChatSessionStore.setState((state) => ({
      ...mergeAcpSessionPage(state, page, previousCursor),
      hasHydratedSessions: true,
      isLoading: false,
    }));

    if (!options.exhaust && fetchedTarget) {
      return true;
    }

    const nextCursor = useChatSessionStore.getState().sessionPageCursor;
    if (!nextCursor) {
      return false;
    }

    previousCursor = nextCursor;
    cursor = nextCursor;
  }
}

export function requireSession(sessionId: string): ChatSession {
  const session = useChatSessionStore.getState().getSession(sessionId);
  if (!session) {
    throw new CommandError(
      "session_not_found",
      sessionNotFoundMessage(sessionId),
    );
  }
  return session;
}

export function refuseWindowedTarget(sessionId: string, verb: string): void {
  if (useSessionWindowStore.getState().isOpenInWindow(sessionId)) {
    throw new CommandError(
      "target_session_running",
      `Refusing to ${verb} session "${sessionId}" while it is open in a separate window; close that window first or ask the user.`,
    );
  }
}

export function refuseRunningTarget(sessionId: string, verb: string): void {
  refuseWindowedTarget(sessionId, verb);
  const runtime = useChatStore.getState().getSessionRuntime(sessionId);
  if (isSessionRunning(runtime.chatState) || runtime.isRunCancellationPending) {
    throw new CommandError(
      "target_session_running",
      `Refusing to ${verb} session "${sessionId}" while its agent is running or cancellation is pending; wait for the turn to finish or ask the user.`,
    );
  }
}

export function sessionMetadata(session: ChatSession) {
  const runtime = useChatStore.getState().getSessionRuntime(session.id);
  const isOpenInWindow = useSessionWindowStore
    .getState()
    .isOpenInWindow(session.id);
  return {
    session_id: session.id,
    title: session.title,
    harness_id: session.executionTarget?.harnessId ?? "goose",
    model_id: session.executionTarget?.modelId ?? null,
    agent_id: session.personaId ?? null,
    project_id: session.projectId ?? null,
    working_dir: session.workingDir ?? null,
    created_at: session.createdAt,
    updated_at: session.updatedAt,
    archived: session.archivedAt != null,
    is_running:
      isSessionRunning(runtime.chatState) || runtime.isRunCancellationPending,
    is_open_in_window: isOpenInWindow,
    chat_state: runtime.chatState,
    message_count: session.messageCount,
  };
}

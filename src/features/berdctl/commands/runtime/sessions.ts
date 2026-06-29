import { isSessionRunning } from "@/features/chat/lib/sessionActivity";
import {
  acpSessionToChatSession,
  mergeAcpSessionPage,
} from "@/features/chat/lib/acpSessionMapping";
import {
  type ChatSession,
  useChatSessionStore,
} from "@/features/chat/stores/chatSessionStore";
import { useChatStore } from "@/features/chat/stores/chatStore";
import { useSessionWindowStore } from "@/features/chat/stores/sessionWindowStore";
import { acpListSessionsPage } from "@/shared/api/acp";
import {
  GOOSE_PROVIDER_ID,
  isGooseManagedProvider,
} from "@/shared/api/acpPersonaHandoff";

import { sessionNotFoundMessage } from "../helpers";
import { CommandError } from "../types";

export async function loadAllSessionsForBerdctl(): Promise<void> {
  try {
    await loadSessionsForBerdctlUntil(() => false, { exhaust: true });
  } catch (error) {
    throw new CommandError(
      "backend_read_failed",
      `Failed to read sessions from the app backend: ${String(error)}`,
    );
  }
}

export async function loadSessionForBerdctl(sessionId: string): Promise<void> {
  let found = false;
  try {
    found = await loadSessionsForBerdctlUntil(
      (session) => session.id === sessionId,
    );
  } catch (error) {
    throw new CommandError(
      "backend_read_failed",
      `Failed to read sessions from the app backend: ${String(error)}`,
    );
  }
  if (!found) {
    throw new CommandError(
      "session_not_found",
      sessionNotFoundMessage(sessionId),
    );
  }
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
      .map(acpSessionToChatSession)
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

export function refuseRunningTarget(sessionId: string, verb: string): void {
  if (useSessionWindowStore.getState().isOpenInWindow(sessionId)) {
    throw new CommandError(
      "target_session_running",
      `Refusing to ${verb} session "${sessionId}" while it is open in a separate window; close that window first or ask the user.`,
    );
  }
  const runtime = useChatStore.getState().getSessionRuntime(sessionId);
  if (isSessionRunning(runtime.chatState)) {
    throw new CommandError(
      "target_session_running",
      `Refusing to ${verb} session "${sessionId}" while its agent is running; wait for the turn to finish or ask the user.`,
    );
  }
}

export function sessionMetadata(session: ChatSession) {
  const providerId = session.providerId;
  return {
    session_id: session.id,
    title: session.title,
    harness_id:
      providerId == null || isGooseManagedProvider(providerId)
        ? GOOSE_PROVIDER_ID
        : providerId,
    model_id: session.modelId ?? null,
    agent_id: session.personaId ?? null,
    project_id: session.projectId ?? null,
    working_dir: session.workingDir ?? null,
    created_at: session.createdAt,
    updated_at: session.updatedAt,
    archived: session.archivedAt != null,
    message_count: session.messageCount,
  };
}

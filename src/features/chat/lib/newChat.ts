import type { Message } from "@/shared/types/messages";
import type { ChatSession } from "../stores/chatSessionStore";
import { isDefaultChatTitle } from "./sessionTitle";
import {
  sameSessionExecutionTarget,
  type SessionExecutionTarget,
} from "./sessionExecutionTarget";

interface NewChatRequest {
  title: string;
  projectId?: string;
  executionTarget?: SessionExecutionTarget;
  reasoningEffortValue?: string;
  remoteHost?: string;
}

interface FindExistingDraftArgs {
  sessions: ChatSession[];
  activeSessionId: string | null;
  draftsBySession: Record<string, string>;
  messagesBySession: Record<string, Message[]>;
  sessionIdsWithTerminals?: ReadonlySet<string>;
  request: NewChatRequest;
  allowDraftReuse?: boolean;
}

/** Treats undefined, null, and empty/whitespace hosts as "local". */
function normalizeRemoteHost(
  host: string | null | undefined,
): string | undefined {
  const trimmed = host?.trim();
  return trimmed ? trimmed : undefined;
}

function isMatchingContext(
  session: ChatSession,
  request: Omit<NewChatRequest, "title">,
): boolean {
  return (
    session.projectId === request.projectId &&
    normalizeRemoteHost(session.remoteHost) ===
      normalizeRemoteHost(request.remoteHost) &&
    (!request.executionTarget ||
      sameSessionExecutionTarget(
        session.executionTarget,
        request.executionTarget,
      )) &&
    (!request.reasoningEffortValue ||
      session.reasoningEffort?.currentValue === request.reasoningEffortValue)
  );
}

function sessionHasTerminal(
  session: ChatSession,
  sessionIdsWithTerminals: ReadonlySet<string>,
): boolean {
  return (
    sessionIdsWithTerminals.has(session.id) ||
    Boolean(
      session.clientSessionId &&
        sessionIdsWithTerminals.has(session.clientSessionId),
    )
  );
}

function isReusableDraft(
  session: ChatSession,
  localMessages: Message[] | undefined,
): boolean {
  return (
    !session.archivedAt &&
    session.intent !== "build-agent" &&
    session.messageCount === 0 &&
    (localMessages?.length ?? 0) === 0
  );
}

export function findExistingDraft({
  sessions,
  activeSessionId,
  draftsBySession,
  messagesBySession,
  sessionIdsWithTerminals = new Set(),
  request,
  allowDraftReuse = true,
}: FindExistingDraftArgs): ChatSession | undefined {
  if (!allowDraftReuse) {
    return undefined;
  }

  if (!isDefaultChatTitle(request.title)) {
    return undefined;
  }

  const candidates = sessions.filter(
    (session) =>
      isMatchingContext(session, request) &&
      isReusableDraft(session, messagesBySession[session.id]),
  );

  if (candidates.length === 0) {
    return undefined;
  }

  const activeCandidate = candidates.find(
    (session) => session.id === activeSessionId,
  );
  if (activeCandidate) {
    return activeCandidate;
  }

  const withContent = candidates.filter(
    (session) =>
      (draftsBySession[session.id] ?? "").length > 0 ||
      sessionHasTerminal(session, sessionIdsWithTerminals),
  );
  if (withContent.length > 0) {
    return (
      withContent.find((session) => session.id === activeSessionId) ??
      withContent[0]
    );
  }

  return undefined;
}

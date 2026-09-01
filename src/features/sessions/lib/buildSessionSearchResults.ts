import { compareSessionsByActivityDesc } from "@/features/chat/lib/sessionActivity";
import type { ChatSession } from "@/features/chat/stores/chatSessionStore";
import type { AcpSessionSearchResult } from "@/shared/api/acp";
import { filterSessions, type FilterResolvers } from "./filterSessions";

interface BuildSessionSearchResultsOptions {
  locale?: string;
  getDisplayTitle?: (session: ChatSession) => string;
  visibleMetadataOnly?: boolean;
  /** Sessions matched server-side that are not in the loaded `sessions` list.
   *  Metadata filtering still runs against the loaded list alone (its
   *  resolvers only know loaded personas/projects); extras enter purely as
   *  message matches. Loaded sessions win on id overlap — the store's copy
   *  carries live state (workspace, pins) the server's metadata lacks. */
  extraSessions?: ChatSession[];
}

export interface SessionSearchDisplayResult {
  session: ChatSession;
  matchType: "metadata" | "message";
  snippet?: string;
  messageId?: string;
  messageRole?: "user" | "assistant" | "system";
  matchCount?: number;
}

function sortByActivityDesc(sessions: ChatSession[]): ChatSession[] {
  return [...sessions].sort(compareSessionsByActivityDesc);
}

function sortResultsByActivityDesc(
  results: SessionSearchDisplayResult[],
): SessionSearchDisplayResult[] {
  return [...results].sort((a, b) =>
    compareSessionsByActivityDesc(a.session, b.session),
  );
}

export function mergeSessionSearchResults(
  existingResults: SessionSearchDisplayResult[],
  nextResults: SessionSearchDisplayResult[],
): SessionSearchDisplayResult[] {
  const bySessionId = new Map<string, SessionSearchDisplayResult>();
  for (const result of existingResults) {
    bySessionId.set(result.session.id, result);
  }
  for (const result of nextResults) {
    bySessionId.set(result.session.id, result);
  }

  return sortResultsByActivityDesc([...bySessionId.values()]);
}

export function buildSessionSearchResults(
  sessions: ChatSession[],
  query: string,
  messageMatches: AcpSessionSearchResult[],
  resolvers: FilterResolvers,
  options: BuildSessionSearchResultsOptions = {},
): SessionSearchDisplayResult[] {
  const metadataMatchIds = new Set(
    filterSessions(sessions, query, resolvers, options).map(
      (session) => session.id,
    ),
  );
  const messageMatchesBySessionId = new Map(
    messageMatches.map((match) => [match.sessionId, match]),
  );

  const loadedIds = new Set(sessions.map((session) => session.id));
  const extras = (options.extraSessions ?? []).filter(
    (session) =>
      !loadedIds.has(session.id) && messageMatchesBySessionId.has(session.id),
  );

  return sortByActivityDesc([...sessions, ...extras])
    .filter((session) => {
      return (
        metadataMatchIds.has(session.id) ||
        messageMatchesBySessionId.has(session.id)
      );
    })
    .map((session) => {
      const messageMatch = messageMatchesBySessionId.get(session.id);
      if (!messageMatch) {
        return {
          session,
          matchType: "metadata" as const,
        };
      }

      return {
        session,
        matchType: "message" as const,
        // Server-discovered matches arrive with no snippet/messageId until an
        // export enriches them; the empty string must not win over the card's
        // own preview fallback.
        snippet: messageMatch.snippet || undefined,
        messageId: messageMatch.messageId || undefined,
        messageRole: messageMatch.messageRole,
        matchCount: messageMatch.matchCount || undefined,
      };
    });
}

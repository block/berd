import { useCallback, useRef, useState } from "react";
import type { ChatSession } from "@/features/chat/stores/chatSessionStore";
import { acpSearchSessions } from "@/shared/api/acp";
import { formatAcpErrorMessage } from "@/shared/api/acpErrors";
import {
  buildSessionSearchResults,
  mergeSessionSearchResults,
  type SessionSearchDisplayResult,
} from "../lib/buildSessionSearchResults";
import type { FilterResolvers } from "../lib/filterSessions";

interface UseSessionSearchOptions {
  sessions: ChatSession[];
  resolvers: FilterResolvers;
  locale?: string;
  getDisplayTitle?: (session: ChatSession) => string;
  visibleMetadataOnly?: boolean;
}

function searchErrorMessage(error: unknown): string {
  return formatAcpErrorMessage(error, "Search failed");
}

type ResultApplyMode = "replace" | "merge";

type SubmittedSearch = {
  query: string;
  requestId: number;
};

export function useSessionSearch({
  sessions,
  resolvers,
  locale,
  getDisplayTitle,
  visibleMetadataOnly,
}: UseSessionSearchOptions) {
  const [query, setQuery] = useState("");
  const [submittedSearch, setSubmittedSearch] =
    useState<SubmittedSearch | null>(null);
  const submittedQuery = submittedSearch?.query ?? "";
  const [results, setResults] = useState<SessionSearchDisplayResult[]>([]);
  const [isSearching, setIsSearching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const requestIdRef = useRef(0);
  const searchedSessionIdsRef = useRef<Set<string>>(new Set());
  const pendingSessionIdsRef = useRef<Set<string>>(new Set());
  const activeSearchesRef = useRef(0);

  const buildResults = useCallback(
    (
      targetSessions: ChatSession[],
      trimmed: string,
      messageResults: Awaited<ReturnType<typeof acpSearchSessions>> = [],
    ) =>
      buildSessionSearchResults(
        targetSessions,
        trimmed,
        messageResults,
        resolvers,
        {
          locale,
          getDisplayTitle,
          visibleMetadataOnly,
        },
      ),
    [getDisplayTitle, locale, resolvers, visibleMetadataOnly],
  );

  const applyResults = useCallback(
    (
      nextResults: SessionSearchDisplayResult[],
      mode: ResultApplyMode = "merge",
    ) => {
      if (mode === "replace") {
        setResults(nextResults);
        return;
      }

      setResults((current) => mergeSessionSearchResults(current, nextResults));
    },
    [],
  );

  const runSearchPage = useCallback(
    async ({
      requestId,
      trimmed,
      targetSessions,
      initialApplyMode,
    }: {
      requestId: number;
      trimmed: string;
      targetSessions: ChatSession[];
      initialApplyMode: ResultApplyMode;
    }): Promise<boolean> => {
      const metadataResults = buildResults(targetSessions, trimmed);
      const sessionIds = targetSessions.map((session) => session.id);

      setError(null);
      applyResults(metadataResults, initialApplyMode);

      if (trimmed.length < 2 || sessionIds.length === 0) {
        return true;
      }

      activeSearchesRef.current += 1;
      setIsSearching(true);

      try {
        const messageResults = await acpSearchSessions(trimmed, sessionIds);
        if (requestIdRef.current !== requestId) {
          return false;
        }

        applyResults(buildResults(targetSessions, trimmed, messageResults));
        return true;
      } catch (searchError) {
        if (requestIdRef.current !== requestId) {
          return false;
        }

        setError(searchErrorMessage(searchError));
        applyResults(metadataResults);
        return false;
      } finally {
        if (requestIdRef.current === requestId) {
          activeSearchesRef.current = Math.max(
            0,
            activeSearchesRef.current - 1,
          );
          setIsSearching(activeSearchesRef.current > 0);
        }
      }
    },
    [applyResults, buildResults],
  );

  const clear = useCallback(() => {
    requestIdRef.current += 1;
    searchedSessionIdsRef.current = new Set();
    pendingSessionIdsRef.current = new Set();
    activeSearchesRef.current = 0;
    setQuery("");
    setSubmittedSearch(null);
    setResults([]);
    setIsSearching(false);
    setError(null);
  }, []);

  const updateQuery = useCallback((nextQuery: string) => {
    requestIdRef.current += 1;
    searchedSessionIdsRef.current = new Set();
    pendingSessionIdsRef.current = new Set();
    activeSearchesRef.current = 0;
    setQuery(nextQuery);
    setSubmittedSearch(null);
    setResults([]);
    setIsSearching(false);
    setError(null);
  }, []);

  const search = useCallback(
    async (explicitQuery?: string) => {
      const trimmed = (explicitQuery ?? query).trim();
      if (!trimmed) {
        clear();
        return;
      }

      const requestId = requestIdRef.current + 1;
      requestIdRef.current = requestId;
      searchedSessionIdsRef.current = new Set(
        sessions.map((session) => session.id),
      );
      pendingSessionIdsRef.current = new Set();
      activeSearchesRef.current = 0;

      setSubmittedSearch({ query: trimmed, requestId });

      await runSearchPage({
        requestId,
        trimmed,
        targetSessions: sessions,
        initialApplyMode: "replace",
      });
    },
    [clear, query, runSearchPage, sessions],
  );

  const searchMore = useCallback(
    async (nextSessions: ChatSession[]) => {
      if (
        !submittedSearch ||
        requestIdRef.current !== submittedSearch.requestId
      ) {
        return;
      }

      const { query: trimmed, requestId } = submittedSearch;
      if (!trimmed) return;

      const unsearchedSessions = nextSessions.filter(
        (session) =>
          !searchedSessionIdsRef.current.has(session.id) &&
          !pendingSessionIdsRef.current.has(session.id),
      );
      if (unsearchedSessions.length === 0) {
        return;
      }

      for (const session of unsearchedSessions) {
        pendingSessionIdsRef.current.add(session.id);
      }

      const succeeded = await runSearchPage({
        requestId,
        trimmed,
        targetSessions: unsearchedSessions,
        initialApplyMode: "merge",
      });

      if (requestIdRef.current !== requestId) return;
      for (const session of unsearchedSessions) {
        pendingSessionIdsRef.current.delete(session.id);
        if (succeeded) {
          searchedSessionIdsRef.current.add(session.id);
        }
      }
    },
    [runSearchPage, submittedSearch],
  );

  return {
    query,
    submittedQuery,
    results,
    isSearching,
    error,
    setQuery: updateQuery,
    search,
    searchMore,
    clear,
  };
}

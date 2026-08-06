import { useCallback, useContext, useRef, useState } from "react";
import { QueryClientContext } from "@tanstack/react-query";
import type { ChatSession } from "@/features/chat/stores/chatSessionStore";
import { acpSearchSessions } from "@/shared/api/acp";
import { formatAcpErrorMessage } from "@/shared/api/acpErrors";
import { sessionSearchStamp } from "@/shared/api/sessionSearch";
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

/** What a run is allowed to invalidate on screen. */
type SweepMode =
  /** A new query: every result of the previous one is invalid. */
  | "query"
  /** A re-sweep of the query already on screen, because the sessions behind it
   *  changed — the list gained or lost one, or one of them has new content. */
  | "resweep"
  /** Another page of sessions for the query already on screen. */
  | "page";

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
  // Optional so provider-less mounts (tests) fall back to uncached exports;
  // with a client, sweeps share one corpus export per (session, stamp) across
  // the search page, the Cmd-K dialog, and history.
  const queryClient = useContext(QueryClientContext);
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
  // `search` reads sessions and query through refs so its identity stays
  // stable across store churn and query state updates: consumers key sweep
  // effects on that identity, and an unstable callback used to re-fire a full
  // export sweep on every session-list update plus a second, discarded sweep
  // per keystroke (updateQuery bumps requestIdRef, orphaning the first).
  const sessionsRef = useRef(sessions);
  sessionsRef.current = sessions;
  const queryRef = useRef(query);
  queryRef.current = query;
  const submittedSearchRef = useRef(submittedSearch);
  submittedSearchRef.current = submittedSearch;
  // The display options ride the same ref for the same reason: they are only
  // ever read inside a run, and `resolvers` is a fresh object whenever the
  // persona or project store hands back a new array — which the persona 60s
  // and window-focus refresh does unconditionally, so a mounted `usePersonas`
  // consumer would otherwise re-fire consumers' sweep effects on a timer.
  const displayOptionsRef = useRef({
    resolvers,
    locale,
    getDisplayTitle,
    visibleMetadataOnly,
  });
  displayOptionsRef.current = {
    resolvers,
    locale,
    getDisplayTitle,
    visibleMetadataOnly,
  };

  const buildResults = useCallback(
    (
      targetSessions: ChatSession[],
      trimmed: string,
      messageResults: Awaited<ReturnType<typeof acpSearchSessions>> = [],
    ) => {
      const options = displayOptionsRef.current;
      return buildSessionSearchResults(
        targetSessions,
        trimmed,
        messageResults,
        options.resolvers,
        {
          locale: options.locale,
          getDisplayTitle: options.getDisplayTitle,
          visibleMetadataOnly: options.visibleMetadataOnly,
        },
      );
    },
    [],
  );

  /**
   * Metadata matches, applied before the export sweep resolves so title and
   * filter hits render immediately. Only a new query may clear the screen: for
   * a re-sweep these results are metadata-only, so replacing with them would
   * drop every content match for the frames until the sweep resolves — the
   * results flashing out and back in under the user.
   */
  const applyInterimResults = useCallback(
    (
      metadataResults: SessionSearchDisplayResult[],
      mode: SweepMode,
      sweptSessionIds: Set<string>,
    ) => {
      if (mode === "query") {
        setResults(metadataResults);
        return;
      }
      if (mode === "page") {
        setResults((current) =>
          mergeSessionSearchResults(current, metadataResults),
        );
        return;
      }
      // Re-sweep: keep what is on screen for the sessions still in the list
      // (merged last, so an existing content match is not downgraded to a
      // metadata one), add metadata hits for sessions that just joined, and
      // drop the ones that left.
      setResults((current) =>
        mergeSessionSearchResults(
          metadataResults,
          current.filter((result) => sweptSessionIds.has(result.session.id)),
        ),
      );
    },
    [],
  );

  /**
   * The sweep's own results: authoritative for the sessions it covered, so a
   * session that stopped matching disappears, and additive for the rest, so a
   * `searchMore` page merged in while the sweep was running survives it.
   */
  const applySweptResults = useCallback(
    (
      nextResults: SessionSearchDisplayResult[],
      sweptSessionIds: Set<string>,
    ) => {
      setResults((current) =>
        mergeSessionSearchResults(
          current.filter((result) => !sweptSessionIds.has(result.session.id)),
          nextResults,
        ),
      );
    },
    [],
  );

  const runSearchPage = useCallback(
    async ({
      requestId,
      trimmed,
      targetSessions,
      mode,
    }: {
      requestId: number;
      trimmed: string;
      targetSessions: ChatSession[];
      mode: SweepMode;
    }): Promise<boolean> => {
      const metadataResults = buildResults(targetSessions, trimmed);
      const targets = targetSessions.map((session) => ({
        id: session.id,
        stamp: sessionSearchStamp(session),
      }));
      const sweptSessionIds = new Set(targets.map((target) => target.id));

      setError(null);
      applyInterimResults(metadataResults, mode, sweptSessionIds);

      if (trimmed.length < 2 || targets.length === 0) {
        return true;
      }

      activeSearchesRef.current += 1;
      setIsSearching(true);

      try {
        const messageResults = await acpSearchSessions(trimmed, targets, {
          queryClient,
        });
        if (requestIdRef.current !== requestId) {
          return false;
        }

        applySweptResults(
          buildResults(targetSessions, trimmed, messageResults),
          sweptSessionIds,
        );
        return true;
      } catch (searchError) {
        if (requestIdRef.current !== requestId) {
          return false;
        }

        setError(searchErrorMessage(searchError));
        // The sweep produced nothing, so leave the metadata matches standing
        // rather than dropping content matches from an earlier one.
        setResults((current) =>
          mergeSessionSearchResults(current, metadataResults),
        );
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
    [applyInterimResults, applySweptResults, buildResults, queryClient],
  );

  const clear = useCallback(() => {
    requestIdRef.current += 1;
    searchedSessionIdsRef.current = new Set();
    pendingSessionIdsRef.current = new Set();
    activeSearchesRef.current = 0;
    queryRef.current = "";
    submittedSearchRef.current = null;
    setQuery("");
    setSubmittedSearch(null);
    setResults([]);
    setIsSearching(false);
    setError(null);
  }, []);

  const updateQuery = useCallback((nextQuery: string) => {
    // Re-sending the query already held is a no-op. Consumers call this on
    // every sweep trigger, not only on keystrokes — SearchView re-sends the
    // debounced query whenever its swept sessions change — and the reset
    // below would drop the results of the query still on screen and orphan an
    // in-flight sweep for nothing.
    if (nextQuery === queryRef.current) return;

    requestIdRef.current += 1;
    searchedSessionIdsRef.current = new Set();
    pendingSessionIdsRef.current = new Set();
    activeSearchesRef.current = 0;
    // Synced here as well as on render so a submit in the same tick as the
    // update (setQuery("x"); search()) already sees the new query.
    queryRef.current = nextQuery;
    submittedSearchRef.current = null;
    setQuery(nextQuery);
    setSubmittedSearch(null);
    setResults([]);
    setIsSearching(false);
    setError(null);
  }, []);

  const search = useCallback(
    async (explicitQuery?: string) => {
      const trimmed = (explicitQuery ?? queryRef.current).trim();
      if (!trimmed) {
        clear();
        return;
      }

      const targetSessions = sessionsRef.current;
      // Re-running the query already submitted is a re-sweep, not a new
      // search: consumers keying a sweep effect on their sessions land here
      // whenever the list gains, loses, or updates one.
      const mode: SweepMode =
        submittedSearchRef.current?.query === trimmed ? "resweep" : "query";
      const requestId = requestIdRef.current + 1;
      requestIdRef.current = requestId;
      searchedSessionIdsRef.current = new Set(
        targetSessions.map((session) => session.id),
      );
      pendingSessionIdsRef.current = new Set();
      activeSearchesRef.current = 0;

      submittedSearchRef.current = { query: trimmed, requestId };
      setSubmittedSearch({ query: trimmed, requestId });

      await runSearchPage({ requestId, trimmed, targetSessions, mode });
    },
    [clear, runSearchPage],
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
        mode: "page",
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

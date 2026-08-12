import { useCallback, useContext, useRef, useState } from "react";
import { QueryClientContext } from "@tanstack/react-query";
import type { ChatSession } from "@/features/chat/stores/chatSessionStore";
import {
  acpSearchSessions,
  type AcpSessionSearchResult,
} from "@/shared/api/acp";
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

/**
 * Shortest query that gets a conversation-text sweep. Below it only metadata
 * is matched, so anything narrating the search scope must read this rather
 * than assume every submitted query reached message content.
 */
export const SESSION_CONTENT_SEARCH_MIN_CHARS = 2;

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

/** Content-sweep coverage for the submitted query, for narrating progress. */
export type SessionSearchProgress = {
  /** Sessions whose conversation text was actually read and matched. */
  searched: number;
  /**
   * Unique sessions a content sweep has targeted so far (grows with
   * `searchMore`). Counted by id rather than by attempt, so retrying a failed
   * page cannot inflate the denominator past the number of real sessions.
   */
  total: number;
  /**
   * Targeted sessions whose corpus could not be read, so their conversation
   * text is unsearched. Non-zero means the sweep's coverage is partial and
   * "no match" cannot be claimed for these sessions.
   */
  unreadable: number;
};

/**
 * Whether a query reaches conversation text at all. Sessions are only counted
 * toward content coverage when a sweep will really run, so a query too short to
 * sweep reports no coverage instead of a vacuous "n of n".
 */
function sweepsContent(trimmed: string, targetCount: number): boolean {
  return trimmed.length >= SESSION_CONTENT_SEARCH_MIN_CHARS && targetCount > 0;
}

/** What one sweep settled, for callers deciding what may be marked done. */
type SweepOutcome = {
  /** False when the sweep was orphaned by a newer request, or threw. */
  ok: boolean;
  /**
   * Targets whose corpus could not be read. These must not be recorded as
   * searched: a caller that does so filters them out of every later sweep,
   * turning one transient export failure into a permanently hidden session.
   */
  unreadableIds: string[];
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
  // Sweep coverage mirrored into state so consumers can narrate progress —
  // the coverage refs alone never trigger a re-render.
  const [progress, setProgress] = useState<SessionSearchProgress | null>(null);
  const requestIdRef = useRef(0);
  const searchedSessionIdsRef = useRef<Set<string>>(new Set());
  const pendingSessionIdsRef = useRef<Set<string>>(new Set());
  const activeSearchesRef = useRef(0);
  // Coverage behind `progress`, tracked as id sets rather than counters and
  // kept in refs (mirrored into state via `syncProgress`) so concurrent page
  // sweeps can update them without racing through stale state closures.
  //
  // Sets, not tallies: `searchMore` used to add every attempted session to a
  // running total before its sweep, but a failed sweep dropped those ids from
  // pending without ever marking them searched. Retrying the same ids counted
  // them a second time, so the denominator measured attempts instead of
  // sessions and could sit permanently above the numerator ("3 of 4" once all
  // three had in fact been searched). Keyed by id, a retry is idempotent.
  const targetedContentIdsRef = useRef<Set<string>>(new Set());
  const searchedContentIdsRef = useRef<Set<string>>(new Set());
  const unreadableContentIdsRef = useRef<Set<string>>(new Set());
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

  const syncProgress = useCallback(() => {
    setProgress({
      searched: searchedContentIdsRef.current.size,
      total: targetedContentIdsRef.current.size,
      unreadable: unreadableContentIdsRef.current.size,
    });
  }, []);

  const resetCoverage = useCallback(() => {
    targetedContentIdsRef.current = new Set();
    searchedContentIdsRef.current = new Set();
    unreadableContentIdsRef.current = new Set();
  }, []);

  /**
   * Fold one sweep's reported coverage in. A session that failed to export is
   * moved out of `searched` — a later retry can promote it back — so the
   * numerator only ever counts conversations actually read.
   */
  const recordCoverage = useCallback(
    (searchedIds: string[], failedIds: string[]) => {
      for (const id of searchedIds) {
        searchedContentIdsRef.current.add(id);
        unreadableContentIdsRef.current.delete(id);
      }
      for (const id of failedIds) {
        unreadableContentIdsRef.current.add(id);
        searchedContentIdsRef.current.delete(id);
      }
    },
    [],
  );

  const buildResults = useCallback(
    (
      targetSessions: ChatSession[],
      trimmed: string,
      messageResults: AcpSessionSearchResult[] = [],
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
   * The sweep's own results: authoritative only for the sessions whose corpus
   * was actually read — a session that stopped matching disappears — and
   * additive for the rest, so a `searchMore` page merged in while the sweep
   * was running survives it. A target whose corpus could not be read keeps
   * whatever it already had on screen: no successful read established that it
   * stopped matching, so replacing its prior content match (or downgrading it
   * to the metadata-only hit the new build produced) would present a transient
   * export failure as "no longer matches".
   */
  const applySweptResults = useCallback(
    (nextResults: SessionSearchDisplayResult[], searchedIds: Set<string>) => {
      setResults((current) => {
        const currentIds = new Set(current.map((result) => result.session.id));
        return mergeSessionSearchResults(
          current.filter((result) => !searchedIds.has(result.session.id)),
          nextResults.filter(
            (result) =>
              searchedIds.has(result.session.id) ||
              !currentIds.has(result.session.id),
          ),
        );
      });
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
    }): Promise<SweepOutcome> => {
      const metadataResults = buildResults(targetSessions, trimmed);
      const targets = targetSessions.map((session) => ({
        id: session.id,
        stamp: sessionSearchStamp(session),
      }));
      const sweptSessionIds = new Set(targets.map((target) => target.id));

      setError(null);
      applyInterimResults(metadataResults, mode, sweptSessionIds);

      if (!sweepsContent(trimmed, targets.length)) {
        // No content sweep was owed, so there is nothing unread to retry.
        return { ok: true, unreadableIds: [] };
      }

      activeSearchesRef.current += 1;
      setIsSearching(true);

      try {
        const sweep = await acpSearchSessions(trimmed, targets, {
          queryClient,
        });
        if (requestIdRef.current !== requestId) {
          return { ok: false, unreadableIds: [] };
        }

        // Coverage comes from the sweep, not from the target list: the boundary
        // resolves even when individual corpus exports fail, so counting every
        // target as searched here is what let the UI claim it had read
        // conversations it never opened.
        recordCoverage(sweep.searchedIds, sweep.failedIds);
        syncProgress();

        applySweptResults(
          buildResults(targetSessions, trimmed, sweep.results),
          new Set(sweep.searchedIds),
        );
        // Partial coverage still counts as a completed sweep, but the skipped
        // sessions travel back so the caller does not mark them done.
        return { ok: true, unreadableIds: sweep.failedIds };
      } catch (searchError) {
        if (requestIdRef.current !== requestId) {
          return { ok: false, unreadableIds: [] };
        }

        setError(searchErrorMessage(searchError));
        // Nothing was read, so every target of this sweep is unsearched. The
        // ids stay in `targeted`, so a retry promotes them rather than adding
        // a second set of denominators.
        recordCoverage(
          [],
          targets.map((target) => target.id),
        );
        syncProgress();
        // The sweep produced nothing, so leave the metadata matches standing
        // rather than dropping content matches from an earlier one.
        setResults((current) =>
          mergeSessionSearchResults(current, metadataResults),
        );
        return {
          ok: false,
          unreadableIds: targets.map((target) => target.id),
        };
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
    [
      applyInterimResults,
      applySweptResults,
      buildResults,
      queryClient,
      recordCoverage,
      syncProgress,
    ],
  );

  const clear = useCallback(() => {
    requestIdRef.current += 1;
    searchedSessionIdsRef.current = new Set();
    pendingSessionIdsRef.current = new Set();
    activeSearchesRef.current = 0;
    resetCoverage();
    queryRef.current = "";
    submittedSearchRef.current = null;
    setQuery("");
    setSubmittedSearch(null);
    setResults([]);
    setIsSearching(false);
    setError(null);
    setProgress(null);
  }, [resetCoverage]);

  const updateQuery = useCallback(
    (nextQuery: string) => {
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
      resetCoverage();
      // Synced here as well as on render so a submit in the same tick as the
      // update (setQuery("x"); search()) already sees the new query.
      queryRef.current = nextQuery;
      submittedSearchRef.current = null;
      setQuery(nextQuery);
      setSubmittedSearch(null);
      setResults([]);
      setIsSearching(false);
      setError(null);
      setProgress(null);
    },
    [resetCoverage],
  );

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
      // Initial targets are pending, not searched: marking them searched
      // before the sweep settles would exclude any that turn out unreadable
      // from every later `searchMore`, so one transient export failure could
      // hide a matching conversation until a manual resubmit. Completion is
      // recorded from the settled sweep below, exactly as `searchMore` does.
      searchedSessionIdsRef.current = new Set();
      pendingSessionIdsRef.current = new Set(
        targetSessions.map((session) => session.id),
      );
      activeSearchesRef.current = 0;
      resetCoverage();
      // A new query targets exactly the sessions it is about to sweep — and
      // only if it will actually reach conversation text, so a one-character
      // query reports no content coverage rather than a vacuous "n of n".
      if (sweepsContent(trimmed, targetSessions.length)) {
        targetedContentIdsRef.current = new Set(
          targetSessions.map((session) => session.id),
        );
      }
      syncProgress();

      submittedSearchRef.current = { query: trimmed, requestId };
      setSubmittedSearch({ query: trimmed, requestId });

      // Coverage is recorded inside `runSearchPage`, from what the sweep
      // reported reading — never assumed from the target list here.
      const { ok, unreadableIds } = await runSearchPage({
        requestId,
        trimmed,
        targetSessions,
        mode,
      });

      if (requestIdRef.current !== requestId) return;
      // Same settlement rule as `searchMore`: only sessions the sweep really
      // read move to searched. An unreadable target stays out of the set, so
      // the next incremental sweep targets it again instead of filtering it
      // out as already-covered.
      const unreadable = new Set(unreadableIds);
      for (const session of targetSessions) {
        pendingSessionIdsRef.current.delete(session.id);
        if (ok && !unreadable.has(session.id)) {
          searchedSessionIdsRef.current.add(session.id);
        }
      }
    },
    [clear, resetCoverage, runSearchPage, syncProgress],
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
      // Union, not addition: a retry of a previously failed page re-adds ids
      // that are already counted, and `Set` makes that idempotent.
      if (sweepsContent(trimmed, unsearchedSessions.length)) {
        for (const session of unsearchedSessions) {
          targetedContentIdsRef.current.add(session.id);
        }
      }
      syncProgress();

      const { ok, unreadableIds } = await runSearchPage({
        requestId,
        trimmed,
        targetSessions: unsearchedSessions,
        mode: "page",
      });

      if (requestIdRef.current !== requestId) return;
      // A session whose corpus could not be read stays out of the searched set,
      // so the next page sweep targets it again. Marking it done on a partially
      // failed sweep would filter it out of every later sweep and turn one
      // transient export failure into a permanently hidden conversation.
      const unreadable = new Set(unreadableIds);
      for (const session of unsearchedSessions) {
        pendingSessionIdsRef.current.delete(session.id);
        if (ok && !unreadable.has(session.id)) {
          searchedSessionIdsRef.current.add(session.id);
        }
      }
    },
    [runSearchPage, submittedSearch, syncProgress],
  );

  return {
    query,
    submittedQuery,
    results,
    isSearching,
    error,
    progress,
    setQuery: updateQuery,
    search,
    searchMore,
    clear,
  };
}

import { useCallback, useContext, useEffect, useRef, useState } from "react";
import { QueryClientContext } from "@tanstack/react-query";
import type { ChatSession } from "@/features/chat/stores/chatSessionStore";
import { chatSessionFromAcpInfo } from "@/features/chat/lib/acpSessionMapping";
import type {
  AcpSessionInfo,
  AcpSessionSearchResult,
  AcpSessionSearchSweep,
} from "@/shared/api/acp";
import { formatAcpErrorMessage } from "@/shared/api/acpErrors";
import {
  SERVER_CONTENT_SEARCH_MIN_CHARS,
  searchSessionsViaExports,
  sessionSearchStamp,
  type SessionSearchPhase,
  type SessionSearchTarget,
} from "@/shared/api/sessionSearch";
import {
  buildSessionSearchResults,
  mergeSessionSearchResults,
  type SessionSearchDisplayResult,
} from "../lib/buildSessionSearchResults";
import { ContentSweepOwner, raceWithAbort } from "../lib/contentSweeps";
import type { FilterResolvers } from "../lib/filterSessions";

interface UseSessionSearchOptions {
  sessions: ChatSession[];
  resolvers: FilterResolvers;
  locale?: string;
  getDisplayTitle?: (session: ChatSession) => string;
  visibleMetadataOnly?: boolean;
  /** Admission check for server-discovered sessions outside `sessions`. When
   *  the caller's view is a filtered slice of the store (history's scope tab +
   *  project filter), a content hit that fails the check is not surfaced.
   *  Default admits everything. */
  includeDiscoveredSession?: (session: ChatSession) => boolean;
}

/**
 * Shortest query that gets a conversation-text sweep. Below it only metadata
 * is matched, so anything narrating the search scope must read this rather
 * than assume every submitted query reached message content. The value lives
 * at the API boundary; the hook re-exports it so UI copy reads one policy.
 */
export const SESSION_CONTENT_SEARCH_MIN_CHARS = SERVER_CONTENT_SEARCH_MIN_CHARS;

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
  content: boolean;
};

/** Where a content sweep is spending its time. */
export type { SessionSearchPhase };

/** Options for a single search call. */
export interface SessionSearchRunOptions {
  /** Set false to match metadata only: interim results apply and no server
   *  content sweep runs at all. Default true. */
  content?: boolean;
}

class ContentSweepFailure {
  constructor(
    readonly error: unknown,
    readonly timedOut: boolean,
    readonly attemptedTargetIds: ReadonlySet<string>,
  ) {}
}

/**
 * How long one logical sweep may run before the UI settles on what it has.
 * A timed-out page cannot be interrupted on the shared ACP connection, but
 * aborting its signal prevents another page from starting when it settles.
 */
export const SESSION_SEARCH_TIMEOUT_MS = 30_000;

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
  /**
   * Where the sweep is spending its time: still waiting on the server's page
   * walk, or reading sessions the server already matched. Absent once the
   * sweep is no longer running.
   */
  phase?: SessionSearchPhase;
};

/**
 * Whether a query reaches conversation text at all. Content discovery runs
 * server-side over the whole store, so length is the only gate — an empty
 * loaded slice still discovers matches.
 */
function sweepsContent(trimmed: string): boolean {
  return trimmed.length >= SESSION_CONTENT_SEARCH_MIN_CHARS;
}

export function useSessionSearch({
  sessions,
  resolvers,
  locale,
  getDisplayTitle,
  visibleMetadataOnly,
  includeDiscoveredSession,
}: UseSessionSearchOptions) {
  // Optional so provider-less mounts (tests) fall back to uncached exports;
  // with a client, sweeps share one corpus export per (session, stamp) across
  // the search page, the Cmd-K dialog, and history.
  const queryClient = useContext(QueryClientContext);
  const [query, setQuery] = useState("");
  const [submittedSearch, setSubmittedSearch] =
    useState<SubmittedSearch | null>(null);
  const submittedQuery = submittedSearch?.query ?? "";
  const submittedContentSearch =
    submittedSearch?.content === true && sweepsContent(submittedQuery);
  const [results, setResults] = useState<SessionSearchDisplayResult[]>([]);
  const [isSearching, setIsSearching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The last content sweep hit its time budget rather than the server: the
  // status line shows its own copy for that, ahead of the generic failure.
  const [timedOut, setTimedOut] = useState(false);
  // Sweep coverage mirrored into state so consumers can narrate progress —
  // the coverage refs alone never trigger a re-render.
  const [progress, setProgress] = useState<SessionSearchProgress | null>(null);
  const requestIdRef = useRef(0);
  const searchedSessionIdsRef = useRef<Set<string>>(new Set());
  const pendingSessionIdsRef = useRef<Set<string>>(new Set());
  const submittedTargetSessionsRef = useRef<Map<string, ChatSession>>(
    new Map(),
  );
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
  // Server-matched sessions outside the loaded list, kept across the pages of
  // one query so a `searchMore` rebuild cannot drop the rows the query sweep
  // discovered. Cleared with the coverage sets on a new query/clear.
  const syntheticContentSessionsRef = useRef<Map<string, ChatSession>>(
    new Map(),
  );
  // Monotonic generation for overlapping sweeps of one query; only the newest
  // may commit authoritative state (see runSearchPage).
  const sweepGenerationRef = useRef(0);
  const contentSweepOwnerRef = useRef<ContentSweepOwner | null>(null);
  contentSweepOwnerRef.current ??= new ContentSweepOwner();
  const contentSweepOwner = contentSweepOwnerRef.current;
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      requestIdRef.current += 1;
      contentSweepOwner.reset();
    };
  }, [contentSweepOwner]);
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
    includeDiscoveredSession,
  });
  displayOptionsRef.current = {
    resolvers,
    locale,
    getDisplayTitle,
    visibleMetadataOnly,
    includeDiscoveredSession,
  };

  /** True while the newest request may still commit state. */
  const isCurrentRequest = useCallback(
    (requestId: number) =>
      mountedRef.current && requestIdRef.current === requestId,
    [],
  );

  const syncProgress = useCallback(() => {
    setProgress({
      searched: searchedContentIdsRef.current.size,
      total: targetedContentIdsRef.current.size,
      unreadable: unreadableContentIdsRef.current.size,
    });
  }, []);

  /** Overlay the running sweep's phase onto the mirrored coverage. */
  const setProgressPhase = useCallback((phase: SessionSearchPhase) => {
    setProgress((current) => (current ? { ...current, phase } : current));
  }, []);

  const resetCoverage = useCallback(() => {
    targetedContentIdsRef.current = new Set();
    searchedContentIdsRef.current = new Set();
    unreadableContentIdsRef.current = new Set();
  }, []);

  const resetDiscovered = useCallback(() => {
    syntheticContentSessionsRef.current = new Map();
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
      extraSessions?: ChatSession[],
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
          extraSessions,
        },
      );
    },
    [],
  );

  /**
   * ChatSessions for the sessions the server matched, looked up against every
   * session the caller tracks (not only the current sweep's targets, so a page
   * sweep keeps the store's live copies for earlier hits). Sessions the store
   * has never loaded are mapped from the server's metadata, cheaply and
   * without the workspace backfill, and must pass the caller's
   * `includeDiscoveredSession` admission check; archive scope is the caller's
   * decision (History's Archived tab admits archived sessions, Cmd-K does not).
   */
  const mapContentHitSessions = useCallback(
    (matchedInfos: AcpSessionInfo[]): ChatSession[] => {
      const include = displayOptionsRef.current.includeDiscoveredSession;
      const storeById = new Map(
        sessionsRef.current.map((session) => [session.id, session]),
      );
      const hitSessions: ChatSession[] = [];
      for (const info of matchedInfos) {
        const session =
          storeById.get(info.sessionId) ?? chatSessionFromAcpInfo(info);
        if (include && !include(session)) continue;
        hitSessions.push(session);
      }
      return hitSessions;
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
      // drop the ones that left. Server-discovered rows survive too: the
      // fresh answer has not landed, so the last authoritative match set is
      // still the best one on screen.
      const discoveredIds = new Set(syntheticContentSessionsRef.current.keys());
      setResults((current) =>
        mergeSessionSearchResults(
          metadataResults,
          current.filter(
            (result) =>
              sweptSessionIds.has(result.session.id) ||
              discoveredIds.has(result.session.id),
          ),
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
        const enrichedById = new Map(
          current
            .filter((result) => result.snippet)
            .map((result) => [result.session.id, result]),
        );
        return mergeSessionSearchResults(
          current.filter((result) => !searchedIds.has(result.session.id)),
          nextResults
            .filter(
              (result) =>
                searchedIds.has(result.session.id) ||
                !currentIds.has(result.session.id),
            )
            // A still-matching session whose enrichment failed this sweep is
            // rebuilt as a snippet-less placeholder; keep the snippet an
            // earlier successful read produced rather than degrading the row.
            // Message placeholders only: a row that fell back to a metadata
            // match must not keep navigating to the old message.
            .map((result) => {
              if (result.snippet || result.matchType !== "message") {
                return result;
              }
              const enriched = enrichedById.get(result.session.id);
              if (!enriched) return result;
              return {
                ...result,
                snippet: enriched.snippet,
                messageId: enriched.messageId,
                messageRole: enriched.messageRole,
                matchCount: enriched.matchCount,
              };
            }),
        );
      });
    },
    [],
  );

  const abortActiveSweeps = useCallback(() => {
    contentSweepOwner.abort();
  }, [contentSweepOwner]);
  const resetContentSweeps = useCallback(() => {
    contentSweepOwner.reset();
  }, [contentSweepOwner]);

  /** Attach a waiter to the query's raw sweep and settle it, reconciling the
   * server's answer against this caller's target snapshot. Null when this
   * request was superseded or its answer went stale before it applied. */
  const settleContentSweep = useCallback(
    async (
      requestId: number,
      trimmed: string,
      targets: SessionSearchTarget[],
      mode: SweepMode,
    ): Promise<{
      sweep: AcpSessionSearchSweep;
      freshHitIds: Set<string>;
      currentTargetIds: Set<string>;
    } | null> => {
      // Overlapping sweeps of one query (a resweep racing a page load) must
      // not let the slower answer overwrite the newer one: each sweep takes a
      // generation number, and only the latest generation may commit the
      // authoritative match set and its rebuilt rows.
      const sweepGeneration = ++sweepGenerationRef.current;
      let deadlineExpired = false;
      const lease = contentSweepOwner.acquire(trimmed, targets, {
        queryClient,
        onPhaseChange: (phase) => {
          if (isCurrentRequest(requestId)) setProgressPhase(phase);
        },
        targetMode: mode === "page" ? "append" : "replace",
        timeoutMs: SESSION_SEARCH_TIMEOUT_MS,
        onDeadline: () => {
          deadlineExpired = true;
        },
      });
      if (lease.removedTargetIds.size > 0) {
        for (const id of lease.removedTargetIds) {
          syntheticContentSessionsRef.current.delete(id);
          pendingSessionIdsRef.current.delete(id);
          searchedSessionIdsRef.current.delete(id);
        }
        setResults((current) =>
          current.filter(
            (result) => !lease.removedTargetIds.has(result.session.id),
          ),
        );
      }
      try {
        return await lease.awaitSettlement(async (settled) => {
          if (
            lease.signal.aborted ||
            !isCurrentRequest(requestId) ||
            sweepGenerationRef.current !== sweepGeneration
          ) {
            // Aborted by us, or a newer sweep of this query owns the commit.
            return null;
          }

          const freshHitIds = new Set(
            settled.matchedInfos.map((info) => info.sessionId),
          );
          const currentTargetIds = new Set(lease.targetIds);
          for (const id of lease.removedTargetIds) freshHitIds.delete(id);
          // A joined discovery may predate this caller's target snapshot.
          // Read every new/changed target locally, then let that fresh corpus
          // add or remove it from the server snapshot without another walk.
          const enrichmentTargets = lease.joined ? lease.targets : targets;
          const changedTargets = enrichmentTargets.filter(
            (target) => lease.targetStamps.get(target.id) !== target.stamp,
          );
          if (changedTargets.length === 0) {
            return { sweep: settled, freshHitIds, currentTargetIds };
          }

          setProgressPhase("reading");
          const additional = await raceWithAbort(
            searchSessionsViaExports(trimmed, changedTargets, {
              queryClient,
              signal: lease.signal,
              corpusStampGeneration: lease.corpusStampGeneration,
            }),
            lease.signal,
          );
          if (
            !isCurrentRequest(requestId) ||
            sweepGenerationRef.current !== sweepGeneration
          ) {
            return null;
          }

          const additionalResults = new Map(
            additional.results.map((result) => [result.sessionId, result]),
          );
          const resultsById = new Map(
            settled.results.map((result) => [result.sessionId, result]),
          );
          const searchedIds = new Set(settled.searchedIds);
          const failedIds = new Set(settled.failedIds);
          for (const id of additional.searchedIds) {
            searchedIds.add(id);
            failedIds.delete(id);
            resultsById.delete(id);
            if (additionalResults.has(id)) freshHitIds.add(id);
            else freshHitIds.delete(id);
          }
          for (const [id, result] of additionalResults) {
            resultsById.set(id, result);
          }
          for (const id of additional.failedIds) {
            failedIds.add(id);
            searchedIds.delete(id);
          }
          return {
            sweep: {
              ...settled,
              results: [...resultsById.values()],
              searchedIds: [...searchedIds],
              failedIds: [...failedIds],
            },
            freshHitIds,
            currentTargetIds,
          };
        });
      } catch (error) {
        if (
          !isCurrentRequest(requestId) ||
          sweepGenerationRef.current !== sweepGeneration
        ) {
          return null;
        }
        throw new ContentSweepFailure(
          error,
          deadlineExpired,
          new Set(
            [...lease.attemptedTargetIds].filter((id) =>
              pendingSessionIdsRef.current.has(id),
            ),
          ),
        );
      }
    },
    [contentSweepOwner, isCurrentRequest, queryClient, setProgressPhase],
  );

  /** Move a page's sessions from pending to searched from what the sweep
   * settled. A session whose corpus could not be read stays out of the
   * searched set so the next sweep targets it again — marking it done would
   * turn one transient export failure into a permanently hidden
   * conversation. */
  const markSettled = useCallback(
    (
      requestId: number,
      sweptSessions: ChatSession[],
      { ok, unreadableIds }: { ok: boolean; unreadableIds: string[] },
    ) => {
      if (!isCurrentRequest(requestId)) return;
      const unreadable = new Set(unreadableIds);
      for (const session of sweptSessions) {
        pendingSessionIdsRef.current.delete(session.id);
        if (ok && !unreadable.has(session.id)) {
          searchedSessionIdsRef.current.add(session.id);
        } else {
          searchedSessionIdsRef.current.delete(session.id);
        }
      }
    },
    [isCurrentRequest],
  );

  const runSearchPage = useCallback(
    async ({
      requestId,
      trimmed,
      targetSessions,
      mode,
      content = true,
    }: {
      requestId: number;
      trimmed: string;
      targetSessions: ChatSession[];
      mode: SweepMode;
      content?: boolean;
    }): Promise<void> => {
      const metadataResults = buildResults(
        targetSessions,
        trimmed,
        [],
        [...syntheticContentSessionsRef.current.values()],
      );
      const targets = targetSessions.map((session) => ({
        id: session.id,
        stamp: sessionSearchStamp(session),
      }));
      const sweptSessionIds = new Set(targets.map((target) => target.id));

      if (content || mode === "query") {
        setError(null);
        setTimedOut(false);
      }
      applyInterimResults(metadataResults, mode, sweptSessionIds);

      // Content search needs no loaded targets: the server answers for the
      // whole store, so an empty loaded slice (a project filter or archive tab
      // with nothing on screen yet) still discovers matches. A metadata-only
      // run applies the interim results above and never touches the server.
      if (!content || !sweepsContent(trimmed)) {
        markSettled(requestId, targetSessions, {
          ok: true,
          unreadableIds: [],
        });
        return;
      }

      activeSearchesRef.current += 1;
      setIsSearching(true);

      try {
        const settled = await settleContentSweep(
          requestId,
          trimmed,
          targets,
          mode,
        );
        if (!settled) return;
        const { sweep, freshHitIds, currentTargetIds } = settled;

        setProgressPhase("reading");
        const ownerSessions = [
          ...submittedTargetSessionsRef.current.values(),
        ].filter((session) => currentTargetIds.has(session.id));
        const ownerSessionIds = new Set(
          ownerSessions.map((session) => session.id),
        );
        const hitSessions = mapContentHitSessions(
          sweep.matchedInfos.filter((info) => freshHitIds.has(info.sessionId)),
        );
        const mappedHitIds = new Set(hitSessions.map((session) => session.id));
        const include = displayOptionsRef.current.includeDiscoveredSession;
        for (const session of ownerSessions) {
          if (
            freshHitIds.has(session.id) &&
            !mappedHitIds.has(session.id) &&
            (!include || include(session))
          ) {
            hitSessions.push(session);
          }
        }
        const hitIds = new Set(hitSessions.map((session) => session.id));

        // Union the page's targets with every admitted server match; loaded
        // sessions win over mapped copies (live store state).
        const extras = hitSessions.filter(
          (session) => !ownerSessionIds.has(session.id),
        );
        const unionSessions = [...ownerSessions, ...extras];

        // Swap the retained match set for the fresh one, remembering the ids
        // it replaces: a match the server no longer returns must leave the
        // screen, and only naming it here can invalidate its old row.
        const previousHitIds = new Set(
          syntheticContentSessionsRef.current.keys(),
        );
        syntheticContentSessionsRef.current = new Map(
          hitSessions.map((session) => [session.id, session]),
        );

        const failedTargetIds = sweep.failedIds.filter((id) =>
          currentTargetIds.has(id),
        );
        recordCoverage(
          sweep.searchedIds.filter((id) => currentTargetIds.has(id)),
          failedTargetIds,
        );
        syncProgress();

        // Every admitted match rows as a content hit; export enrichment only
        // overlays snippet/messageId/matchCount where it succeeded. A match
        // with no enrichment keeps a snippet-less content row rather than
        // vanishing behind a transient export failure.
        const enrichmentById = new Map(
          sweep.results.map((result) => [result.sessionId, result]),
        );
        const messageResults: AcpSessionSearchResult[] = hitSessions.map(
          (session) =>
            enrichmentById.get(session.id) ?? {
              sessionId: session.id,
              snippet: "",
              messageId: "",
              matchCount: 0,
            },
        );

        // Replace content state for everything this answer speaks for: every
        // target the server searched (matched or not — an unmatched target
        // has provably lost any prior content row), every admitted match, and
        // every previously retained match (its absence from the fresh set
        // removes its row). Rows outside the set survive untouched.
        applySweptResults(
          buildResults(unionSessions, trimmed, messageResults),
          new Set([...currentTargetIds, ...hitIds, ...previousHitIds]),
        );
        markSettled(requestId, ownerSessions, {
          ok: true,
          unreadableIds: failedTargetIds,
        });
      } catch (searchError) {
        if (!isCurrentRequest(requestId)) return;
        const failure =
          searchError instanceof ContentSweepFailure
            ? searchError
            : new ContentSweepFailure(
                searchError,
                false,
                new Set(targets.map((target) => target.id)),
              );
        const isTimeout = failure.timedOut;

        // The deadline is a budget, not a backend failure: it gets its own
        // copy via `timedOut`, and the interim results stay exactly as the
        // staleness rules left them. The in-flight page drains, observes the
        // aborted signal, and starts no successor page.
        setError(
          isTimeout
            ? "Session search timed out"
            : searchErrorMessage(failure.error),
        );
        setTimedOut(isTimeout);
        const targetIds = [...failure.attemptedTargetIds];
        recordCoverage([], isTimeout ? [] : targetIds);
        syncProgress();
        if (!isTimeout) {
          // The sweep produced nothing, so leave the metadata matches
          // standing rather than dropping content matches from an earlier
          // one.
          setResults((current) =>
            mergeSessionSearchResults(current, metadataResults),
          );
        }
        const attemptedSessions = new Map(
          [...submittedTargetSessionsRef.current.values(), ...targetSessions]
            .filter((session) => failure.attemptedTargetIds.has(session.id))
            .map((session) => [session.id, session]),
        );
        markSettled(requestId, [...attemptedSessions.values()], {
          ok: false,
          unreadableIds: isTimeout ? [] : targetIds,
        });
      } finally {
        if (isCurrentRequest(requestId)) {
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
      isCurrentRequest,
      mapContentHitSessions,
      markSettled,
      recordCoverage,
      setProgressPhase,
      settleContentSweep,
      syncProgress,
    ],
  );

  const resetForQuery = useCallback(
    (nextQuery: string) => {
      requestIdRef.current += 1;
      resetContentSweeps();
      searchedSessionIdsRef.current = new Set();
      pendingSessionIdsRef.current = new Set();
      submittedTargetSessionsRef.current = new Map();
      activeSearchesRef.current = 0;
      resetCoverage();
      resetDiscovered();
      // A submit in this tick must already read the new query from the ref.
      queryRef.current = nextQuery;
      submittedSearchRef.current = null;
      setQuery(nextQuery);
      setSubmittedSearch(null);
      setResults([]);
      setIsSearching(false);
      setError(null);
      setTimedOut(false);
      setProgress(null);
    },
    [resetContentSweeps, resetCoverage, resetDiscovered],
  );

  const clear = useCallback(() => resetForQuery(""), [resetForQuery]);

  const updateQuery = useCallback(
    (nextQuery: string) => {
      // Session-list effects re-send the current query; resetting it would
      // discard valid results and orphan its in-flight sweep.
      if (nextQuery === queryRef.current) return;
      resetForQuery(nextQuery);
    },
    [resetForQuery],
  );

  const search = useCallback(
    async (explicitQuery?: string, options?: SessionSearchRunOptions) => {
      const content = options?.content !== false;
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
      const targetIds = new Set(targetSessions.map((session) => session.id));
      if (!content && mode === "resweep") {
        for (const id of submittedTargetSessionsRef.current.keys()) {
          if (!targetIds.has(id))
            syntheticContentSessionsRef.current.delete(id);
        }
      }
      submittedTargetSessionsRef.current = new Map(
        targetSessions.map((session) => [session.id, session]),
      );
      const requestId = requestIdRef.current + 1;
      requestIdRef.current = requestId;
      if (!content || !sweepsContent(trimmed)) {
        abortActiveSweeps();
        setIsSearching(false);
      }
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
      // A new query abandons the previous server answer; a resweep keeps it
      // until the fresh one lands, so discovered rows don't blink out (and a
      // failed resweep can't lose them).
      if (mode === "query") {
        resetDiscovered();
      }
      // A new query targets exactly the sessions it is about to sweep — and
      // only if it will actually reach conversation text, so a one-character
      // or metadata-only query reports no content coverage rather than a
      // vacuous "n of n".
      if (content && sweepsContent(trimmed)) {
        targetedContentIdsRef.current = new Set(
          targetSessions.map((session) => session.id),
        );
      }
      syncProgress();

      submittedSearchRef.current = { query: trimmed, requestId, content };
      setSubmittedSearch({ query: trimmed, requestId, content });

      // Coverage is recorded inside `runSearchPage`, from what the sweep
      // reported reading — never assumed from the target list here.
      await runSearchPage({
        requestId,
        trimmed,
        targetSessions,
        mode,
        content,
      });
    },
    [
      abortActiveSweeps,
      clear,
      resetCoverage,
      resetDiscovered,
      runSearchPage,
      syncProgress,
    ],
  );

  const searchMore = useCallback(
    async (nextSessions: ChatSession[]) => {
      if (
        !submittedSearch ||
        requestIdRef.current !== submittedSearch.requestId
      ) {
        return;
      }

      const { query: trimmed, requestId, content } = submittedSearch;
      if (!trimmed) return;

      const changedSessionIds = new Set<string>();
      for (const session of nextSessions) {
        const previous = submittedTargetSessionsRef.current.get(session.id);
        if (
          previous &&
          sessionSearchStamp(previous) !== sessionSearchStamp(session)
        ) {
          changedSessionIds.add(session.id);
        }
        submittedTargetSessionsRef.current.set(session.id, session);
      }
      const unsearchedSessions = nextSessions.filter(
        (session) =>
          changedSessionIds.has(session.id) ||
          (!searchedSessionIdsRef.current.has(session.id) &&
            !pendingSessionIdsRef.current.has(session.id)),
      );
      if (unsearchedSessions.length === 0) {
        return;
      }

      for (const session of unsearchedSessions) {
        pendingSessionIdsRef.current.add(session.id);
      }
      // Union, not addition: a retry of a previously failed page re-adds ids
      // that are already counted, and `Set` makes that idempotent.
      if (content && sweepsContent(trimmed)) {
        for (const session of unsearchedSessions) {
          targetedContentIdsRef.current.add(session.id);
        }
      }
      syncProgress();

      await runSearchPage({
        requestId,
        trimmed,
        targetSessions: unsearchedSessions,
        mode: "page",
        content,
      });
    },
    [runSearchPage, submittedSearch, syncProgress],
  );

  return {
    query,
    submittedQuery,
    submittedContentSearch,
    results,
    isSearching,
    error,
    timedOut,
    progress,
    setQuery: updateQuery,
    search,
    searchMore,
    clear,
  };
}

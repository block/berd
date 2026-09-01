import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import { createElement, type ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatSession } from "@/features/chat/stores/chatSessionStore";
import type { FilterResolvers } from "@/features/sessions/lib/filterSessions";

const mockAcpSearchSessions = vi.fn();
type MessageSearchResult = {
  sessionId: string;
  snippet: string;
  messageId: string;
  matchCount: number;
};

type SearchSweep = {
  results: MessageSearchResult[];
  searchedIds: string[];
  failedIds: string[];
  /** Server-discovered match set; production always returns it for a content
   *  query. Tests model it explicitly: any session the server matched, whether
   *  or not it is also an enrichment target. */
  matchedInfos: MatchedInfo[];
};

type MatchedInfo = {
  sessionId: string;
  title: string;
  updatedAt: string;
  createdAt: string | null;
  lastMessageAt: string | null;
  archivedAt: string | null;
  userSetName: boolean;
  messageCount: number;
  subtitle: string | null;
  workingDir: string | null;
  projectId: string | null;
  providerId: string | null;
  modelId: string | null;
  personaId: string | null;
};

function matchedInfo(sessionId: string, title = "Server match"): MatchedInfo {
  return {
    sessionId,
    title,
    updatedAt: "2026-04-12T12:00:00Z",
    createdAt: "2026-04-12T12:00:00Z",
    lastMessageAt: null,
    archivedAt: null,
    userSetName: false,
    messageCount: 3,
    subtitle: "preview text",
    workingDir: null,
    projectId: null,
    providerId: null,
    modelId: null,
    personaId: null,
  };
}

/**
 * A sweep where the server matched every target it was handed. Production
 * searchedIds are exactly the matched targets that were export-read, so
 * modeling all targets as matched and read is the reachable shape.
 */
function sweptAll(results: MessageSearchResult[] = []) {
  return async (
    _query: string,
    targets: { id: string }[],
  ): Promise<SearchSweep> => ({
    results,
    searchedIds: targets.map((target) => target.id),
    failedIds: [],
    matchedInfos: targets.map((target) => matchedInfo(target.id)),
  });
}

/**
 * An explicit sweep result, for deferred mocks that cannot see their targets.
 * `searchedIds` must name the sessions this sweep actually covered, and every
 * searched id must also appear in `matchedInfos` — the boundary only reads
 * targets the server matched.
 */
function sweep(
  searchedIds: string[],
  results: MessageSearchResult[] = [],
  matchedInfos: MatchedInfo[] = searchedIds.map((id) => matchedInfo(id)),
): SearchSweep {
  return { results, searchedIds, failedIds: [], matchedInfos };
}

vi.mock("@/shared/api/acp", () => ({
  acpSearchSessions: (...args: unknown[]) => mockAcpSearchSessions(...args),
}));

import { useSessionSearch } from "../useSessionSearch";

function createDeferredPromise<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

const sessions: ChatSession[] = [
  {
    id: "acp-1",
    title: "Needle notes",
    createdAt: "2026-04-10T12:00:00Z",
    updatedAt: "2026-04-10T12:00:00Z",
    messageCount: 1,
  },
];

const newerSession: ChatSession = {
  id: "acp-2",
  title: "Needle follow-up",
  createdAt: "2026-04-11T12:00:00Z",
  updatedAt: "2026-04-11T12:00:00Z",
  messageCount: 1,
};

const oldQueryOnlySession: ChatSession = {
  id: "acp-3",
  title: "Needle archive",
  createdAt: "2026-04-12T12:00:00Z",
  updatedAt: "2026-04-12T12:00:00Z",
  messageCount: 1,
};

const resolvers = {
  getPersonaName: () => undefined,
  getProjectName: () => undefined,
};

interface SessionSearchProps {
  currentSessions: ChatSession[];
  currentResolvers?: FilterResolvers;
}

function renderSessionSearch(hookSessions = sessions) {
  const queryClient = new QueryClient();
  return renderHook<ReturnType<typeof useSessionSearch>, SessionSearchProps>(
    ({ currentSessions, currentResolvers = resolvers }) =>
      useSessionSearch({
        sessions: currentSessions,
        resolvers: currentResolvers,
      }),
    {
      initialProps: { currentSessions: hookSessions },
      wrapper: ({ children }: { children: ReactNode }) =>
        createElement(QueryClientProvider, { client: queryClient }, children),
    },
  );
}

function searchTarget(session: ChatSession) {
  return {
    id: session.id,
    stamp: `${session.updatedAt}:${session.messageCount}:`,
  };
}

const searchOptions = { queryClient: expect.any(QueryClient) };

type SearchHookResult = ReturnType<typeof renderSessionSearch>["result"];

async function setSearchQuery(result: SearchHookResult, query: string) {
  await act(async () => {
    result.current.setQuery(query);
  });
}

async function submitCurrentSearch(result: SearchHookResult) {
  await act(async () => {
    await result.current.search();
  });
}

async function searchFor(result: SearchHookResult, query: string) {
  await setSearchQuery(result, query);
  await submitCurrentSearch(result);
}

async function searchMore(
  result: SearchHookResult,
  nextSessions: ChatSession[],
) {
  await act(async () => {
    await result.current.searchMore(nextSessions);
  });
}

describe("useSessionSearch", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("clears the loading state when a short query skips backend search", async () => {
    const deferred = createDeferredPromise<SearchSweep>();
    mockAcpSearchSessions.mockReturnValueOnce(deferred.promise);

    const { result } = renderSessionSearch();

    await setSearchQuery(result, "needle");
    await act(async () => {
      void result.current.search();
    });

    expect(result.current.isSearching).toBe(true);

    await searchFor(result, "n");

    expect(result.current.isSearching).toBe(false);
    expect(result.current.submittedQuery).toBe("n");

    deferred.resolve(sweep(["acp-1"]));
    await act(async () => {
      await deferred.promise;
    });

    expect(result.current.isSearching).toBe(false);
  });

  it("searches only new sessions incrementally and merges message results newest first", async () => {
    // The server answers with the full match set on every call, not only the
    // page's targets: page two's set includes acp-1 again.
    mockAcpSearchSessions
      .mockImplementationOnce(sweptAll())
      .mockImplementationOnce(async () => ({
        results: [
          {
            sessionId: "acp-2",
            snippet: "needle in message",
            messageId: "message-2",
            matchCount: 2,
          },
        ],
        searchedIds: ["acp-2"],
        failedIds: [],
        matchedInfos: [matchedInfo("acp-1"), matchedInfo("acp-2")],
      }));

    const { result } = renderSessionSearch();

    await searchFor(result, "needle");
    await searchMore(result, [...sessions, newerSession]);
    await searchMore(result, [newerSession]);

    expect(mockAcpSearchSessions).toHaveBeenNthCalledWith(
      1,
      "needle",
      [searchTarget(sessions[0])],
      searchOptions,
    );
    expect(mockAcpSearchSessions).toHaveBeenNthCalledWith(
      2,
      "needle",
      [searchTarget(newerSession)],
      searchOptions,
    );
    expect(mockAcpSearchSessions).toHaveBeenCalledTimes(2);
    expect(result.current.results.map((item) => item.session.id)).toEqual([
      "acp-2",
      "acp-1",
    ]);
    expect(result.current.results[0]).toMatchObject({
      matchType: "message",
      snippet: "needle in message",
      messageId: "message-2",
      matchCount: 2,
    });
  });

  it("ignores stale incremental searches from an old submitted query", async () => {
    mockAcpSearchSessions.mockImplementation(sweptAll());

    const { result } = renderSessionSearch();

    await searchFor(result, "needle");
    const staleSearchMore = result.current.searchMore;

    // "follow" matches nothing on the server: an empty match set.
    mockAcpSearchSessions.mockImplementationOnce(async () => ({
      results: [],
      searchedIds: [],
      failedIds: [],
      matchedInfos: [],
    }));
    await searchFor(result, "follow");
    await act(async () => {
      await staleSearchMore([oldQueryOnlySession]);
    });

    expect(mockAcpSearchSessions).toHaveBeenCalledTimes(2);
    expect(result.current.submittedQuery).toBe("follow");
    expect(result.current.results).toEqual([]);
  });

  it("ignores stale incremental responses after clear", async () => {
    const deferred = createDeferredPromise<SearchSweep>();
    mockAcpSearchSessions
      .mockImplementationOnce(sweptAll())
      .mockReturnValueOnce(deferred.promise);

    const { result } = renderSessionSearch();

    await searchFor(result, "needle");
    await act(async () => {
      void result.current.searchMore([newerSession]);
    });
    await waitFor(() => {
      expect(result.current.isSearching).toBe(true);
    });

    await act(async () => {
      result.current.clear();
    });
    deferred.resolve(
      sweep(
        ["acp-2"],
        [
          {
            sessionId: "acp-2",
            snippet: "stale",
            messageId: "message-2",
            matchCount: 1,
          },
        ],
      ),
    );
    await act(async () => {
      await deferred.promise;
    });

    expect(result.current.results).toEqual([]);
    expect(result.current.isSearching).toBe(false);
  });

  it("keeps search identity stable when the sessions array churns", async () => {
    const { result, rerender } = renderSessionSearch();
    const initialSearch = result.current.search;
    const initialSearchMore = result.current.searchMore;

    rerender({
      currentSessions: sessions.map((session) => ({ ...session })),
    });

    expect(result.current.search).toBe(initialSearch);
    expect(result.current.searchMore).toBe(initialSearchMore);
  });

  it("keeps search identity stable when the resolvers churn", async () => {
    const { result, rerender } = renderSessionSearch();
    const initialSearch = result.current.search;
    const initialSearchMore = result.current.searchMore;

    // A persona or project refresh rebuilds the resolvers object without
    // changing what it resolves.
    rerender({
      currentSessions: sessions,
      currentResolvers: {
        getPersonaName: () => undefined,
        getProjectName: () => undefined,
      },
    });

    expect(result.current.search).toBe(initialSearch);
    expect(result.current.searchMore).toBe(initialSearchMore);
  });

  it("builds results with the resolvers from the latest render", async () => {
    mockAcpSearchSessions.mockImplementation(sweptAll());
    const personaSession: ChatSession = {
      ...sessions[0],
      title: "Untitled",
      personaId: "persona-1",
    };
    const { result, rerender } = renderSessionSearch([personaSession]);

    rerender({
      currentSessions: [personaSession],
      currentResolvers: {
        getPersonaName: () => "Reviewer",
        getProjectName: () => undefined,
      },
    });
    await searchFor(result, "reviewer");

    expect(result.current.results.map(({ session }) => session.id)).toEqual([
      personaSession.id,
    ]);
  });

  it("searches the sessions from the latest render, not the first", async () => {
    mockAcpSearchSessions.mockImplementation(sweptAll());
    const { result, rerender } = renderSessionSearch();

    rerender({ currentSessions: [...sessions, newerSession] });
    await searchFor(result, "needle");

    expect(mockAcpSearchSessions).toHaveBeenCalledWith(
      "needle",
      [searchTarget(sessions[0]), searchTarget(newerSession)],
      searchOptions,
    );
  });

  it("keeps content matches on screen while a re-sweep of the same query runs", async () => {
    // A session that only matches on message content: rebuilding the results
    // without the sweep's output drops it entirely.
    const contentOnlySession: ChatSession = {
      id: "acp-9",
      title: "Untitled",
      createdAt: "2026-04-10T12:00:00Z",
      updatedAt: "2026-04-10T12:00:00Z",
      messageCount: 1,
    };
    const messageMatch = {
      sessionId: "acp-9",
      snippet: "needle in message",
      messageId: "message-9",
      matchCount: 1,
    };
    mockAcpSearchSessions.mockImplementationOnce(sweptAll([messageMatch]));

    const { result } = renderSessionSearch([contentOnlySession]);
    await searchFor(result, "needle");

    expect(result.current.results[0]).toMatchObject({
      matchType: "message",
      snippet: "needle in message",
    });

    // A membership change re-sends the same query and re-sweeps: the row must
    // not blink out while the sweep is in flight.
    const deferred = createDeferredPromise<SearchSweep>();
    mockAcpSearchSessions.mockReturnValueOnce(deferred.promise);
    await setSearchQuery(result, "needle");
    await act(async () => {
      void result.current.search();
    });

    expect(result.current.isSearching).toBe(true);
    expect(result.current.results[0]).toMatchObject({
      matchType: "message",
      snippet: "needle in message",
    });

    deferred.resolve(sweep(["acp-9"], [messageMatch]));
    await act(async () => {
      await deferred.promise;
    });

    expect(result.current.results.map((item) => item.session.id)).toEqual([
      "acp-9",
    ]);
  });

  it("drops results for sessions that left the list on a re-sweep", async () => {
    mockAcpSearchSessions.mockImplementation(sweptAll());
    const { result, rerender } = renderSessionSearch([
      sessions[0],
      newerSession,
    ]);

    await searchFor(result, "needle");
    expect(result.current.results.map((item) => item.session.id)).toEqual([
      "acp-2",
      "acp-1",
    ]);

    rerender({ currentSessions: [sessions[0]] });
    await submitCurrentSearch(result);

    expect(result.current.results.map((item) => item.session.id)).toEqual([
      "acp-1",
    ]);
  });

  it("reports null progress before a search is submitted", () => {
    const { result } = renderSessionSearch();

    expect(result.current.progress).toBeNull();
  });

  it("starts progress at 0 of total when a search is submitted", async () => {
    const deferred = createDeferredPromise<SearchSweep>();
    mockAcpSearchSessions.mockReturnValueOnce(deferred.promise);

    const { result } = renderSessionSearch([sessions[0], newerSession]);

    await setSearchQuery(result, "needle");
    await act(async () => {
      void result.current.search();
    });

    expect(result.current.isSearching).toBe(true);
    expect(result.current.progress).toEqual({
      searched: 0,
      total: 2,
      unreadable: 0,
    });

    deferred.resolve(sweep(["acp-1", "acp-2"]));
    await act(async () => {
      await deferred.promise;
    });

    expect(result.current.progress).toEqual({
      searched: 2,
      total: 2,
      unreadable: 0,
    });
  });

  it("grows progress as incremental sweeps are queued and complete", async () => {
    mockAcpSearchSessions.mockImplementationOnce(sweptAll());

    const { result } = renderSessionSearch();

    await searchFor(result, "needle");
    expect(result.current.progress).toEqual({
      searched: 1,
      total: 1,
      unreadable: 0,
    });

    const deferred = createDeferredPromise<SearchSweep>();
    mockAcpSearchSessions.mockReturnValueOnce(deferred.promise);
    await act(async () => {
      void result.current.searchMore([...sessions, newerSession]);
    });

    expect(result.current.progress).toEqual({
      searched: 1,
      total: 2,
      unreadable: 0,
    });

    deferred.resolve(sweep(["acp-2"]));
    await act(async () => {
      await deferred.promise;
    });

    expect(result.current.progress).toEqual({
      searched: 2,
      total: 2,
      unreadable: 0,
    });
  });

  // The boundary resolves even when individual corpus exports fail, so a sweep
  // that "succeeded" can still have skipped conversations. Counting those as
  // searched is what let the UI present a false negative as authoritative.
  it("does not count sessions whose corpus could not be read", async () => {
    mockAcpSearchSessions.mockImplementationOnce(
      async (): Promise<SearchSweep> => ({
        results: [],
        searchedIds: ["acp-1"],
        failedIds: ["acp-2"],
        matchedInfos: [matchedInfo("acp-1"), matchedInfo("acp-2")],
      }),
    );

    const { result } = renderSessionSearch([sessions[0], newerSession]);

    await searchFor(result, "needle");

    // One of the two conversations was never read: coverage is 1 of 2, and the
    // unread one is reported rather than folded into the searched count.
    expect(result.current.progress).toEqual({
      searched: 1,
      total: 2,
      unreadable: 1,
    });
  });

  it("promotes a session to searched when a retry reads it", async () => {
    mockAcpSearchSessions
      .mockImplementationOnce(
        async (): Promise<SearchSweep> => ({
          results: [],
          searchedIds: [],
          failedIds: ["acp-1"],
          matchedInfos: [matchedInfo("acp-1")],
        }),
      )
      .mockImplementationOnce(sweptAll());

    const { result } = renderSessionSearch();

    await searchFor(result, "needle");
    expect(result.current.progress).toEqual({
      searched: 0,
      total: 1,
      unreadable: 1,
    });

    // Re-submitting the same query re-sweeps; a successful read must clear the
    // unreadable flag rather than leaving a permanent gap.
    await submitCurrentSearch(result);
    expect(result.current.progress).toEqual({
      searched: 1,
      total: 1,
      unreadable: 0,
    });
  });

  // Regression: `searchMore` used to add every attempted session to a running
  // total, but a failed sweep dropped those ids without marking them searched.
  // Retrying them counted them twice, so the denominator measured attempts and
  // could sit permanently above the numerator.
  it("counts unique sessions in progress when a failed page is retried", async () => {
    const thirdSession: ChatSession = {
      id: "acp-3",
      title: "Needle third",
      createdAt: "2026-04-12T12:00:00Z",
      updatedAt: "2026-04-12T12:00:00Z",
      messageCount: 1,
    };

    mockAcpSearchSessions
      // Initial sweep of acp-1 succeeds.
      .mockImplementationOnce(sweptAll())
      // The page adding acp-2 fails outright.
      .mockImplementationOnce(async () => {
        throw new Error("sweep failed");
      })
      // The retry covers acp-2 together with acp-3.
      .mockImplementationOnce(sweptAll());

    const { result } = renderSessionSearch();

    await searchFor(result, "needle");
    expect(result.current.progress).toEqual({
      searched: 1,
      total: 1,
      unreadable: 0,
    });

    await searchMore(result, [...sessions, newerSession]);
    expect(result.current.progress).toEqual({
      searched: 1,
      total: 2,
      unreadable: 1,
    });

    await searchMore(result, [...sessions, newerSession, thirdSession]);

    // Three real sessions, all now read: the retry must not have counted acp-2
    // a second time and left an unreachable "3 of 4".
    expect(result.current.progress).toEqual({
      searched: 3,
      total: 3,
      unreadable: 0,
    });
  });

  // Regression: a partially failed page sweep still resolves, so marking every
  // session in it as searched filtered the unread one out of all later sweeps —
  // one transient export failure hid a matching conversation for good.
  it("re-targets a page session whose corpus could not be read", async () => {
    const messageMatch = {
      sessionId: "acp-2",
      snippet: "needle in message",
      messageId: "message-2",
      matchCount: 1,
    };
    mockAcpSearchSessions
      // Initial sweep of acp-1.
      .mockImplementationOnce(sweptAll())
      // The page carrying acp-2 resolves, but its corpus could not be read.
      .mockImplementationOnce(
        async (): Promise<SearchSweep> => ({
          results: [],
          searchedIds: [],
          failedIds: ["acp-2"],
          matchedInfos: [matchedInfo("acp-2")],
        }),
      )
      // The next page sweep must target acp-2 again, and this time it reads.
      .mockImplementationOnce(sweptAll([messageMatch]));

    const { result } = renderSessionSearch();

    await searchFor(result, "needle");
    await searchMore(result, [...sessions, newerSession]);

    expect(result.current.progress).toEqual({
      searched: 1,
      total: 2,
      unreadable: 1,
    });

    // Same session list again: acp-2 was never read, so it must not have been
    // filtered out as already-searched.
    await searchMore(result, [...sessions, newerSession]);

    expect(mockAcpSearchSessions).toHaveBeenNthCalledWith(
      3,
      "needle",
      [searchTarget(newerSession)],
      searchOptions,
    );
    expect(result.current.progress).toEqual({
      searched: 2,
      total: 2,
      unreadable: 0,
    });
    expect(result.current.results.map((item) => item.session.id)).toContain(
      "acp-2",
    );
  });

  // Regression: applySweptResults treated every *target* of a sweep as
  // authoritative, so a resweep whose export failed for one session removed
  // that session's previously established content match — presenting a
  // transient read failure as "no longer matches".
  it("keeps a prior content match when a resweep cannot read that corpus", async () => {
    const messageMatch = {
      sessionId: "acp-1",
      snippet: "needle in message",
      messageId: "message-1",
      matchCount: 1,
    };
    const contentOnlySession: ChatSession = {
      ...sessions[0],
      // Title does not match the query, so the session can only appear as a
      // content match — the discriminating case, since a metadata hit would
      // mask the removal.
      title: "Untitled",
    };
    mockAcpSearchSessions
      // Initial sweep reads the corpus and finds the content match.
      .mockImplementationOnce(sweptAll([messageMatch]))
      // Same-query resweep resolves, but this corpus could not be read.
      .mockImplementationOnce(
        async (): Promise<SearchSweep> => ({
          results: [],
          searchedIds: [],
          failedIds: ["acp-1"],
          matchedInfos: [matchedInfo("acp-1")],
        }),
      );

    const { result } = renderSessionSearch([contentOnlySession]);

    await searchFor(result, "needle");
    expect(result.current.results.map((item) => item.session.id)).toEqual([
      "acp-1",
    ]);

    // Re-submitting the same query is a resweep of the session on screen.
    await submitCurrentSearch(result);

    // No successful read established that it stopped matching, so the match
    // stays — with its content snippet, not downgraded — and the coverage
    // narration owns the gap instead.
    expect(result.current.results.map((item) => item.session.id)).toEqual([
      "acp-1",
    ]);
    expect(result.current.results[0]?.snippet).toBe("needle in message");
    expect(result.current.progress).toEqual({
      searched: 0,
      total: 1,
      unreadable: 1,
    });
  });

  // Regression: `search` pre-marked every initial target as searched before
  // the sweep settled, so an initial target whose corpus could not be read was
  // filtered out of every later `searchMore` — unlike the identical failure on
  // a paged-in session, which stayed retryable.
  it("re-targets an initial session whose corpus could not be read", async () => {
    const messageMatch = {
      sessionId: "acp-1",
      snippet: "needle in message",
      messageId: "message-1",
      matchCount: 1,
    };
    mockAcpSearchSessions
      // The initial sweep resolves, but acp-1's corpus could not be read.
      .mockImplementationOnce(
        async (): Promise<SearchSweep> => ({
          results: [],
          searchedIds: [],
          failedIds: ["acp-1"],
          matchedInfos: [matchedInfo("acp-1")],
        }),
      )
      // The next incremental sweep must target acp-1 again, and it reads.
      .mockImplementationOnce(sweptAll([messageMatch]));

    const { result } = renderSessionSearch();

    await searchFor(result, "needle");
    expect(result.current.progress).toEqual({
      searched: 0,
      total: 1,
      unreadable: 1,
    });

    // Same loaded set — no new sessions. The unreadable initial target must
    // still be eligible, exactly like a failed paged-in target.
    await searchMore(result, sessions);

    expect(mockAcpSearchSessions).toHaveBeenNthCalledWith(
      2,
      "needle",
      [searchTarget(sessions[0])],
      searchOptions,
    );
    expect(result.current.progress).toEqual({
      searched: 1,
      total: 1,
      unreadable: 0,
    });
    expect(result.current.results.map((item) => item.session.id)).toContain(
      "acp-1",
    );
  });

  it("resets progress to null on clear and on a query update", async () => {
    mockAcpSearchSessions.mockImplementation(sweptAll());

    const { result } = renderSessionSearch();

    await searchFor(result, "needle");
    expect(result.current.progress).toEqual({
      searched: 1,
      total: 1,
      unreadable: 0,
    });

    await act(async () => {
      result.current.clear();
    });
    expect(result.current.progress).toBeNull();

    await searchFor(result, "needle");
    expect(result.current.progress).toEqual({
      searched: 1,
      total: 1,
      unreadable: 0,
    });

    await setSearchQuery(result, "other");
    expect(result.current.progress).toBeNull();
  });

  it("surfaces ACP error data for backend search failures", async () => {
    const error = new Error("Internal error") as Error & { data: string };
    error.name = "RequestError";
    error.data = "Failed to export session for search: session missing";
    mockAcpSearchSessions.mockRejectedValueOnce(error);

    const { result } = renderSessionSearch();

    await searchFor(result, "needle");

    expect(result.current.error).toBe(
      "Failed to export session for search: session missing",
    );
  });
});

function serverSweep(
  matchedInfos: MatchedInfo[],
  searchedIds: string[],
  results: MessageSearchResult[] = [],
  failedIds: string[] = [],
): SearchSweep {
  return { results, searchedIds, failedIds, matchedInfos };
}

describe("server-side discovery", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("surfaces content matches for sessions that are not loaded", async () => {
    mockAcpSearchSessions.mockResolvedValueOnce(
      serverSweep([matchedInfo("acp-1"), matchedInfo("old-1")], ["acp-1"]),
    );

    const { result } = renderSessionSearch();
    await searchFor(result, "needle");

    expect(result.current.results.map((item) => item.session.id)).toEqual([
      "old-1",
      "acp-1",
    ]);
    const discovered = result.current.results.find(
      (item) => item.session.id === "old-1",
    );
    // A server-discovered match rows as a content hit with no client-derived
    // snippet until its corpus is exported.
    expect(discovered).toMatchObject({
      matchType: "message",
      session: { id: "old-1", title: "Server match" },
    });
    expect(discovered?.snippet).toBeUndefined();
    expect(discovered?.messageId).toBeUndefined();
  });

  it("drops a loaded content match the server no longer matches", async () => {
    const contentOnlySession: ChatSession = {
      id: "acp-9",
      title: "Untitled",
      createdAt: "2026-04-10T12:00:00Z",
      updatedAt: "2026-04-10T12:00:00Z",
      messageCount: 1,
    };
    mockAcpSearchSessions.mockResolvedValueOnce(
      serverSweep(
        [matchedInfo("acp-9")],
        ["acp-9"],
        [
          {
            sessionId: "acp-9",
            snippet: "needle in message",
            messageId: "message-9",
            matchCount: 1,
          },
        ],
      ),
    );

    const { result } = renderSessionSearch([contentOnlySession]);
    await searchFor(result, "needle");
    expect(result.current.results.map((item) => item.session.id)).toEqual([
      "acp-9",
    ]);

    // The session's content changed between sweeps: the server's empty match
    // set is authoritative, so the stale content row must go even though no
    // enrichment ran for it.
    mockAcpSearchSessions.mockResolvedValueOnce(serverSweep([], []));
    await submitCurrentSearch(result);

    expect(result.current.results).toEqual([]);
  });

  it("keeps a matched target on screen when its enrichment export fails", async () => {
    // Title deliberately does NOT match the query: if the row survives only
    // as a metadata hit, the test proves nothing about content retention.
    const contentOnlySession: ChatSession = {
      id: "acp-9",
      title: "Untitled",
      createdAt: "2026-04-10T12:00:00Z",
      updatedAt: "2026-04-10T12:00:00Z",
      messageCount: 1,
    };
    mockAcpSearchSessions.mockResolvedValueOnce({
      ...serverSweep([matchedInfo("acp-9")], []),
      failedIds: ["acp-9"],
    });

    const { result } = renderSessionSearch([contentOnlySession]);
    await searchFor(result, "needle");

    // The export could not be read, but the server confirmed the match: the
    // row degrades to snippet-less rather than vanishing.
    expect(result.current.results).toHaveLength(1);
    expect(result.current.results[0]).toMatchObject({
      session: { id: "acp-9" },
      matchType: "message",
    });
    expect(result.current.progress).toMatchObject({
      searched: 0,
      unreadable: 1,
    });
  });

  it("honors the admission check for discovered sessions", async () => {
    mockAcpSearchSessions.mockResolvedValueOnce(
      serverSweep([matchedInfo("acp-1"), matchedInfo("old-1")], ["acp-1"]),
    );

    const queryClient = new QueryClient();
    const { result } = renderHook(
      () =>
        useSessionSearch({
          sessions,
          resolvers,
          includeDiscoveredSession: (session) => session.id !== "old-1",
        }),
      {
        wrapper: ({ children }: { children: ReactNode }) =>
          createElement(QueryClientProvider, { client: queryClient }, children),
      },
    );
    await searchFor(result, "needle");

    expect(result.current.results.map((item) => item.session.id)).toEqual([
      "acp-1",
    ]);
  });

  it("discovers matches with no loaded sessions at all", async () => {
    // An empty loaded slice (fresh store, or a project filter with nothing on
    // screen) must still reach the server: discovery needs no export targets.
    mockAcpSearchSessions.mockResolvedValueOnce(
      serverSweep([matchedInfo("old-1")], []),
    );

    const { result } = renderSessionSearch([]);
    await searchFor(result, "needle");

    expect(mockAcpSearchSessions).toHaveBeenCalledWith(
      "needle",
      [],
      searchOptions,
    );
    expect(result.current.results.map((item) => item.session.id)).toEqual([
      "old-1",
    ]);
  });

  it("keeps earlier server-discovered rows across a searchMore page sweep", async () => {
    mockAcpSearchSessions.mockResolvedValue(
      serverSweep([matchedInfo("acp-1"), matchedInfo("old-1")], ["acp-1"]),
    );

    const { result } = renderSessionSearch();
    await searchFor(result, "needle");
    expect(result.current.results.map((item) => item.session.id)).toEqual([
      "old-1",
      "acp-1",
    ]);

    // A page sweep re-runs discovery; the server answers with the full match
    // set again (now including the newly loaded session), so every earlier
    // row must survive the rebuild.
    mockAcpSearchSessions.mockResolvedValueOnce(
      serverSweep(
        [matchedInfo("acp-1"), matchedInfo("acp-2"), matchedInfo("old-1")],
        ["acp-2"],
      ),
    );
    await searchMore(result, [...sessions, newerSession]);

    expect(result.current.results.map((item) => item.session.id)).toEqual([
      "old-1",
      "acp-2",
      "acp-1",
    ]);
  });
});

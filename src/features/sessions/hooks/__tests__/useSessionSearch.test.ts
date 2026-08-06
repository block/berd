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
    const deferred = createDeferredPromise<MessageSearchResult[]>();
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

    deferred.resolve([]);
    await act(async () => {
      await deferred.promise;
    });

    expect(result.current.isSearching).toBe(false);
  });

  it("searches only new sessions incrementally and merges message results newest first", async () => {
    mockAcpSearchSessions.mockResolvedValueOnce([]).mockResolvedValueOnce([
      {
        sessionId: "acp-2",
        snippet: "needle in message",
        messageId: "message-2",
        matchCount: 2,
      },
    ]);

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
    mockAcpSearchSessions.mockResolvedValue([]);

    const { result } = renderSessionSearch();

    await searchFor(result, "needle");
    const staleSearchMore = result.current.searchMore;

    await searchFor(result, "follow");
    await act(async () => {
      await staleSearchMore([oldQueryOnlySession]);
    });

    expect(mockAcpSearchSessions).toHaveBeenCalledTimes(2);
    expect(result.current.submittedQuery).toBe("follow");
    expect(result.current.results).toEqual([]);
  });

  it("ignores stale incremental responses after clear", async () => {
    const deferred = createDeferredPromise<MessageSearchResult[]>();
    mockAcpSearchSessions
      .mockResolvedValueOnce([])
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
    deferred.resolve([
      {
        sessionId: "acp-2",
        snippet: "stale",
        messageId: "message-2",
        matchCount: 1,
      },
    ]);
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
    mockAcpSearchSessions.mockResolvedValue([]);
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
    mockAcpSearchSessions.mockResolvedValue([]);
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
    mockAcpSearchSessions.mockResolvedValueOnce([messageMatch]);

    const { result } = renderSessionSearch([contentOnlySession]);
    await searchFor(result, "needle");

    expect(result.current.results[0]).toMatchObject({
      matchType: "message",
      snippet: "needle in message",
    });

    // A membership change re-sends the same query and re-sweeps: the row must
    // not blink out while the sweep is in flight.
    const deferred = createDeferredPromise<MessageSearchResult[]>();
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

    deferred.resolve([messageMatch]);
    await act(async () => {
      await deferred.promise;
    });

    expect(result.current.results.map((item) => item.session.id)).toEqual([
      "acp-9",
    ]);
  });

  it("drops results for sessions that left the list on a re-sweep", async () => {
    mockAcpSearchSessions.mockResolvedValue([]);
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

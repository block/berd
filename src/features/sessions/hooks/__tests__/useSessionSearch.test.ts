import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatSession } from "@/features/chat/stores/chatSessionStore";

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

function renderSessionSearch(hookSessions = sessions) {
  return renderHook(() =>
    useSessionSearch({
      sessions: hookSessions,
      resolvers,
    }),
  );
}

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

    expect(mockAcpSearchSessions).toHaveBeenNthCalledWith(1, "needle", [
      "acp-1",
    ]);
    expect(mockAcpSearchSessions).toHaveBeenNthCalledWith(2, "needle", [
      "acp-2",
    ]);
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
});

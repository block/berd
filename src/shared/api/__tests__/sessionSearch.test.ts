import { QueryClient } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockExportSession = vi.hoisted(() => vi.fn());
const mockListSessionsPage = vi.hoisted(() => vi.fn());

vi.mock("../acpApi", () => ({
  exportSession: mockExportSession,
  listSessionsPage: (...args: unknown[]) => mockListSessionsPage(...args),
}));

import {
  searchSessions,
  searchSessionsViaExports,
  sessionSearchStamp,
} from "../sessionSearch";

function exportedNeedleConversation(sessionId: string): string {
  return JSON.stringify({
    conversation: [
      {
        id: `${sessionId}-message`,
        role: "assistant",
        content: `needle in ${sessionId}`,
      },
    ],
  });
}

describe("sessionSearchStamp", () => {
  it("combines updatedAt, messageCount, and lastMessageAt", () => {
    expect(
      sessionSearchStamp({
        updatedAt: "2026-04-10T12:00:00Z",
        messageCount: 3,
        lastMessageAt: "2026-04-10T12:30:00Z",
      }),
    ).toBe("2026-04-10T12:00:00Z:3:2026-04-10T12:30:00Z");
    expect(
      sessionSearchStamp({
        updatedAt: "2026-04-10T12:00:00Z",
        messageCount: 0,
      }),
    ).toBe("2026-04-10T12:00:00Z:0:");
  });
});

describe("searchSessionsViaExports", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it.each([
    ["snake_case", { user_visible: false }],
    ["camelCase", { userVisible: false }],
  ])("ignores %s hidden exported messages before building snippets", async (_caseName, hiddenMetadata) => {
    mockExportSession.mockResolvedValueOnce(
      JSON.stringify({
        conversation: [
          {
            id: "hidden-message",
            role: "assistant",
            metadata: hiddenMetadata,
            content: "hidden needle should not become the snippet",
          },
          {
            id: "visible-message",
            role: "assistant",
            content: "visible needle should become the snippet",
          },
        ],
      }),
    );

    await expect(
      searchSessionsViaExports("needle", [{ id: "session-1", stamp: "v1" }]),
    ).resolves.toEqual({
      results: [
        {
          sessionId: "session-1",
          snippet: "visible needle should become the snippet",
          messageId: "visible-message",
          messageRole: "assistant",
          matchCount: 1,
        },
      ],
      searchedIds: ["session-1"],
      failedIds: [],
    });
  });

  it("exports each session once across sweeps with unchanged stamps", async () => {
    const queryClient = new QueryClient();
    mockExportSession.mockImplementation(async (sessionId: string) =>
      exportedNeedleConversation(sessionId),
    );

    const targets = [
      { id: "session-1", stamp: "v1" },
      { id: "session-2", stamp: "v1" },
    ];

    const first = await searchSessionsViaExports("needle", targets, {
      queryClient,
    });
    const second = await searchSessionsViaExports("needle", targets, {
      queryClient,
    });

    expect(mockExportSession).toHaveBeenCalledTimes(2);
    expect(mockExportSession).toHaveBeenCalledWith("session-1");
    expect(mockExportSession).toHaveBeenCalledWith("session-2");
    expect(second).toEqual(first);
    expect(second.results.map((result) => result.sessionId)).toEqual([
      "session-1",
      "session-2",
    ]);
  });

  it("re-exports only the session whose stamp changed", async () => {
    const queryClient = new QueryClient();
    mockExportSession.mockImplementation(async (sessionId: string) =>
      exportedNeedleConversation(sessionId),
    );

    await searchSessionsViaExports(
      "needle",
      [
        { id: "session-1", stamp: "v1" },
        { id: "session-2", stamp: "v1" },
      ],
      { queryClient },
    );
    mockExportSession.mockClear();

    await searchSessionsViaExports(
      "needle",
      [
        { id: "session-1", stamp: "v1" },
        { id: "session-2", stamp: "v2" },
      ],
      { queryClient },
    );

    expect(mockExportSession).toHaveBeenCalledTimes(1);
    expect(mockExportSession).toHaveBeenCalledWith("session-2");
  });

  it("never runs more exports concurrently than the pool bound", async () => {
    const queryClient = new QueryClient();
    let active = 0;
    let maxActive = 0;
    const releases: Array<() => void> = [];
    mockExportSession.mockImplementation(
      (sessionId: string) =>
        new Promise<string>((resolve) => {
          active += 1;
          maxActive = Math.max(maxActive, active);
          releases.push(() => {
            active -= 1;
            resolve(exportedNeedleConversation(sessionId));
          });
        }),
    );

    const targets = Array.from({ length: 10 }, (_, index) => ({
      id: `session-${index}`,
      stamp: "v1",
    }));
    const sweep = searchSessionsViaExports("needle", targets, { queryClient });

    // The pool fills before anything resolves; wait for that so the drain
    // below cannot release early slots while later workers are still starting.
    await vi.waitFor(() => {
      expect(active).toBe(4);
    });

    let settled = false;
    void sweep.finally(() => {
      settled = true;
    });
    while (!settled) {
      while (releases.length) releases.shift()?.();
      await new Promise((resolve) => setTimeout(resolve, 0));
    }

    expect(maxActive).toBe(4);
    expect(mockExportSession).toHaveBeenCalledTimes(10);
    const settledSweep = await sweep;
    expect(settledSweep.results).toHaveLength(10);
    expect(settledSweep.searchedIds).toHaveLength(10);
    expect(settledSweep.failedIds).toEqual([]);
  });

  it("keeps corpora well past the react-query default gc window", async () => {
    vi.useFakeTimers();
    try {
      const queryClient = new QueryClient();
      mockExportSession.mockImplementation(async (sessionId: string) =>
        exportedNeedleConversation(sessionId),
      );
      const targets = [{ id: "session-1", stamp: "v1" }];

      await searchSessionsViaExports("needle", targets, { queryClient });

      // The gc timer is scheduled when the export settles and cache hits never
      // reschedule it, so under the 5-minute default a search page left open
      // longer than that re-exported every session on the next keystroke.
      await vi.advanceTimersByTimeAsync(6 * 60 * 1000);
      await searchSessionsViaExports("needle", targets, { queryClient });

      expect(mockExportSession).toHaveBeenCalledTimes(1);

      // Still bounded: the entry goes away 30 minutes after its export.
      await vi.advanceTimersByTimeAsync(25 * 60 * 1000);
      await searchSessionsViaExports("needle", targets, { queryClient });

      expect(mockExportSession).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("drops a corpus whose stamp the sweep superseded", async () => {
    const queryClient = new QueryClient();
    mockExportSession.mockImplementation(async (sessionId: string) =>
      exportedNeedleConversation(sessionId),
    );

    await searchSessionsViaExports(
      "needle",
      [{ id: "session-1", stamp: "v1" }],
      {
        queryClient,
      },
    );
    await searchSessionsViaExports(
      "needle",
      [{ id: "session-1", stamp: "v2" }],
      {
        queryClient,
      },
    );

    // Nothing can read the v1 corpus again, so it must not sit in the cache
    // for the rest of the gc window.
    expect(
      queryClient
        .getQueryCache()
        .findAll({ queryKey: ["session-search-corpus"] })
        .map((query) => query.queryKey),
    ).toEqual([["session-search-corpus", "session-1", "v2"]]);
  });

  it("keeps corpora for sessions the sweep did not cover", async () => {
    const queryClient = new QueryClient();
    mockExportSession.mockImplementation(async (sessionId: string) =>
      exportedNeedleConversation(sessionId),
    );

    await searchSessionsViaExports(
      "needle",
      [
        { id: "session-1", stamp: "v1" },
        { id: "session-2", stamp: "v1" },
      ],
      { queryClient },
    );
    // A narrower sweep (the Cmd-K dialog over a filtered list) must not evict
    // what the search page cached.
    await searchSessionsViaExports(
      "needle",
      [{ id: "session-1", stamp: "v2" }],
      {
        queryClient,
      },
    );
    mockExportSession.mockClear();

    await searchSessionsViaExports(
      "needle",
      [{ id: "session-2", stamp: "v1" }],
      {
        queryClient,
      },
    );

    expect(mockExportSession).not.toHaveBeenCalled();
  });

  it("retries a failed export on the next sweep instead of caching it", async () => {
    const queryClient = new QueryClient();
    mockExportSession
      .mockRejectedValueOnce(new Error("export failed"))
      .mockResolvedValue(exportedNeedleConversation("session-1"));

    const targets = [{ id: "session-1", stamp: "v1" }];

    // A failed export is reported as unread rather than as a searched session
    // that simply had no match — the caller needs that split to avoid claiming
    // it searched conversation text it never read.
    await expect(
      searchSessionsViaExports("needle", targets, { queryClient }),
    ).resolves.toEqual({
      results: [],
      searchedIds: [],
      failedIds: ["session-1"],
    });

    const retried = await searchSessionsViaExports("needle", targets, {
      queryClient,
    });

    expect(mockExportSession).toHaveBeenCalledTimes(2);
    expect(retried.results).toMatchObject([
      { sessionId: "session-1", matchCount: 1 },
    ]);
    expect(retried.searchedIds).toEqual(["session-1"]);
    expect(retried.failedIds).toEqual([]);
  });
});

function serverSession(
  sessionId: string,
  overrides: Record<string, unknown> = {},
) {
  return {
    sessionId,
    title: `Session ${sessionId}`,
    updatedAt: "2026-04-10T12:00:00Z",
    createdAt: null,
    lastMessageAt: null,
    archivedAt: null,
    userSetName: false,
    messageCount: 2,
    subtitle: null,
    workingDir: null,
    projectId: null,
    providerId: null,
    modelId: null,
    personaId: null,
    ...overrides,
  };
}

describe("searchSessions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("does not hit the server for queries below the content threshold", async () => {
    await expect(
      searchSessions("n", [{ id: "session-1", stamp: "v1" }]),
    ).resolves.toEqual({
      results: [],
      searchedIds: [],
      failedIds: [],
      matchedInfos: [],
    });
    expect(mockListSessionsPage).not.toHaveBeenCalled();
    expect(mockExportSession).not.toHaveBeenCalled();
  });

  it("discovers matches server-side across pages and enriches only matched targets", async () => {
    mockListSessionsPage
      .mockResolvedValueOnce({
        sessions: [serverSession("session-1"), serverSession("old-1")],
        nextCursor: "cursor-2",
      })
      .mockResolvedValueOnce({
        sessions: [serverSession("old-2")],
        nextCursor: null,
      });
    mockExportSession.mockResolvedValue(
      exportedNeedleConversation("session-1"),
    );

    const sweep = await searchSessions("needle", [
      { id: "session-1", stamp: "v1" },
      { id: "session-2", stamp: "v1" },
    ]);

    // The query filter rides every page request, and pagination follows the
    // returned cursor until the server stops handing one out.
    expect(mockListSessionsPage).toHaveBeenNthCalledWith(1, {
      cursor: null,
      query: "needle",
    });
    expect(mockListSessionsPage).toHaveBeenNthCalledWith(2, {
      cursor: "cursor-2",
      query: "needle",
    });

    // Every server match — including sessions outside the loaded targets —
    // comes back in matchedInfos so the caller can surface them.
    expect(sweep.matchedInfos?.map((info) => info.sessionId)).toEqual([
      "session-1",
      "old-1",
      "old-2",
    ]);

    // Only matched targets get an export; the unmatched one is already
    // answered by the server and must not pay for a corpus read.
    expect(mockExportSession).toHaveBeenCalledTimes(1);
    expect(mockExportSession).toHaveBeenCalledWith("session-1");
    expect(sweep.results).toMatchObject([
      { sessionId: "session-1", matchCount: 1 },
    ]);
    expect(sweep.searchedIds).toEqual(["session-1"]);
    expect(sweep.failedIds).toEqual([]);
  });

  it("matches any whitespace-separated keyword, mirroring the server filter", async () => {
    mockListSessionsPage.mockResolvedValueOnce({
      sessions: [serverSession("session-1")],
      nextCursor: null,
    });
    mockExportSession.mockResolvedValue(
      JSON.stringify({
        conversation: [
          {
            id: "m1",
            role: "user",
            content: "only the second word appears here",
          },
        ],
      }),
    );

    // The full phrase never appears, but the server's OR over words matched
    // this session — the enrichment must agree or the match would be erased.
    const sweep = await searchSessions("missing word", [
      { id: "session-1", stamp: "v1" },
    ]);

    expect(sweep.results).toMatchObject([
      { sessionId: "session-1", matchCount: 1 },
    ]);
    expect(sweep.failedIds).toEqual([]);
  });

  it("reports matched targets whose export fails as unread, keeping the match", async () => {
    mockListSessionsPage.mockResolvedValueOnce({
      sessions: [serverSession("session-1")],
      nextCursor: null,
    });
    mockExportSession.mockRejectedValue(new Error("export failed"));

    const sweep = await searchSessions("needle", [
      { id: "session-1", stamp: "v1" },
    ]);

    expect(sweep.results).toEqual([]);
    expect(sweep.failedIds).toEqual(["session-1"]);
    // The server already established the match; matchedInfos carries it so
    // the caller can degrade to a snippet-less row instead of hiding it.
    expect(sweep.matchedInfos?.map((info) => info.sessionId)).toEqual([
      "session-1",
    ]);
  });

  it("fails on a repeated pagination cursor instead of looping", async () => {
    mockListSessionsPage.mockResolvedValue({
      sessions: [serverSession("loop-1")],
      nextCursor: "cursor-forever",
    });

    // A server that hands back the same cursor is cycling; the search must
    // error rather than storm requests or treat duplicates as the full set.
    await expect(searchSessions("needle", [])).rejects.toThrow(
      "repeated pagination cursor",
    );
    expect(mockListSessionsPage).toHaveBeenCalledTimes(2);
  });

  it("fails rather than truncate when the page cap is reached", async () => {
    let page = 0;
    mockListSessionsPage.mockImplementation(async () => {
      page += 1;
      return {
        sessions: [serverSession(`session-${page}`)],
        nextCursor: `cursor-${page}`,
      };
    });

    await expect(searchSessions("needle", [])).rejects.toThrow(
      "exceeded 100 pages",
    );
    expect(mockListSessionsPage).toHaveBeenCalledTimes(100);
  });

  it("propagates a mid-pagination failure", async () => {
    mockListSessionsPage
      .mockResolvedValueOnce({
        sessions: [serverSession("session-1")],
        nextCursor: "cursor-2",
      })
      .mockRejectedValueOnce(new Error("connection closed"));

    await expect(searchSessions("needle", [])).rejects.toThrow(
      "connection closed",
    );
    expect(mockExportSession).not.toHaveBeenCalled();
  });
});

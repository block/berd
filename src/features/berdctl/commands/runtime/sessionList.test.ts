import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  type ChatSession,
  useChatSessionStore,
} from "@/features/chat/stores/chatSessionStore";
import type { AcpSessionInfo, AcpSessionsPage } from "@/shared/api/acp";
import { CommandError } from "../types";
import {
  listSessionsForBerdctl,
  loadAllSessionsForBerdctl,
} from "./sessionList";

const mocks = vi.hoisted(() => ({
  acpGetSessionInfo: vi.fn(),
  acpListSessionsPage: vi.fn(),
}));

vi.mock("@/shared/api/acp", () => ({
  acpGetSessionInfo: (...args: unknown[]) => mocks.acpGetSessionInfo(...args),
  acpListSessionsPage: (...args: unknown[]) =>
    mocks.acpListSessionsPage(...args),
}));

const PAGE_SIZE = 50;
const BASE_EPOCH_SECOND = 1_800_000_000;
const NOT_FOUND = Object.assign(new Error("Resource not found"), {
  code: -32002,
});

const unarchived = (session: ChatSession) => !session.archivedAt;

function at(second: number): string {
  return new Date((BASE_EPOCH_SECOND + second) * 1000).toISOString();
}

function acpSession(
  sessionId: string,
  activitySecond: number,
  overrides: Partial<AcpSessionInfo> = {},
): AcpSessionInfo {
  return {
    sessionId,
    title: `Session ${sessionId}`,
    createdAt: at(0),
    updatedAt: at(activitySecond),
    lastMessageAt: at(activitySecond),
    archivedAt: null,
    userSetName: false,
    messageCount: 3,
    subtitle: null,
    workingDir: null,
    projectId: null,
    providerId: null,
    modelId: null,
    personaId: null,
    ...overrides,
  };
}

function cachedSession(
  id: string,
  activitySecond: number,
  overrides: Partial<ChatSession> = {},
): ChatSession {
  return {
    id,
    title: `Session ${id}`,
    createdAt: at(0),
    updatedAt: at(activitySecond),
    lastMessageAt: at(activitySecond),
    messageCount: 3,
    ...overrides,
  };
}

/** Mirror Goose's session/list order: activity second desc, then id desc. */
function compareLikeGoose(a: AcpSessionInfo, b: AcpSessionInfo): number {
  const aSecond = Date.parse(a.lastMessageAt ?? a.updatedAt ?? "");
  const bSecond = Date.parse(b.lastMessageAt ?? b.updatedAt ?? "");
  if (aSecond !== bSecond) return bSecond - aSecond;
  if (a.sessionId === b.sessionId) return 0;
  return a.sessionId < b.sessionId ? 1 : -1;
}

/** Serve `sessions` as an offset-cursor session/list backend. */
function serveSessionList(sessions: AcpSessionInfo[]): void {
  const ordered = [...sessions].sort(compareLikeGoose);
  mocks.acpListSessionsPage.mockImplementation(
    async ({ cursor }: { cursor?: string | null } = {}) => {
      const start = cursor ? Number(cursor.replace("offset-", "")) : 0;
      const end = start + PAGE_SIZE;
      return {
        sessions: ordered.slice(start, end),
        nextCursor: end < ordered.length ? `offset-${end}` : null,
      } satisfies AcpSessionsPage;
    },
  );
}

function servePages(...pages: AcpSessionsPage[]): void {
  for (const page of pages) {
    mocks.acpListSessionsPage.mockResolvedValueOnce(page);
  }
}

function resetStore(sessions: ChatSession[] = []): void {
  useChatSessionStore.setState({
    sessions,
    isLoading: false,
    isLoadingMoreSessions: false,
    hasHydratedSessions: false,
    sessionPageCursor: null,
    hasMoreSessions: false,
    hasReachedSessionListEnd: false,
    archiveMutationBySessionId: {},
  });
}

/** The answer a full read would give for the same starting store. */
async function exhaustiveIds(
  seed: ChatSession[],
  matches: (session: ChatSession) => boolean,
  limit: number,
): Promise<string[]> {
  resetStore(seed);
  await loadAllSessionsForBerdctl();
  const ids = useChatSessionStore
    .getState()
    .sessions.filter(matches)
    .slice(0, limit)
    .map((session) => session.id);
  resetStore(seed);
  mocks.acpListSessionsPage.mockClear();
  mocks.acpGetSessionInfo.mockClear();
  return ids;
}

async function listIds(
  matches: (session: ChatSession) => boolean,
  limit: number,
  deadlineMs?: number,
): Promise<string[]> {
  const sessions = await listSessionsForBerdctl({
    matches,
    limit,
    deadlineMs,
  });
  return sessions.map((session) => session.id);
}

async function expectTimedOut(promise: Promise<unknown>): Promise<void> {
  const error = await promise.then(
    () => new Error("expected a timeout"),
    (rejection: unknown) => rejection,
  );
  expect(error).toBeInstanceOf(CommandError);
  expect((error as CommandError).code).toBe("timed_out");
}

beforeEach(() => {
  window.localStorage.clear();
  resetStore();
  mocks.acpListSessionsPage.mockReset();
  mocks.acpGetSessionInfo.mockReset();
  mocks.acpGetSessionInfo.mockRejectedValue(NOT_FOUND);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("listSessionsForBerdctl", () => {
  it("reads one page when it already holds the first match", async () => {
    serveSessionList(
      Array.from({ length: 150 }, (_, index) =>
        acpSession(`s-${index}`, 1000 - index),
      ),
    );

    expect(await listIds(unarchived, 1)).toEqual(["s-0"]);
    expect(mocks.acpListSessionsPage).toHaveBeenCalledTimes(1);
  });

  it("filters project, title, and archived rows across pages", async () => {
    const sessions = Array.from({ length: 200 }, (_, index) =>
      acpSession(`s-${String(index).padStart(3, "0")}`, 1000 - index, {
        projectId: index % 2 === 0 ? "p-1" : "p-2",
        title: index % 10 === 0 ? `Fix login ${index}` : `Other ${index}`,
        archivedAt: index % 20 === 0 ? at(5) : null,
      }),
    );
    serveSessionList(sessions);
    const matches = (session: ChatSession) =>
      unarchived(session) &&
      session.projectId === "p-1" &&
      session.title.toLowerCase().includes("login");
    const expected = await exhaustiveIds([], matches, 3);

    expect(await listIds(matches, 3)).toEqual(expected);
    expect(expected).toEqual(["s-010", "s-030", "s-050"]);
    expect(mocks.acpListSessionsPage).toHaveBeenCalledTimes(2);
  });

  it("reads the next page before trusting a match tied with the oldest row read", async () => {
    // Goose breaks same-second ties by binary id order; the store uses
    // locale order, so an unread "B" can outrank a read "a".
    servePages(
      {
        sessions: [acpSession("x", 9), acpSession("a", 5)],
        nextCursor: "page-2",
      },
      {
        sessions: [acpSession("B", 5), acpSession("z", 1)],
        nextCursor: "page-3",
      },
    );

    expect(await listIds(unarchived, 2)).toEqual(["x", "B"]);
    expect(mocks.acpListSessionsPage).toHaveBeenCalledTimes(2);
  });

  it("orders ms-precision cached rows against whole-second backend rows like a full read", async () => {
    const seed = [
      cachedSession("draft", 5, {
        lastMessageAt: undefined,
        updatedAt: new Date((BASE_EPOCH_SECOND + 5) * 1000 + 500).toISOString(),
        messageCount: 0,
      }),
    ];
    const pages = [
      { sessions: [acpSession("a", 9), acpSession("b", 5)], nextCursor: "p2" },
      { sessions: [acpSession("c", 5), acpSession("d", 2)], nextCursor: "p3" },
      { sessions: [acpSession("e", 1)], nextCursor: null },
    ];
    servePages(...pages);
    const expected = await exhaustiveIds(seed, unarchived, 3);
    servePages(...pages);
    mocks.acpGetSessionInfo.mockResolvedValue(
      acpSession("draft", 5, {
        lastMessageAt: null,
        messageCount: 0,
      }),
    );

    expect(await listIds(unarchived, 3)).toEqual(expected);
  });

  it("does not let a stale cached row outrank fresher backend rows", async () => {
    // The cache still shows "moved" as newest; the backend now lists it on
    // page 2 with older activity.
    const seed = [cachedSession("moved", 999)];
    serveSessionList([
      ...Array.from({ length: 60 }, (_, index) =>
        acpSession(`s-${String(index).padStart(2, "0")}`, 500 - index),
      ),
      acpSession("moved", 10),
    ]);
    mocks.acpGetSessionInfo.mockResolvedValue(acpSession("moved", 10));
    const expected = await exhaustiveIds(seed, unarchived, 1);
    mocks.acpGetSessionInfo.mockResolvedValue(acpSession("moved", 10));

    expect(await listIds(unarchived, 1)).toEqual(expected);
    expect(expected).toEqual(["s-00"]);
    expect(mocks.acpGetSessionInfo).toHaveBeenCalledWith("moved");
    expect(mocks.acpListSessionsPage).toHaveBeenCalledTimes(2);
  });

  it("does not trust a cached row whose archive state changed on the backend", async () => {
    resetStore([cachedSession("archived-elsewhere", 999)]);
    serveSessionList([
      acpSession("archived-elsewhere", 999, { archivedAt: at(999) }),
      ...Array.from({ length: 60 }, (_, index) =>
        acpSession(`s-${String(index).padStart(2, "0")}`, 500 - index),
      ),
    ]);

    expect(await listIds(unarchived, 1)).toEqual(["s-00"]);
    expect(mocks.acpListSessionsPage).toHaveBeenCalledTimes(1);
  });

  it("orders by live activity when a row changes while a lookup is pending", async () => {
    resetStore([cachedSession("draft", 900, { messageCount: 0 })]);
    serveSessionList(
      Array.from({ length: 120 }, (_, index) =>
        acpSession(`s-${String(index).padStart(3, "0")}`, 500 - index),
      ),
    );
    mocks.acpGetSessionInfo.mockImplementation(async () => {
      // A local patch updates activity in place without re-sorting the store.
      useChatSessionStore.setState((state) => ({
        sessions: state.sessions.map((session) =>
          session.id === "s-001"
            ? { ...session, lastMessageAt: at(950) }
            : session,
        ),
      }));
      return acpSession("draft", 900, { messageCount: 0 });
    });

    expect(await listIds(unarchived, 2)).toEqual(["s-001", "draft"]);
  });

  it("lists a cached draft session/list omits without a full read", async () => {
    // A messageless draft is absent from session/list, and getSessionInfo
    // shows activity newer than anything left unread.
    const seed = [cachedSession("draft", 900, { messageCount: 0 })];
    serveSessionList(
      Array.from({ length: 150 }, (_, index) =>
        acpSession(`s-${String(index).padStart(3, "0")}`, 500 - index),
      ),
    );
    mocks.acpGetSessionInfo.mockResolvedValue(
      acpSession("draft", 900, { messageCount: 0 }),
    );
    const expected = await exhaustiveIds(seed, unarchived, 2);

    expect(await listIds(unarchived, 2)).toEqual(expected);
    expect(expected).toEqual(["draft", "s-000"]);
    expect(mocks.acpListSessionsPage).toHaveBeenCalledTimes(1);
    expect(mocks.acpGetSessionInfo).toHaveBeenCalledWith("draft");
  });

  it.each([
    ["not found", NOT_FOUND],
    ["a failed lookup", new Error("backend busy")],
  ])("reads every page when a cached row's lookup returns %s", async (_label, lookupError) => {
    // Goose also reports database errors as not-found, so neither answer
    // proves session/list will not return the row on a later page.
    const seed = [cachedSession("unconfirmed", 900)];
    serveSessionList(
      Array.from({ length: 120 }, (_, index) =>
        acpSession(`s-${String(index).padStart(3, "0")}`, 500 - index),
      ),
    );
    mocks.acpGetSessionInfo.mockRejectedValue(lookupError);
    const expected = await exhaustiveIds(seed, unarchived, 2);

    expect(await listIds(unarchived, 2)).toEqual(expected);
    expect(expected).toEqual(["unconfirmed", "s-000"]);
    expect(mocks.acpListSessionsPage).toHaveBeenCalledTimes(3);
    expect(mocks.acpGetSessionInfo).toHaveBeenCalledOnce();
  });

  it.each([
    ["a remote host", { remoteHost: "devbox" }],
    ["a composite remote id", { id: "ssh:devbox#remote-1" }],
  ])("pages instead of probing a cached row on %s", async (_label, overrides) => {
    const seed = [cachedSession("remote", 900, overrides)];
    serveSessionList(
      Array.from({ length: 120 }, (_, index) =>
        acpSession(`s-${String(index).padStart(3, "0")}`, 500 - index),
      ),
    );
    const expected = await exhaustiveIds(seed, unarchived, 2);

    expect(await listIds(unarchived, 2)).toEqual(expected);
    expect(mocks.acpGetSessionInfo).not.toHaveBeenCalled();
    expect(mocks.acpListSessionsPage).toHaveBeenCalledTimes(3);
  });

  it("stops waiting on a slow lookup and keeps paging", async () => {
    vi.useFakeTimers();
    const seed = [cachedSession("stalled", 900)];
    serveSessionList(
      Array.from({ length: 120 }, (_, index) =>
        acpSession(`s-${String(index).padStart(3, "0")}`, 500 - index),
      ),
    );
    const expected = await exhaustiveIds(seed, unarchived, 2);
    mocks.acpGetSessionInfo.mockReturnValue(new Promise(() => {}));

    const listing = listIds(unarchived, 2);
    await vi.advanceTimersByTimeAsync(1000);

    expect(await listing).toEqual(expected);
    expect(mocks.acpGetSessionInfo).toHaveBeenCalledOnce();
    expect(mocks.acpListSessionsPage).toHaveBeenCalledTimes(3);
  });

  it("re-reads the store after a lookup so concurrent archives are honored", async () => {
    const seed = [cachedSession("draft", 900, { messageCount: 0 })];
    serveSessionList(
      Array.from({ length: 120 }, (_, index) =>
        acpSession(`s-${String(index).padStart(3, "0")}`, 500 - index),
      ),
    );
    resetStore(seed);
    mocks.acpGetSessionInfo.mockImplementation(async () => {
      // The user archives a listed session while the lookup is in flight.
      useChatSessionStore.setState((state) => ({
        sessions: state.sessions.map((session) =>
          session.id === "s-000" ? { ...session, archivedAt: at(1) } : session,
        ),
      }));
      return acpSession("draft", 900, { messageCount: 0 });
    });

    expect(await listIds(unarchived, 2)).toEqual(["draft", "s-001"]);
  });

  it("reads every page and returns nothing when nothing matches", async () => {
    serveSessionList(
      Array.from({ length: 120 }, (_, index) =>
        acpSession(`s-${index}`, 1000 - index),
      ),
    );

    expect(await listIds(() => false, 5)).toEqual([]);
    expect(mocks.acpListSessionsPage).toHaveBeenCalledTimes(3);
  });

  it("returns fewer than the limit at the end of the list", async () => {
    serveSessionList([acpSession("a", 9), acpSession("b", 8)]);

    expect(await listIds(unarchived, 10)).toEqual(["a", "b"]);
    expect(mocks.acpListSessionsPage).toHaveBeenCalledTimes(1);
  });

  it("reads every page once a page breaks newest-first order", async () => {
    servePages(
      { sessions: [acpSession("a", 5), acpSession("b", 4)], nextCursor: "p2" },
      {
        sessions: [acpSession("late", 9), acpSession("c", 3)],
        nextCursor: "p3",
      },
      { sessions: [acpSession("d", 1)], nextCursor: null },
    );

    expect(await listIds(unarchived, 3)).toEqual(["late", "a", "b"]);
    expect(mocks.acpListSessionsPage).toHaveBeenCalledTimes(3);
  });

  it("stops requesting pages once the deadline passes during a slow page", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const deadlineMs = 1000;
    mocks.acpListSessionsPage.mockImplementation(async () => {
      vi.setSystemTime(deadlineMs + 1);
      return { sessions: [acpSession("a", 5)], nextCursor: "p2" };
    });

    await expectTimedOut(listIds(() => false, 1, deadlineMs));
    expect(mocks.acpListSessionsPage).toHaveBeenCalledTimes(1);
  });

  it("requests nothing when the deadline has already passed", async () => {
    serveSessionList([acpSession("a", 5)]);

    await expectTimedOut(listIds(unarchived, 1, Date.now() - 1));
    expect(mocks.acpListSessionsPage).not.toHaveBeenCalled();
  });
});

describe("loadAllSessionsForBerdctl", () => {
  it.each([
    ["the previous page's cursor", ["c1", "c1"]],
    ["a cursor from several pages back", ["c1", "c2", "c1"]],
  ])("fails instead of looping when the backend repeats %s", async (_label, cursors) => {
    servePages(
      ...cursors.map((nextCursor, index) => ({
        sessions: [acpSession(`s-${index}`, 9 - index)],
        nextCursor,
      })),
    );

    const error = await loadAllSessionsForBerdctl().catch(
      (rejection: unknown) => rejection,
    );

    expect(error).toBeInstanceOf(CommandError);
    expect((error as CommandError).code).toBe("backend_read_failed");
    expect(mocks.acpListSessionsPage).toHaveBeenCalledTimes(cursors.length);
  });

  it("times out instead of finishing a long read", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    let page = 0;
    mocks.acpListSessionsPage.mockImplementation(async () => {
      page += 1;
      vi.setSystemTime(page * 400);
      return {
        sessions: [acpSession(`s-${page}`, 1000 - page)],
        nextCursor: `p${page + 1}`,
      };
    });

    await expectTimedOut(loadAllSessionsForBerdctl({ deadlineMs: 1000 }));
    expect(mocks.acpListSessionsPage).toHaveBeenCalledTimes(3);
  });

  it("wraps backend failures as backend_read_failed", async () => {
    mocks.acpListSessionsPage.mockRejectedValue(new Error("backend down"));

    const error = await loadAllSessionsForBerdctl().catch(
      (rejection: unknown) => rejection,
    );

    expect(error).toBeInstanceOf(CommandError);
    expect((error as CommandError).code).toBe("backend_read_failed");
  });
});

describe("shared store pagination", () => {
  function pagedBackend(): void {
    serveSessionList(
      Array.from({ length: 200 }, (_, index) =>
        acpSession(`s-${String(index).padStart(3, "0")}`, 1000 - index),
      ),
    );
  }

  it("hydrates an empty store and owns its cursor from the first page", async () => {
    pagedBackend();

    await listIds(unarchived, 1);

    const state = useChatSessionStore.getState();
    expect(state.hasHydratedSessions).toBe(true);
    expect(state.sessionPageCursor).toBe("offset-50");
    expect(state.hasMoreSessions).toBe(true);
  });

  it("restores pagination after a failed sidebar load", async () => {
    pagedBackend();
    // A failed sidebar load marks the store hydrated with no cursor.
    useChatSessionStore.setState({
      hasHydratedSessions: true,
      sessionPageCursor: null,
      hasMoreSessions: false,
    });

    await listIds(unarchived, 1);

    const state = useChatSessionStore.getState();
    expect(state.sessionPageCursor).toBe("offset-50");
    expect(state.hasMoreSessions).toBe(true);
  });

  it("keeps an exhausted sidebar at the end of the list", async () => {
    pagedBackend();
    const store = useChatSessionStore.getState();
    await store.loadSessions();
    while (useChatSessionStore.getState().hasMoreSessions) {
      await store.loadMoreSessions();
    }
    expect(useChatSessionStore.getState().sessionPageCursor).toBeNull();

    await listIds(unarchived, 1);

    const state = useChatSessionStore.getState();
    expect(state.sessionPageCursor).toBeNull();
    expect(state.hasMoreSessions).toBe(false);
  });

  it("restores pagination after a failed load even when first-page rows are cached", async () => {
    pagedBackend();
    // Rows restored or fetched one by one, then a failed sidebar load.
    useChatSessionStore.setState({
      sessions: Array.from({ length: 50 }, (_, index) =>
        cachedSession(`s-${String(index).padStart(3, "0")}`, 1000 - index),
      ),
      hasHydratedSessions: true,
      sessionPageCursor: null,
      hasMoreSessions: false,
    });

    await listIds(unarchived, 1);

    const state = useChatSessionStore.getState();
    expect(state.sessionPageCursor).toBe("offset-50");
    expect(state.hasMoreSessions).toBe(true);
  });

  it("restores pagination after the sidebar stopped on a repeated cursor", async () => {
    servePages(
      { sessions: [acpSession("a", 9)], nextCursor: "page-2" },
      { sessions: [acpSession("b", 8)], nextCursor: "page-2" },
      {
        sessions: [acpSession("a", 9), acpSession("b", 8)],
        nextCursor: "page-2",
      },
    );
    const store = useChatSessionStore.getState();
    await store.loadSessions();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    await store.loadMoreSessions();
    expect(useChatSessionStore.getState().hasMoreSessions).toBe(false);

    await listIds(unarchived, 1);

    const state = useChatSessionStore.getState();
    expect(state.sessionPageCursor).toBe("page-2");
    expect(state.hasMoreSessions).toBe(true);
  });

  it("does not rewind a sidebar cursor that is already further along", async () => {
    pagedBackend();
    useChatSessionStore.setState({
      hasHydratedSessions: true,
      sessionPageCursor: "offset-150",
      hasMoreSessions: true,
    });

    await listIds(unarchived, 1);

    expect(useChatSessionStore.getState().sessionPageCursor).toBe("offset-150");
  });

  it("advances the sidebar cursor only when the scan reads its next page", async () => {
    pagedBackend();
    useChatSessionStore.setState({
      hasHydratedSessions: true,
      sessionPageCursor: "offset-50",
      hasMoreSessions: true,
    });

    await loadAllSessionsForBerdctl();

    const state = useChatSessionStore.getState();
    expect(state.sessionPageCursor).toBeNull();
    expect(state.hasMoreSessions).toBe(false);
    expect(state.sessions).toHaveLength(200);
  });

  it("leaves an in-flight sidebar refresh's loading state alone", async () => {
    pagedBackend();
    useChatSessionStore.setState({ isLoading: true });

    await listIds(unarchived, 1);

    expect(useChatSessionStore.getState().isLoading).toBe(true);
  });
});

describe("synthetic large history", () => {
  // Shape of a large real history: ~1,580 sessions with messages (what
  // session/list returns), about half archived, 50 rows per page. Values are
  // synthetic.
  const SESSION_COUNT = 1582;
  const sessions = Array.from({ length: SESSION_COUNT }, (_, index) =>
    acpSession(`s-${String(index).padStart(4, "0")}`, 100_000 - index * 7, {
      archivedAt: index % 13 < 7 ? at(1) : null,
      projectId: index % 9 === 0 ? "p-small" : "p-main",
      title: [150, 700, 1200, 1650].includes(index)
        ? `Release ${index}`
        : `Session ${index}`,
    }),
  );
  const totalPages = Math.ceil(SESSION_COUNT / PAGE_SIZE);
  const cases: Array<{
    name: string;
    limit: number;
    matches: (session: ChatSession) => boolean;
    pages: number;
  }> = [
    { name: "limit 1", limit: 1, matches: unarchived, pages: 1 },
    { name: "default limit 20", limit: 20, matches: unarchived, pages: 1 },
    { name: "limit 100", limit: 100, matches: unarchived, pages: 5 },
    {
      name: "small project, limit 20",
      limit: 20,
      matches: (session) =>
        unarchived(session) && session.projectId === "p-small",
      pages: 8,
    },
    {
      name: "4 title matches, limit 10",
      limit: 10,
      matches: (session) =>
        unarchived(session) && session.title.toLowerCase().includes("release"),
      pages: totalPages,
    },
  ];

  it.each(
    cases,
  )("$name reads $pages of the pages and matches a full read", async ({
    limit,
    matches,
    pages,
  }) => {
    serveSessionList(
      sessions.map((session) =>
        // Keep the four title matches unarchived.
        session.title?.startsWith("Release")
          ? { ...session, archivedAt: null }
          : session,
      ),
    );
    const expected = await exhaustiveIds([], matches, limit);
    expect(mocks.acpListSessionsPage).not.toHaveBeenCalled();

    expect(await listIds(matches, limit)).toEqual(expected);
    expect(mocks.acpListSessionsPage).toHaveBeenCalledTimes(pages);
  });
});

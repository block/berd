import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AcpSessionInfo } from "@/shared/api/acp";
import type { ChatSession } from "@/features/chat/stores/chatSessionStore";
import { useChatSessionStore } from "@/features/chat/stores/chatSessionStore";
import type { ProjectInfo } from "@/features/projects/api/projects";
import { useProjectStore } from "@/features/projects/stores/projectStore";
import {
  resetProjectSessionHydrationAccounting,
  useProjectSessionHydration,
} from "../useProjectSessionHydration";

const mocks = vi.hoisted(() => ({
  acpCreateSession: vi.fn(),
  acpListSessionsPage: vi.fn(),
  archiveSession: vi.fn(),
  releaseSession: vi.fn(),
  unarchiveSession: vi.fn(),
}));

vi.mock("@/shared/api/acp", () => ({
  acpCreateSession: (...args: unknown[]) => mocks.acpCreateSession(...args),
  acpListSessionsPage: (...args: unknown[]) =>
    mocks.acpListSessionsPage(...args),
}));

vi.mock("@/shared/profile/buildProfile", () => ({
  getBuildFeatureState: () => ({
    authGate: false,
    agentTools: true,
    automations: true,
    builderbot: true,
    byoKeyProviders: false,
    telemetry: true,
    voiceDictation: true,
    managedConnections: true,
    securityMl: true,
    updater: true,
  }),
}));

vi.mock("@/shared/api/acpApi", () => ({
  archiveSession: (...args: unknown[]) => mocks.archiveSession(...args),
  unarchiveSession: (...args: unknown[]) => mocks.unarchiveSession(...args),
}));

vi.mock("@/features/chat/lib/sessionWindowCommands", () => ({
  releaseSession: (...args: unknown[]) => mocks.releaseSession(...args),
}));

const PAGE_SIZE = 3;

function makeProject(
  id: string,
  archivedAt: string | null = null,
): ProjectInfo {
  return {
    id,
    path: `/projects/${id}`,
    name: id,
    description: "",
    prompt: "",
    icon: "",
    color: "",
    projectWorkspaces: [],
    workingDirs: [],
    useWorktrees: false,
    order: 0,
    archivedAt,
  };
}

function makeSession(
  id: string,
  overrides: Partial<ChatSession> = {},
): ChatSession {
  return {
    id,
    title: id,
    createdAt: "2026-04-01T00:00:00.000Z",
    updatedAt: "2026-04-01T00:00:00.000Z",
    messageCount: 1,
    ...overrides,
  };
}

function makeAcpSession(
  id: string,
  activityOffset: number,
  projectId: string | null = null,
): AcpSessionInfo {
  const lastMessageAt = new Date(
    Date.UTC(2026, 3, 1) - activityOffset * 60_000,
  ).toISOString();
  return {
    sessionId: id,
    title: id,
    updatedAt: "2026-04-01T00:00:00.000Z",
    createdAt: "2026-03-01T00:00:00.000Z",
    lastMessageAt,
    archivedAt: null,
    userSetName: false,
    messageCount: 1,
    subtitle: null,
    workingDir: null,
    projectId,
    providerId: null,
    modelId: null,
    personaId: null,
  };
}

/**
 * Sessions ordered newest-first like the backend: standalone chats, then
 * `projectSessionsPerProject` chats per project in order. A project whose
 * chats sit past `loadedPages` pages only hydrates through the hook.
 */
function buildBackendCatalog(
  projectIds: string[],
  projectSessionsPerProject: number,
  standaloneCount = 2,
): AcpSessionInfo[] {
  const catalog: AcpSessionInfo[] = [];
  for (let index = 0; index < standaloneCount; index += 1) {
    catalog.push(makeAcpSession(`standalone-${index + 1}`, index));
  }
  let offset = standaloneCount;
  for (const projectId of projectIds) {
    for (let index = 0; index < projectSessionsPerProject; index += 1) {
      catalog.push(
        makeAcpSession(`${projectId}-chat-${index + 1}`, offset, projectId),
      );
      offset += 1;
    }
  }
  return catalog;
}

function pageFromCatalog(
  catalog: AcpSessionInfo[],
  cursor: string | null | undefined,
): { sessions: AcpSessionInfo[]; nextCursor: string | null } {
  const start = cursor ? Number.parseInt(cursor, 10) : 0;
  const sessions = catalog.slice(start, start + PAGE_SIZE);
  const nextOffset = start + sessions.length;
  return {
    sessions,
    nextCursor: nextOffset < catalog.length ? String(nextOffset) : null,
  };
}

function seedLoadedState(
  catalog: AcpSessionInfo[],
  loadedPages: number,
  extraSessions: ChatSession[] = [],
) {
  const sessions = catalog.slice(0, loadedPages * PAGE_SIZE);
  const nextOffset = sessions.length;
  useChatSessionStore.setState({
    sessions: [
      ...extraSessions,
      ...sessions.map((session) =>
        makeSession(session.sessionId, {
          projectId: session.projectId ?? undefined,
          messageCount: session.messageCount,
          lastMessageAt: session.lastMessageAt ?? undefined,
        }),
      ),
    ],
    hasHydratedSessions: true,
    sessionPageCursor: nextOffset < catalog.length ? String(nextOffset) : null,
    hasMoreSessions: nextOffset < catalog.length,
  });
}

async function flushHydration() {
  await act(async () => {
    await Promise.resolve();
  });
}

function renderHydration(enabled = true) {
  return renderHook(() => {
    const projects = useProjectStore((state) => state.projects);
    useProjectSessionHydration(enabled, projects);
  });
}

function resetStores() {
  window.localStorage.clear();
  useProjectStore.setState({
    projects: [],
    loading: false,
    hasFetchedProjects: false,
    activeProjectId: null,
  });
  useChatSessionStore.setState({
    sessions: [],
    activeSessionId: null,
    isLoading: false,
    isLoadingMoreSessions: false,
    hasHydratedSessions: false,
    sessionListReloadCount: 0,
    sessionPageCursor: null,
    hasMoreSessions: false,
    activeWorkspaceBySession: {},
    archiveMutationBySessionId: {},
  });
}

describe("useProjectSessionHydration", () => {
  beforeEach(() => {
    resetStores();
    resetProjectSessionHydrationAccounting();
    vi.clearAllMocks();
    mocks.acpListSessionsPage.mockImplementation(
      ({ cursor }: { cursor?: string | null } = {}) =>
        Promise.reject(
          new Error(`unexpected session/list call (cursor: ${cursor})`),
        ),
    );
  });

  it("hydrates a project whose chats sit many pages deep", {
    timeout: 20_000,
  }, async () => {
    // project-b's newest chat sits past 60 sessions — beyond the previous
    // grouped auto-load cap — so this reproduces the zero-chats bug from #259.
    const catalog = buildBackendCatalog(["project-a", "project-b"], 61);
    expect(
      catalog.findIndex((session) => session.projectId === "project-b"),
    ).toBeGreaterThan(60);
    useProjectStore.setState({
      projects: [makeProject("project-a"), makeProject("project-b")],
      hasFetchedProjects: true,
    });
    seedLoadedState(catalog, 1);
    mocks.acpListSessionsPage.mockImplementation(
      ({ cursor }: { cursor?: string | null } = {}) =>
        Promise.resolve(pageFromCatalog(catalog, cursor)),
    );

    renderHydration();

    await waitFor(() => {
      const projectIds = new Set(
        useChatSessionStore
          .getState()
          .sessions.map((session) => session.projectId),
      );
      expect(projectIds).toContain("project-a");
      expect(projectIds).toContain("project-b");
    });
    expect(mocks.acpListSessionsPage.mock.calls.length).toBeGreaterThan(1);
  });

  it("stops paging as soon as every visible project has a loaded chat", async () => {
    const catalog = buildBackendCatalog(["project-a"], 4);
    useProjectStore.setState({
      projects: [makeProject("project-a")],
      hasFetchedProjects: true,
    });
    // Only the two standalone chats are loaded; project-a's chats start on
    // the next page, which still has more pages behind it.
    seedLoadedState(catalog, 0, [
      makeSession("standalone-1", {
        lastMessageAt: catalog[0].lastMessageAt ?? undefined,
      }),
      makeSession("standalone-2", {
        lastMessageAt: catalog[1].lastMessageAt ?? undefined,
      }),
    ]);
    useChatSessionStore.setState({
      sessionPageCursor: "2",
      hasMoreSessions: true,
    });
    mocks.acpListSessionsPage.mockImplementation(
      ({ cursor }: { cursor?: string | null } = {}) =>
        Promise.resolve(pageFromCatalog(catalog, cursor)),
    );

    renderHydration();

    // Wait until the single needed page has actually merged project-a's
    // first chat, then drain effects and assert no further page is requested.
    await waitFor(() => {
      expect(
        useChatSessionStore
          .getState()
          .sessions.some((session) => session.projectId === "project-a"),
      ).toBe(true);
    });
    await flushHydration();
    expect(mocks.acpListSessionsPage).toHaveBeenCalledTimes(1);
    expect(mocks.acpListSessionsPage).toHaveBeenCalledWith({ cursor: "2" });
    expect(useChatSessionStore.getState().hasMoreSessions).toBe(true);
  });

  it("does not page when disabled", async () => {
    const catalog = buildBackendCatalog(["project-a"], 5);
    useProjectStore.setState({
      projects: [makeProject("project-a")],
      hasFetchedProjects: true,
    });
    seedLoadedState(catalog, 1);
    mocks.acpListSessionsPage.mockResolvedValue(pageFromCatalog(catalog, null));

    renderHydration(false);
    await flushHydration();

    expect(mocks.acpListSessionsPage).not.toHaveBeenCalled();
  });

  it("does not page before projects have been fetched from the backend", async () => {
    const catalog = buildBackendCatalog(["project-a"], 5);
    seedLoadedState(catalog, 1);
    mocks.acpListSessionsPage.mockResolvedValue(pageFromCatalog(catalog, null));

    renderHydration();
    await flushHydration();

    expect(mocks.acpListSessionsPage).not.toHaveBeenCalled();
  });

  it("ignores archived projects when deciding what still needs chats", async () => {
    // other-project's chat is already in the first page, so the archived
    // project is the only thing that could trigger paging. If archived
    // projects counted as pending, a request would fire here.
    const catalog = buildBackendCatalog(["other-project"], 5);
    useProjectStore.setState({
      projects: [
        makeProject("other-project"),
        makeProject("archived-project", "2026-03-01T00:00:00.000Z"),
      ],
      hasFetchedProjects: true,
    });
    seedLoadedState(catalog, 1);
    mocks.acpListSessionsPage.mockImplementation(
      ({ cursor }: { cursor?: string | null } = {}) =>
        Promise.resolve(pageFromCatalog(catalog, cursor)),
    );

    renderHydration();
    await flushHydration();

    expect(mocks.acpListSessionsPage).not.toHaveBeenCalled();
  });

  it("does not count zero-message placeholder sessions toward hydration", async () => {
    // A placeholder renders in the project section only while locally
    // relevant; it cannot stand in for the project's real chats, so the hook
    // keeps paging until a started chat for the project lands.
    const catalog = buildBackendCatalog(["project-a"], 2);
    useProjectStore.setState({
      projects: [makeProject("project-a")],
      hasFetchedProjects: true,
    });
    seedLoadedState(catalog, 0, [
      makeSession("standalone-1", {
        lastMessageAt: catalog[0].lastMessageAt ?? undefined,
      }),
      makeSession("standalone-2", {
        lastMessageAt: catalog[1].lastMessageAt ?? undefined,
      }),
      makeSession("pinned-placeholder", {
        projectId: "project-a",
        messageCount: 0,
        pinnedLoadState: "loading",
      }),
    ]);
    useChatSessionStore.setState({
      sessionPageCursor: "2",
      hasMoreSessions: true,
    });
    mocks.acpListSessionsPage.mockImplementation(
      ({ cursor }: { cursor?: string | null } = {}) =>
        Promise.resolve(pageFromCatalog(catalog, cursor)),
    );

    renderHydration();

    await waitFor(() => {
      const started = useChatSessionStore
        .getState()
        .sessions.some(
          (session) =>
            session.projectId === "project-a" && session.messageCount > 0,
        );
      expect(started).toBe(true);
    });
  });

  it("walks to the end of the catalog for a project that owns no sessions", async () => {
    const catalog = buildBackendCatalog(["other-project"], 9);
    useProjectStore.setState({
      projects: [makeProject("empty-project"), makeProject("other-project")],
      hasFetchedProjects: true,
    });
    seedLoadedState(catalog, 1);
    mocks.acpListSessionsPage.mockImplementation(
      ({ cursor }: { cursor?: string | null } = {}) =>
        Promise.resolve(pageFromCatalog(catalog, cursor)),
    );

    renderHydration();

    await waitFor(() => {
      expect(useChatSessionStore.getState().hasMoreSessions).toBe(false);
    });
    const pageCount = mocks.acpListSessionsPage.mock.calls.length;
    expect(pageCount).toBeGreaterThan(1);
    expect(pageCount).toBeLessThanOrEqual(40);

    // Once pagination is exhausted the hook stays idle.
    const callsAtExhaustion = mocks.acpListSessionsPage.mock.calls.length;
    await flushHydration();
    expect(mocks.acpListSessionsPage).toHaveBeenCalledTimes(callsAtExhaustion);
  });

  it("stops paging when the backend repeats a cursor", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const catalog = buildBackendCatalog(["project-a"], 3);
    useProjectStore.setState({
      projects: [makeProject("project-a"), makeProject("missing-project")],
      hasFetchedProjects: true,
    });
    seedLoadedState(catalog, 1);
    mocks.acpListSessionsPage.mockImplementation(
      ({ cursor }: { cursor?: string | null } = {}) => {
        const page = pageFromCatalog(catalog, cursor);
        return Promise.resolve({ ...page, nextCursor: cursor ?? null });
      },
    );

    renderHydration();

    await waitFor(() => {
      expect(useChatSessionStore.getState().hasMoreSessions).toBe(false);
    });
    const callsAtStop = mocks.acpListSessionsPage.mock.calls.length;
    expect(callsAtStop).toBe(1);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("same pagination cursor"),
    );

    await flushHydration();
    expect(mocks.acpListSessionsPage).toHaveBeenCalledTimes(callsAtStop);
  });

  it("bounds paging when the catalog never ends", {
    timeout: 20_000,
  }, async () => {
    useProjectStore.setState({
      projects: [makeProject("missing-project")],
      hasFetchedProjects: true,
    });
    useChatSessionStore.setState({
      sessions: [],
      hasHydratedSessions: true,
      sessionPageCursor: "0",
      hasMoreSessions: true,
    });
    mocks.acpListSessionsPage.mockImplementation(
      ({ cursor }: { cursor?: string | null } = {}) => {
        const start = cursor ? Number.parseInt(cursor, 10) : 0;
        return Promise.resolve({
          sessions: [makeAcpSession(`other-${start}`, start)],
          nextCursor: String(start + 1),
        });
      },
    );

    renderHydration();

    await waitFor(
      () => {
        expect(mocks.acpListSessionsPage).toHaveBeenCalledTimes(40);
      },
      { timeout: 10_000 },
    );
    const cappedCalls = mocks.acpListSessionsPage.mock.calls.length;
    await flushHydration();
    expect(mocks.acpListSessionsPage).toHaveBeenCalledTimes(cappedCalls);
  });

  it("recovers when a page request fails after a backoff retry", async () => {
    vi.useFakeTimers();
    try {
      const catalog = buildBackendCatalog(["project-a"], 6);
      useProjectStore.setState({
        projects: [makeProject("project-a")],
        hasFetchedProjects: true,
      });
      // Project-a's chats all sit past the loaded standalone chats.
      seedLoadedState(catalog, 0, [
        makeSession("standalone-1", {
          lastMessageAt: catalog[0].lastMessageAt ?? undefined,
        }),
        makeSession("standalone-2", {
          lastMessageAt: catalog[1].lastMessageAt ?? undefined,
        }),
      ]);
      useChatSessionStore.setState({
        sessionPageCursor: "2",
        hasMoreSessions: true,
      });
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      let shouldFail = true;
      mocks.acpListSessionsPage.mockImplementation(
        ({ cursor }: { cursor?: string | null } = {}) => {
          if (shouldFail) {
            shouldFail = false;
            return Promise.reject(new Error("network down"));
          }
          return Promise.resolve(pageFromCatalog(catalog, cursor));
        },
      );

      renderHydration();
      // First attempt fails without advancing pagination; no immediate retry.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(mocks.acpListSessionsPage).toHaveBeenCalledTimes(1);
      expect(errorSpy).toHaveBeenCalledWith(
        "Failed to load more sessions from ACP:",
        expect.any(Error),
      );

      // The backoff timer retries, the next page lands, and hydration
      // continues until project-a has a started chat loaded.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(2_000);
      });
      const hydrated = () =>
        useChatSessionStore
          .getState()
          .sessions.some((session) => session.projectId === "project-a");
      for (let step = 0; step < 10 && !hydrated(); step += 1) {
        await act(async () => {
          await vi.advanceTimersByTimeAsync(1_000);
        });
      }
      expect(hydrated()).toBe(true);
      expect(mocks.acpListSessionsPage.mock.calls.length).toBeGreaterThan(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("stops retrying after repeated failures", async () => {
    vi.useFakeTimers();
    try {
      const catalog = buildBackendCatalog(["project-a"], 6);
      useProjectStore.setState({
        projects: [makeProject("project-a")],
        hasFetchedProjects: true,
      });
      seedLoadedState(catalog, 0, [
        makeSession("standalone-1", {
          lastMessageAt: catalog[0].lastMessageAt ?? undefined,
        }),
        makeSession("standalone-2", {
          lastMessageAt: catalog[1].lastMessageAt ?? undefined,
        }),
      ]);
      useChatSessionStore.setState({
        sessionPageCursor: "2",
        hasMoreSessions: true,
      });
      vi.spyOn(console, "error").mockImplementation(() => {});
      mocks.acpListSessionsPage.mockRejectedValue(new Error("network down"));

      renderHydration();
      // 1 initial attempt + 4 backoff retries = 5 total failures, then stop.
      for (const delayMs of [0, 2_000, 4_000, 8_000, 16_000]) {
        await act(async () => {
          await vi.advanceTimersByTimeAsync(delayMs);
        });
      }
      expect(mocks.acpListSessionsPage).toHaveBeenCalledTimes(5);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(60_000);
      });
      expect(mocks.acpListSessionsPage).toHaveBeenCalledTimes(5);
    } finally {
      vi.useRealTimers();
    }
  });

  it("stops paging after unmount", async () => {
    let releasePage!: (page: {
      sessions: AcpSessionInfo[];
      nextCursor: string | null;
    }) => void;
    const pendingPage = new Promise<{
      sessions: AcpSessionInfo[];
      nextCursor: string | null;
    }>((resolve) => {
      releasePage = resolve;
    });
    const catalog = buildBackendCatalog(["project-a", "project-b"], 5);
    useProjectStore.setState({
      projects: [makeProject("project-a"), makeProject("project-b")],
      hasFetchedProjects: true,
    });
    seedLoadedState(catalog, 1);
    mocks.acpListSessionsPage
      .mockReturnValueOnce(pendingPage)
      .mockImplementation(({ cursor }: { cursor?: string | null } = {}) =>
        Promise.resolve(pageFromCatalog(catalog, cursor)),
      );

    const { unmount } = renderHydration();
    await waitFor(() => {
      expect(mocks.acpListSessionsPage).toHaveBeenCalledTimes(1);
    });
    unmount();
    await act(async () => {
      releasePage(pageFromCatalog(catalog, "3"));
    });
    await flushHydration();

    expect(mocks.acpListSessionsPage).toHaveBeenCalledTimes(1);
  });

  it("resumes a pending backoff retry after unmount and remount", async () => {
    vi.useFakeTimers();
    try {
      const catalog = buildBackendCatalog(["project-a"], 6);
      useProjectStore.setState({
        projects: [makeProject("project-a")],
        hasFetchedProjects: true,
      });
      seedLoadedState(catalog, 0, [
        makeSession("standalone-1", {
          lastMessageAt: catalog[0].lastMessageAt ?? undefined,
        }),
        makeSession("standalone-2", {
          lastMessageAt: catalog[1].lastMessageAt ?? undefined,
        }),
      ]);
      useChatSessionStore.setState({
        sessionPageCursor: "2",
        hasMoreSessions: true,
      });
      vi.spyOn(console, "error").mockImplementation(() => {});
      let shouldFail = true;
      mocks.acpListSessionsPage.mockImplementation(
        ({ cursor }: { cursor?: string | null } = {}) => {
          if (shouldFail) {
            shouldFail = false;
            return Promise.reject(new Error("network down"));
          }
          return Promise.resolve(pageFromCatalog(catalog, cursor));
        },
      );

      // Fail once so a backoff deadline is pending, then unmount before the
      // original instance's wake timer can fire.
      const first = renderHydration();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(mocks.acpListSessionsPage).toHaveBeenCalledTimes(1);
      first.unmount();

      // A new instance mounts during the backoff window; it must honor the
      // shared deadline and then retry on its own timer.
      renderHydration();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1_000);
      });
      expect(mocks.acpListSessionsPage).toHaveBeenCalledTimes(1);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(1_000);
      });
      const hydrated = () =>
        useChatSessionStore
          .getState()
          .sessions.some((session) => session.projectId === "project-a");
      for (let step = 0; step < 10 && !hydrated(); step += 1) {
        await act(async () => {
          await vi.advanceTimersByTimeAsync(1_000);
        });
      }
      expect(hydrated()).toBe(true);
      expect(mocks.acpListSessionsPage.mock.calls.length).toBeGreaterThan(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("resumes hydration after a loadSessions() refresh rewinds the cursor", async () => {
    // project-a's chats start at index 12. The second hydration page is held
    // deferred so hydration cannot reach project-a before the refresh; the
    // refresh then rewinds the cursor to "3", a position already attempted.
    const catalog = buildBackendCatalog(["project-a"], 12, 12);
    useProjectStore.setState({
      projects: [makeProject("project-a")],
      hasFetchedProjects: true,
    });
    seedLoadedState(catalog, 1);
    let releaseSecondPage!: (page: {
      sessions: AcpSessionInfo[];
      nextCursor: string | null;
    }) => void;
    const secondPage = new Promise<{
      sessions: AcpSessionInfo[];
      nextCursor: string | null;
    }>((resolve) => {
      releaseSecondPage = resolve;
    });
    let calls = 0;
    mocks.acpListSessionsPage.mockImplementation(
      ({ cursor }: { cursor?: string | null } = {}) => {
        calls += 1;
        if (calls === 1) return secondPage;
        return Promise.resolve(pageFromCatalog(catalog, cursor));
      },
    );

    renderHydration();
    await waitFor(() => {
      expect(mocks.acpListSessionsPage).toHaveBeenCalledTimes(1);
    });
    // One position attempted, project-a still absent.
    expect(
      useChatSessionStore
        .getState()
        .sessions.some((session) => session.projectId === "project-a"),
    ).toBe(false);

    // Refresh while the first hydration page is held; the stale completion is
    // dropped by the store's epoch guard.
    await act(async () => {
      const refresh = useChatSessionStore.getState().loadSessions();
      releaseSecondPage(pageFromCatalog(catalog, "3"));
      await refresh;
    });

    // Hydration resumes from the rewound cursor — re-requesting the already
    // attempted "3" position — and walks until project-a is hydrated.
    await waitFor(() => {
      expect(
        mocks.acpListSessionsPage.mock.calls.filter(
          (args) =>
            (args[0] as { cursor?: string } | undefined)?.cursor === "3",
        ).length,
      ).toBeGreaterThanOrEqual(2);
    });
    await waitFor(() => {
      const hydrated = useChatSessionStore
        .getState()
        .sessions.some((session) => session.projectId === "project-a");
      expect(hydrated).toBe(true);
    });
  });

  it("drops an in-flight hydration page superseded by a refresh", async () => {
    let releaseStalePage!: (page: {
      sessions: AcpSessionInfo[];
      nextCursor: string | null;
    }) => void;
    const stalePage = new Promise<{
      sessions: AcpSessionInfo[];
      nextCursor: string | null;
    }>((resolve) => {
      releaseStalePage = resolve;
    });
    const catalog = buildBackendCatalog(["project-a"], 12, 12);
    useProjectStore.setState({
      projects: [makeProject("project-a")],
      hasFetchedProjects: true,
    });
    seedLoadedState(catalog, 1);
    mocks.acpListSessionsPage
      .mockReturnValueOnce(stalePage)
      .mockImplementation(({ cursor }: { cursor?: string | null } = {}) =>
        Promise.resolve(pageFromCatalog(catalog, cursor)),
      );

    renderHydration();
    await waitFor(() => {
      expect(mocks.acpListSessionsPage).toHaveBeenCalledTimes(1);
    });

    // Refresh while the hydration page is in flight; the store's epoch guard
    // discards the stale page when it finally resolves. The sentinel id would
    // appear in the store if the stale merge were applied.
    await act(async () => {
      const refresh = useChatSessionStore.getState().loadSessions();
      releaseStalePage({
        sessions: [makeAcpSession("stale-sentinel", 99, "project-a")],
        nextCursor: "6",
      });
      await refresh;
    });
    expect(
      useChatSessionStore
        .getState()
        .sessions.some((session) => session.id === "stale-sentinel"),
    ).toBe(false);

    await waitFor(() => {
      const hydrated = useChatSessionStore
        .getState()
        .sessions.some((session) => session.projectId === "project-a");
      expect(hydrated).toBe(true);
    });
  });

  it("resets the consecutive-failure count after a successful page", async () => {
    vi.useFakeTimers();
    try {
      // project-a's chats start at index 30, so hydration keeps walking.
      const catalog = buildBackendCatalog(["project-a"], 6, 30);
      useProjectStore.setState({
        projects: [makeProject("project-a")],
        hasFetchedProjects: true,
      });
      seedLoadedState(catalog, 0, [
        makeSession("standalone-1", {
          lastMessageAt: catalog[0].lastMessageAt ?? undefined,
        }),
        makeSession("standalone-2", {
          lastMessageAt: catalog[1].lastMessageAt ?? undefined,
        }),
      ]);
      useChatSessionStore.setState({
        sessionPageCursor: "2",
        hasMoreSessions: true,
      });
      vi.spyOn(console, "error").mockImplementation(() => {});
      // Fail the first attempt, succeed for a while, then fail persistently.
      // The success must reset the failure counter so the later outage gets a
      // fresh set of five attempts (1 + 4 retries) instead of stopping early.
      let callCount = 0;
      mocks.acpListSessionsPage.mockImplementation(
        ({ cursor }: { cursor?: string | null } = {}) => {
          callCount += 1;
          if (callCount === 1 || callCount >= 4) {
            return Promise.reject(new Error("network down"));
          }
          return Promise.resolve(pageFromCatalog(catalog, cursor));
        },
      );

      renderHydration();
      // Attempt 1 fails immediately; the 2s backoff retry succeeds, the next
      // page chains immediately and succeeds, and the following page fails —
      // four calls by t=2s.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(2_000);
      });
      expect(mocks.acpListSessionsPage).toHaveBeenCalledTimes(4);

      // The success reset the failure counter, so the new outage gets a full
      // set of retries: failures 2-5 at 4s, 8s, 16s, and 32s, then stop.
      for (const delayMs of [4_000, 8_000, 16_000, 32_000]) {
        await act(async () => {
          await vi.advanceTimersByTimeAsync(delayMs);
        });
      }
      expect(mocks.acpListSessionsPage).toHaveBeenCalledTimes(8);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(120_000);
      });
      expect(mocks.acpListSessionsPage).toHaveBeenCalledTimes(8);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps paging when a project is added mid-hydration", async () => {
    let releasePage!: (page: {
      sessions: AcpSessionInfo[];
      nextCursor: string | null;
    }) => void;
    const pendingPage = new Promise<{
      sessions: AcpSessionInfo[];
      nextCursor: string | null;
    }>((resolve) => {
      releasePage = resolve;
    });
    // Both projects' chats sit past page 1, so hydration is in flight when
    // project-b appears.
    const catalog = buildBackendCatalog(["project-a", "project-b"], 5, 8);
    useProjectStore.setState({
      projects: [makeProject("project-a")],
      hasFetchedProjects: true,
    });
    seedLoadedState(catalog, 1);
    mocks.acpListSessionsPage
      .mockReturnValueOnce(pendingPage)
      .mockImplementation(({ cursor }: { cursor?: string | null } = {}) =>
        Promise.resolve(pageFromCatalog(catalog, cursor)),
      );

    renderHydration();
    await waitFor(() => {
      expect(mocks.acpListSessionsPage).toHaveBeenCalledTimes(1);
    });

    // project-b appears while a page for project-a is still in flight.
    await act(async () => {
      useProjectStore.setState({
        projects: [makeProject("project-a"), makeProject("project-b")],
      });
      releasePage(pageFromCatalog(catalog, "3"));
    });

    await waitFor(() => {
      const projectIds = new Set(
        useChatSessionStore
          .getState()
          .sessions.map((session) => session.projectId),
      );
      expect(projectIds).toContain("project-a");
      expect(projectIds).toContain("project-b");
    });
  });

  it("does not count archived chats toward their project's hydration", async () => {
    // project-a's only loaded chat is archived; its active chat sits on the
    // next page, so hydration must keep paging rather than trusting the
    // archived row.
    const catalog = buildBackendCatalog(["project-a"], 2, 8);
    useProjectStore.setState({
      projects: [makeProject("project-a")],
      hasFetchedProjects: true,
    });
    seedLoadedState(catalog, 0, [
      makeSession("archived-chat", {
        projectId: "project-a",
        messageCount: 3,
        archivedAt: "2026-03-01T00:00:00.000Z",
      }),
    ]);
    useChatSessionStore.setState({
      sessionPageCursor: "0",
      hasMoreSessions: true,
    });
    mocks.acpListSessionsPage.mockImplementation(
      ({ cursor }: { cursor?: string | null } = {}) =>
        Promise.resolve(pageFromCatalog(catalog, cursor)),
    );

    renderHydration();

    await waitFor(() => {
      const active = useChatSessionStore
        .getState()
        .sessions.some(
          (session) => session.projectId === "project-a" && !session.archivedAt,
        );
      expect(active).toBe(true);
    });
  });

  it("stops retrying after 15 lifetime failures even across refreshes", async () => {
    vi.useFakeTimers();
    try {
      const catalog = buildBackendCatalog(["project-a"], 6, 30);
      useProjectStore.setState({
        projects: [makeProject("project-a")],
        hasFetchedProjects: true,
      });
      seedLoadedState(catalog, 0, [
        makeSession("standalone-1", {
          lastMessageAt: catalog[0].lastMessageAt ?? undefined,
        }),
        makeSession("standalone-2", {
          lastMessageAt: catalog[1].lastMessageAt ?? undefined,
        }),
      ]);
      useChatSessionStore.setState({
        sessionPageCursor: "2",
        hasMoreSessions: true,
      });
      vi.spyOn(console, "error").mockImplementation(() => {});
      // First-page reloads succeed (each re-arms the consecutive-failure
      // breaker); deeper pages always fail.
      mocks.acpListSessionsPage.mockImplementation(
        ({ cursor }: { cursor?: string | null } = {}) =>
          cursor == null || cursor === "0"
            ? Promise.resolve(pageFromCatalog(catalog, cursor))
            : Promise.reject(new Error("network down")),
      );

      renderHydration();
      // Three rounds of five consecutive failures, each followed by a
      // successful loadSessions() reload that resets the consecutive breaker.
      for (let round = 0; round < 3; round += 1) {
        for (const delayMs of [0, 2_000, 4_000, 8_000, 16_000]) {
          await act(async () => {
            await vi.advanceTimersByTimeAsync(delayMs);
          });
        }
        await act(async () => {
          await useChatSessionStore.getState().loadSessions();
        });
      }
      expect(mocks.acpListSessionsPage).toHaveBeenCalledTimes(15 + 3);

      // The lifetime breaker holds despite further successful refreshes.
      await act(async () => {
        await useChatSessionStore.getState().loadSessions();
        await vi.advanceTimersByTimeAsync(120_000);
      });
      expect(mocks.acpListSessionsPage).toHaveBeenCalledTimes(15 + 4);
    } finally {
      vi.useRealTimers();
    }
  });

  it("resumes hydration when a refresh happens while unmounted", async () => {
    // project-a's chats start at index 12. Hydrate one page, unmount, run a
    // full refresh (rewinding the cursor), then remount: the rewound position
    // must be re-attempted rather than treated as already visited.
    const catalog = buildBackendCatalog(["project-a"], 12, 12);
    useProjectStore.setState({
      projects: [makeProject("project-a")],
      hasFetchedProjects: true,
    });
    seedLoadedState(catalog, 1);
    mocks.acpListSessionsPage.mockImplementation(
      ({ cursor }: { cursor?: string | null } = {}) =>
        Promise.resolve(pageFromCatalog(catalog, cursor)),
    );

    const { unmount } = renderHydration();
    await waitFor(() => {
      expect(mocks.acpListSessionsPage).toHaveBeenCalled();
    });
    const callsBeforeUnmount = mocks.acpListSessionsPage.mock.calls.length;
    unmount();

    await act(async () => {
      await useChatSessionStore.getState().loadSessions();
    });

    renderHydration();
    await waitFor(() => {
      const hydrated = useChatSessionStore
        .getState()
        .sessions.some((session) => session.projectId === "project-a");
      expect(hydrated).toBe(true);
    });
    // The refresh rewound pagination while unmounted; the remounted hook must
    // have requested further pages to finish hydrating project-a.
    expect(mocks.acpListSessionsPage.mock.calls.length).toBeGreaterThan(
      callsBeforeUnmount,
    );
  });

  it("retries its position when a concurrent page request wins the race", async () => {
    // project-a's chats start at index 12. The hook's first request is held
    // while a competing loadMoreSessions (as the flat sidebar or history view
    // could issue) wins the in-flight guard; the hook's attempt resolves
    // "skipped" and must retry once the winner settles.
    const catalog = buildBackendCatalog(["project-a"], 6, 12);
    useProjectStore.setState({
      projects: [makeProject("project-a")],
      hasFetchedProjects: true,
    });
    seedLoadedState(catalog, 1);
    let releaseHeld!: (page: {
      sessions: AcpSessionInfo[];
      nextCursor: string | null;
    }) => void;
    const heldPage = new Promise<{
      sessions: AcpSessionInfo[];
      nextCursor: string | null;
    }>((resolve) => {
      releaseHeld = resolve;
    });
    let calls = 0;
    mocks.acpListSessionsPage.mockImplementation(
      ({ cursor }: { cursor?: string | null } = {}) => {
        calls += 1;
        if (calls === 1) return heldPage;
        return Promise.resolve(pageFromCatalog(catalog, cursor));
      },
    );

    renderHydration();
    await waitFor(() => {
      expect(mocks.acpListSessionsPage).toHaveBeenCalledTimes(1);
    });

    // A competing pager issues a request while the hook's page is held; the
    // hook's own next attempt (after the held page lands) must still walk to
    // project-a instead of stalling on a skipped position.
    await act(async () => {
      releaseHeld(pageFromCatalog(catalog, "3"));
    });
    await act(async () => {
      await useChatSessionStore.getState().loadMoreSessions();
    });

    await waitFor(() => {
      const hydrated = useChatSessionStore
        .getState()
        .sessions.some((session) => session.projectId === "project-a");
      expect(hydrated).toBe(true);
    });
  });
});

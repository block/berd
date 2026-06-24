import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AcpSessionInfo } from "@/shared/api/acp";
import { useSessionWindowStore } from "@/features/chat/stores/sessionWindowStore";
import {
  type ChatSession,
  SessionNotFoundError,
  useChatSessionStore,
} from "../chatSessionStore";

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

vi.mock("@/shared/api/acpApi", () => ({
  archiveSession: (...args: unknown[]) => mocks.archiveSession(...args),
  unarchiveSession: (...args: unknown[]) => mocks.unarchiveSession(...args),
  renameSession: vi.fn().mockResolvedValue(undefined),
  updateSessionProject: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/features/chat/lib/sessionWindowCommands", () => ({
  releaseSession: (...args: unknown[]) => mocks.releaseSession(...args),
}));

function resetStore() {
  useChatSessionStore.setState({
    sessions: [],
    activeSessionId: null,
    isLoading: false,
    isLoadingMoreSessions: false,
    hasHydratedSessions: false,
    sessionPageCursor: null,
    hasMoreSessions: false,
    isContextPanelOpen: false,
    activeWorkspaceBySession: {},
    modelSelectionIntentBySession: {},
    archiveMutationBySessionId: {},
  });
}

function makeSession(overrides: Partial<ChatSession> = {}): ChatSession {
  return {
    id: "session-1",
    title: "Test Session",
    createdAt: "2026-04-01T00:00:00.000Z",
    updatedAt: "2026-04-01T00:00:00.000Z",
    messageCount: 0,
    ...overrides,
  };
}

function seedSession(overrides: Partial<ChatSession> = {}): ChatSession {
  const session = makeSession(overrides);
  useChatSessionStore.setState((state) => ({
    sessions: [session, ...state.sessions],
  }));
  return session;
}

function makeAcpSession(
  overrides: Partial<AcpSessionInfo> & { sessionId: string },
): AcpSessionInfo {
  const { sessionId, ...rest } = overrides;
  return {
    sessionId,
    title: "ACP Session",
    updatedAt: "2026-04-01T00:00:00.000Z",
    createdAt: "2026-04-01T00:00:00.000Z",
    archivedAt: null,
    userSetName: false,
    messageCount: 1,
    subtitle: null,
    workingDir: null,
    projectId: null,
    providerId: null,
    modelId: null,
    personaId: null,
    ...rest,
  };
}

function mockPage(
  sessions: AcpSessionInfo[] = [],
  nextCursor: string | null = null,
) {
  return { sessions, nextCursor };
}

function createDeferredPromise<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("chatSessionStore", () => {
  beforeEach(() => {
    window.localStorage.removeItem("goose:context-panel-open");
    resetStore();
    useSessionWindowStore.getState().setSnapshot([]);
    vi.clearAllMocks();
    mocks.archiveSession.mockResolvedValue(undefined);
    mocks.releaseSession.mockResolvedValue(undefined);
    mocks.unarchiveSession.mockResolvedValue(undefined);
  });

  it("releases a windowed session when removing it locally", () => {
    seedSession({ id: "session-1" });
    useSessionWindowStore
      .getState()
      .setSnapshot([{ sessionId: "session-1", windowLabel: "session:a" }]);

    useChatSessionStore.getState().removeSession("session-1");

    expect(mocks.releaseSession).toHaveBeenCalledWith("session-1");
  });

  describe("archiveSession", () => {
    it("archives optimistically and awaits the backend call", async () => {
      seedSession({ id: "session-1" });
      useChatSessionStore.setState({ activeSessionId: "session-1" });

      await useChatSessionStore.getState().archiveSession("session-1");

      expect(mocks.archiveSession).toHaveBeenCalledWith("session-1");
      const state = useChatSessionStore.getState();
      expect(state.getSession("session-1")?.archivedAt).toEqual(
        expect.any(String),
      );
      expect(state.activeSessionId).toBe("session-1");
    });

    it("rolls back archivedAt to the prior value when the backend fails", async () => {
      seedSession({ id: "session-1" });
      useChatSessionStore.setState({ activeSessionId: "session-1" });
      mocks.archiveSession.mockRejectedValue(new Error("backend down"));

      await expect(
        useChatSessionStore.getState().archiveSession("session-1"),
      ).rejects.toThrow("backend down");

      const state = useChatSessionStore.getState();
      expect(state.getSession("session-1")?.archivedAt).toBeUndefined();
      expect(state.activeSessionId).toBe("session-1");
    });

    it("restores a pre-existing archivedAt timestamp on rollback", async () => {
      const priorArchivedAt = "2026-03-15T00:00:00.000Z";
      seedSession({ id: "session-1", archivedAt: priorArchivedAt });
      mocks.archiveSession.mockRejectedValue(new Error("backend down"));

      await expect(
        useChatSessionStore.getState().archiveSession("session-1"),
      ).rejects.toThrow("backend down");

      expect(
        useChatSessionStore.getState().getSession("session-1")?.archivedAt,
      ).toBe(priorArchivedAt);
    });

    it("throws SessionNotFoundError for an unknown id without calling the backend", async () => {
      await expect(
        useChatSessionStore.getState().archiveSession("missing-session"),
      ).rejects.toBeInstanceOf(SessionNotFoundError);

      expect(mocks.archiveSession).not.toHaveBeenCalled();
      expect(mocks.releaseSession).not.toHaveBeenCalled();
    });

    it("does not release a windowed session when archiving", async () => {
      seedSession({ id: "session-1" });
      useSessionWindowStore
        .getState()
        .setSnapshot([{ sessionId: "session-1", windowLabel: "session:a" }]);

      await useChatSessionStore.getState().archiveSession("session-1");

      expect(mocks.releaseSession).not.toHaveBeenCalled();
    });

    it("does not let an older unarchive failure roll back a newer archive", async () => {
      const priorArchivedAt = "2026-03-15T00:00:00.000Z";
      const unarchive = createDeferredPromise<void>();
      const archive = createDeferredPromise<void>();
      seedSession({ id: "session-1", archivedAt: priorArchivedAt });
      mocks.unarchiveSession.mockReturnValueOnce(unarchive.promise);
      mocks.archiveSession.mockReturnValueOnce(archive.promise);

      const unarchivePromise = useChatSessionStore
        .getState()
        .unarchiveSession("session-1");
      expect(
        useChatSessionStore.getState().getSession("session-1")?.archivedAt,
      ).toBeUndefined();

      const archivePromise = useChatSessionStore
        .getState()
        .archiveSession("session-1");
      const latestArchivedAt = useChatSessionStore
        .getState()
        .getSession("session-1")?.archivedAt;
      expect(latestArchivedAt).toEqual(expect.any(String));

      unarchive.reject(new Error("stale failure"));
      await expect(unarchivePromise).rejects.toThrow("stale failure");

      expect(
        useChatSessionStore.getState().getSession("session-1")?.archivedAt,
      ).toBe(latestArchivedAt);

      archive.resolve(undefined);
      await archivePromise;
      expect(
        useChatSessionStore.getState().getSession("session-1")?.archivedAt,
      ).toBe(latestArchivedAt);
    });

    it("rolls back to the backend-known archived state when overlapping unarchive and archive both fail", async () => {
      const priorArchivedAt = "2026-03-15T00:00:00.000Z";
      const unarchive = createDeferredPromise<void>();
      const archive = createDeferredPromise<void>();
      seedSession({ id: "session-1", archivedAt: priorArchivedAt });
      mocks.unarchiveSession.mockReturnValueOnce(unarchive.promise);
      mocks.archiveSession.mockReturnValueOnce(archive.promise);

      const unarchivePromise = useChatSessionStore
        .getState()
        .unarchiveSession("session-1");
      const archivePromise = useChatSessionStore
        .getState()
        .archiveSession("session-1");

      unarchive.reject(new Error("unarchive failed"));
      await expect(unarchivePromise).rejects.toThrow("unarchive failed");
      archive.reject(new Error("archive failed"));
      await expect(archivePromise).rejects.toThrow("archive failed");

      expect(
        useChatSessionStore.getState().getSession("session-1")?.archivedAt,
      ).toBe(priorArchivedAt);
    });

    it("applies an older archive success after a newer unarchive failure clears the mutation", async () => {
      const archive = createDeferredPromise<void>();
      const unarchive = createDeferredPromise<void>();
      seedSession({ id: "session-1" });
      mocks.archiveSession.mockReturnValueOnce(archive.promise);
      mocks.unarchiveSession.mockReturnValueOnce(unarchive.promise);

      const archivePromise = useChatSessionStore
        .getState()
        .archiveSession("session-1");
      const archivedAt = useChatSessionStore
        .getState()
        .getSession("session-1")?.archivedAt;
      expect(archivedAt).toEqual(expect.any(String));

      const unarchivePromise = useChatSessionStore
        .getState()
        .unarchiveSession("session-1");
      unarchive.reject(new Error("unarchive failed"));
      await expect(unarchivePromise).rejects.toThrow("unarchive failed");

      expect(
        useChatSessionStore.getState().getSession("session-1")?.archivedAt,
      ).toBeUndefined();
      expect(
        useChatSessionStore.getState().archiveMutationBySessionId,
      ).not.toHaveProperty("session-1");

      archive.resolve(undefined);
      await archivePromise;

      expect(
        useChatSessionStore.getState().getSession("session-1")?.archivedAt,
      ).toBe(archivedAt);
      expect(
        useChatSessionStore.getState().archiveMutationBySessionId["session-1"],
      ).toMatchObject({
        desiredState: "archived",
        status: "succeeded",
      });
    });
  });

  describe("unarchiveSession", () => {
    it("clears archivedAt optimistically and awaits the backend call", async () => {
      seedSession({ id: "session-1", archivedAt: "2026-03-15T00:00:00.000Z" });

      await useChatSessionStore.getState().unarchiveSession("session-1");

      expect(mocks.unarchiveSession).toHaveBeenCalledWith("session-1");
      expect(
        useChatSessionStore.getState().getSession("session-1")?.archivedAt,
      ).toBeUndefined();
    });

    it("rolls back archivedAt when the backend fails", async () => {
      const archivedAt = "2026-03-15T00:00:00.000Z";
      seedSession({ id: "session-1", archivedAt });
      mocks.unarchiveSession.mockRejectedValue(new Error("backend down"));

      await expect(
        useChatSessionStore.getState().unarchiveSession("session-1"),
      ).rejects.toThrow("backend down");

      expect(
        useChatSessionStore.getState().getSession("session-1")?.archivedAt,
      ).toBe(archivedAt);
    });

    it("does nothing for an unknown id", async () => {
      await useChatSessionStore.getState().unarchiveSession("missing-session");

      expect(mocks.unarchiveSession).not.toHaveBeenCalled();
    });

    it("rolls back to the backend-known unarchived state when overlapping archive and unarchive both fail", async () => {
      const archive = createDeferredPromise<void>();
      const unarchive = createDeferredPromise<void>();
      seedSession({ id: "session-1" });
      mocks.archiveSession.mockReturnValueOnce(archive.promise);
      mocks.unarchiveSession.mockReturnValueOnce(unarchive.promise);

      const archivePromise = useChatSessionStore
        .getState()
        .archiveSession("session-1");
      const unarchivePromise = useChatSessionStore
        .getState()
        .unarchiveSession("session-1");

      archive.reject(new Error("archive failed"));
      await expect(archivePromise).rejects.toThrow("archive failed");
      unarchive.reject(new Error("unarchive failed"));
      await expect(unarchivePromise).rejects.toThrow("unarchive failed");

      expect(
        useChatSessionStore.getState().getSession("session-1")?.archivedAt,
      ).toBeUndefined();
    });

    it("uses an older successful archive as rollback base when a newer unarchive fails", async () => {
      const archive = createDeferredPromise<void>();
      const unarchive = createDeferredPromise<void>();
      seedSession({ id: "session-1" });
      mocks.archiveSession.mockReturnValueOnce(archive.promise);
      mocks.unarchiveSession.mockReturnValueOnce(unarchive.promise);

      const archivePromise = useChatSessionStore
        .getState()
        .archiveSession("session-1");
      const archivedAt = useChatSessionStore
        .getState()
        .getSession("session-1")?.archivedAt;
      const unarchivePromise = useChatSessionStore
        .getState()
        .unarchiveSession("session-1");

      archive.resolve(undefined);
      await archivePromise;
      unarchive.reject(new Error("unarchive failed"));
      await expect(unarchivePromise).rejects.toThrow("unarchive failed");

      expect(
        useChatSessionStore.getState().getSession("session-1")?.archivedAt,
      ).toBe(archivedAt);
    });

    it("applies an older unarchive success after a newer archive failure clears the mutation", async () => {
      const priorArchivedAt = "2026-03-15T00:00:00.000Z";
      const unarchive = createDeferredPromise<void>();
      const archive = createDeferredPromise<void>();
      seedSession({ id: "session-1", archivedAt: priorArchivedAt });
      mocks.unarchiveSession.mockReturnValueOnce(unarchive.promise);
      mocks.archiveSession.mockReturnValueOnce(archive.promise);

      const unarchivePromise = useChatSessionStore
        .getState()
        .unarchiveSession("session-1");
      expect(
        useChatSessionStore.getState().getSession("session-1")?.archivedAt,
      ).toBeUndefined();

      const archivePromise = useChatSessionStore
        .getState()
        .archiveSession("session-1");
      expect(
        useChatSessionStore.getState().getSession("session-1")?.archivedAt,
      ).toEqual(expect.any(String));

      archive.reject(new Error("archive failed"));
      await expect(archivePromise).rejects.toThrow("archive failed");

      expect(
        useChatSessionStore.getState().getSession("session-1")?.archivedAt,
      ).toBe(priorArchivedAt);
      expect(
        useChatSessionStore.getState().archiveMutationBySessionId,
      ).not.toHaveProperty("session-1");

      unarchive.resolve(undefined);
      await unarchivePromise;

      expect(
        useChatSessionStore.getState().getSession("session-1")?.archivedAt,
      ).toBeUndefined();
      expect(
        useChatSessionStore.getState().archiveMutationBySessionId["session-1"],
      ).toMatchObject({
        desiredState: "unarchived",
        status: "succeeded",
      });
    });
  });

  describe("createSession", () => {
    it("creates a real ACP-backed session", async () => {
      mocks.acpCreateSession.mockResolvedValue({ sessionId: "acp-1" });

      const session = await useChatSessionStore.getState().createSession({
        title: "New Chat",
        providerId: "openai",
        projectId: "project-1",
        personaId: "persona-1",
        modelId: "gpt-4.1",
        modelName: "GPT-4.1",
        workingDir: "/tmp/project",
      });

      expect(mocks.acpCreateSession).toHaveBeenCalledWith(
        "openai",
        "/tmp/project",
        {
          projectId: "project-1",
          personaId: "persona-1",
          modelId: "gpt-4.1",
        },
      );
      expect(session).toMatchObject({
        id: "acp-1",
        title: "New Chat",
        projectId: "project-1",
        providerId: "openai",
        personaId: "persona-1",
        modelId: "gpt-4.1",
        modelName: "GPT-4.1",
        workingDir: "/tmp/project",
      });
      expect(useChatSessionStore.getState().sessions).toContainEqual(session);
    });

    it("creates a local draft session without touching ACP", () => {
      const session = useChatSessionStore.getState().createDraftSession({
        title: "New Chat",
        providerId: "openai",
        projectId: "project-1",
        modelId: "gpt-4.1",
        modelName: "GPT-4.1",
        workingDir: "/tmp/project",
      });

      expect(mocks.acpCreateSession).not.toHaveBeenCalled();
      expect(session).toMatchObject({
        title: "New Chat",
        projectId: "project-1",
        providerId: "openai",
        modelId: "gpt-4.1",
        modelName: "GPT-4.1",
        workingDir: "/tmp/project",
        messageCount: 0,
        creationState: "pending",
      });
      expect(session.id).toEqual(expect.any(String));
      expect(useChatSessionStore.getState().sessions).toContainEqual(session);
    });

    it("promotes a pending draft session to the real ACP session id", () => {
      seedSession({
        id: "local-session",
        title: "New Chat",
        projectId: "project-1",
        providerId: "openai",
        workingDir: "/tmp/project",
        creationState: "pending",
      });
      useChatSessionStore.setState({
        activeSessionId: "local-session",
        activeWorkspaceBySession: {
          "local-session": { path: "/tmp/project", branch: "main" },
        },
        modelSelectionIntentBySession: {
          "local-session": {
            requestId: "request-1",
            kind: "model",
            providerId: "openai",
            modelId: "gpt-4.1",
          },
        },
      });

      useChatSessionStore
        .getState()
        .promoteDraftSession("local-session", "acp-session", {
          modelId: "gpt-4.1",
          modelName: "GPT-4.1",
        });

      const state = useChatSessionStore.getState();
      expect(state.getSession("local-session")).toBeUndefined();
      expect(state.getSession("acp-session")).toMatchObject({
        id: "acp-session",
        modelId: "gpt-4.1",
        modelName: "GPT-4.1",
        creationState: undefined,
        creationError: undefined,
      });
      expect(state.activeSessionId).toBe("acp-session");
      expect(state.activeWorkspaceBySession).toEqual({
        "acp-session": { path: "/tmp/project", branch: "main" },
      });
      expect(state.modelSelectionIntentBySession).toHaveProperty("acp-session");
      expect(state.modelSelectionIntentBySession).not.toHaveProperty(
        "local-session",
      );
    });

    it("marks a pending draft session failed when ACP creation fails", () => {
      seedSession({
        id: "local-session",
        title: "New Chat",
        creationState: "pending",
      });

      useChatSessionStore
        .getState()
        .markSessionCreationFailed("local-session", "boom");

      expect(
        useChatSessionStore.getState().getSession("local-session"),
      ).toMatchObject({
        creationState: "failed",
        creationError: "boom",
      });
    });

    it("returns a failed draft session to pending when resetting creation", () => {
      seedSession({
        id: "local-session",
        title: "New Chat",
        creationState: "failed",
        creationError: "folders missing",
      });

      useChatSessionStore.getState().resetSessionCreation("local-session");

      expect(
        useChatSessionStore.getState().getSession("local-session"),
      ).toMatchObject({
        creationState: "pending",
        creationError: undefined,
      });
    });

    it("leaves a non-failed session untouched when resetting creation", () => {
      seedSession({
        id: "local-session",
        title: "New Chat",
        creationState: "pending",
      });

      useChatSessionStore.getState().resetSessionCreation("local-session");

      expect(
        useChatSessionStore.getState().getSession("local-session")
          ?.creationState,
      ).toBe("pending");
    });

    it("clears creation failure state when promoting a draft session", () => {
      seedSession({
        id: "local-session",
        title: "New Chat",
        creationState: "failed",
        creationError: "folders missing",
      });

      useChatSessionStore
        .getState()
        .promoteDraftSession("local-session", "acp-session");

      expect(
        useChatSessionStore.getState().getSession("acp-session"),
      ).toMatchObject({
        creationState: undefined,
        creationError: undefined,
      });
    });

    it("keeps a stable client session id when promoting a draft session", () => {
      const draft = useChatSessionStore.getState().createDraftSession({
        title: "New Chat",
        providerId: "openai",
        workingDir: "/tmp/project",
      });

      useChatSessionStore
        .getState()
        .promoteDraftSession(draft.id, "acp-session");

      expect(
        useChatSessionStore.getState().getSession("acp-session"),
      ).toMatchObject({
        id: "acp-session",
        clientSessionId: draft.id,
      });
    });
  });

  describe("ensurePinnedSessionPlaceholder", () => {
    it("does not mark draft sessions as loading", () => {
      seedSession({
        id: "draft-session",
        creationState: "pending",
      });

      useChatSessionStore
        .getState()
        .ensurePinnedSessionPlaceholder("draft-session");

      const session = useChatSessionStore
        .getState()
        .getSession("draft-session");
      expect(session).toMatchObject({
        creationState: "pending",
      });
      expect(session?.pinnedLoadState).toBeUndefined();
    });

    it("marks failed pinned sessions as loading for retry", () => {
      seedSession({
        id: "failed-pinned-session",
        pinnedLoadState: "failed",
      });

      useChatSessionStore
        .getState()
        .ensurePinnedSessionPlaceholder("failed-pinned-session");

      expect(
        useChatSessionStore.getState().getSession("failed-pinned-session"),
      ).toMatchObject({
        pinnedLoadState: "loading",
      });
    });
  });

  describe("loadSessions", () => {
    it("loads sessions from ACP and maps them correctly", async () => {
      mocks.acpListSessionsPage.mockResolvedValue(
        mockPage(
          [
            makeAcpSession({
              sessionId: "acp-1",
              title: "ACP Session 1",
              updatedAt: "2026-04-01",
              createdAt: "2026-03-31",
              userSetName: true,
              messageCount: 4,
              workingDir: "/tmp/acp-1",
              projectId: "project-123",
              providerId: "openai",
              personaId: "persona-1",
              modelId: "gpt-4.1",
            }),
            makeAcpSession({
              sessionId: "acp-2",
              title: null,
              updatedAt: "2026-04-02",
              createdAt: "2026-04-02",
              messageCount: 7,
            }),
          ],
          "cursor-2",
        ),
      );

      await useChatSessionStore.getState().loadSessions();

      expect(mocks.acpListSessionsPage).toHaveBeenCalledWith();
      const sessions = useChatSessionStore.getState().sessions;
      expect(sessions).toHaveLength(2);
      expect(sessions[0].id).toBe("acp-2");
      expect(sessions[0].title).toBe("Untitled");
      expect(sessions[0].messageCount).toBe(7);
      expect(sessions[1].id).toBe("acp-1");
      expect(sessions[1].title).toBe("ACP Session 1");
      expect(sessions[1].messageCount).toBe(4);
      expect(sessions[1].providerId).toBe("openai");
      expect(sessions[1].projectId).toBe("project-123");
      expect(sessions[1].personaId).toBe("persona-1");
      expect(sessions[1].modelId).toBe("gpt-4.1");
      expect(sessions[1].workingDir).toBe("/tmp/acp-1");
      expect(sessions[1].userSetName).toBe(true);
      expect(useChatSessionStore.getState().sessionPageCursor).toBe("cursor-2");
      expect(useChatSessionStore.getState().hasMoreSessions).toBe(true);
    });

    it("preserves a local persona tag when an ACP session row omits persona metadata", async () => {
      seedSession({
        id: "session-1",
        title: "Tagged chat",
        personaId: "persona-1",
        providerId: "goose",
        updatedAt: "2026-04-01T00:00:00.000Z",
      });

      mocks.acpListSessionsPage.mockResolvedValue(
        mockPage([
          makeAcpSession({
            sessionId: "session-1",
            title: "Tagged chat",
            providerId: "goose",
            personaId: null,
            updatedAt: "2026-04-02T00:00:00.000Z",
          }),
        ]),
      );

      await useChatSessionStore.getState().loadSessions();

      expect(
        useChatSessionStore.getState().getSession("session-1"),
      ).toMatchObject({
        personaId: "persona-1",
        updatedAt: "2026-04-02T00:00:00.000Z",
      });
    });

    it("hydrates the first page without dropping local sessions or clearing active session", async () => {
      const draft = makeSession({
        id: "draft-session",
        title: "Draft",
        creationState: "pending",
        updatedAt: "2026-04-03T00:00:00.000Z",
      });
      useChatSessionStore.setState({
        sessions: [
          draft,
          makeSession({
            id: "older-loaded-session",
            title: "Older Loaded Session",
            updatedAt: "2026-03-01T00:00:00.000Z",
          }),
        ],
        activeSessionId: "older-loaded-session",
      });

      mocks.acpListSessionsPage.mockResolvedValue(
        mockPage(
          [
            makeAcpSession({
              sessionId: "acp-1",
              updatedAt: "2026-04-02",
              createdAt: "2026-04-02",
            }),
          ],
          "cursor-2",
        ),
      );

      await useChatSessionStore.getState().loadSessions();

      const state = useChatSessionStore.getState();
      expect(state.sessions.map((session) => session.id)).toEqual([
        "draft-session",
        "acp-1",
        "older-loaded-session",
      ]);
      expect(state.activeSessionId).toBe("older-loaded-session");
      expect(state.sessionPageCursor).toBe("cursor-2");
      expect(state.hasMoreSessions).toBe(true);
    });

    it("preserves a pending optimistic archive when ACP returns stale unarchived state", async () => {
      const archive = createDeferredPromise<void>();
      seedSession({ id: "session-1" });
      mocks.archiveSession.mockReturnValueOnce(archive.promise);

      const archivePromise = useChatSessionStore
        .getState()
        .archiveSession("session-1");
      const optimisticArchivedAt = useChatSessionStore
        .getState()
        .getSession("session-1")?.archivedAt;
      expect(optimisticArchivedAt).toEqual(expect.any(String));

      mocks.acpListSessionsPage.mockResolvedValueOnce(
        mockPage([
          makeAcpSession({ sessionId: "session-1", archivedAt: null }),
        ]),
      );
      await useChatSessionStore.getState().loadSessions();

      expect(
        useChatSessionStore.getState().getSession("session-1")?.archivedAt,
      ).toBe(optimisticArchivedAt);

      archive.resolve(undefined);
      await archivePromise;
    });

    it("preserves a succeeded optimistic archive until ACP confirms the archived state", async () => {
      const canonicalArchivedAt = "2026-04-10T00:00:00.000Z";
      seedSession({ id: "session-1" });

      await useChatSessionStore.getState().archiveSession("session-1");
      const optimisticArchivedAt = useChatSessionStore
        .getState()
        .getSession("session-1")?.archivedAt;
      expect(optimisticArchivedAt).toEqual(expect.any(String));

      mocks.acpListSessionsPage.mockResolvedValueOnce(
        mockPage([
          makeAcpSession({ sessionId: "session-1", archivedAt: null }),
        ]),
      );
      await useChatSessionStore.getState().loadSessions();

      expect(
        useChatSessionStore.getState().getSession("session-1")?.archivedAt,
      ).toBe(optimisticArchivedAt);
      expect(
        useChatSessionStore.getState().archiveMutationBySessionId,
      ).toHaveProperty("session-1");

      mocks.acpListSessionsPage.mockResolvedValueOnce(
        mockPage([
          makeAcpSession({
            sessionId: "session-1",
            archivedAt: canonicalArchivedAt,
          }),
        ]),
      );
      await useChatSessionStore.getState().loadSessions();

      expect(
        useChatSessionStore.getState().getSession("session-1")?.archivedAt,
      ).toBe(canonicalArchivedAt);
      expect(
        useChatSessionStore.getState().archiveMutationBySessionId,
      ).not.toHaveProperty("session-1");
    });

    it("rolls back a failed archive after a stale ACP page merged while pending", async () => {
      const priorArchivedAt = "2026-03-15T00:00:00.000Z";
      const archive = createDeferredPromise<void>();
      seedSession({ id: "session-1", archivedAt: priorArchivedAt });
      mocks.archiveSession.mockReturnValueOnce(archive.promise);

      const archivePromise = useChatSessionStore
        .getState()
        .archiveSession("session-1");
      const optimisticArchivedAt = useChatSessionStore
        .getState()
        .getSession("session-1")?.archivedAt;
      expect(optimisticArchivedAt).not.toBe(priorArchivedAt);

      mocks.acpListSessionsPage.mockResolvedValueOnce(
        mockPage([
          makeAcpSession({ sessionId: "session-1", archivedAt: null }),
        ]),
      );
      await useChatSessionStore.getState().loadSessions();
      expect(
        useChatSessionStore.getState().getSession("session-1")?.archivedAt,
      ).toBe(optimisticArchivedAt);

      archive.reject(new Error("backend down"));
      await expect(archivePromise).rejects.toThrow("backend down");

      expect(
        useChatSessionStore.getState().getSession("session-1")?.archivedAt,
      ).toBe(priorArchivedAt);
      expect(
        useChatSessionStore.getState().archiveMutationBySessionId,
      ).not.toHaveProperty("session-1");
    });

    it("preserves a pending optimistic unarchive when ACP returns the old archived timestamp", async () => {
      const priorArchivedAt = "2026-03-15T00:00:00.000Z";
      const unarchive = createDeferredPromise<void>();
      seedSession({ id: "session-1", archivedAt: priorArchivedAt });
      mocks.unarchiveSession.mockReturnValueOnce(unarchive.promise);

      const unarchivePromise = useChatSessionStore
        .getState()
        .unarchiveSession("session-1");
      expect(
        useChatSessionStore.getState().getSession("session-1")?.archivedAt,
      ).toBeUndefined();

      mocks.acpListSessionsPage.mockResolvedValueOnce(
        mockPage([
          makeAcpSession({
            sessionId: "session-1",
            archivedAt: priorArchivedAt,
          }),
        ]),
      );
      await useChatSessionStore.getState().loadSessions();

      expect(
        useChatSessionStore.getState().getSession("session-1")?.archivedAt,
      ).toBeUndefined();

      unarchive.resolve(undefined);
      await unarchivePromise;
    });

    it("keeps empty sessions list on error", async () => {
      mocks.acpListSessionsPage.mockRejectedValue(new Error("Network error"));

      await useChatSessionStore.getState().loadSessions();

      expect(useChatSessionStore.getState().sessions).toEqual([]);
      expect(useChatSessionStore.getState().hasHydratedSessions).toBe(true);
    });

    it("appends the next page and advances the cursor", async () => {
      useChatSessionStore.setState({
        sessions: [
          makeSession({
            id: "acp-1",
            updatedAt: "2026-04-03T00:00:00.000Z",
          }),
        ],
        sessionPageCursor: "cursor-2",
        hasMoreSessions: true,
      });
      mocks.acpListSessionsPage.mockResolvedValue(
        mockPage(
          [
            makeAcpSession({
              sessionId: "acp-2",
              updatedAt: "2026-04-02T00:00:00.000Z",
            }),
          ],
          "cursor-3",
        ),
      );

      await useChatSessionStore.getState().loadMoreSessions();

      expect(mocks.acpListSessionsPage).toHaveBeenCalledWith({
        cursor: "cursor-2",
      });
      const state = useChatSessionStore.getState();
      expect(state.sessions.map((session) => session.id)).toEqual([
        "acp-1",
        "acp-2",
      ]);
      expect(state.sessionPageCursor).toBe("cursor-3");
      expect(state.hasMoreSessions).toBe(true);
    });

    it("preserves optimistic archive state while loading more sessions", async () => {
      const archive = createDeferredPromise<void>();
      seedSession({ id: "session-1" });
      useChatSessionStore.setState({
        sessionPageCursor: "cursor-2",
        hasMoreSessions: true,
      });
      mocks.archiveSession.mockReturnValueOnce(archive.promise);

      const archivePromise = useChatSessionStore
        .getState()
        .archiveSession("session-1");
      const optimisticArchivedAt = useChatSessionStore
        .getState()
        .getSession("session-1")?.archivedAt;

      mocks.acpListSessionsPage.mockResolvedValueOnce(
        mockPage(
          [makeAcpSession({ sessionId: "session-1", archivedAt: null })],
          "cursor-3",
        ),
      );
      await useChatSessionStore.getState().loadMoreSessions();

      expect(mocks.acpListSessionsPage).toHaveBeenCalledWith({
        cursor: "cursor-2",
      });
      expect(
        useChatSessionStore.getState().getSession("session-1")?.archivedAt,
      ).toBe(optimisticArchivedAt);

      archive.resolve(undefined);
      await archivePromise;
    });

    it("does not start a second next-page request while one is in flight", async () => {
      const deferred = createDeferredPromise<ReturnType<typeof mockPage>>();
      useChatSessionStore.setState({
        sessionPageCursor: "cursor-2",
        hasMoreSessions: true,
      });
      mocks.acpListSessionsPage.mockReturnValue(deferred.promise);

      const firstLoad = useChatSessionStore.getState().loadMoreSessions();
      const secondLoad = useChatSessionStore.getState().loadMoreSessions();

      expect(mocks.acpListSessionsPage).toHaveBeenCalledOnce();

      deferred.resolve(mockPage());
      await Promise.all([firstLoad, secondLoad]);

      expect(useChatSessionStore.getState().isLoadingMoreSessions).toBe(false);
    });

    it("stops pagination when the backend repeats a cursor", async () => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      useChatSessionStore.setState({
        sessionPageCursor: "cursor-2",
        hasMoreSessions: true,
      });
      mocks.acpListSessionsPage.mockResolvedValue(
        mockPage(
          [
            makeAcpSession({
              sessionId: "acp-2",
              updatedAt: "2026-04-02T00:00:00.000Z",
            }),
          ],
          "cursor-2",
        ),
      );

      await useChatSessionStore.getState().loadMoreSessions();

      const state = useChatSessionStore.getState();
      expect(state.sessionPageCursor).toBeNull();
      expect(state.hasMoreSessions).toBe(false);
      expect(warnSpy).toHaveBeenCalledWith(
        "ACP session/list returned the same pagination cursor; stopping pagination to avoid an infinite loop.",
      );
      warnSpy.mockRestore();
    });

    it("does not apply stale loadMore results after loadSessions starts", async () => {
      const loadMore = createDeferredPromise<ReturnType<typeof mockPage>>();
      const loadFirstPage =
        createDeferredPromise<ReturnType<typeof mockPage>>();
      useChatSessionStore.setState({
        sessions: [
          makeSession({
            id: "existing-session",
            updatedAt: "2026-04-03T00:00:00.000Z",
          }),
        ],
        sessionPageCursor: "cursor-2",
        hasMoreSessions: true,
      });
      mocks.acpListSessionsPage
        .mockReturnValueOnce(loadMore.promise)
        .mockReturnValueOnce(loadFirstPage.promise);

      const loadMorePromise = useChatSessionStore.getState().loadMoreSessions();
      const loadSessionsPromise = useChatSessionStore.getState().loadSessions();

      loadFirstPage.resolve(
        mockPage([
          makeAcpSession({
            sessionId: "fresh-session",
            updatedAt: "2026-04-04T00:00:00.000Z",
          }),
        ]),
      );
      await loadSessionsPromise;

      loadMore.resolve(
        mockPage(
          [
            makeAcpSession({
              sessionId: "stale-session",
              updatedAt: "2026-04-05T00:00:00.000Z",
            }),
          ],
          "cursor-3",
        ),
      );
      await loadMorePromise;

      const state = useChatSessionStore.getState();
      expect(mocks.acpListSessionsPage).toHaveBeenNthCalledWith(1, {
        cursor: "cursor-2",
      });
      expect(mocks.acpListSessionsPage).toHaveBeenNthCalledWith(2);
      expect(state.sessions.map((session) => session.id)).toEqual([
        "fresh-session",
        "existing-session",
      ]);
      expect(state.sessionPageCursor).toBeNull();
      expect(state.hasMoreSessions).toBe(false);
      expect(state.isLoadingMoreSessions).toBe(false);
    });

    it("dedupes sessions by id and refreshes existing metadata", async () => {
      seedSession({
        id: "acp-1",
        title: "Old Title",
        modelId: "gpt-4.1",
        modelName: "GPT-4.1",
        updatedAt: "2026-04-01T00:00:00.000Z",
      });
      mocks.acpListSessionsPage.mockResolvedValue(
        mockPage([
          makeAcpSession({
            sessionId: "acp-1",
            title: "Updated Title",
            updatedAt: "2026-04-03T00:00:00.000Z",
            modelId: "gpt-4.1",
          }),
          makeAcpSession({
            sessionId: "acp-1",
            title: "Duplicate Title",
            updatedAt: "2026-04-04T00:00:00.000Z",
            modelId: "gpt-4.1",
          }),
        ]),
      );

      await useChatSessionStore.getState().loadSessions();

      const sessions = useChatSessionStore.getState().sessions;
      expect(sessions).toHaveLength(1);
      expect(sessions[0]).toMatchObject({
        id: "acp-1",
        title: "Duplicate Title",
        updatedAt: "2026-04-04T00:00:00.000Z",
        modelId: "gpt-4.1",
        modelName: "GPT-4.1",
      });
      mocks.acpListSessionsPage.mockResolvedValue(
        mockPage([
          makeAcpSession({
            sessionId: "acp-1",
            modelId: "gpt-5.4",
          }),
        ]),
      );

      await useChatSessionStore.getState().loadSessions();

      const session = useChatSessionStore.getState().getSession("acp-1");
      expect(session?.modelId).toBe("gpt-5.4");
      expect(session?.modelName).toBeUndefined();
    });
  });

  describe("patchSession", () => {
    it("patches session properties while preserving updatedAt when omitted", () => {
      const session = seedSession();
      const originalUpdatedAt = session.updatedAt;

      useChatSessionStore.getState().patchSession(session.id, {
        title: "Updated Title",
        projectId: "new-project",
      });

      const updated = useChatSessionStore.getState().getSession(session.id);
      expect(updated).toMatchObject({
        title: "Updated Title",
        projectId: "new-project",
        updatedAt: originalUpdatedAt,
      });
    });

    it("updates updatedAt when explicitly provided in patch", () => {
      const session = seedSession();
      const newTimestamp = "2026-04-01T00:01:00.000Z";
      useChatSessionStore.getState().patchSession(session.id, {
        updatedAt: newTimestamp,
      });

      const updated = useChatSessionStore.getState().getSession(session.id);
      expect(updated?.updatedAt).toBe(newTimestamp);
    });
  });

  describe("updateSessionSubtitleFromText", () => {
    it("sets the subtitle from real text", () => {
      const session = seedSession({ subtitle: undefined });

      useChatSessionStore
        .getState()
        .updateSessionSubtitleFromText(session.id, "  hello   world  ");

      expect(
        useChatSessionStore.getState().getSession(session.id)?.subtitle,
      ).toBe("hello world");
    });

    it("strips markdown styling from the subtitle", () => {
      const session = seedSession({ subtitle: undefined });

      useChatSessionStore
        .getState()
        .updateSessionSubtitleFromText(session.id, "**hi** there");

      expect(
        useChatSessionStore.getState().getSession(session.id)?.subtitle,
      ).toBe("hi there");
    });

    it("leaves the prior subtitle unchanged for empty or whitespace-only text", () => {
      const session = seedSession({ subtitle: "previous snippet" });

      useChatSessionStore
        .getState()
        .updateSessionSubtitleFromText(session.id, "   \n\t  ");

      expect(
        useChatSessionStore.getState().getSession(session.id)?.subtitle,
      ).toBe("previous snippet");
    });

    it("does not bump updatedAt when updating the subtitle", () => {
      const session = seedSession({ subtitle: undefined });
      const originalUpdatedAt = session.updatedAt;

      useChatSessionStore
        .getState()
        .updateSessionSubtitleFromText(session.id, "latest message");

      expect(
        useChatSessionStore.getState().getSession(session.id)?.updatedAt,
      ).toBe(originalUpdatedAt);
    });

    it("ignores an unknown session id", () => {
      seedSession({ id: "known", subtitle: "keep me" });

      useChatSessionStore
        .getState()
        .updateSessionSubtitleFromText("missing", "new text");

      expect(
        useChatSessionStore.getState().getSession("missing"),
      ).toBeUndefined();
      expect(useChatSessionStore.getState().getSession("known")?.subtitle).toBe(
        "keep me",
      );
    });
  });

  describe("provider switching", () => {
    it("clears the selected model when switching providers", () => {
      const session = seedSession({
        providerId: "openai",
        modelId: "gpt-4o",
        modelName: "GPT-4o",
        reasoningEffort: {
          configId: "thinking_effort",
          currentValue: "high",
          options: [{ id: "high", name: "high" }],
        },
      });

      useChatSessionStore
        .getState()
        .switchSessionProvider(session.id, "anthropic");

      const updated = useChatSessionStore.getState().getSession(session.id);
      expect(updated?.providerId).toBe("anthropic");
      expect(updated?.modelId).toBeUndefined();
      expect(updated?.modelName).toBeUndefined();
      expect(updated?.reasoningEffort).toBeUndefined();
    });
  });

  describe("context panel preference", () => {
    it("stores context panel open state as a global preference", () => {
      useChatSessionStore.getState().setContextPanelOpen("session-1", true);

      expect(useChatSessionStore.getState().isContextPanelOpen).toBe(true);
      expect(window.localStorage.getItem("goose:context-panel-open")).toBe("1");

      useChatSessionStore.getState().setContextPanelOpen("session-2", false);

      expect(useChatSessionStore.getState().isContextPanelOpen).toBe(false);
      expect(window.localStorage.getItem("goose:context-panel-open")).toBe("0");
    });
  });
});

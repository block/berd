import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  REMOTE_SESSIONS_STORAGE_KEY,
  persistRemoteSessionRecord,
  readRemoteSessionRecords,
  reconcileRemoteSessionsForExperiment,
  rehydrateRemoteSessions,
  removeRemoteSessionRecord,
  type RemoteSessionRecord,
} from "../remoteSessionPersistence";
import { useChatSessionStore } from "../chatSessionStore";

const mocks = vi.hoisted(() => ({
  registerSessionBackend: vi.fn(),
  transferSessionBackend: vi.fn(),
  unregisterSessionBackend: vi.fn(),
  getSessionBackend: vi.fn(),
  invalidateBackendConnection: vi.fn().mockResolvedValue(undefined),
  disconnectRemoteHost: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/shared/api/acp", () => ({
  acpCreateSession: vi.fn(),
  acpListSessionsPage: vi.fn(),
}));

vi.mock("@/features/providers/api/credentials", () => ({
  checkAllProviderStatus: vi.fn().mockResolvedValue([]),
}));

vi.mock("@/shared/api/acpApi", () => ({
  archiveSession: vi.fn().mockResolvedValue(undefined),
  unarchiveSession: vi.fn().mockResolvedValue(undefined),
  renameSession: vi.fn().mockResolvedValue(undefined),
  updateSessionProject: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/features/chat/lib/sessionWindowCommands", () => ({
  releaseSession: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/shared/api/acpSessionBackends", () => ({
  registerSessionBackend: (...args: unknown[]) =>
    mocks.registerSessionBackend(...args),
  transferSessionBackend: (...args: unknown[]) =>
    mocks.transferSessionBackend(...args),
  unregisterSessionBackend: (...args: unknown[]) =>
    mocks.unregisterSessionBackend(...args),
  getSessionBackend: (...args: unknown[]) => mocks.getSessionBackend(...args),
}));

vi.mock("@/shared/api/remoteHosts", () => ({
  disconnectRemoteHost: (...args: unknown[]) =>
    mocks.disconnectRemoteHost(...args),
}));

vi.mock("@/shared/api/acpConnection", () => ({
  invalidateBackendConnection: (...args: unknown[]) =>
    mocks.invalidateBackendConnection(...args),
}));

function makeRecord(
  overrides: Partial<RemoteSessionRecord> = {},
): RemoteSessionRecord {
  return {
    sessionId: "remote-1",
    host: "devbox",
    title: "Remote chat",
    workingDir: "/remote/home/damien/project",
    updatedAt: "2026-08-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("remoteSessionPersistence", () => {
  beforeEach(() => {
    window.localStorage.clear();
    vi.clearAllMocks();
    useChatSessionStore.setState({
      sessions: [],
      activeSessionId: null,
      activeWorkspaceBySession: {},
      archiveMutationBySessionId: {},
    });
  });

  it("round-trips records through localStorage", () => {
    persistRemoteSessionRecord(makeRecord());
    persistRemoteSessionRecord(
      makeRecord({ sessionId: "remote-2", host: "otherbox" }),
    );

    expect(readRemoteSessionRecords()).toEqual([
      makeRecord(),
      makeRecord({ sessionId: "remote-2", host: "otherbox" }),
    ]);

    removeRemoteSessionRecord("remote-1");
    expect(readRemoteSessionRecords()).toEqual([
      makeRecord({ sessionId: "remote-2", host: "otherbox" }),
    ]);

    removeRemoteSessionRecord("remote-2");
    expect(readRemoteSessionRecords()).toEqual([]);
    expect(window.localStorage.getItem(REMOTE_SESSIONS_STORAGE_KEY)).toBeNull();
  });

  it("round-trips projectId and seeds it on the rehydrated placeholder", async () => {
    persistRemoteSessionRecord(
      makeRecord({ sessionId: "ssh:devbox#remote-3", projectId: "proj-1" }),
    );

    expect(readRemoteSessionRecords()).toEqual([
      makeRecord({ sessionId: "ssh:devbox#remote-3", projectId: "proj-1" }),
    ]);

    await rehydrateRemoteSessions();
    const session = useChatSessionStore
      .getState()
      .getSession("ssh:devbox#remote-3");
    expect(session?.projectId).toBe("proj-1");
  });

  it("upserts by session id", () => {
    persistRemoteSessionRecord(makeRecord());
    persistRemoteSessionRecord(makeRecord({ title: "Renamed" }));

    expect(readRemoteSessionRecords()).toEqual([
      makeRecord({ title: "Renamed" }),
    ]);
  });

  it("drops malformed stored entries on read", () => {
    window.localStorage.setItem(
      REMOTE_SESSIONS_STORAGE_KEY,
      JSON.stringify({
        "remote-1": { host: "devbox", title: "ok" },
        "remote-bad": { title: "missing host" },
        "remote-worse": "not an object",
      }),
    );

    expect(readRemoteSessionRecords()).toEqual([
      expect.objectContaining({ sessionId: "remote-1", host: "devbox" }),
    ]);
  });

  it("returns no records for corrupted storage", () => {
    window.localStorage.setItem(REMOTE_SESSIONS_STORAGE_KEY, "{not json");
    expect(readRemoteSessionRecords()).toEqual([]);
  });

  describe("rehydrateRemoteSessions", () => {
    it("registers backends and seeds sidebar placeholders", async () => {
      persistRemoteSessionRecord(
        makeRecord({ sessionId: "ssh:devbox#remote-1" }),
      );

      await rehydrateRemoteSessions();

      expect(mocks.registerSessionBackend).toHaveBeenCalledWith(
        "ssh:devbox#remote-1",
        "ssh:devbox",
        "remote-1",
      );
      const session = useChatSessionStore
        .getState()
        .getSession("ssh:devbox#remote-1");
      expect(session).toMatchObject({
        id: "ssh:devbox#remote-1",
        title: "Remote chat",
        remoteHost: "devbox",
        workingDir: "/remote/home/damien/project",
        clientSessionId: "ssh:devbox#remote-1",
      });
      // Placeholder must be visible in the sidebar before the remote
      // transcript loads.
      expect(session?.messageCount).toBeGreaterThan(0);
      // The already-composite record is not rewritten.
      expect(readRemoteSessionRecords()).toEqual([
        makeRecord({ sessionId: "ssh:devbox#remote-1" }),
      ]);
    });

    it("migrates old-format records (bare wire ids) to composite ids", async () => {
      persistRemoteSessionRecord(makeRecord({ sessionId: "remote-1" }));

      await rehydrateRemoteSessions();

      expect(mocks.registerSessionBackend).toHaveBeenCalledWith(
        "ssh:devbox#remote-1",
        "ssh:devbox",
        "remote-1",
      );
      const session = useChatSessionStore
        .getState()
        .getSession("ssh:devbox#remote-1");
      expect(session).toMatchObject({
        id: "ssh:devbox#remote-1",
        remoteHost: "devbox",
      });
      expect(
        useChatSessionStore.getState().getSession("remote-1"),
      ).toBeUndefined();
      // The stored record is rewritten under the composite id.
      expect(readRemoteSessionRecords()).toEqual([
        makeRecord({ sessionId: "ssh:devbox#remote-1" }),
      ]);
    });

    it("rehydrates archived records into session history", async () => {
      const archivedAt = "2026-08-02T00:00:00.000Z";
      persistRemoteSessionRecord(makeRecord({ archivedAt }));

      await rehydrateRemoteSessions();

      expect(mocks.registerSessionBackend).toHaveBeenCalledWith(
        "ssh:devbox#remote-1",
        "ssh:devbox",
        "remote-1",
      );
      expect(
        useChatSessionStore.getState().getSession("ssh:devbox#remote-1"),
      ).toMatchObject({ archivedAt, remoteHost: "devbox" });
    });

    it("does not clobber a session already in the store", async () => {
      persistRemoteSessionRecord(
        makeRecord({
          sessionId: "ssh:devbox#remote-1",
          title: "Stale title",
        }),
      );
      useChatSessionStore.setState({
        sessions: [
          {
            id: "ssh:devbox#remote-1",
            title: "Fresh title",
            remoteHost: "devbox",
            createdAt: "2026-08-03T00:00:00.000Z",
            updatedAt: "2026-08-03T00:00:00.000Z",
            messageCount: 4,
          },
        ],
      });

      await rehydrateRemoteSessions();

      expect(mocks.registerSessionBackend).toHaveBeenCalledWith(
        "ssh:devbox#remote-1",
        "ssh:devbox",
        "remote-1",
      );
      expect(
        useChatSessionStore.getState().getSession("ssh:devbox#remote-1"),
      ).toMatchObject({ title: "Fresh title", messageCount: 4 });
    });
  });

  describe("reconcileRemoteSessionsForExperiment", () => {
    it("hides remote sessions and disconnects hosts without deleting persistence", async () => {
      const record = makeRecord({ sessionId: "ssh:devbox#remote-1" });
      persistRemoteSessionRecord(record);
      useChatSessionStore.setState({
        sessions: [
          {
            id: "local-1",
            title: "Local chat",
            createdAt: record.updatedAt,
            updatedAt: record.updatedAt,
            messageCount: 1,
          },
          {
            id: record.sessionId,
            title: record.title,
            remoteHost: record.host,
            createdAt: record.updatedAt,
            updatedAt: record.updatedAt,
            messageCount: 1,
          },
        ],
        activeSessionId: record.sessionId,
        activeWorkspaceBySession: {
          [record.sessionId]: { path: record.workingDir, branch: null },
        },
      });

      await reconcileRemoteSessionsForExperiment(false);

      expect(useChatSessionStore.getState().sessions).toEqual([
        expect.objectContaining({ id: "local-1" }),
      ]);
      expect(useChatSessionStore.getState().activeSessionId).toBeNull();
      expect(
        useChatSessionStore.getState().activeWorkspaceBySession,
      ).not.toHaveProperty(record.sessionId);
      expect(mocks.unregisterSessionBackend).toHaveBeenCalledWith(
        record.sessionId,
      );
      expect(mocks.disconnectRemoteHost).toHaveBeenCalledWith(record.host);
      expect(mocks.invalidateBackendConnection).toHaveBeenCalledWith(
        "ssh:devbox",
      );
      expect(readRemoteSessionRecords()).toEqual([record]);
    });

    it("rehydrates persisted sessions immediately when enabled", async () => {
      persistRemoteSessionRecord(
        makeRecord({ sessionId: "ssh:devbox#remote-1" }),
      );

      await reconcileRemoteSessionsForExperiment(true);

      expect(
        useChatSessionStore.getState().getSession("ssh:devbox#remote-1"),
      ).toMatchObject({ remoteHost: "devbox" });
    });
  });
});

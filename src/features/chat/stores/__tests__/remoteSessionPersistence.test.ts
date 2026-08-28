import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  REMOTE_SESSIONS_STORAGE_KEY,
  persistRemoteSessionRecord,
  readRemoteSessionRecords,
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
      persistRemoteSessionRecord(makeRecord());

      await rehydrateRemoteSessions();

      expect(mocks.registerSessionBackend).toHaveBeenCalledWith(
        "remote-1",
        "ssh:devbox",
      );
      const session = useChatSessionStore.getState().getSession("remote-1");
      expect(session).toMatchObject({
        id: "remote-1",
        title: "Remote chat",
        remoteHost: "devbox",
        workingDir: "/remote/home/damien/project",
        clientSessionId: "remote-1",
      });
      // Placeholder must be visible in the sidebar before the remote
      // transcript loads.
      expect(session?.messageCount).toBeGreaterThan(0);
    });

    it("skips archived records", async () => {
      persistRemoteSessionRecord(
        makeRecord({ archivedAt: "2026-08-02T00:00:00.000Z" }),
      );

      await rehydrateRemoteSessions();

      expect(mocks.registerSessionBackend).not.toHaveBeenCalled();
      expect(
        useChatSessionStore.getState().getSession("remote-1"),
      ).toBeUndefined();
    });

    it("does not clobber a session already in the store", async () => {
      persistRemoteSessionRecord(makeRecord({ title: "Stale title" }));
      useChatSessionStore.setState({
        sessions: [
          {
            id: "remote-1",
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
        "remote-1",
        "ssh:devbox",
      );
      expect(
        useChatSessionStore.getState().getSession("remote-1"),
      ).toMatchObject({ title: "Fresh title", messageCount: 4 });
    });
  });
});

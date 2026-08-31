import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  REMOTE_SESSIONS_STORAGE_KEY,
  readRemoteSessionRecords,
  rehydrateRemoteSessions,
} from "../remoteSessionPersistence";
import { useChatSessionStore } from "../chatSessionStore";

const mocks = vi.hoisted(() => ({
  acpCreateSession: vi.fn(),
  acpListSessionsPage: vi.fn(),
  registerSessionBackend: vi.fn(),
  transferSessionBackend: vi.fn(),
  unregisterSessionBackend: vi.fn(),
  getSessionBackend: vi.fn(),
}));

vi.mock("@/shared/api/acp", () => ({
  acpCreateSession: (...args: unknown[]) => mocks.acpCreateSession(...args),
  acpListSessionsPage: (...args: unknown[]) =>
    mocks.acpListSessionsPage(...args),
}));

vi.mock("@/features/providers/api/credentials", () => ({
  checkAllProviderStatus: vi.fn().mockResolvedValue([]),
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

function resetStore() {
  useChatSessionStore.setState({
    sessions: [],
    activeSessionId: null,
    isLoading: false,
    isLoadingMoreSessions: false,
    hasHydratedSessions: false,
    sessionPageCursor: null,
    hasMoreSessions: false,
    isRightRailOpen: false,
    activeWorkspaceBySession: {},
    archiveMutationBySessionId: {},
  });
}

describe("chatSessionStore remote sessions", () => {
  beforeEach(() => {
    window.localStorage.clear();
    resetStore();
    vi.clearAllMocks();
  });

  it("carries remoteHost from draft creation through promotion", () => {
    const store = useChatSessionStore.getState();
    const draft = store.createDraftSession({
      workingDir: "/remote/home/damien/project",
      remoteHost: "devbox",
    });

    expect(draft.remoteHost).toBe("devbox");
    expect(mocks.registerSessionBackend).toHaveBeenCalledWith(
      draft.id,
      "ssh:devbox",
    );

    store.promoteDraftSession(draft.id, "backend-1");

    expect(mocks.transferSessionBackend).toHaveBeenCalledWith(
      draft.id,
      "backend-1",
    );
    const promoted = useChatSessionStore.getState().getSession("backend-1");
    expect(promoted?.remoteHost).toBe("devbox");
    expect(promoted?.workingDir).toBe("/remote/home/damien/project");
  });

  it("does not register a backend for local drafts", () => {
    const store = useChatSessionStore.getState();
    const draft = store.createDraftSession({ workingDir: "/local/project" });

    expect(draft.remoteHost).toBeUndefined();
    expect(mocks.registerSessionBackend).not.toHaveBeenCalled();

    store.promoteDraftSession(draft.id, "backend-local");
    expect(window.localStorage.getItem(REMOTE_SESSIONS_STORAGE_KEY)).toBeNull();
  });

  it("creates remote sessions on the SSH backend and persists a record", async () => {
    mocks.acpCreateSession.mockResolvedValue({
      sessionId: "remote-1",
      configOptionsSnapshot: null,
    });

    const session = await useChatSessionStore.getState().createSession({
      workingDir: "/remote/dir",
      remoteHost: "devbox",
    });

    expect(session.remoteHost).toBe("devbox");
    // Backend registration happens inside acpCreateSession (the newSession
    // call registers the created id); the store's job is to thread the host.
    expect(mocks.acpCreateSession).toHaveBeenCalledWith(
      expect.any(String),
      "/remote/dir",
      expect.objectContaining({ remoteHost: "devbox" }),
    );
    expect(readRemoteSessionRecords()).toEqual([
      expect.objectContaining({
        sessionId: "remote-1",
        host: "devbox",
        workingDir: "/remote/dir",
      }),
    ]);
  });

  it("persists the promoted record under the backend id", () => {
    const store = useChatSessionStore.getState();
    const draft = store.createDraftSession({
      workingDir: "/remote/dir",
      remoteHost: "devbox",
    });

    store.promoteDraftSession(draft.id, "backend-2", { title: "Remote work" });

    const records = readRemoteSessionRecords();
    expect(records).toEqual([
      expect.objectContaining({
        sessionId: "backend-2",
        host: "devbox",
        title: "Remote work",
      }),
    ]);
  });

  it("persists remote sessions inserted by fork flows", () => {
    useChatSessionStore.getState().addSession({
      id: "ssh:devbox#fork-1",
      title: "Remote fork",
      remoteHost: "devbox",
      workingDir: "/remote/dir",
      createdAt: "2026-08-31T00:00:00.000Z",
      updatedAt: "2026-08-31T00:00:00.000Z",
      messageCount: 3,
    });

    expect(readRemoteSessionRecords()).toEqual([
      expect.objectContaining({
        sessionId: "ssh:devbox#fork-1",
        host: "devbox",
        title: "Remote fork",
        workingDir: "/remote/dir",
      }),
    ]);
  });

  it("updates the record on rename and removes it on delete", () => {
    const store = useChatSessionStore.getState();
    const draft = store.createDraftSession({
      workingDir: "/remote/dir",
      remoteHost: "devbox",
    });
    store.promoteDraftSession(draft.id, "backend-3");

    useChatSessionStore
      .getState()
      .patchSession("backend-3", { title: "Renamed" });
    expect(readRemoteSessionRecords()).toEqual([
      expect.objectContaining({ sessionId: "backend-3", title: "Renamed" }),
    ]);

    useChatSessionStore.getState().removeSession("backend-3");
    expect(readRemoteSessionRecords()).toEqual([]);
  });

  it("records archivedAt after a successful archive", async () => {
    const store = useChatSessionStore.getState();
    const draft = store.createDraftSession({
      workingDir: "/remote/dir",
      remoteHost: "devbox",
    });
    store.promoteDraftSession(draft.id, "backend-4");

    await useChatSessionStore.getState().archiveSession("backend-4");

    expect(readRemoteSessionRecords()).toEqual([
      expect.objectContaining({
        sessionId: "backend-4",
        archivedAt: expect.any(String),
      }),
    ]);

    await useChatSessionStore.getState().unarchiveSession("backend-4");
    expect(readRemoteSessionRecords()[0]?.archivedAt).toBeUndefined();
  });

  it("rehydrates archived remote sessions into history after restart", async () => {
    const store = useChatSessionStore.getState();
    const draft = store.createDraftSession({
      workingDir: "/remote/dir",
      remoteHost: "devbox",
    });
    store.promoteDraftSession(draft.id, "ssh:devbox#backend-5", {
      title: "Archived remote work",
    });
    await useChatSessionStore.getState().archiveSession("ssh:devbox#backend-5");
    const archivedAt = readRemoteSessionRecords()[0]?.archivedAt;

    resetStore();
    vi.clearAllMocks();
    await rehydrateRemoteSessions();

    expect(mocks.registerSessionBackend).toHaveBeenCalledWith(
      "ssh:devbox#backend-5",
      "ssh:devbox",
      "backend-5",
    );
    expect(
      useChatSessionStore.getState().getSession("ssh:devbox#backend-5"),
    ).toEqual(
      expect.objectContaining({
        title: "Archived remote work",
        remoteHost: "devbox",
        archivedAt,
      }),
    );
  });
});

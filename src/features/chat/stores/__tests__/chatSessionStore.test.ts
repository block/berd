import { getModelSelectionIntent } from "@/features/chat/model-selection/modelSelectionIntent";
import { beginModelSelectionIntent } from "@/features/chat/model-selection/modelSelectionIntent";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AcpSessionInfo } from "@/shared/api/acp";
import { useSessionWindowStore } from "@/features/chat/stores/sessionWindowStore";
import { useSecurityConfirmationStore } from "@/features/security/stores/securityConfirmationStore";
import {
  getIncludedWorkspaceAttachments,
  workspaceAttachmentIdForPath,
} from "@/features/chat/lib/workspaceAttachments";
import { targetFromAgentModelSelection } from "@/features/chat/lib/sessionExecutionTarget";
import {
  CHAT_WORKSPACE_METADATA_STORAGE_KEY,
  type PersistedChatWorkspaceMetadata,
} from "../workspaceAttachmentPersistence";
import {
  type ChatSession,
  SessionNotFoundError,
  useChatSessionStore,
} from "../chatSessionStore";

const mocks = vi.hoisted(() => ({
  acpCreateSession: vi.fn(),
  acpListSessionsPage: vi.fn(),
  archiveSession: vi.fn(),
  checkAllProviderStatus: vi.fn(),
  releaseSession: vi.fn(),
  unarchiveSession: vi.fn(),
}));

vi.mock("@/shared/api/acp", () => ({
  acpCreateSession: (...args: unknown[]) => mocks.acpCreateSession(...args),
  acpListSessionsPage: (...args: unknown[]) =>
    mocks.acpListSessionsPage(...args),
}));

vi.mock("@/features/providers/api/credentials", () => ({
  checkAllProviderStatus: (...args: unknown[]) =>
    mocks.checkAllProviderStatus(...args),
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
    isRightRailOpen: false,
    activeWorkspaceBySession: {},
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
    lastMessageAt: null,
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

function readPersistedWorkspaceMetadata(): Record<
  string,
  PersistedChatWorkspaceMetadata
> {
  return JSON.parse(
    window.localStorage.getItem(CHAT_WORKSPACE_METADATA_STORAGE_KEY) ?? "{}",
  );
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
    window.localStorage.removeItem("goose:right-rail-open");
    window.localStorage.removeItem("goose:context-panel-open");
    window.localStorage.removeItem(CHAT_WORKSPACE_METADATA_STORAGE_KEY);
    resetStore();
    useSecurityConfirmationStore.setState({
      pendingBySessionId: {},
      mountedSurfaceCountBySessionId: {},
    });
    useSessionWindowStore.getState().setSnapshot([]);
    vi.clearAllMocks();
    mocks.archiveSession.mockResolvedValue(undefined);
    mocks.checkAllProviderStatus.mockResolvedValue([]);
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

  it("cancels pending security decisions when removing a session", () => {
    const resolve = vi.fn();
    seedSession({ id: "session-1" });
    useSecurityConfirmationStore.setState({
      pendingBySessionId: {
        "session-1": [
          {
            request: { sessionId: "session-1" } as never,
            title: "Tool call",
            command: "command",
            alertText: "🔒 Security Alert",
            inferredExplanation: { status: "idle" },
            resolve,
          },
        ],
      },
    });

    useChatSessionStore.getState().removeSession("session-1");

    expect(resolve).toHaveBeenCalledWith({
      outcome: { outcome: "cancelled" },
    });
    expect(useSecurityConfirmationStore.getState().pendingBySessionId).toEqual(
      {},
    );
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

    it("cancels all pending security decisions after archive succeeds", async () => {
      const firstResolve = vi.fn();
      const secondResolve = vi.fn();
      seedSession({ id: "session-1" });
      useSecurityConfirmationStore.setState({
        pendingBySessionId: {
          "session-1": [firstResolve, secondResolve].map((resolve) => ({
            request: { sessionId: "session-1" } as never,
            title: "Tool call",
            command: "command",
            alertText: "🔒 Security Alert",
            inferredExplanation: { status: "idle" } as const,
            resolve,
          })),
        },
      });

      await useChatSessionStore.getState().archiveSession("session-1");

      expect(firstResolve).toHaveBeenCalledWith({
        outcome: { outcome: "cancelled" },
      });
      expect(secondResolve).toHaveBeenCalledWith({
        outcome: { outcome: "cancelled" },
      });
      expect(
        useSecurityConfirmationStore.getState().pendingBySessionId,
      ).toEqual({});
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

    it("archives a known paged-out session without materializing it", async () => {
      const pagedOut = makeSession({ id: "paged-out" });

      await useChatSessionStore
        .getState()
        .archiveSession(pagedOut.id, pagedOut);

      const state = useChatSessionStore.getState();
      expect(mocks.archiveSession).toHaveBeenCalledWith("paged-out");
      expect(state.getSession("paged-out")).toBeUndefined();
      expect(state.archiveMutationBySessionId["paged-out"]).toBeUndefined();
    });

    it("leaves no store state when a paged-out archive fails", async () => {
      const pagedOut = makeSession({ id: "paged-out" });
      mocks.archiveSession.mockRejectedValue(new Error("backend down"));

      await expect(
        useChatSessionStore.getState().archiveSession(pagedOut.id, pagedOut),
      ).rejects.toThrow("backend down");

      const state = useChatSessionStore.getState();
      expect(state.getSession("paged-out")).toBeUndefined();
      expect(state.archiveMutationBySessionId["paged-out"]).toBeUndefined();
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
      const resolve = vi.fn();
      seedSession({ id: "session-1" });
      useSecurityConfirmationStore.setState({
        pendingBySessionId: {
          "session-1": [
            {
              request: { sessionId: "session-1" } as never,
              title: "Tool call",
              command: "command",
              alertText: "🔒 Security Alert",
              inferredExplanation: { status: "idle" },
              resolve,
            },
          ],
        },
      });
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
      expect(resolve).toHaveBeenCalledWith({
        outcome: { outcome: "cancelled" },
      });
      expect(
        useSecurityConfirmationStore.getState().pendingBySessionId,
      ).toEqual({});
    });

    it("preserves pending security decisions when overlapping archives both fail", async () => {
      const firstArchive = createDeferredPromise<void>();
      const secondArchive = createDeferredPromise<void>();
      const resolve = vi.fn();
      const pending = {
        request: { sessionId: "session-1" } as never,
        title: "Tool call",
        command: "command",
        alertText: "🔒 Security Alert",
        inferredExplanation: { status: "idle" } as const,
        resolve,
      };
      seedSession({ id: "session-1" });
      useSecurityConfirmationStore.setState({
        pendingBySessionId: { "session-1": [pending] },
      });
      mocks.archiveSession
        .mockReturnValueOnce(firstArchive.promise)
        .mockReturnValueOnce(secondArchive.promise);

      const firstPromise = useChatSessionStore
        .getState()
        .archiveSession("session-1");
      const secondPromise = useChatSessionStore
        .getState()
        .archiveSession("session-1");

      firstArchive.reject(new Error("first archive failed"));
      await expect(firstPromise).rejects.toThrow("first archive failed");
      expect(resolve).not.toHaveBeenCalled();

      secondArchive.reject(new Error("second archive failed"));
      await expect(secondPromise).rejects.toThrow("second archive failed");

      expect(
        useChatSessionStore.getState().getSession("session-1")?.archivedAt,
      ).toBeUndefined();
      expect(resolve).not.toHaveBeenCalled();
      expect(
        useSecurityConfirmationStore.getState().pendingBySessionId,
      ).toEqual({ "session-1": [pending] });
    });

    it("applies an older unarchive success after a newer archive failure clears the mutation", async () => {
      const priorArchivedAt = "2026-03-15T00:00:00.000Z";
      const unarchive = createDeferredPromise<void>();
      const archive = createDeferredPromise<void>();
      const resolve = vi.fn();
      const pending = {
        request: { sessionId: "session-1" } as never,
        title: "Tool call",
        command: "command",
        alertText: "🔒 Security Alert",
        inferredExplanation: { status: "idle" } as const,
        resolve,
      };
      seedSession({ id: "session-1", archivedAt: priorArchivedAt });
      mocks.unarchiveSession.mockReturnValueOnce(unarchive.promise);
      mocks.archiveSession.mockReturnValueOnce(archive.promise);

      const unarchivePromise = useChatSessionStore
        .getState()
        .unarchiveSession("session-1");
      expect(
        useChatSessionStore.getState().getSession("session-1")?.archivedAt,
      ).toBeUndefined();
      useSecurityConfirmationStore.setState({
        pendingBySessionId: { "session-1": [pending] },
      });

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
      expect(resolve).not.toHaveBeenCalled();

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
      expect(resolve).not.toHaveBeenCalled();
      expect(
        useSecurityConfirmationStore.getState().pendingBySessionId,
      ).toEqual({ "session-1": [pending] });
    });
  });

  describe("createSession", () => {
    it("creates a real ACP-backed session", async () => {
      mocks.acpCreateSession.mockResolvedValue({ sessionId: "acp-1" });

      const session = await useChatSessionStore.getState().createSession({
        title: "New Chat",
        executionTarget: targetFromAgentModelSelection("goose", {
          modelProviderId: "openai",
          modelId: "gpt-4.1",
          modelName: "GPT-4.1",
        }),
        projectId: "project-1",
        personaId: "persona-1",
        workingDir: "/tmp/project",
      });

      expect(mocks.acpCreateSession).toHaveBeenCalledWith(
        "openai",
        "/tmp/project",
        {
          projectId: "project-1",
          personaId: "persona-1",
          modelId: "gpt-4.1",
          deferProviderSetup: false,
        },
      );
      expect(session).toMatchObject({
        id: "acp-1",
        title: "New Chat",
        projectId: "project-1",
        executionTarget: {
          harnessId: "goose",
          modelProviderId: "openai",
          modelId: "gpt-4.1",
          modelName: "GPT-4.1",
        },
        personaId: "persona-1",
        workingDir: "/tmp/project",
      });
      expect(session.workspaceAttachments).toEqual([
        {
          id: workspaceAttachmentIdForPath("/tmp/project"),
          path: "/tmp/project",
          kind: "directory",
          source: "inferred",
          branch: null,
          usedByAgent: false,
        },
      ]);
      expect(session.activeWorkspaceId).toBe(
        workspaceAttachmentIdForPath("/tmp/project"),
      );
      expect(useChatSessionStore.getState().sessions).toContainEqual(session);
      expect(readPersistedWorkspaceMetadata()["acp-1"]).toEqual({
        workspaceAttachments: session.workspaceAttachments,
        activeWorkspaceId: workspaceAttachmentIdForPath("/tmp/project"),
        workingDir: "/tmp/project",
      });
    });

    it("does not attach an ACP default model to an unqualified Goose harness", async () => {
      mocks.acpCreateSession.mockResolvedValue({
        sessionId: "acp-1",
        configOptionsSnapshot: {
          model: { modelId: "gpt-5.5", modelName: "GPT-5.5" },
          reasoningEffort: null,
        },
      });

      const session = await useChatSessionStore.getState().createSession({
        executionTarget: { harnessId: "goose" },
        workingDir: "/tmp/project",
      });

      expect(session.executionTarget).toEqual({ harnessId: "goose" });
    });

    it("seeds reasoning effort from ACP session creation config", async () => {
      mocks.acpCreateSession.mockResolvedValue({
        sessionId: "acp-1",
        configOptionsSnapshot: {
          model: null,
          reasoningEffort: {
            configId: "thinking_effort",
            currentValue: "medium",
            options: [
              { id: "low", name: "Low" },
              { id: "medium", name: "Medium" },
              { id: "high", name: "High" },
            ],
          },
        },
      });

      const session = await useChatSessionStore.getState().createSession({
        executionTarget: {
          harnessId: "goose",
          modelProviderId: "openai",
        },
        workingDir: "/tmp/project",
      });

      expect(mocks.acpCreateSession).toHaveBeenCalledWith(
        "openai",
        "/tmp/project",
        {
          projectId: undefined,
          personaId: undefined,
          modelId: undefined,
          deferProviderSetup: true,
        },
      );
      expect(session.reasoningEffort).toEqual({
        configId: "thinking_effort",
        currentValue: "medium",
        options: [
          { id: "low", name: "Low" },
          { id: "medium", name: "Medium" },
          { id: "high", name: "High" },
        ],
      });
      expect(
        useChatSessionStore.getState().getSession("acp-1")?.reasoningEffort,
      ).toEqual(session.reasoningEffort);
    });

    it("creates a local draft session without touching ACP", () => {
      const session = useChatSessionStore.getState().createDraftSession({
        title: "New Chat",
        executionTarget: targetFromAgentModelSelection("goose", {
          modelProviderId: "openai",
          modelId: "gpt-4.1",
          modelName: "GPT-4.1",
        }),
        projectId: "project-1",
        workingDir: "/tmp/project",
      });

      expect(mocks.acpCreateSession).not.toHaveBeenCalled();
      expect(session).toMatchObject({
        title: "New Chat",
        projectId: "project-1",
        executionTarget: {
          harnessId: "goose",
          modelProviderId: "openai",
          modelId: "gpt-4.1",
          modelName: "GPT-4.1",
        },
        workingDir: "/tmp/project",
        messageCount: 0,
        creationState: "pending",
      });
      expect(session.workspaceAttachments).toEqual([
        expect.objectContaining({
          id: workspaceAttachmentIdForPath("/tmp/project"),
          path: "/tmp/project",
          source: "inferred",
          usedByAgent: false,
        }),
      ]);
      expect(session.activeWorkspaceId).toBe(
        workspaceAttachmentIdForPath("/tmp/project"),
      );
      expect(session.id).toEqual(expect.any(String));
      expect(useChatSessionStore.getState().sessions).toContainEqual(session);
    });

    it("promotes a pending draft session to the real ACP session id", () => {
      seedSession({
        id: "local-session",
        title: "New Chat",
        projectId: "project-1",
        executionTarget: {
          harnessId: "goose",
          modelProviderId: "openai",
        },
        workingDir: "/tmp/project",
        creationState: "pending",
      });
      useChatSessionStore.setState({
        activeSessionId: "local-session",
        activeWorkspaceBySession: {
          "local-session": { path: "/tmp/project", branch: "main" },
        },
      });

      useChatSessionStore
        .getState()
        .promoteDraftSession("local-session", "acp-session", {
          executionTarget: targetFromAgentModelSelection("goose", {
            modelProviderId: "openai",
            modelId: "gpt-4.1",
            modelName: "GPT-4.1",
          }),
        });

      const state = useChatSessionStore.getState();
      expect(state.getSession("local-session")).toBeUndefined();
      expect(state.getSession("acp-session")).toMatchObject({
        id: "acp-session",
        executionTarget: {
          modelId: "gpt-4.1",
          modelName: "GPT-4.1",
        },
        creationState: undefined,
        creationError: undefined,
      });
      expect(state.activeSessionId).toBe("acp-session");
      expect(state.activeWorkspaceBySession).toEqual({
        "acp-session": { path: "/tmp/project", branch: "main" },
      });
    });

    it("keeps UI ownership when promotion explicitly clears the target", () => {
      seedSession({
        id: "local-session",
        executionTarget: {
          harnessId: "goose",
          modelProviderId: "openai",
          modelId: "gpt-4.1",
          modelName: "GPT-4.1",
        },
        executionTargetSource: "acp",
        creationState: "pending",
      });

      useChatSessionStore
        .getState()
        .promoteDraftSession("local-session", "acp-session", {
          executionTarget: undefined,
        });

      const promoted = useChatSessionStore.getState().getSession("acp-session");
      expect(promoted?.executionTarget).toBeUndefined();
      expect(promoted?.executionTargetSource).toBe("ui");
    });

    it("preserves builder metadata when promoting an optimistic draft session", () => {
      seedSession({
        id: "local-builder-session",
        title: "New agent",
        workingDir: "/tmp/project",
        creationState: "pending",
        intent: "build-agent",
        agentBuilderOpen: false,
        agentBuilderContextState: "userOpened",
        targetAgentPath: "/Users/x/.agents/agents/draft-local.md",
        targetAgentSlug: "draft-local",
        targetAgentDraftState: null,
        targetAgentDraftSaved: true,
      });

      useChatSessionStore
        .getState()
        .promoteDraftSession("local-builder-session", "acp-builder-session");

      expect(
        useChatSessionStore.getState().getSession("acp-builder-session"),
      ).toMatchObject({
        id: "acp-builder-session",
        intent: "build-agent",
        agentBuilderOpen: false,
        agentBuilderContextState: "userOpened",
        targetAgentPath: "/Users/x/.agents/agents/draft-local.md",
        targetAgentSlug: "draft-local",
        targetAgentDraftState: null,
        targetAgentDraftSaved: true,
      });
    });

    it("honors an explicit Context-state clear during builder promotion", () => {
      seedSession({
        id: "local-builder-session",
        title: "New agent",
        creationState: "pending",
        intent: "build-agent",
        agentBuilderOpen: true,
        agentBuilderContextState: "userOpened",
      });

      useChatSessionStore
        .getState()
        .promoteDraftSession("local-builder-session", "acp-builder-session", {
          agentBuilderOpen: false,
          agentBuilderContextState: undefined,
        });

      const promoted = useChatSessionStore
        .getState()
        .getSession("acp-builder-session");
      expect(promoted?.agentBuilderOpen).toBe(false);
      expect(promoted?.agentBuilderContextState).toBeUndefined();
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
        executionTarget: {
          harnessId: "goose",
          modelProviderId: "openai",
        },
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

    it("persists draft workspace attachments under the real ACP session id when promoting", () => {
      const draft = useChatSessionStore.getState().createDraftSession({
        title: "New Chat",
        executionTarget: {
          harnessId: "goose",
          modelProviderId: "openai",
        },
        workingDir: "/tmp/main",
        workspaceAttachments: [
          {
            id: workspaceAttachmentIdForPath("/tmp/main"),
            path: "/tmp/main",
            kind: "git-main-worktree",
            source: "inferred",
            branch: "main",
            usedByAgent: false,
          },
          {
            id: workspaceAttachmentIdForPath("/tmp/main-worktrees/feature"),
            path: "/tmp/main-worktrees/feature",
            kind: "git-linked-worktree",
            source: "created",
            branch: "feature",
            repositoryPath: "/tmp/main",
            worktreePath: "/tmp/main-worktrees/feature",
            usedByAgent: false,
          },
        ],
      });

      useChatSessionStore
        .getState()
        .promoteDraftSession(draft.id, "acp-session");

      const persisted = readPersistedWorkspaceMetadata();
      expect(persisted[draft.id]).toBeUndefined();
      expect(persisted["acp-session"]).toEqual({
        workspaceAttachments: useChatSessionStore
          .getState()
          .getSession("acp-session")?.workspaceAttachments,
        activeWorkspaceId: null,
        workingDir: "/tmp/main",
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
              lastMessageAt: "2026-04-05T00:00:00.000Z",
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
      expect(sessions[0].id).toBe("acp-1");
      expect(sessions[0].title).toBe("ACP Session 1");
      expect(sessions[0].messageCount).toBe(4);
      expect(sessions[0].lastMessageAt).toBe("2026-04-05T00:00:00.000Z");
      expect(sessions[0].executionTarget).toMatchObject({
        harnessId: "goose",
        modelProviderId: "openai",
        modelId: "gpt-4.1",
      });
      expect(sessions[0].projectId).toBe("project-123");
      expect(sessions[0].personaId).toBe("persona-1");
      expect(sessions[0].workingDir).toBe("/tmp/acp-1");
      expect(sessions[0].workspaceAttachments).toEqual([
        {
          id: workspaceAttachmentIdForPath("/tmp/acp-1"),
          path: "/tmp/acp-1",
          kind: "directory",
          source: "inferred",
          branch: null,
          usedByAgent: true,
        },
      ]);
      expect(sessions[0].activeWorkspaceId).toBe(
        workspaceAttachmentIdForPath("/tmp/acp-1"),
      );
      expect(sessions[0].userSetName).toBe(true);
      expect(sessions[1].id).toBe("acp-2");
      expect(sessions[1].title).toBe("Untitled");
      expect(sessions[1].messageCount).toBe(7);
      expect(useChatSessionStore.getState().sessionPageCursor).toBe("cursor-2");
      expect(useChatSessionStore.getState().hasMoreSessions).toBe(true);
    });

    it("preserves a local persona tag when an ACP session row omits persona metadata", async () => {
      seedSession({
        id: "session-1",
        title: "Tagged chat",
        personaId: "persona-1",
        executionTarget: { harnessId: "goose" },
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

    it("preserves the UI-owned provider and model pair when ACP refresh metadata is stale", async () => {
      const staleRefresh = createDeferredPromise<ReturnType<typeof mockPage>>();
      seedSession({
        id: "session-1",
        title: "Fable chat",
        executionTarget: {
          harnessId: "goose",
          modelProviderId: "databricks_v2",
          modelId: "goose-gpt-5-5",
          modelName: "GPT-5.5",
        },
        updatedAt: "2026-04-01T00:00:00.000Z",
      });
      mocks.acpListSessionsPage.mockReturnValue(staleRefresh.promise);

      const load = useChatSessionStore.getState().loadSessions();
      useChatSessionStore.getState().replaceSessionExecutionTarget(
        "session-1",
        targetFromAgentModelSelection("goose", {
          modelProviderId: "databricks_v2",
          modelId: "goose-claude-fable-5",
          modelName: "Claude Fable 5",
        }),
      );
      staleRefresh.resolve(
        mockPage([
          makeAcpSession({
            sessionId: "session-1",
            title: "Fable chat",
            providerId: "goose",
            modelId: "goose-gpt-5-5",
            updatedAt: "2026-04-02T00:00:00.000Z",
          }),
        ]),
      );

      await load;

      expect(
        useChatSessionStore.getState().getSession("session-1"),
      ).toMatchObject({
        executionTarget: {
          harnessId: "goose",
          modelProviderId: "databricks_v2",
          modelId: "goose-claude-fable-5",
          modelName: "Claude Fable 5",
        },
        updatedAt: "2026-04-02T00:00:00.000Z",
      });
    });

    it("does not restore an old provider model while a provider switch owns an empty model", async () => {
      seedSession({
        id: "session-1",
        executionTarget: {
          harnessId: "goose",
          modelProviderId: "anthropic",
        },
      });
      beginModelSelectionIntent("session-1", {
        requestId: "provider-request-1",
        target: { harnessId: "goose", modelProviderId: "anthropic" },
        previousTarget: targetFromAgentModelSelection("goose", {
          modelProviderId: "databricks_v2",
          modelId: "goose-gpt-5-5",
          modelName: "GPT-5.5",
        }),
      });

      mocks.acpListSessionsPage.mockResolvedValue(
        mockPage([
          makeAcpSession({
            sessionId: "session-1",
            providerId: "databricks_v2",
            modelId: "goose-gpt-5-5",
          }),
        ]),
      );

      await useChatSessionStore.getState().loadSessions();

      expect(
        useChatSessionStore.getState().getSession("session-1"),
      ).toMatchObject({
        executionTarget: {
          harnessId: "goose",
          modelProviderId: "anthropic",
        },
      });
      expect(
        useChatSessionStore.getState().getSession("session-1")?.executionTarget
          ?.modelId,
      ).toBeUndefined();
      expect(getModelSelectionIntent("session-1")).toMatchObject({
        requestId: "provider-request-1",
        target: {
          harnessId: "goose",
          modelProviderId: "anthropic",
        },
      });
    });

    it("hydrates persisted workspace attachments when loading sessions from ACP", async () => {
      window.localStorage.setItem(
        CHAT_WORKSPACE_METADATA_STORAGE_KEY,
        JSON.stringify({
          "acp-1": {
            workspaceAttachments: [
              {
                id: workspaceAttachmentIdForPath("/tmp/main"),
                path: "/tmp/main",
                kind: "git-main-worktree",
                source: "inferred",
                branch: "main",
                usedByAgent: true,
              },
              {
                id: workspaceAttachmentIdForPath("/tmp/main-worktrees/feature"),
                path: "/tmp/main-worktrees/feature",
                kind: "git-linked-worktree",
                source: "selected",
                branch: "feature",
                repositoryPath: "/tmp/main",
                worktreePath: "/tmp/main-worktrees/feature",
                usedByAgent: true,
              },
            ],
            activeWorkspaceId: workspaceAttachmentIdForPath("/tmp/main"),
          },
        }),
      );
      mocks.acpListSessionsPage.mockResolvedValue(
        mockPage([
          makeAcpSession({
            sessionId: "acp-1",
            workingDir: "/tmp/main",
          }),
        ]),
      );

      await useChatSessionStore.getState().loadSessions();

      const session = useChatSessionStore.getState().getSession("acp-1");
      expect(session?.workspaceAttachments).toEqual([
        expect.objectContaining({
          path: "/tmp/main",
          kind: "git-main-worktree",
          source: "inferred",
        }),
        expect.objectContaining({
          path: "/tmp/main-worktrees/feature",
          kind: "git-linked-worktree",
          source: "selected",
          repositoryPath: "/tmp/main",
          worktreePath: "/tmp/main-worktrees/feature",
        }),
      ]);
      expect(session?.activeWorkspaceId).toBe(
        workspaceAttachmentIdForPath("/tmp/main"),
      );
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

    it("does not hydrate the Goose provider sentinel as a model", async () => {
      mocks.acpListSessionsPage.mockResolvedValue(
        mockPage([
          makeAcpSession({
            sessionId: "legacy-session",
            providerId: "databricks_v2",
            modelId: "goose",
          }),
        ]),
      );

      await useChatSessionStore.getState().loadSessions();

      expect(
        useChatSessionStore.getState().getSession("legacy-session")
          ?.executionTarget?.modelId,
      ).toBeUndefined();
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
        updatedAt: "2026-04-01T00:00:00.000Z",
      });
      mocks.acpListSessionsPage.mockResolvedValue(
        mockPage([
          makeAcpSession({
            sessionId: "acp-1",
            title: "Updated Title",
            updatedAt: "2026-04-03T00:00:00.000Z",
          }),
          makeAcpSession({
            sessionId: "acp-1",
            title: "Duplicate Title",
            updatedAt: "2026-04-04T00:00:00.000Z",
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
      });
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

    it("suppresses structurally unchanged reasoning effort patches", () => {
      const reasoningEffort = {
        configId: "thinking_effort",
        currentValue: "high",
        options: [{ id: "high", name: "High" }],
      };
      const session = seedSession({ reasoningEffort });
      const storedReasoningEffort = useChatSessionStore
        .getState()
        .getSession(session.id)?.reasoningEffort;
      const listener = vi.fn();
      const unsubscribe = useChatSessionStore.subscribe(listener);

      useChatSessionStore.getState().patchSession(session.id, {
        reasoningEffort: {
          configId: reasoningEffort.configId,
          currentValue: reasoningEffort.currentValue,
          options: reasoningEffort.options.map((option) => ({ ...option })),
        },
      });
      unsubscribe();

      expect(listener).not.toHaveBeenCalled();
      expect(
        useChatSessionStore.getState().getSession(session.id)?.reasoningEffort,
      ).toBe(storedReasoningEffort);
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

    it("adds and activates a workspace attachment when the working directory changes", () => {
      const oldAttachmentId = workspaceAttachmentIdForPath("/tmp/old");
      const session = seedSession({
        workingDir: "/tmp/old",
        workspaceAttachments: [
          {
            id: oldAttachmentId,
            path: "/tmp/old",
            kind: "directory",
            source: "inferred",
            branch: null,
            usedByAgent: false,
          },
        ],
        activeWorkspaceId: oldAttachmentId,
      });

      useChatSessionStore.getState().patchSession(session.id, {
        workingDir: "/tmp/new",
      });

      const updated = useChatSessionStore.getState().getSession(session.id);
      expect(
        updated?.workspaceAttachments?.map((attachment) => attachment.path),
      ).toEqual(["/tmp/old", "/tmp/new"]);
      expect(updated?.workspaceAttachments?.[1]).toMatchObject({
        id: workspaceAttachmentIdForPath("/tmp/new"),
        path: "/tmp/new",
        source: "inferred",
        usedByAgent: false,
      });
      expect(updated?.activeWorkspaceId).toBe(
        workspaceAttachmentIdForPath("/tmp/new"),
      );
    });

    it("attaches an included workspace without changing the active workspace", () => {
      const mainAttachmentId = workspaceAttachmentIdForPath("/tmp/main");
      const session = seedSession({
        workingDir: "/tmp/main",
        workspaceAttachments: [
          {
            id: mainAttachmentId,
            path: "/tmp/main",
            kind: "git-main-worktree",
            source: "inferred",
            branch: "main",
            usedByAgent: false,
          },
        ],
        activeWorkspaceId: mainAttachmentId,
      });

      useChatSessionStore.getState().attachWorkspace(session.id, {
        path: "/tmp/main-worktrees/feature",
        branch: "feature",
        kind: "git-linked-worktree",
        source: "selected",
      });

      const updated = useChatSessionStore.getState().getSession(session.id);
      expect(updated?.activeWorkspaceId).toBe(mainAttachmentId);
      expect(updated?.workspaceAttachments).toEqual([
        expect.objectContaining({
          path: "/tmp/main",
          branch: "main",
        }),
        expect.objectContaining({
          path: "/tmp/main-worktrees/feature",
          branch: "feature",
          kind: "git-linked-worktree",
          source: "selected",
          usedByAgent: false,
        }),
      ]);
      expect(readPersistedWorkspaceMetadata()[session.id]).toEqual({
        workspaceAttachments: updated?.workspaceAttachments,
        activeWorkspaceId: mainAttachmentId,
        workingDir: "/tmp/main",
      });
    });

    it("persists Goose-created workspace cleanup metadata", () => {
      const mainAttachmentId = workspaceAttachmentIdForPath("/tmp/main");
      const featurePath = "/tmp/main-worktrees/feature";
      const session = seedSession({
        workingDir: "/tmp/main",
        workspaceAttachments: [
          {
            id: mainAttachmentId,
            path: "/tmp/main",
            kind: "git-main-worktree",
            source: "inferred",
            branch: "main",
            usedByAgent: false,
          },
        ],
        activeWorkspaceId: mainAttachmentId,
      });

      useChatSessionStore.getState().attachWorkspace(session.id, {
        path: featurePath,
        branch: "feature",
        kind: "git-linked-worktree",
        source: "created",
        repositoryPath: "/tmp/main",
        worktreePath: featurePath,
        lifecycle: {
          owner: "goose",
          cleanup: "worktree",
          branch: "feature",
          baseBranch: "main",
          repositoryPath: "/tmp/main",
          worktreePath: featurePath,
          createdBranch: true,
        },
      });

      const updated = useChatSessionStore.getState().getSession(session.id);
      expect(updated?.workspaceAttachments?.[1]).toMatchObject({
        path: featurePath,
        source: "created",
        lifecycle: {
          owner: "goose",
          cleanup: "worktree",
          branch: "feature",
          baseBranch: "main",
          repositoryPath: "/tmp/main",
          worktreePath: featurePath,
          createdBranch: true,
        },
      });
      expect(readPersistedWorkspaceMetadata()[session.id]).toEqual({
        workspaceAttachments: updated?.workspaceAttachments,
        activeWorkspaceId: mainAttachmentId,
        workingDir: "/tmp/main",
      });
    });

    it("removes an included workspace attachment", () => {
      const mainAttachmentId = workspaceAttachmentIdForPath("/tmp/main");
      const featureAttachmentId = workspaceAttachmentIdForPath(
        "/tmp/main-worktrees/feature",
      );
      const session = seedSession({
        workingDir: "/tmp/main",
        workspaceAttachments: [
          {
            id: mainAttachmentId,
            path: "/tmp/main",
            kind: "git-main-worktree",
            source: "inferred",
            branch: "main",
            usedByAgent: false,
          },
          {
            id: featureAttachmentId,
            path: "/tmp/main-worktrees/feature",
            kind: "git-linked-worktree",
            source: "selected",
            branch: "feature",
            usedByAgent: false,
          },
        ],
      });

      useChatSessionStore
        .getState()
        .removeWorkspaceAttachment(session.id, featureAttachmentId);

      const updated = useChatSessionStore.getState().getSession(session.id);
      expect(
        updated?.workspaceAttachments?.map((attachment) => attachment.path),
      ).toEqual(["/tmp/main"]);
      expect(readPersistedWorkspaceMetadata()[session.id]).toEqual({
        workspaceAttachments: updated?.workspaceAttachments,
        activeWorkspaceId: mainAttachmentId,
        workingDir: "/tmp/main",
      });
    });

    it("clears the transient active workspace when removing that workspace", () => {
      const mainAttachmentId = workspaceAttachmentIdForPath("/tmp/main");
      const featurePath = "/tmp/main-worktrees/feature";
      const featureAttachmentId = workspaceAttachmentIdForPath(featurePath);
      const session = seedSession({
        workingDir: "/tmp/main",
        workspaceAttachments: [
          {
            id: mainAttachmentId,
            path: "/tmp/main",
            kind: "git-main-worktree",
            source: "inferred",
            branch: "main",
            usedByAgent: false,
          },
          {
            id: featureAttachmentId,
            path: featurePath,
            kind: "git-linked-worktree",
            source: "selected",
            branch: "feature",
            usedByAgent: false,
          },
        ],
        activeWorkspaceId: mainAttachmentId,
      });
      useChatSessionStore.setState({
        activeWorkspaceBySession: {
          [session.id]: { path: featurePath, branch: "feature" },
        },
      });

      useChatSessionStore
        .getState()
        .removeWorkspaceAttachment(session.id, featureAttachmentId);

      expect(useChatSessionStore.getState().activeWorkspaceBySession).toEqual(
        {},
      );
      expect(
        useChatSessionStore
          .getState()
          .getSession(session.id)
          ?.workspaceAttachments?.map((attachment) => attachment.path),
      ).toEqual(["/tmp/main"]);
    });

    it("removes an inferred default workspace from the chat", () => {
      const mainAttachmentId = workspaceAttachmentIdForPath("/tmp/main");
      const session = seedSession({
        workingDir: "/tmp/main",
      });

      useChatSessionStore
        .getState()
        .removeWorkspaceAttachment(session.id, mainAttachmentId);

      const updated = useChatSessionStore.getState().getSession(session.id);
      expect(updated?.workspaceAttachments).toEqual([
        expect.objectContaining({
          path: "/tmp/main",
          source: "excluded",
        }),
      ]);
      expect(getIncludedWorkspaceAttachments(updated)).toEqual([]);
      expect(readPersistedWorkspaceMetadata()[session.id]).toEqual({
        workspaceAttachments: updated?.workspaceAttachments,
        activeWorkspaceId: null,
        workingDir: "/tmp/main",
      });
    });

    it("marks every included workspace as used by the agent when sending", () => {
      const session = seedSession({
        workingDir: "/tmp/main",
        workspaceAttachments: [
          {
            id: workspaceAttachmentIdForPath("/tmp/main"),
            path: "/tmp/main",
            kind: "git-main-worktree",
            source: "inferred",
            branch: "main",
            usedByAgent: false,
          },
          {
            id: workspaceAttachmentIdForPath("/tmp/main-worktrees/feature"),
            path: "/tmp/main-worktrees/feature",
            kind: "git-linked-worktree",
            source: "selected",
            branch: "feature",
            usedByAgent: false,
          },
        ],
      });

      useChatSessionStore.getState().markWorkspaceUsedByAgent(session.id);

      const updated = useChatSessionStore.getState().getSession(session.id);
      expect(
        updated?.workspaceAttachments?.map((attachment) => ({
          path: attachment.path,
          usedByAgent: attachment.usedByAgent,
        })),
      ).toEqual([
        { path: "/tmp/main", usedByAgent: true },
        { path: "/tmp/main-worktrees/feature", usedByAgent: true },
      ]);
      expect(readPersistedWorkspaceMetadata()[session.id]).toEqual({
        workspaceAttachments: updated?.workspaceAttachments,
        activeWorkspaceId: null,
        workingDir: "/tmp/main",
      });
    });

    it("marks only the chat working directory as used when no explicit workspaces exist", () => {
      const session = seedSession({
        workingDir: "/tmp/main",
      });

      useChatSessionStore.getState().markWorkspaceUsedByAgent(session.id);

      const updated = useChatSessionStore.getState().getSession(session.id);
      expect(
        updated?.workspaceAttachments?.map((attachment) => ({
          path: attachment.path,
          source: attachment.source,
          usedByAgent: attachment.usedByAgent,
        })),
      ).toEqual([
        {
          path: "/tmp/main",
          source: "inferred",
          usedByAgent: true,
        },
      ]);
      expect(readPersistedWorkspaceMetadata()[session.id]).toEqual({
        workspaceAttachments: updated?.workspaceAttachments,
        activeWorkspaceId: workspaceAttachmentIdForPath("/tmp/main"),
        workingDir: "/tmp/main",
      });
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

  describe("execution target", () => {
    it("replaces the complete target atomically and clears stale reasoning", () => {
      const session = seedSession({
        executionTarget: {
          harnessId: "goose",
          modelProviderId: "openai",
          modelId: "gpt-4o",
          modelName: "GPT-4o",
        },
        reasoningEffort: {
          configId: "thinking_effort",
          currentValue: "high",
          options: [{ id: "high", name: "high" }],
        },
      });

      useChatSessionStore.getState().replaceSessionExecutionTarget(session.id, {
        harnessId: "goose",
        modelProviderId: "anthropic",
        modelId: "claude-opus-4-6",
        modelName: "Claude Opus 4.6",
      });

      const updated = useChatSessionStore.getState().getSession(session.id);
      expect(updated?.executionTarget).toEqual({
        harnessId: "goose",
        modelProviderId: "anthropic",
        modelId: "claude-opus-4-6",
        modelName: "Claude Opus 4.6",
      });
      expect(updated).not.toHaveProperty("providerId");
      expect(updated).not.toHaveProperty("modelId");
      expect(updated?.reasoningEffort).toBeUndefined();
    });

    it("does not retain model state when replacing with a provider-only target", () => {
      const session = seedSession({
        executionTarget: {
          harnessId: "goose",
          modelProviderId: "openai",
          modelId: "gpt-4o",
          modelName: "GPT-4o",
        },
      });

      useChatSessionStore.getState().replaceSessionExecutionTarget(session.id, {
        harnessId: "goose",
        modelProviderId: "anthropic",
      });

      const updated = useChatSessionStore.getState().getSession(session.id);
      expect(updated?.executionTarget).toEqual({
        harnessId: "goose",
        modelProviderId: "anthropic",
      });
    });

    it("keeps an explicit UI clear authoritative over later ACP hydration", () => {
      const session = seedSession({
        executionTarget: {
          harnessId: "goose",
          modelProviderId: "openai",
          modelId: "gpt-4o",
          modelName: "GPT-4o",
        },
        executionTargetSource: "acp",
      });

      const store = useChatSessionStore.getState();
      store.replaceSessionExecutionTarget(session.id, undefined);
      store.hydrateSessionExecutionTarget(session.id, {
        harnessId: "goose",
        modelProviderId: "anthropic",
        modelId: "claude-fable-5",
        modelName: "Claude Fable 5",
      });

      expect(
        useChatSessionStore.getState().getSession(session.id),
      ).toMatchObject({ executionTargetSource: "ui" });
      expect(
        useChatSessionStore.getState().getSession(session.id)?.executionTarget,
      ).toBeUndefined();
    });

    it("does not allow generic patches to bypass target replacement", () => {
      const session = seedSession({
        executionTarget: {
          harnessId: "goose",
          modelProviderId: "openai",
        },
      });

      expect(() =>
        useChatSessionStore.getState().patchSession(session.id, {
          // @ts-expect-error Execution targets have a dedicated atomic action.
          executionTarget: {
            harnessId: "goose",
            modelProviderId: "anthropic",
          },
        }),
      ).toThrow("Use replaceSessionExecutionTarget");
    });

    it("preserves reasoning when only the model label changes", () => {
      const reasoningEffort = {
        configId: "thinking_effort",
        currentValue: "high",
        options: [{ id: "high", name: "High" }],
      };
      const session = seedSession({
        executionTarget: {
          harnessId: "goose",
          modelProviderId: "openai",
          modelId: "gpt-5.5",
          modelName: "gpt-5.5",
        },
        reasoningEffort,
      });

      useChatSessionStore.getState().replaceSessionExecutionTarget(session.id, {
        harnessId: "goose",
        modelProviderId: "openai",
        modelId: "gpt-5.5",
        modelName: "GPT-5.5",
      });

      expect(
        useChatSessionStore.getState().getSession(session.id),
      ).toMatchObject({
        executionTarget: { modelName: "GPT-5.5" },
        reasoningEffort,
      });
    });

    it("installs a selection intent and its target in one state transition", () => {
      const session = seedSession({
        executionTarget: {
          harnessId: "goose",
          modelProviderId: "openai",
          modelId: "gpt-5.5",
          modelName: "GPT-5.5",
        },
        reasoningEffort: {
          configId: "thinking_effort",
          currentValue: "high",
          options: [{ id: "high", name: "High" }],
        },
      });
      const observedStates: ReturnType<typeof useChatSessionStore.getState>[] =
        [];
      const unsubscribe = useChatSessionStore.subscribe((state) => {
        observedStates.push(state);
      });

      beginModelSelectionIntent(session.id, {
        requestId: "request-1",
        target: {
          harnessId: "goose",
          modelProviderId: "anthropic",
          modelId: "claude-fable-5",
          modelName: "Claude Fable 5",
        },
        previousTarget: session.executionTarget,
      });
      unsubscribe();

      expect(observedStates).toHaveLength(1);
      expect(observedStates[0]?.getSession(session.id)).toMatchObject({
        executionTarget: {
          harnessId: "goose",
          modelProviderId: "anthropic",
          modelId: "claude-fable-5",
          modelName: "Claude Fable 5",
        },
      });
      expect(
        observedStates[0]?.getSession(session.id)?.reasoningEffort,
      ).toBeUndefined();
      expect(getModelSelectionIntent(session.id)).toMatchObject({
        requestId: "request-1",
        target: {
          modelProviderId: "anthropic",
          modelId: "claude-fable-5",
        },
      });
    });
  });

  describe("right rail preference", () => {
    it("migrates the legacy context-panel preference", async () => {
      window.localStorage.setItem("goose:context-panel-open", "1");
      vi.resetModules();
      const { useChatSessionStore: migratedStore } = await import(
        "../chatSessionStore"
      );

      expect(migratedStore.getState().isRightRailOpen).toBe(true);
      expect(window.localStorage.getItem("goose:right-rail-open")).toBe("1");
    });

    it("stores right rail open state as a global preference", () => {
      useChatSessionStore.getState().setRightRailOpen(true);

      expect(useChatSessionStore.getState().isRightRailOpen).toBe(true);
      expect(window.localStorage.getItem("goose:right-rail-open")).toBe("1");

      useChatSessionStore.getState().setRightRailOpen(false);

      expect(useChatSessionStore.getState().isRightRailOpen).toBe(false);
      expect(window.localStorage.getItem("goose:right-rail-open")).toBe("0");
    });
  });
});

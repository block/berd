import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ProjectInfo } from "@/features/projects/api/projects";
import { useProjectStore } from "@/features/projects/stores/projectStore";
import { useChatSessionStore, type ChatSession } from "../chatSessionStore";
import {
  moveSessionToProject,
  updateSessionProject,
  updateSessionTitle,
} from "../chatSessionOperations";

const mockRenameSession = vi.fn();
const mockUpdateSessionProject = vi.fn();
const mockResolveSessionCwd = vi.fn();
const mockApplyLatestSessionConfig = vi.fn();

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, resolve, reject };
}

vi.mock("@/shared/api/acpApi", () => ({
  DEFAULT_PROVIDER: { id: "goose", label: "Goose (Default)" },
  renameSession: (...args: unknown[]) => mockRenameSession(...args),
  updateSessionProject: (...args: unknown[]) =>
    mockUpdateSessionProject(...args),
}));

vi.mock("@/features/projects/lib/sessionCwdSelection", () => ({
  resolveSessionCwd: (...args: unknown[]) => mockResolveSessionCwd(...args),
}));

vi.mock("@/features/chat/lib/sessionConfigRequests", () => ({
  applyLatestSessionConfig: (...args: unknown[]) =>
    mockApplyLatestSessionConfig(...args),
}));

function resetStore() {
  useChatSessionStore.setState({
    sessions: [],
    activeSessionId: null,
    isLoading: false,
    hasHydratedSessions: false,
    activeWorkspaceBySession: {},
    modelSelectionIntentBySession: {},
  });
  useProjectStore.setState({
    projects: [],
    loading: false,
    activeProjectId: null,
  });
}

function seedSession(overrides: Partial<ChatSession> = {}) {
  useChatSessionStore.setState({
    sessions: [
      {
        id: "session-1",
        title: "Original Title",
        createdAt: "2026-04-01T00:00:00.000Z",
        updatedAt: "2026-04-01T00:00:00.000Z",
        messageCount: 0,
        ...overrides,
      },
    ],
  });
}

function buildProject(overrides: Partial<ProjectInfo> = {}): ProjectInfo {
  return {
    id: "project-new",
    path: "/tmp/project-source",
    name: "Project",
    description: "",
    prompt: "",
    icon: "",
    color: "#000000",
    preferredProvider: null,
    preferredModel: null,
    workingDirs: ["/tmp/project-new"],
    useWorktrees: false,
    order: 0,
    archivedAt: null,
    ...overrides,
  };
}

describe("chatSessionOperations", () => {
  beforeEach(() => {
    resetStore();
    vi.clearAllMocks();
    mockResolveSessionCwd.mockResolvedValue("/tmp/project-new");
    mockApplyLatestSessionConfig.mockResolvedValue({ applied: true });
  });

  describe("updateSessionTitle", () => {
    it("renames in backend before patching local state", async () => {
      seedSession({ userSetName: false });
      mockRenameSession.mockResolvedValue(undefined);

      await updateSessionTitle("session-1", "Manual Title");

      expect(mockRenameSession).toHaveBeenCalledWith(
        "session-1",
        "Manual Title",
      );
      expect(
        useChatSessionStore.getState().getSession("session-1"),
      ).toMatchObject({
        title: "Manual Title",
        userSetName: true,
      });
    });

    it("does not patch local state when backend rename fails", async () => {
      seedSession({ userSetName: false });
      mockRenameSession.mockRejectedValue(new Error("rename failed"));

      await expect(
        updateSessionTitle("session-1", "Manual Title"),
      ).rejects.toThrow("rename failed");

      expect(
        useChatSessionStore.getState().getSession("session-1"),
      ).toMatchObject({
        title: "Original Title",
        userSetName: false,
      });
    });
  });

  describe("updateSessionProject", () => {
    it("updates project in backend before patching local state", async () => {
      seedSession({ projectId: "project-old" });
      mockUpdateSessionProject.mockResolvedValue(undefined);

      await updateSessionProject("session-1", "project-new");

      expect(mockUpdateSessionProject).toHaveBeenCalledWith(
        "session-1",
        "project-new",
      );
      expect(
        useChatSessionStore.getState().getSession("session-1")?.projectId,
      ).toBe("project-new");
    });

    it("does not patch local state when backend project update fails", async () => {
      seedSession({ projectId: "project-old" });
      mockUpdateSessionProject.mockRejectedValue(new Error("project failed"));

      await expect(
        updateSessionProject("session-1", "project-new"),
      ).rejects.toThrow("project failed");

      expect(
        useChatSessionStore.getState().getSession("session-1")?.projectId,
      ).toBe("project-old");
    });
  });

  describe("moveSessionToProject", () => {
    it("ignores moves for missing sessions", async () => {
      await expect(
        moveSessionToProject("missing-session", "project-new"),
      ).resolves.toBeUndefined();

      expect(mockUpdateSessionProject).not.toHaveBeenCalled();
      expect(mockResolveSessionCwd).not.toHaveBeenCalled();
      expect(mockApplyLatestSessionConfig).not.toHaveBeenCalled();
    });

    it("persists project, applies cwd config, and patches local state", async () => {
      seedSession({
        projectId: null,
        providerId: "openai",
        modelId: "gpt-5.4",
        workingDir: "/tmp/old",
      });
      useProjectStore.setState({ projects: [buildProject()] });
      mockUpdateSessionProject.mockResolvedValue(undefined);

      await moveSessionToProject("session-1", "project-new", {
        activeWorkspacePath: "/tmp/worktree",
      });

      expect(mockUpdateSessionProject).toHaveBeenCalledWith(
        "session-1",
        "project-new",
      );
      expect(mockResolveSessionCwd).toHaveBeenCalledWith(
        expect.objectContaining({ id: "project-new" }),
        "/tmp/worktree",
      );
      expect(mockApplyLatestSessionConfig).toHaveBeenCalledWith({
        sessionId: "session-1",
        providerId: "openai",
        workingDir: "/tmp/project-new",
        modelId: "gpt-5.4",
      });
      expect(
        useChatSessionStore.getState().getSession("session-1"),
      ).toMatchObject({
        projectId: "project-new",
        workingDir: "/tmp/project-new",
      });
    });

    it("does not patch local state when project persistence fails", async () => {
      seedSession({ projectId: "project-old", workingDir: "/tmp/old" });
      mockUpdateSessionProject.mockRejectedValue(new Error("project failed"));

      await expect(
        moveSessionToProject("session-1", "project-new"),
      ).rejects.toThrow("project failed");

      expect(mockResolveSessionCwd).not.toHaveBeenCalled();
      expect(mockApplyLatestSessionConfig).not.toHaveBeenCalled();
      expect(
        useChatSessionStore.getState().getSession("session-1"),
      ).toMatchObject({
        projectId: "project-old",
        workingDir: "/tmp/old",
      });
    });

    it("stops when a session disappears after project persistence", async () => {
      seedSession({ projectId: "project-old", workingDir: "/tmp/old" });
      mockUpdateSessionProject.mockImplementationOnce(async () => {
        useChatSessionStore.setState({ sessions: [] });
      });

      await expect(
        moveSessionToProject("session-1", "project-new"),
      ).resolves.toBeUndefined();

      expect(mockUpdateSessionProject).toHaveBeenCalledWith(
        "session-1",
        "project-new",
      );
      expect(mockResolveSessionCwd).not.toHaveBeenCalled();
      expect(mockApplyLatestSessionConfig).not.toHaveBeenCalled();
    });

    it("moves a session back to no project", async () => {
      seedSession({ projectId: "project-old", providerId: "goose" });
      mockUpdateSessionProject.mockResolvedValue(undefined);
      mockResolveSessionCwd.mockResolvedValue("/Users/test");

      await moveSessionToProject("session-1", null);

      expect(mockUpdateSessionProject).toHaveBeenCalledWith("session-1", null);
      expect(mockResolveSessionCwd).toHaveBeenCalledWith(null, undefined);
      expect(
        useChatSessionStore.getState().getSession("session-1"),
      ).toMatchObject({
        projectId: null,
        workingDir: "/Users/test",
      });
    });

    it("patches project but preserves working directory when config is superseded", async () => {
      seedSession({ projectId: "project-old", workingDir: "/tmp/old" });
      mockUpdateSessionProject.mockResolvedValue(undefined);
      mockApplyLatestSessionConfig.mockResolvedValue({ applied: false });

      await moveSessionToProject("session-1", "project-new");

      expect(
        useChatSessionStore.getState().getSession("session-1"),
      ).toMatchObject({
        projectId: "project-new",
        workingDir: "/tmp/old",
      });
    });

    it("ignores an older project move that resolves after a newer move", async () => {
      seedSession({ projectId: "project-old", workingDir: "/tmp/old" });
      const olderMove = deferred();
      const newerMove = deferred();
      mockUpdateSessionProject
        .mockReturnValueOnce(olderMove.promise)
        .mockReturnValueOnce(newerMove.promise);

      const olderMoveResult = moveSessionToProject("session-1", "project-a");
      const newerMoveResult = moveSessionToProject("session-1", "project-b");

      newerMove.resolve();
      await newerMoveResult;

      expect(
        useChatSessionStore.getState().getSession("session-1"),
      ).toMatchObject({
        projectId: "project-b",
        workingDir: "/tmp/project-new",
      });

      olderMove.resolve();
      await olderMoveResult;

      expect(
        useChatSessionStore.getState().getSession("session-1"),
      ).toMatchObject({
        projectId: "project-b",
        workingDir: "/tmp/project-new",
      });
    });

    it("applies a pending model intent when moving project", async () => {
      seedSession({
        projectId: "project-old",
        providerId: "openai",
        modelId: "gpt-5.3",
        modelName: "GPT 5.3",
        workingDir: "/tmp/old",
      });
      mockUpdateSessionProject.mockResolvedValue(undefined);
      useChatSessionStore.getState().beginModelSelectionIntent("session-1", {
        requestId: "request-1",
        kind: "model",
        providerId: "openai",
        modelId: "gpt-5.4",
        modelName: "GPT 5.4",
      });

      await moveSessionToProject("session-1", "project-new");

      expect(mockApplyLatestSessionConfig).toHaveBeenCalledWith({
        sessionId: "session-1",
        providerId: "openai",
        workingDir: "/tmp/project-new",
        modelId: "gpt-5.4",
      });
      expect(
        useChatSessionStore.getState().getSession("session-1"),
      ).toMatchObject({
        projectId: "project-new",
        workingDir: "/tmp/project-new",
        modelId: "gpt-5.4",
        modelName: "GPT 5.4",
      });
    });

    it("skips config when model intent changes during project move", async () => {
      seedSession({
        projectId: "project-old",
        providerId: "openai",
        modelId: "gpt-5.3",
        modelName: "GPT 5.3",
        workingDir: "/tmp/old",
      });
      mockUpdateSessionProject.mockResolvedValue(undefined);
      mockResolveSessionCwd.mockImplementationOnce(async () => {
        useChatSessionStore.getState().beginModelSelectionIntent("session-1", {
          requestId: "request-1",
          kind: "model",
          providerId: "openai",
          modelId: "gpt-5.4",
          modelName: "GPT 5.4",
        });
        return "/tmp/project-new";
      });

      await moveSessionToProject("session-1", "project-new");

      expect(mockApplyLatestSessionConfig).not.toHaveBeenCalled();
      expect(
        useChatSessionStore.getState().getSession("session-1"),
      ).toMatchObject({
        projectId: "project-new",
        workingDir: "/tmp/old",
        modelId: "gpt-5.3",
        modelName: "GPT 5.3",
      });
    });
  });
});

import { beforeEach, describe, expect, it, vi } from "vitest";
import { useChatSessionStore, type ChatSession } from "../chatSessionStore";
import {
  moveSessionToProject,
  updateSessionProject,
  updateSessionTitle,
} from "../chatSessionOperations";

const mockRenameSession = vi.fn();
const mockUpdateSessionProject = vi.fn();

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

function resetStore() {
  useChatSessionStore.setState({
    sessions: [],
    activeSessionId: null,
    isLoading: false,
    hasHydratedSessions: false,
    activeWorkspaceBySession: {},
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

describe("chatSessionOperations", () => {
  beforeEach(() => {
    resetStore();
    vi.clearAllMocks();
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
    });

    it("persists project association without changing chat cwd or workspaces", async () => {
      const workspaceAttachments = [
        {
          id: "path:/tmp/old",
          path: "/tmp/old",
          kind: "git-main-worktree" as const,
          source: "selected" as const,
          branch: "main",
          usedByAgent: false,
        },
        {
          id: "path:/tmp/other",
          path: "/tmp/other",
          kind: "subdirectory" as const,
          source: "selected" as const,
          branch: "feature",
          repositoryPath: "/tmp/repo",
          worktreePath: "/tmp/repo-worktrees/feature",
          usedByAgent: true,
        },
      ];
      seedSession({
        projectId: null,
        executionTarget: {
          harnessId: "goose",
          modelProviderId: "openai",
          modelId: "gpt-5.4",
          modelName: "GPT 5.4",
        },
        workingDir: "/tmp/old",
        workspaceAttachments,
        activeWorkspaceId: "path:/tmp/other",
      });
      mockUpdateSessionProject.mockResolvedValue(undefined);

      await moveSessionToProject("session-1", "project-new");

      expect(mockUpdateSessionProject).toHaveBeenCalledWith(
        "session-1",
        "project-new",
      );
      expect(
        useChatSessionStore.getState().getSession("session-1"),
      ).toMatchObject({
        projectId: "project-new",
        executionTarget: {
          harnessId: "goose",
          modelProviderId: "openai",
          modelId: "gpt-5.4",
          modelName: "GPT 5.4",
        },
        workingDir: "/tmp/old",
        workspaceAttachments,
        activeWorkspaceId: "path:/tmp/other",
      });
    });

    it("does not patch local state when project persistence fails", async () => {
      seedSession({ projectId: "project-old", workingDir: "/tmp/old" });
      mockUpdateSessionProject.mockRejectedValue(new Error("project failed"));

      await expect(
        moveSessionToProject("session-1", "project-new"),
      ).rejects.toThrow("project failed");

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
    });

    it("moves a session back to no project", async () => {
      seedSession({
        projectId: "project-old",
        executionTarget: { harnessId: "goose" },
        workingDir: "/tmp/current",
      });
      mockUpdateSessionProject.mockResolvedValue(undefined);

      await moveSessionToProject("session-1", null);

      expect(mockUpdateSessionProject).toHaveBeenCalledWith("session-1", null);
      expect(
        useChatSessionStore.getState().getSession("session-1"),
      ).toMatchObject({
        projectId: null,
        workingDir: "/tmp/current",
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
        workingDir: "/tmp/old",
      });

      olderMove.resolve();
      await olderMoveResult;

      expect(
        useChatSessionStore.getState().getSession("session-1"),
      ).toMatchObject({
        projectId: "project-b",
        workingDir: "/tmp/old",
      });
    });
  });
});

import { beforeEach, describe, expect, it, vi } from "vitest";
import { ensureReplayBuffer } from "@/features/chat/hooks/replayBuffer";
import { loadSessionMessages } from "@/features/chat/lib/sessionActivation";
import { DEFAULT_CHAT_TITLE } from "@/features/chat/lib/sessionTitle";
import { MULTI_WORKSPACE_EXPERIMENT_ID } from "@/features/experiments/experimentDefinitions";
import { setExperimentEnabled } from "@/features/experiments/experimentPreferences";
import { useChatStore } from "@/features/chat/stores/chatStore";
import {
  type ChatSession,
  useChatSessionStore,
} from "@/features/chat/stores/chatSessionStore";
import type { ProjectInfo } from "@/features/projects/api/projects";
import { useProjectStore } from "@/features/projects/stores/projectStore";
import {
  createUserMessage,
  type Message,
  type SystemNotificationContent,
} from "@/shared/types/messages";

const acpGetSessionInfo = vi.hoisted(() => vi.fn());
const acpLoadSession = vi.hoisted(() => vi.fn());
const resolvePath = vi.hoisted(() => vi.fn());
const checkDirectoriesExist = vi.hoisted(() => vi.fn());

vi.mock("@/shared/api/acp", () => ({
  acpGetSessionInfo: (...args: unknown[]) => acpGetSessionInfo(...args),
  acpLoadSession: (...args: unknown[]) => acpLoadSession(...args),
}));

vi.mock("@/shared/api/pathResolver", () => ({
  resolvePath: (...args: unknown[]) => resolvePath(...args),
  checkDirectoriesExist: (...args: unknown[]) => checkDirectoriesExist(...args),
}));

vi.mock("@/features/chat/acp/acpNotificationHandler", () => ({
  getReplayPerf: () => undefined,
  clearReplayPerf: vi.fn(),
}));

function makeProject(overrides: Partial<ProjectInfo> = {}): ProjectInfo {
  return {
    id: "project-1",
    path: "/projects/project-1",
    name: "Project",
    description: "",
    prompt: "",
    icon: "",
    color: "",
    projectWorkspaces: [],
    workingDirs: ["/missing/project"],
    useWorktrees: false,
    order: 0,
    archivedAt: null,
    ...overrides,
  };
}

function replayUserMessage(id = "m1"): Message {
  return { ...createUserMessage("hello"), id };
}

interface SeedOptions {
  project?: ProjectInfo;
  workspacePath?: string;
  missingDir?: string;
  replay?: boolean;
}

function seedSession(
  overrides: Partial<ChatSession>,
  { project, workspacePath, missingDir, replay = true }: SeedOptions = {},
): ChatSession {
  const session: ChatSession = {
    id: "s1",
    title: DEFAULT_CHAT_TITLE,
    projectId: project?.id ?? null,
    providerId: "goose",
    workingDir: null,
    createdAt: "2026-06-09T00:00:00.000Z",
    updatedAt: "2026-06-09T00:00:00.000Z",
    messageCount: 1,
    ...overrides,
  };
  useChatSessionStore.setState({
    sessions: [session],
    ...(workspacePath
      ? {
          activeWorkspaceBySession: {
            [session.id]: { path: workspacePath, branch: null },
          },
        }
      : {}),
  });
  if (project) {
    useProjectStore.setState({ projects: [project] });
  }
  if (replay) {
    ensureReplayBuffer(session.id).push(replayUserMessage());
  }
  if (missingDir) {
    checkDirectoriesExist.mockResolvedValue([missingDir]);
  }
  return session;
}

function messagesFor(sessionId: string): Message[] {
  return useChatStore.getState().messagesBySession[sessionId] ?? [];
}

function notificationFromLastMessage(
  sessionId: string,
): SystemNotificationContent {
  const last = messagesFor(sessionId).at(-1);
  expect(last?.role).toBe("system");
  const notification = last?.content[0];
  expect(notification?.type).toBe("systemNotification");
  return notification as SystemNotificationContent;
}

describe("loadSessionMessages", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.localStorage.clear();
    acpGetSessionInfo.mockResolvedValue(null);
    acpLoadSession.mockResolvedValue(undefined);
    resolvePath.mockImplementation(({ parts }: { parts: string[] }) =>
      Promise.resolve({ path: `/resolved${parts[0]}` }),
    );
    checkDirectoriesExist.mockResolvedValue([]);
    useChatStore.setState({
      messagesBySession: {},
      sessionStateById: {},
      loadingSessionIds: new Set(),
    });
    useChatSessionStore.setState({
      sessions: [],
      activeWorkspaceBySession: {},
    });
    useProjectStore.setState({ projects: [] });
  });

  it("loads with the saved cwd and no warning when the directory exists", async () => {
    seedSession({ id: "s0", workingDir: "/existing/session" });

    await expect(loadSessionMessages("s0")).resolves.toBe(true);

    expect(checkDirectoriesExist).toHaveBeenCalledWith([
      "/resolved/existing/session",
    ]);
    expect(acpLoadSession).toHaveBeenCalledWith(
      "s0",
      "/resolved/existing/session",
    );
    expect(useChatSessionStore.getState().getSession("s0")?.workingDir).toBe(
      "/existing/session",
    );
    expect(messagesFor("s0").map((m) => m.role)).toEqual(["user"]);
  });

  it("loads a session without a stored session record", async () => {
    await expect(loadSessionMessages("unknown-session")).resolves.toBe(true);

    expect(checkDirectoriesExist).not.toHaveBeenCalled();
    expect(acpLoadSession).toHaveBeenCalledWith(
      "unknown-session",
      "~/goose artifacts",
    );
  });

  it("skips ACP load while optimistic session creation is pending", async () => {
    seedSession(
      {
        id: "draft-session",
        creationState: "pending",
        messageCount: 0,
      },
      { replay: false },
    );
    useChatStore.getState().setSessionLoading("draft-session", true);

    await expect(loadSessionMessages("draft-session")).resolves.toBe(true);

    expect(acpLoadSession).not.toHaveBeenCalled();
    expect(resolvePath).not.toHaveBeenCalled();
    expect(checkDirectoriesExist).not.toHaveBeenCalled();
    expect(useChatStore.getState().loadingSessionIds.has("draft-session")).toBe(
      false,
    );
  });

  it("skips ACP load for a stale optimistic session id after promotion", async () => {
    seedSession(
      {
        id: "backend-session",
        clientSessionId: "draft-session",
        messageCount: 0,
      },
      { replay: false },
    );

    await expect(loadSessionMessages("draft-session")).resolves.toBe(true);

    expect(acpLoadSession).not.toHaveBeenCalled();
    expect(resolvePath).not.toHaveBeenCalled();
    expect(checkDirectoriesExist).not.toHaveBeenCalled();
  });

  it("missing project cwd loads with artifact fallback and appends an edit-project warning", async () => {
    seedSession(
      { id: "s1" },
      { project: makeProject(), missingDir: "/resolved/missing/project" },
    );

    await expect(loadSessionMessages("s1")).resolves.toBe(true);

    expect(acpLoadSession).toHaveBeenCalledWith("s1", "~/goose artifacts");
    expect(useChatStore.getState().loadingSessionIds.has("s1")).toBe(false);
    expect(useChatSessionStore.getState().getSession("s1")?.workingDir).toBe(
      "~/goose artifacts",
    );
    const warning = notificationFromLastMessage("s1");
    expect(warning.notificationType).toBe("warning");
    expect(warning.text).toContain("/resolved/missing/project");
    expect(warning.text).toContain("~/goose artifacts");
    expect(warning.action).toEqual({
      type: "editProject",
      projectId: "project-1",
    });
  });

  it("missing saved cwd loads with artifact fallback and appends a change-folder warning", async () => {
    seedSession(
      { id: "s2", workingDir: "/missing/session" },
      { missingDir: "/resolved/missing/session" },
    );

    await expect(loadSessionMessages("s2")).resolves.toBe(true);

    expect(acpLoadSession).toHaveBeenCalledWith("s2", "~/goose artifacts");
    expect(useChatSessionStore.getState().getSession("s2")?.workingDir).toBe(
      "~/goose artifacts",
    );
    const warning = notificationFromLastMessage("s2");
    expect(warning.notificationType).toBe("warning");
    expect(warning.text).toContain("/resolved/missing/session");
    expect(warning.action).toEqual({ type: "openContextPanel" });
  });

  it("checks the first non-blank project working dir, not just index 0", async () => {
    seedSession(
      { id: "s-blank" },
      {
        project: makeProject({ workingDirs: ["  ", "/missing/project"] }),
        missingDir: "/resolved/missing/project",
      },
    );

    await expect(loadSessionMessages("s-blank")).resolves.toBe(true);

    expect(checkDirectoriesExist).toHaveBeenCalledWith([
      "/resolved/missing/project",
    ]);
    expect(acpLoadSession).toHaveBeenCalledWith("s-blank", "~/goose artifacts");
    expect(notificationFromLastMessage("s-blank").action).toEqual({
      type: "editProject",
      projectId: "project-1",
    });
  });

  it("uses explicit chat workspace context when resolving the reload cwd", async () => {
    setExperimentEnabled(MULTI_WORKSPACE_EXPERIMENT_ID, true);
    seedSession(
      {
        id: "s-project-workspaces",
        workspaceAttachments: [
          {
            id: "path:/attached/workspace",
            path: "/attached/workspace",
            kind: "directory",
            source: "selected",
            branch: null,
            usedByAgent: false,
          },
          {
            id: "path:/second/attached/workspace",
            path: "/second/attached/workspace",
            kind: "directory",
            source: "selected",
            branch: null,
            usedByAgent: false,
          },
        ],
      },
      {
        project: makeProject({
          workingDirs: ["/project/root"],
          projectWorkspaces: [
            {
              id: "path:/project/root",
              path: "/project/root",
              kind: "directory",
              source: "selected",
              branch: null,
              usedByAgent: false,
              startupMode: "none",
            },
          ],
        }),
      },
    );

    await expect(loadSessionMessages("s-project-workspaces")).resolves.toBe(
      true,
    );

    expect(checkDirectoriesExist).toHaveBeenCalledWith([
      "/resolved/attached/workspace",
    ]);
    expect(acpLoadSession).toHaveBeenCalledWith(
      "s-project-workspaces",
      "/resolved/attached/workspace",
    );
  });

  it("missing workspace cwd falls back, warns, and clears the stale workspace entry", async () => {
    seedSession(
      { id: "s-ws", workingDir: "/saved/session" },
      {
        workspacePath: "/missing/worktree",
        missingDir: "/resolved/missing/worktree",
      },
    );

    await expect(loadSessionMessages("s-ws")).resolves.toBe(true);

    expect(checkDirectoriesExist).toHaveBeenCalledWith([
      "/resolved/missing/worktree",
    ]);
    expect(acpLoadSession).toHaveBeenCalledWith("s-ws", "~/goose artifacts");
    expect(
      useChatSessionStore.getState().activeWorkspaceBySession["s-ws"],
    ).toBeUndefined();
    expect(useChatSessionStore.getState().getSession("s-ws")?.workingDir).toBe(
      "~/goose artifacts",
    );
    const warning = notificationFromLastMessage("s-ws");
    expect(warning.text).toContain("/resolved/missing/worktree");
    expect(warning.action).toEqual({ type: "openContextPanel" });
  });

  it("skips the warning when the missing dir is the artifact root the fallback recreates", async () => {
    resolvePath.mockImplementation(({ parts }: { parts: string[] }) =>
      Promise.resolve({ path: parts[0] }),
    );
    seedSession(
      { id: "s-root", workingDir: "~/goose artifacts" },
      { missingDir: "~/goose artifacts" },
    );

    await expect(loadSessionMessages("s-root")).resolves.toBe(true);

    expect(acpLoadSession).toHaveBeenCalledWith("s-root", "~/goose artifacts");
    expect(
      useChatSessionStore.getState().getSession("s-root")?.workingDir,
    ).toBe("~/goose artifacts");
    expect(messagesFor("s-root").map((m) => m.role)).toEqual(["user"]);
  });

  it("refreshes pinned placeholder metadata before replaying messages", async () => {
    acpGetSessionInfo.mockResolvedValue({
      sessionId: "s-pinned",
      title: "Control Center MCP Hints",
      updatedAt: "2026-06-25T00:45:04.000Z",
      createdAt: "2026-06-19T03:43:17.000Z",
      lastMessageAt: "2026-06-19T06:59:21.000Z",
      archivedAt: null,
      userSetName: false,
      messageCount: 1143,
      subtitle: "Commented and resolved the GitHub review thread.",
      workingDir: "/Users/morganm/goose artifacts",
      projectId: "goose-internal",
      providerId: "goose",
      modelId: "claude-sonnet-4",
      personaId: null,
    });
    checkDirectoriesExist.mockImplementation((paths: string[]) =>
      Promise.resolve(
        paths.includes("/resolved/missing/session")
          ? ["/resolved/missing/session"]
          : [],
      ),
    );
    seedSession(
      {
        id: "s-pinned",
        title: DEFAULT_CHAT_TITLE,
        projectId: undefined,
        workingDir: "/missing/session",
        pinnedLoadState: "loading",
        updatedAt: "2026-06-25T00:49:00.000Z",
      },
      { replay: true },
    );

    await expect(loadSessionMessages("s-pinned")).resolves.toBe(true);

    expect(acpGetSessionInfo).toHaveBeenCalledWith("s-pinned");
    expect(acpLoadSession).toHaveBeenCalledWith(
      "s-pinned",
      "/resolved/Users/morganm/goose artifacts",
    );
    expect(useChatSessionStore.getState().getSession("s-pinned")).toMatchObject(
      {
        title: "Control Center MCP Hints",
        projectId: "goose-internal",
        workingDir: "/Users/morganm/goose artifacts",
        updatedAt: "2026-06-25T00:45:04.000Z",
        lastMessageAt: "2026-06-19T06:59:21.000Z",
        pinnedLoadState: undefined,
      },
    );
  });

  it("skips ACP load and cwd checks when the session already has messages", async () => {
    seedSession(
      { id: "s3", workingDir: "/missing/session" },
      { replay: false },
    );
    useChatStore.setState({
      messagesBySession: { s3: [replayUserMessage("m-existing")] },
    });

    await expect(loadSessionMessages("s3")).resolves.toBe(true);

    expect(acpLoadSession).not.toHaveBeenCalled();
    expect(resolvePath).not.toHaveBeenCalled();
    expect(checkDirectoriesExist).not.toHaveBeenCalled();
  });

  it("ACP load failure appends an error notification without parking the session in error state", async () => {
    acpLoadSession.mockRejectedValue(new Error("backend down"));
    seedSession(
      { id: "s4", workingDir: "/existing/session" },
      { replay: false },
    );

    await expect(loadSessionMessages("s4")).resolves.toBe(false);

    const runtime = useChatStore.getState().getSessionRuntime("s4");
    expect(runtime.error).toBeNull();
    expect(runtime.chatState).not.toBe("error");
    expect(useChatStore.getState().loadingSessionIds.has("s4")).toBe(false);
    const error = notificationFromLastMessage("s4");
    expect(error.notificationType).toBe("error");
    expect(error.text).toBe("backend down");
  });

  it("retries the load after a failure and replaces the error notification on success", async () => {
    acpLoadSession.mockRejectedValueOnce(new Error("backend down"));
    seedSession(
      { id: "s5", workingDir: "/existing/session" },
      { replay: false },
    );

    await expect(loadSessionMessages("s5")).resolves.toBe(false);
    expect(notificationFromLastMessage("s5").notificationType).toBe("error");

    ensureReplayBuffer("s5").push(replayUserMessage());

    await expect(loadSessionMessages("s5")).resolves.toBe(true);

    expect(acpLoadSession).toHaveBeenCalledTimes(2);
    expect(messagesFor("s5").map((m) => m.role)).toEqual(["user"]);
  });

  it("repeated failures replace the error notification instead of stacking duplicates", async () => {
    acpLoadSession.mockRejectedValue(new Error("backend down"));
    seedSession(
      { id: "s6", workingDir: "/existing/session" },
      { replay: false },
    );

    await expect(loadSessionMessages("s6")).resolves.toBe(false);
    await expect(loadSessionMessages("s6")).resolves.toBe(false);

    expect(messagesFor("s6").map((m) => m.role)).toEqual(["system"]);
  });
});

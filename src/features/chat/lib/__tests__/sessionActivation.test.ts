import { beforeEach, describe, expect, it, vi } from "vitest";
import { ensureReplayBuffer } from "@/features/chat/hooks/replayBuffer";
import {
  clearReplayAssistantTracking,
  ensureReplayAssistantMessage,
} from "@/features/chat/acp/acpReplayAssistant";
import { handleSessionInfoUpdate } from "@/features/chat/acp/acpSessionInfoUpdate";
import {
  clearIdleStreamingMessageAfterReplay,
  loadSessionMessages,
  loadSessionMessagesAndPrepare,
} from "@/features/chat/lib/sessionActivation";
import { DEFAULT_CHAT_TITLE } from "@/features/chat/lib/sessionTitle";
import { setMultiWorkspaceEnabled } from "@/features/workspaces/multiWorkspacePreference";
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
import type { AcpSessionInfo } from "@/shared/api/acp";
import {
  acquireSessionDispatchTarget,
  resetSessionTargetCoordinatorsForTests,
} from "@/features/chat/lib/sessionTargetCoordinator";

const acpGetSessionInfo = vi.hoisted(() => vi.fn());
const acpLoadSession = vi.hoisted(() => vi.fn());
const acpPrepareSession = vi.hoisted(() => vi.fn());
const resolvePath = vi.hoisted(() => vi.fn());
const checkDirectoriesExist = vi.hoisted(() => vi.fn());
const ensureRemoteHostConnected = vi.hoisted(() => vi.fn());

vi.mock("@/shared/api/acp", () => ({
  acpGetSessionInfo: (...args: unknown[]) => acpGetSessionInfo(...args),
  acpLoadSession: (...args: unknown[]) => acpLoadSession(...args),
  acpPrepareSession: (...args: unknown[]) => acpPrepareSession(...args),
}));

vi.mock("@/shared/api/pathResolver", () => ({
  resolvePath: (...args: unknown[]) => resolvePath(...args),
  checkDirectoriesExist: (...args: unknown[]) => checkDirectoriesExist(...args),
}));

vi.mock("@/features/chat/acp/acpNotificationHandler", () => ({
  getReplayPerf: () => undefined,
  clearReplayPerf: vi.fn(),
}));

vi.mock("@/features/chat/lib/remoteSession", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/features/chat/lib/remoteSession")>();
  return {
    ...actual,
    ensureRemoteHostConnected: (...args: unknown[]) =>
      ensureRemoteHostConnected(...args),
  };
});

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
    executionTarget: { harnessId: "goose" },
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

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, reject, resolve };
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
    resetSessionTargetCoordinatorsForTests();
    clearReplayAssistantTracking();
    window.localStorage.clear();
    acpGetSessionInfo.mockResolvedValue(null);
    acpLoadSession.mockResolvedValue(undefined);
    acpPrepareSession.mockResolvedValue(undefined);
    ensureRemoteHostConnected.mockResolvedValue(undefined);
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

  it("uses the leased target when ACP load returns a divergent target", async () => {
    const targetA = {
      harnessId: "goose",
      modelProviderId: "openai",
      modelId: "a",
      modelName: "a",
    } as const;
    const targetB = {
      harnessId: "goose",
      modelProviderId: "openai",
      modelId: "b",
      modelName: "b",
    } as const;
    seedSession({
      id: "leased-load",
      executionTarget: targetA,
      executionTargetSource: "acp",
    });
    acpLoadSession.mockResolvedValue({ providerId: "openai", modelId: "b" });
    const lease = acquireSessionDispatchTarget("leased-load");

    await expect(loadSessionMessages("leased-load")).resolves.toBe(true);

    expect(acpPrepareSession).not.toHaveBeenCalled();
    expect(
      useChatSessionStore.getState().getSession("leased-load")?.executionTarget,
    ).toEqual(targetA);
    lease.release?.();
    expect(
      useChatSessionStore.getState().getSession("leased-load")?.executionTarget,
    ).toEqual(targetB);
  });

  it("uses the leased target when pinned session info returns a divergent target", async () => {
    const targetA = {
      harnessId: "goose",
      modelProviderId: "openai",
      modelId: "a",
      modelName: "a",
    } as const;
    const targetB = {
      harnessId: "goose",
      modelProviderId: "openai",
      modelId: "b",
      modelName: "b",
    } as const;
    seedSession({
      id: "leased-info",
      executionTarget: targetA,
      executionTargetSource: "acp",
      pinnedLoadState: "loading",
    });
    acpGetSessionInfo.mockResolvedValue({
      providerId: "openai",
      modelId: "b",
      messageCount: 1,
    });
    const lease = acquireSessionDispatchTarget("leased-info");

    await expect(loadSessionMessages("leased-info")).resolves.toBe(true);

    expect(acpPrepareSession).not.toHaveBeenCalled();
    expect(
      useChatSessionStore.getState().getSession("leased-info")?.executionTarget,
    ).toEqual(targetA);
    lease.release?.();
    expect(
      useChatSessionStore.getState().getSession("leased-info")?.executionTarget,
    ).toEqual(targetB);
  });

  it.each([
    ["after replay", false],
    ["on the cached-message fast path", true],
  ])("clears an idle streaming pointer %s", async (_name, cached) => {
    seedSession({ id: "idle-replay" });
    if (cached) {
      useChatStore
        .getState()
        .setMessages("idle-replay", [replayUserMessage("cached-message")]);
    }
    useChatStore.getState().setStreamingMessageId("idle-replay", "assistant-1");

    await expect(loadSessionMessages("idle-replay")).resolves.toBe(true);

    expect(
      useChatStore.getState().getSessionRuntime("idle-replay")
        .streamingMessageId,
    ).toBeNull();
    expect(acpLoadSession).toHaveBeenCalledTimes(cached ? 0 : 1);
  });

  it.each([
    ["a live chat state", { chatState: "streaming" as const }],
    ["an active run", { activeRunId: "run-1" }],
    ["pending cancellation", { isRunCancellationPending: true }],
  ])("preserves a replay streaming pointer during %s", (_name, patch) => {
    const sessionId = `protected-${_name}`;
    useChatStore.setState({
      sessionStateById: {
        [sessionId]: {
          ...useChatStore.getState().getSessionRuntime(sessionId),
          streamingMessageId: "assistant-1",
          ...patch,
        },
      },
    });

    expect(clearIdleStreamingMessageAfterReplay(sessionId)).toBe(false);
    expect(
      useChatStore.getState().getSessionRuntime(sessionId).streamingMessageId,
    ).toBe("assistant-1");
  });

  it("preserves a populated transcript when a forced replay is invalid", async () => {
    seedSession(
      { id: "empty-forced-replay", messageCount: 2 },
      { replay: false },
    );
    useChatStore
      .getState()
      .setMessages("empty-forced-replay", [replayUserMessage("existing-1")]);
    ensureReplayBuffer("empty-forced-replay");

    await expect(
      loadSessionMessages("empty-forced-replay", { force: true }),
    ).resolves.toBe(false);

    expect(
      messagesFor("empty-forced-replay").map((message) => message.id),
    ).toEqual(["existing-1", "session-load-error:empty-forced-replay"]);
    expect(notificationFromLastMessage("empty-forced-replay")).toMatchObject({
      notificationType: "error",
      text: "Couldn't refresh this conversation. Your previous messages are still shown.",
    });
    expect(
      useChatSessionStore.getState().getSession("empty-forced-replay")
        ?.messageCount,
    ).toBe(2);
    expect(
      useChatStore.getState().loadingSessionIds.has("empty-forced-replay"),
    ).toBe(false);
  });

  it("reloads a voice reply without exposing its persisted TTS delivery notice", async () => {
    const session = seedSession(
      { id: "voice-replay", messageCount: 1 },
      { replay: false },
    );
    ensureReplayBuffer(session.id).push({
      ...createUserMessage(
        "[voice: tts-delivery-failed]\n" +
          "TTS delivery was interrupted because the user started speaking; the assistant reply was not fully spoken.\n" +
          "Original text: There was a bookshop where every book was blank.\n" +
          "This is TTS delivery state, not live user voice input. Do not respond to this control message or repeat the reply unless re-delivery is still appropriate.\n\n" +
          "Okay, that's perfect. Thank you",
      ),
      id: "persisted-voice-reply",
      metadata: {
        userVisible: true,
        agentVisible: true,
        origin: "voice_conversation",
      },
    });

    await expect(loadSessionMessages(session.id)).resolves.toBe(true);

    expect(messagesFor(session.id)).toHaveLength(1);
    expect(messagesFor(session.id)[0]).toMatchObject({
      id: "persisted-voice-reply",
      role: "user",
      content: [{ type: "text", text: "Okay, that's perfect. Thank you" }],
      metadata: { userVisible: true },
    });
    expect(
      messagesFor(session.id).some((message) =>
        message.content.some(
          (content) =>
            content.type === "text" &&
            content.text.includes("[voice: tts-delivery-failed]"),
        ),
      ),
    ).toBe(false);
  });

  it("rejects an empty cold replay when session metadata expects history", async () => {
    seedSession(
      { id: "cold-empty-replay", messageCount: 3 },
      { replay: false },
    );
    ensureReplayBuffer("cold-empty-replay");

    await expect(loadSessionMessages("cold-empty-replay")).resolves.toBe(false);

    expect(notificationFromLastMessage("cold-empty-replay")).toMatchObject({
      notificationType: "error",
    });
    expect(
      useChatSessionStore.getState().getSession("cold-empty-replay")
        ?.messageCount,
    ).toBe(3);
  });

  it("clears replay loading before publishing error-to-idle", async () => {
    seedSession({ id: "error-replay" });
    useChatStore.getState().setError("error-replay", "stale error");
    const observed: Array<{ loading: boolean; chatState: string }> = [];
    const unsubscribe = useChatStore.subscribe((state) => {
      observed.push({
        loading: state.loadingSessionIds.has("error-replay"),
        chatState: state.getSessionRuntime("error-replay").chatState,
      });
    });

    await expect(loadSessionMessages("error-replay")).resolves.toBe(true);
    unsubscribe();

    expect(
      observed.some(
        (snapshot) => snapshot.loading && snapshot.chatState === "idle",
      ),
    ).toBe(false);
  });

  it("completes the final replay assistant for a settled session", async () => {
    seedSession({ id: "settled-replay" }, { replay: false });
    ensureReplayAssistantMessage("settled-replay", "assistant-1").content.push({
      type: "text",
      text: "Finished answer",
    });
    acpLoadSession.mockImplementation(async () => {
      handleSessionInfoUpdate("settled-replay", {
        sessionUpdate: "session_info_update",
        _meta: { goose: { activeRunId: null } },
      } as never);
    });

    await expect(loadSessionMessages("settled-replay")).resolves.toBe(true);

    expect(messagesFor("settled-replay")[0]).toMatchObject({
      role: "assistant",
      metadata: { completionStatus: "completed" },
    });
  });

  it("completes a pinned settled replay assistant from refreshed session metadata", async () => {
    acpGetSessionInfo.mockResolvedValue({
      sessionId: "pinned-settled-replay",
      title: "Settled Replay",
      updatedAt: "2026-06-25T00:45:04.000Z",
      createdAt: "2026-06-25T00:40:00.000Z",
      lastMessageAt: "2026-06-25T00:45:04.000Z",
      archivedAt: null,
      userSetName: true,
      messageCount: 1,
      subtitle: null,
      workingDir: null,
      projectId: null,
      providerId: "goose",
      modelId: null,
      personaId: null,
      activeRunId: null,
    });
    seedSession(
      { id: "pinned-settled-replay", pinnedLoadState: "loading" },
      { replay: false },
    );
    ensureReplayAssistantMessage(
      "pinned-settled-replay",
      "assistant-1",
    ).content.push({
      type: "text",
      text: "Finished answer",
    });

    await expect(loadSessionMessages("pinned-settled-replay")).resolves.toBe(
      true,
    );

    expect(messagesFor("pinned-settled-replay")[0]).toMatchObject({
      role: "assistant",
      metadata: { completionStatus: "completed" },
    });
  });

  it("preserves a pinned replay assistant when refreshed run state is unknown", async () => {
    acpGetSessionInfo.mockResolvedValue({
      sessionId: "pinned-unknown-replay",
      title: "Unknown Replay",
      updatedAt: "2026-06-25T00:45:04.000Z",
      createdAt: "2026-06-25T00:40:00.000Z",
      lastMessageAt: "2026-06-25T00:45:04.000Z",
      archivedAt: null,
      userSetName: true,
      messageCount: 1,
      subtitle: null,
      workingDir: null,
      projectId: null,
      providerId: "goose",
      modelId: null,
      personaId: null,
    });
    seedSession(
      { id: "pinned-unknown-replay", pinnedLoadState: "loading" },
      { replay: false },
    );
    ensureReplayAssistantMessage(
      "pinned-unknown-replay",
      "assistant-1",
    ).content.push({ type: "text", text: "Maybe still working" });

    await expect(loadSessionMessages("pinned-unknown-replay")).resolves.toBe(
      true,
    );

    expect(messagesFor("pinned-unknown-replay")[0]).toMatchObject({
      role: "assistant",
      metadata: { completionStatus: "inProgress" },
    });
  });

  it("waits for an affirmative run boundary before completing replay", async () => {
    const sessionId = "active-replay";
    seedSession({ id: sessionId }, { replay: false });
    ensureReplayAssistantMessage(sessionId, "assistant-1").content.push({
      type: "text",
      text: "Still working",
    });

    await expect(loadSessionMessages(sessionId)).resolves.toBe(true);

    handleSessionInfoUpdate(sessionId, {
      sessionUpdate: "session_info_update",
      _meta: { goose: { activeRunId: "run-1" } },
    } as never);
    expect(messagesFor(sessionId)[0]).toMatchObject({
      role: "assistant",
      metadata: { completionStatus: "inProgress" },
    });

    handleSessionInfoUpdate(sessionId, {
      sessionUpdate: "session_info_update",
      _meta: { goose: { activeRunId: null } },
    } as never);
    expect(messagesFor(sessionId)[0]).toMatchObject({
      role: "assistant",
      metadata: { completionStatus: "completed" },
    });
  });

  it("waits for explicit run settlement before completing a replay assistant", async () => {
    seedSession({ id: "unknown-run-replay" }, { replay: false });
    ensureReplayAssistantMessage(
      "unknown-run-replay",
      "assistant-1",
    ).content.push({
      type: "text",
      text: "Still working after load",
    });

    await expect(loadSessionMessages("unknown-run-replay")).resolves.toBe(true);

    expect(messagesFor("unknown-run-replay")[0]).toMatchObject({
      role: "assistant",
      metadata: { completionStatus: "inProgress" },
    });

    handleSessionInfoUpdate("unknown-run-replay", {
      sessionUpdate: "session_info_update",
      _meta: { goose: { activeRunId: "run-1" } },
    } as never);

    expect(messagesFor("unknown-run-replay")[0]).toMatchObject({
      role: "assistant",
      metadata: { completionStatus: "inProgress" },
    });

    handleSessionInfoUpdate("unknown-run-replay", {
      sessionUpdate: "session_info_update",
      _meta: { goose: { activeRunId: null } },
    } as never);

    expect(messagesFor("unknown-run-replay")[0]).toMatchObject({
      role: "assistant",
      metadata: { completionStatus: "completed" },
    });
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

  it("reasserts a UI selection changed while cwd resolution delayed ACP load", async () => {
    const cwdCheck = deferred<string[]>();
    checkDirectoriesExist.mockReturnValueOnce(cwdCheck.promise);
    seedSession({
      id: "s-selection-race",
      executionTarget: {
        harnessId: "goose",
        modelProviderId: "databricks_v2",
        modelId: "goose-gpt-5-5",
        modelName: "GPT-5.5",
      },
      workingDir: "/existing/session",
    });

    const load = loadSessionMessagesAndPrepare("s-selection-race");
    await vi.waitFor(() => {
      expect(checkDirectoriesExist).toHaveBeenCalledTimes(1);
    });
    useChatSessionStore
      .getState()
      .replaceSessionExecutionTarget("s-selection-race", {
        harnessId: "goose",
        modelProviderId: "databricks_v2",
        modelId: "goose-gpt-5-6-sol",
        modelName: "GPT-5.6 Sol",
      });
    expect(acpLoadSession).not.toHaveBeenCalled();

    cwdCheck.resolve([]);
    await expect(load).resolves.toBe(true);

    expect(acpLoadSession).toHaveBeenCalledWith(
      "s-selection-race",
      "/resolved/existing/session",
    );
    expect(acpPrepareSession).toHaveBeenCalledWith(
      "s-selection-race",
      "databricks_v2",
      "/resolved/existing/session",
      { modelId: "goose-gpt-5-6-sol" },
    );
    expect(acpLoadSession.mock.invocationCallOrder[0]).toBeLessThan(
      acpPrepareSession.mock.invocationCallOrder[0],
    );
  });

  it("rejects missing replay when session history is unknown", async () => {
    await expect(loadSessionMessages("unknown-session")).resolves.toBe(false);

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
    setMultiWorkspaceEnabled(true);
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

  it("surfaces the missing-folder warning on activation when the transcript is cached", async () => {
    seedSession(
      { id: "s-cached", workingDir: "/missing/session" },
      { missingDir: "/resolved/missing/session", replay: false },
    );
    // A cached transcript makes loadSessionMessages skip the replay path.
    useChatStore.getState().addMessage("s-cached", replayUserMessage("m-old"));

    await expect(loadSessionMessagesAndPrepare("s-cached")).resolves.toBe(true);

    expect(acpLoadSession).not.toHaveBeenCalled();
    expect(
      useChatSessionStore.getState().getSession("s-cached")?.workingDir,
    ).toBe("~/goose artifacts");
    const warning = notificationFromLastMessage("s-cached");
    expect(warning.notificationType).toBe("warning");
    expect(warning.text).toContain("/resolved/missing/session");
    expect(warning.action).toEqual({ type: "openContextPanel" });
  });

  it("does not stack duplicate warnings across repeated activations", async () => {
    seedSession(
      { id: "s-repeat", workingDir: "/missing/session" },
      { missingDir: "/resolved/missing/session", replay: false },
    );
    useChatStore.getState().addMessage("s-repeat", replayUserMessage("m-old"));

    await expect(loadSessionMessagesAndPrepare("s-repeat")).resolves.toBe(true);
    await expect(loadSessionMessagesAndPrepare("s-repeat")).resolves.toBe(true);

    const warnings = messagesFor("s-repeat").filter(
      (message) => message.role === "system",
    );
    expect(warnings).toHaveLength(1);
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
        executionTarget: undefined,
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
        messageCount: 1143,
        pinnedLoadState: undefined,
      },
    );
  });

  it("rejects empty pinned replay when authoritative metadata refresh fails", async () => {
    acpGetSessionInfo.mockRejectedValue(new Error("metadata unavailable"));
    seedSession(
      {
        id: "s-pinned-unknown",
        messageCount: 0,
        pinnedLoadState: "loading",
      },
      { replay: false },
    );
    acpLoadSession.mockImplementation(async (sessionId: string) => {
      ensureReplayBuffer(sessionId);
    });

    await expect(loadSessionMessages("s-pinned-unknown")).resolves.toBe(false);
    await expect(loadSessionMessages("s-pinned-unknown")).resolves.toBe(false);

    expect(acpGetSessionInfo).toHaveBeenCalledTimes(2);
    expect(
      useChatSessionStore.getState().getSession("s-pinned-unknown")
        ?.pinnedLoadState,
    ).toBe("failed");
    expect(notificationFromLastMessage("s-pinned-unknown")).toMatchObject({
      notificationType: "error",
    });
  });

  it("keeps refreshed pinned history metadata across invalid replay retries", async () => {
    acpGetSessionInfo.mockResolvedValue({
      sessionId: "s-pinned-empty",
      title: "Existing session",
      updatedAt: "2026-06-25T00:45:04.000Z",
      createdAt: "2026-06-19T03:43:17.000Z",
      lastMessageAt: "2026-06-19T06:59:21.000Z",
      archivedAt: null,
      userSetName: false,
      messageCount: 9,
      subtitle: null,
      workingDir: null,
      projectId: null,
      providerId: "goose",
      modelId: "claude-sonnet-4",
      personaId: null,
    });
    seedSession(
      {
        id: "s-pinned-empty",
        messageCount: 0,
        pinnedLoadState: "loading",
      },
      { replay: false },
    );
    acpLoadSession.mockImplementation(async (sessionId: string) => {
      ensureReplayBuffer(sessionId);
    });

    await expect(loadSessionMessages("s-pinned-empty")).resolves.toBe(false);
    expect(
      useChatSessionStore.getState().getSession("s-pinned-empty")?.messageCount,
    ).toBe(9);

    await expect(loadSessionMessages("s-pinned-empty")).resolves.toBe(false);
    expect(acpGetSessionInfo).toHaveBeenCalledTimes(1);
    expect(
      useChatSessionStore.getState().getSession("s-pinned-empty")?.messageCount,
    ).toBe(9);
    expect(messagesFor("s-pinned-empty")).toHaveLength(1);
  });

  it("does not let pinned metadata replace a newer UI model selection", async () => {
    const metadata = deferred<AcpSessionInfo>();
    const selectedTarget = {
      harnessId: "goose",
      modelProviderId: "databricks_v2",
      modelId: "goose-gpt-5-6-sol",
      modelName: "GPT-5.6 Sol",
    } as const;
    acpGetSessionInfo.mockReturnValue(metadata.promise);
    seedSession({
      id: "s-pinned-race",
      executionTarget: undefined,
      pinnedLoadState: "loading",
    });

    const load = loadSessionMessages("s-pinned-race");
    useChatSessionStore
      .getState()
      .replaceSessionExecutionTarget("s-pinned-race", selectedTarget);
    metadata.resolve({
      sessionId: "s-pinned-race",
      title: "Pinned race",
      updatedAt: "2026-06-25T00:45:04.000Z",
      createdAt: "2026-06-25T00:40:00.000Z",
      lastMessageAt: null,
      archivedAt: null,
      userSetName: false,
      messageCount: 1,
      subtitle: null,
      workingDir: "/tmp/project",
      projectId: null,
      providerId: "databricks_v2",
      modelId: "goose-gpt-5-5",
      personaId: null,
    });

    await expect(load).resolves.toBe(true);

    expect(
      useChatSessionStore.getState().getSession("s-pinned-race")
        ?.executionTarget,
    ).toEqual(selectedTarget);
  });

  it("shares one replay load between concurrent callers", async () => {
    seedSession(
      { id: "s-concurrent", workingDir: "/existing/session" },
      { replay: false },
    );
    const replayLoad = deferred();
    acpLoadSession.mockReturnValueOnce(replayLoad.promise);

    const firstLoad = loadSessionMessages("s-concurrent");
    const secondLoad = loadSessionMessages("s-concurrent");

    await vi.waitFor(() => {
      expect(acpLoadSession).toHaveBeenCalledTimes(1);
    });
    expect(useChatStore.getState().loadingSessionIds.has("s-concurrent")).toBe(
      true,
    );

    ensureReplayBuffer("s-concurrent").push(replayUserMessage());
    replayLoad.resolve();

    await expect(Promise.all([firstLoad, secondLoad])).resolves.toEqual([
      true,
      true,
    ]);
    expect(acpLoadSession).toHaveBeenCalledTimes(1);
    expect(messagesFor("s-concurrent").map((message) => message.id)).toEqual([
      "m1",
    ]);
    expect(useChatStore.getState().loadingSessionIds.has("s-concurrent")).toBe(
      false,
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

  it("ACP load failure appends an error notification and clears settled replay state", async () => {
    acpLoadSession.mockRejectedValue(new Error("backend down"));
    seedSession(
      { id: "s4", workingDir: "/existing/session" },
      { replay: false },
    );
    useChatStore.getState().setStreamingMessageId("s4", "stale-assistant");

    await expect(loadSessionMessages("s4")).resolves.toBe(false);

    const runtime = useChatStore.getState().getSessionRuntime("s4");
    expect(runtime.error).toBeNull();
    expect(runtime.chatState).not.toBe("error");
    expect(runtime.streamingMessageId).toBeNull();
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

  describe("remote sessions", () => {
    it("passes the remote workingDir through verbatim and skips local checks", async () => {
      seedSession({
        id: "s-remote",
        remoteHost: "devbox",
        workingDir: "/remote/home/damien/project",
      });

      await expect(loadSessionMessages("s-remote")).resolves.toBe(true);

      expect(ensureRemoteHostConnected).toHaveBeenCalledWith("devbox");
      expect(acpLoadSession).toHaveBeenCalledWith(
        "s-remote",
        "/remote/home/damien/project",
      );
      expect(resolvePath).not.toHaveBeenCalled();
      expect(checkDirectoriesExist).not.toHaveBeenCalled();
    });

    it("does not connect a host for local sessions", async () => {
      seedSession({ id: "s-local", workingDir: "/existing/session" });

      await expect(loadSessionMessages("s-local")).resolves.toBe(true);

      expect(ensureRemoteHostConnected).not.toHaveBeenCalled();
    });

    it("surfaces a failed host connection as the standard load failure", async () => {
      ensureRemoteHostConnected.mockRejectedValue(
        new Error("ssh tunnel failed"),
      );
      seedSession(
        {
          id: "s-remote-down",
          remoteHost: "devbox",
          workingDir: "/remote/project",
        },
        { replay: false },
      );

      await expect(loadSessionMessages("s-remote-down")).resolves.toBe(false);

      expect(acpLoadSession).not.toHaveBeenCalled();
      const error = notificationFromLastMessage("s-remote-down");
      expect(error.notificationType).toBe("error");
      expect(error.text).toBe("ssh tunnel failed");
      expect(
        useChatStore.getState().loadingSessionIds.has("s-remote-down"),
      ).toBe(false);
    });
  });
});

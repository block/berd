import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  clearAppNavigationController,
  registerAppNavigationController,
} from "@/features/berdctl/bridge/appNavigationController";
import {
  ALL_TOOL_GROUPS,
  dispatchCommand,
  TOOL_GROUPS,
} from "@/features/berdctl/commands/registry";
import {
  CommandError,
  type AppCommand,
} from "@/features/berdctl/commands/types";
import { useAgentStore } from "@/features/agents/stores/agentStore";
import { DEFAULT_CHAT_TITLE } from "@/features/chat/lib/sessionTitle";
import { resetSessionTargetCoordinatorsForTests } from "@/features/chat/lib/sessionTargetCoordinator";
import {
  applyPendingSessionWorkspaceActivation,
  getPendingSessionWorkspaceActivation,
  queueSessionWorkspaceActivation,
} from "@/features/chat/lib/sessionWorkspaceActivation";
import {
  useChatSessionStore,
  type ChatSession,
} from "@/features/chat/stores/chatSessionStore";
import { useChatStore } from "@/features/chat/stores/chatStore";
import { useSessionWindowStore } from "@/features/chat/stores/sessionWindowStore";
import type { ProjectInfo } from "@/features/projects/api/projects";
import { DEFAULT_PROJECT_COLOR } from "@/features/projects/lib/projectDefaults";
import { DEFAULT_PROJECT_ICON } from "@/features/projects/lib/projectIcons";
import { useProjectStore } from "@/features/projects/stores/projectStore";
import { getModelProviders } from "@/features/providers/providerCatalog";
import { useProviderModelCacheStore } from "@/features/providers/stores/providerModelCacheStore";
import { setMultiWorkspaceEnabled } from "@/features/workspaces/multiWorkspacePreference";
import { resolveSkillPillTone } from "@/features/skills/lib/resolveSkillPillTone";
import { useVoiceConversationStore } from "@/features/voice-conversation/stores/voiceConversationStore";
import type { AcpSessionInfo, AcpSessionsPage } from "@/shared/api/acp";
import { createUserMessage, getTextContent } from "@/shared/types/messages";

const mocks = vi.hoisted(() => ({
  acpCreateSession: vi.fn(),
  acpDuplicateSession: vi.fn(),
  acpGetSessionInfo: vi.fn(),
  acpListSessionsPage: vi.fn(),
  acpPrepareSession: vi.fn(),
  acpSendMessage: vi.fn(),
  loadSessionMessages: vi.fn(),
  acpSteerMessage: vi.fn(),
  discoverAcpProviders: vi.fn(),
  runDoctor: vi.fn(),
  readinessFromReport: vi.fn(),
  lastSessionMessages: vi.fn(),
  updateSessionTitle: vi.fn(),
  moveSessionToProject: vi.fn(),
  listProjects: vi.fn(),
  createProject: vi.fn(),
  archiveProject: vi.fn(),
  updateProject: vi.fn(),
  resolveSessionCwd: vi.fn(),
  planProjectChatWorkspaces: vi.fn(),
  planProjectChatWorkspacesAsIs: vi.fn(),
  projectRequiresStartupWorkspaceName: vi.fn(),
  rollbackProjectChatWorkspacePlan: vi.fn(),
  resolvePath: vi.fn(),
  checkDirectoriesExist: vi.fn(),
  canonicalizeAuthorizedWorkspaceDirectory: vi.fn(),
  getGitState: vi.fn(),
  updateWorkingDir: vi.fn(),
  createPersona: vi.fn(),
  listPersonas: vi.fn(),
  createSkill: vi.fn(),
  listSkills: vi.fn(),
  getVoiceConversationStatus: vi.fn(),
}));

vi.mock("@/shared/api/acp", () => ({
  acpCreateSession: (...args: unknown[]) => mocks.acpCreateSession(...args),
  acpDuplicateSession: (...args: unknown[]) =>
    mocks.acpDuplicateSession(...args),
  acpGetSessionInfo: (...args: unknown[]) => mocks.acpGetSessionInfo(...args),
  acpListSessionsPage: (...args: unknown[]) =>
    mocks.acpListSessionsPage(...args),
  acpPrepareSession: (...args: unknown[]) => mocks.acpPrepareSession(...args),
  acpSendMessage: (...args: unknown[]) => {
    const result = mocks.acpSendMessage(...args);
    const options = args[2] as
      | {
          onPromptDispatching?: () => void;
          onPromptDispatched?: () => void;
        }
      | undefined;
    options?.onPromptDispatching?.();
    options?.onPromptDispatched?.();
    return result;
  },
  acpSteerMessage: (...args: unknown[]) => mocks.acpSteerMessage(...args),
  discoverAcpProviders: (...args: unknown[]) =>
    mocks.discoverAcpProviders(...args),
}));

vi.mock(
  "@/features/voice-conversation/api/voiceConversation",
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import("@/features/voice-conversation/api/voiceConversation")
      >();
    return {
      ...actual,
      getVoiceConversationStatus: (...args: unknown[]) =>
        mocks.getVoiceConversationStatus(...args),
    };
  },
);

vi.mock("@/features/chat/lib/sessionActivation", () => ({
  loadSessionMessages: (...args: unknown[]) =>
    mocks.loadSessionMessages(...args),
}));

vi.mock("@/shared/api/acpApi", () => ({
  archiveSession: vi.fn(),
  unarchiveSession: vi.fn(),
  renameSession: vi.fn().mockResolvedValue(undefined),
  updateSessionProject: vi.fn().mockResolvedValue(undefined),
  updateWorkingDir: (
    sessionId: string,
    path: string,
    beforeUpdate?: () => void,
  ) => {
    beforeUpdate?.();
    return mocks.updateWorkingDir(sessionId, path);
  },
}));

vi.mock("@/shared/api/git", () => ({
  getGitState: (...args: unknown[]) => mocks.getGitState(...args),
}));

vi.mock("@/shared/api/pathResolver", () => ({
  resolvePath: (...args: unknown[]) => mocks.resolvePath(...args),
  checkDirectoriesExist: (...args: unknown[]) =>
    mocks.checkDirectoriesExist(...args),
  canonicalizeAuthorizedWorkspaceDirectory: (...args: unknown[]) =>
    mocks.canonicalizeAuthorizedWorkspaceDirectory(...args),
}));

vi.mock("@/shared/api/sessionSearch", () => ({
  lastSessionMessages: (...args: unknown[]) =>
    mocks.lastSessionMessages(...args),
}));

vi.mock("@/shared/api/doctor", () => ({
  runDoctor: (...args: unknown[]) => mocks.runDoctor(...args),
}));

vi.mock("@/features/providers/hooks/useAgentProviderStatus", () => ({
  readinessFromReport: (...args: unknown[]) =>
    mocks.readinessFromReport(...args),
}));

vi.mock("@/features/chat/lib/sessionWindowCommands", () => ({
  releaseSession: vi.fn(),
}));

vi.mock("@/features/chat/stores/chatSessionOperations", () => ({
  updateSessionTitle: (...args: unknown[]) => mocks.updateSessionTitle(...args),
  moveSessionToProject: (...args: unknown[]) =>
    mocks.moveSessionToProject(...args),
}));

vi.mock("@/features/projects/api/projects", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/features/projects/api/projects")>();
  return {
    normalizeProjectWorkspaces: actual.normalizeProjectWorkspaces,
    projectWorkspaceFromDirectory: actual.projectWorkspaceFromDirectory,
    listProjects: (...args: unknown[]) => mocks.listProjects(...args),
    createProject: (...args: unknown[]) => mocks.createProject(...args),
    archiveProject: (...args: unknown[]) => mocks.archiveProject(...args),
    updateProject: (...args: unknown[]) => mocks.updateProject(...args),
    deleteProject: vi.fn(),
    reorderProjects: vi.fn(),
  };
});

vi.mock("@/features/projects/lib/sessionCwdSelection", () => ({
  resolveSessionCwd: (...args: unknown[]) => mocks.resolveSessionCwd(...args),
}));

vi.mock("@/features/projects/lib/projectChatWorkspaces", () => ({
  planProjectChatWorkspaces: (...args: unknown[]) =>
    mocks.planProjectChatWorkspaces(...args),
  planProjectChatWorkspacesAsIs: (...args: unknown[]) =>
    mocks.planProjectChatWorkspacesAsIs(...args),
  projectRequiresStartupWorkspaceName: (...args: unknown[]) =>
    mocks.projectRequiresStartupWorkspaceName(...args),
  rollbackProjectChatWorkspacePlan: (...args: unknown[]) =>
    mocks.rollbackProjectChatWorkspacePlan(...args),
}));

vi.mock("@/shared/api/agents", () => ({
  createPersona: (...args: unknown[]) => mocks.createPersona(...args),
  listPersonas: (...args: unknown[]) => mocks.listPersonas(...args),
}));

vi.mock("@/features/skills/api/skills", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/features/skills/api/skills")>();
  return {
    // Real predicate: the skills feature owns the id encoding.
    isProjectSkillId: actual.isProjectSkillId,
    createSkill: (...args: unknown[]) => mocks.createSkill(...args),
    listSkills: (...args: unknown[]) => mocks.listSkills(...args),
  };
});

const ctx = {};

const controller = {
  openSession: vi.fn(),
  archiveSession: vi.fn(),
  getAppContext: vi.fn(),
};

function makeSession(overrides: Partial<ChatSession> = {}): ChatSession {
  return {
    id: "session-1",
    title: "Test Session",
    createdAt: "2026-04-01T00:00:00.000Z",
    updatedAt: "2026-04-01T00:00:00.000Z",
    messageCount: 2,
    ...overrides,
  };
}

function makeAcpSession(
  overrides: Partial<AcpSessionInfo> = {},
): AcpSessionInfo {
  return {
    sessionId: "session-1",
    title: "Test Session",
    createdAt: "2026-04-01T00:00:00.000Z",
    updatedAt: "2026-04-01T00:00:00.000Z",
    lastMessageAt: null,
    archivedAt: null,
    userSetName: false,
    messageCount: 2,
    subtitle: null,
    workingDir: null,
    projectId: null,
    providerId: null,
    modelId: null,
    personaId: null,
    ...overrides,
  };
}

function mockSessionPages(...pages: AcpSessionsPage[]): void {
  mocks.acpListSessionsPage.mockReset();
  for (const page of pages) {
    mocks.acpListSessionsPage.mockResolvedValueOnce(page);
  }
  mocks.acpListSessionsPage.mockResolvedValue({
    sessions: [],
    nextCursor: null,
  });
}

function mockSessionFound(overrides: Partial<AcpSessionInfo> = {}): void {
  const session = makeAcpSession({ sessionId: "session-1", ...overrides });
  mocks.acpGetSessionInfo.mockResolvedValue(session);
  mockSessionPages({ sessions: [session], nextCursor: null });
}

function seedSessions(...sessions: ChatSession[]): void {
  useChatSessionStore.setState({ sessions, hasHydratedSessions: true });
}

function makeProject(overrides: Partial<ProjectInfo> = {}): ProjectInfo {
  return {
    id: "project-1",
    path: "/sources/project-1",
    name: "Project One",
    description: "A test project",
    prompt: "",
    icon: DEFAULT_PROJECT_ICON,
    color: DEFAULT_PROJECT_COLOR,
    projectWorkspaces: [],
    workingDirs: ["/projects/one"],
    useWorktrees: false,
    order: 0,
    archivedAt: null,
    ...overrides,
  };
}

/** Seed a fresh (non-stale) model cache entry so list/validate paths never
 *  reach the network; merges with the entries seeded in beforeEach. */
function seedModelCache(cacheKey: string, modelIds: string[]): void {
  useProviderModelCacheStore.setState((state) => {
    const providers = new Map(state.providers);
    providers.set(cacheKey, {
      providerId: cacheKey,
      models: modelIds.map((id) => ({ id, name: id })),
      fetchedAt: Date.now(),
    });
    return { providers };
  });
}

/** Fresh-but-empty cache entries for every catalog model provider, so goose
 *  aggregation never triggers a real refresh in tests. */
function emptyModelProviderCache(): Map<
  string,
  { providerId: string; models: never[]; fetchedAt: number }
> {
  return new Map(
    getModelProviders().map((provider) => [
      provider.id,
      { providerId: provider.id, models: [], fetchedAt: Date.now() },
    ]),
  );
}

async function expectCommandError(
  promise: Promise<unknown>,
  code: string,
): Promise<CommandError> {
  const error = await promise.then(
    () => {
      throw new Error(`expected rejection with code "${code}"`);
    },
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(CommandError);
  expect((error as CommandError).code).toBe(code);
  return error as CommandError;
}

beforeEach(() => {
  resetSessionTargetCoordinatorsForTests();
  localStorage.removeItem("goose:chat-workspace-metadata");
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
  });
  useChatStore.setState({
    messagesBySession: {},
    sessionStateById: {},
    queuedMessageBySession: {},
    draftsBySession: {},
    skillDraftsBySession: {},
    activeSessionId: null,
    isViewingActiveSession: false,
    isConnected: false,
    loadingSessionIds: new Set(),
    scrollTargetMessageBySession: {},
  });
  useSessionWindowStore.getState().setSnapshot([]);
  useProjectStore.setState({
    projects: [],
    loading: false,
    hasFetchedProjects: false,
  });
  useAgentStore.setState({ personas: [], agents: [], activeAgentId: null });
  useProviderModelCacheStore.setState({
    providers: emptyModelProviderCache(),
    refreshingProviderIds: new Set(),
  });
  useVoiceConversationStore.setState({
    status: {
      available: false,
      unavailableReason: null,
      lifecycle: "stopped",
      sessionId: null,
      ownerWindowLabel: null,
      microphoneMuted: false,
      revision: 0,
    },
    uiState: "off",
  });

  window.localStorage.clear();
  setMultiWorkspaceEnabled(true);
  vi.clearAllMocks();
  mocks.acpGetSessionInfo.mockReset();
  mocks.acpListSessionsPage.mockReset();
  mocks.resolveSessionCwd.mockResolvedValue("/resolved/cwd");
  mocks.projectRequiresStartupWorkspaceName.mockReturnValue(false);
  mocks.planProjectChatWorkspaces.mockResolvedValue(null);
  mocks.planProjectChatWorkspacesAsIs.mockReturnValue(null);
  mocks.rollbackProjectChatWorkspacePlan.mockResolvedValue(undefined);
  mocks.acpCreateSession.mockResolvedValue({ sessionId: "session-new" });
  mocks.acpGetSessionInfo.mockRejectedValue(
    Object.assign(new Error("Resource not found"), { code: -32002 }),
  );
  mocks.acpPrepareSession.mockResolvedValue(undefined);
  mocks.acpSendMessage.mockResolvedValue(undefined);
  mocks.loadSessionMessages.mockResolvedValue(true);
  mocks.acpSteerMessage.mockResolvedValue({
    runId: "run-steered",
    messageId: "steer-message",
  });
  mocks.discoverAcpProviders.mockResolvedValue([
    { id: "goose", label: "Goose (Default)" },
    { id: "claude-acp", label: "Claude Code" },
    { id: "codex-acp", label: "Codex" },
  ]);
  mocks.runDoctor.mockResolvedValue({ checks: [] });
  mocks.readinessFromReport.mockReturnValue(
    new Map([
      ["goose", "ready"],
      ["claude-acp", "ready"],
      ["codex-acp", "ready"],
    ]),
  );
  mocks.lastSessionMessages.mockResolvedValue([]);
  mocks.acpListSessionsPage.mockResolvedValue({
    sessions: [],
    nextCursor: null,
  });
  mocks.listProjects.mockResolvedValue([]);
  mocks.listPersonas.mockResolvedValue([]);
  mocks.listSkills.mockResolvedValue([]);
  mocks.getVoiceConversationStatus.mockResolvedValue({
    available: false,
    unavailableReason: null,
    lifecycle: "stopped",
    sessionId: null,
    ownerWindowLabel: null,
    microphoneMuted: false,
    revision: 0,
  });
  mocks.updateSessionTitle.mockResolvedValue(undefined);
  mocks.moveSessionToProject.mockResolvedValue(undefined);
  mocks.updateProject.mockImplementation(
    async (project: ProjectInfo, updates: Partial<ProjectInfo>) => ({
      ...project,
      ...updates,
    }),
  );
  mocks.resolvePath.mockImplementation(
    async ({ parts }: { parts: string[] }) => ({ path: parts[0] }),
  );
  mocks.checkDirectoriesExist.mockResolvedValue([]);
  mocks.getGitState.mockResolvedValue({
    isGitRepo: true,
    currentBranch: "main",
    dirtyFileCount: 0,
    incomingCommitCount: 0,
    worktrees: [],
    isWorktree: false,
    mainWorktreePath: null,
    localBranches: ["main"],
  });
  mocks.updateWorkingDir.mockImplementation(
    async (
      _sessionId: string,
      _workingDir: string,
      beforeUpdate?: () => void,
    ) => {
      beforeUpdate?.();
    },
  );

  controller.openSession.mockResolvedValue({ ok: true });
  controller.archiveSession.mockResolvedValue({ ok: true });
  controller.getAppContext.mockReturnValue({
    view: "home",
    activeSessionId: null,
    activeProjectId: null,
  });
  registerAppNavigationController(controller);
});

afterEach(() => {
  clearAppNavigationController();
});

describe("dispatchCommand", () => {
  it("rejects unknown tools with unknown_command", async () => {
    await expectCommandError(
      dispatchCommand("self_destruct", {}, ctx),
      "unknown_command",
    );
  });

  it("rejects unknown or missing actions with unknown_action", async () => {
    const missing = await expectCommandError(
      dispatchCommand("sessions", {}, ctx),
      "unknown_action",
    );
    expect(missing.message).toContain("create");
    await expectCommandError(
      dispatchCommand("sessions", { action: "self_destruct" }, ctx),
      "unknown_action",
    );
    // Explicit null arguments (possible from direct callers; the broker
    // rejects non-object args) carry no action either.
    await expectCommandError(
      dispatchCommand("projects", null, ctx),
      "unknown_action",
    );
  });

  it("rejects prototype-chain keys at both group and action level", async () => {
    // TOOL_GROUPS and the action maps are plain objects: these names resolve
    // to inherited members and must not bypass the unknown checks.
    for (const name of ["constructor", "__proto__", "toString"]) {
      await expectCommandError(
        dispatchCommand(name, { action: "list" }, ctx),
        "unknown_command",
      );
    }
    for (const action of ["constructor", "__proto__", "toString"]) {
      await expectCommandError(
        dispatchCommand("sessions", { action }, ctx),
        "unknown_action",
      );
    }
  });

  it("rejects args that fail the zod schema with invalid_args", async () => {
    const error = await expectCommandError(
      dispatchCommand(
        "sessions",
        { action: "rename", session_id: "session-1", title: "New", x: true },
        ctx,
      ),
      "invalid_args",
    );
    expect(error.message).toContain("x");
    expect(mocks.updateSessionTitle).not.toHaveBeenCalled();
  });

  it("rejects sibling-action keys with invalid_args naming the field", async () => {
    // The published per-action schemas say additionalProperties: false; the
    // strict parse must agree (e.g. list's `limit` on a get call).
    const error = await expectCommandError(
      dispatchCommand(
        "sessions",
        { action: "get", session_id: "session-1", limit: 5 },
        ctx,
      ),
      "invalid_args",
    );
    expect(error.message).toContain("limit");
  });

  it("rejects missing required args with invalid_args", async () => {
    const error = await expectCommandError(
      dispatchCommand("sessions", { action: "create" }, ctx),
      "invalid_args",
    );
    expect(error.message).toContain("prompt");
  });

  it("prefers the broker-resolved deadline from ctx over the static timeout", async () => {
    // A request timeout_ms override changes the broker deadline; dispatch
    // must honor the forwarded value instead of recomputing its own.
    const now = Date.now();
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(now);

    await expectCommandError(
      dispatchCommand(
        "sessions",
        { action: "create", prompt: "hi" },
        { deadlineMs: now + 1_000 },
      ),
      "timed_out",
    );
    expect(mocks.acpCreateSession).not.toHaveBeenCalled();
    nowSpy.mockRestore();
  });
});

describe("action schemas", () => {
  it("every action schema rejects unknown keys (derived from the registry)", () => {
    const validArgs: Record<string, Record<string, unknown>> = {
      "sessions.create": { prompt: "hi" },
      "sessions.send": { session_id: "s1", prompt: "hi" },
      "sessions.open": { session_id: "s1" },
      "sessions.list": {},
      "sessions.get": { session_id: "s1" },
      "sessions.rename": { session_id: "s1", title: "Title" },
      "sessions.move": { session_id: "s1", project_id: "p1" },
      "sessions.move_to_group": { session_id: "s1", group_id: "g1" },
      "sessions.clear_project": { session_id: "s1" },
      "folders.attach": { session_id: "s1", path: "/tmp/wt" },
      "folders.detach": { session_id: "s1", path: "/tmp/wt" },
      "folders.replace": {
        session_id: "s1",
        old_path: "/tmp/old",
        new_path: "/tmp/new",
      },
      "folders.set_cwd": { session_id: "s1", path: "/tmp/wt" },
      "folders.list": { session_id: "s1" },
      "sessions.fork": { session_id: "s1" },
      "sessions.archive": { session_id: "s1" },
      "projects.create": { name: "Project" },
      "projects.list": {},
      "projects.get": { project_id: "p1" },
      "projects.set_startup_mode": { project_id: "p1", mode: "worktree" },
      "projects.archive": { project_id: "p1" },
      "agents.create": { name: "Agent", system_prompt: "Be helpful" },
      "agents.list": {},
      "skills.create": { name: "Skill", description: "Does X", content: "#" },
      "skills.list": {},
      "skills.get": { skill_id: "global:/skills/x" },
      "feedback.open": { title: "Bug", description: "Details" },
      "feedback.submit": { title: "Bug", description: "Details" },
      "info.list_harnesses": {},
      "info.list_models": {},
      "info.get_context": {},
    };

    for (const [groupName, group] of Object.entries(TOOL_GROUPS)) {
      for (const [actionName, command] of Object.entries(group.actions)) {
        const key = `${groupName}.${actionName}`;
        const args = validArgs[key];
        // A missing fixture fails loudly instead of skipping coverage.
        expect(args, `missing valid-args fixture for ${key}`).toBeDefined();
        const schema = (command as AppCommand<unknown, unknown>).schema;
        expect(schema.safeParse(args).success, `${key} valid args`).toBe(true);
        expect(
          schema.safeParse({ ...args, unexpected: true }).success,
          `${key} unknown key`,
        ).toBe(false);
      }
    }
  });
});

describe("command safety metadata", () => {
  it("keeps mutations visible and limits destructive metadata to session archive", () => {
    for (const [groupName, group] of Object.entries(TOOL_GROUPS)) {
      for (const [actionName, command] of Object.entries(group.actions)) {
        const key = `${groupName}.${actionName}`;
        const metadata = command as AppCommand<unknown, unknown>;

        expect(metadata.destructive, `${key} destructive`).toBe(
          key === "sessions.archive",
        );
        expect(
          ["read", "create", "update", "archive"],
          `${key} effect`,
        ).toContain(metadata.effect);
        expect(
          ["none", "immediate", "discoverable"],
          `${key} visibility`,
        ).toContain(metadata.visibility);
        if (metadata.effect !== "read") {
          expect(metadata.visibility, `${key} mutation visibility`).not.toBe(
            "none",
          );
        }
      }
    }
  });
});

describe("sessions.create", () => {
  it("creates the session and leaves the accepted first prompt in the shared queue", async () => {
    seedModelCache("databricks_v2", ["model-9"]);
    mocks.listPersonas.mockResolvedValue([
      {
        id: "agent-7",
        displayName: "Reviewer",
        systemPrompt: "Review the work carefully.",
        isBuiltin: false,
        writable: true,
      },
    ]);
    // A foreground agent on another provider must not leak into the
    // background send's pending-assistant hint.
    useAgentStore.setState({
      agents: [
        {
          id: "fg-agent",
          name: "Foreground",
          provider: "claude-acp",
          model: "claude",
          connectionType: "acp",
          status: "online",
          isBuiltin: false,
          createdAt: "2026-04-01T00:00:00.000Z",
          updatedAt: "2026-04-01T00:00:00.000Z",
        },
      ],
      activeAgentId: "fg-agent",
    });

    const result = await dispatchCommand(
      "sessions",
      {
        action: "create",
        prompt: "what is 1+1",
        agent_id: "agent-7",
        model_id: "model-9",
        from: "the test orchestrator",
      },
      ctx,
    );

    expect(mocks.resolveSessionCwd).toHaveBeenCalledWith(null);
    expect(mocks.acpCreateSession).toHaveBeenCalledWith(
      "databricks_v2",
      "/resolved/cwd",
      {
        personaId: "agent-7",
        modelId: "model-9",
        projectId: undefined,
        deferProviderSetup: false,
      },
    );
    expect(result).toEqual({
      session_id: "session-new",
      title: DEFAULT_CHAT_TITLE,
      harness_id: "goose",
      send_status: "dispatched",
    });

    const queued =
      useChatStore.getState().queuedMessageBySession["session-new"];
    expect(queued?.[0]).toMatchObject({
      kind: "transport-ready",
      payload: {
        text: "what is 1+1",
        sendOptions: {
          userMessageMetadata: {
            origin: "berdctl_cross_session",
            berdSenderLabel: "the test orchestrator",
          },
          acpGooseMetadata: {
            origin: "berdctl_cross_session",
            berdSenderLabel: "the test orchestrator",
          },
        },
      },
    });
    expect(controller.openSession).not.toHaveBeenCalled();
  });

  it("rejects an unknown agent before creating the session", async () => {
    await expectCommandError(
      dispatchCommand(
        "sessions",
        { action: "create", prompt: "hi", agent_id: "missing-agent" },
        ctx,
      ),
      "agent_not_found",
    );

    expect(mocks.listPersonas).toHaveBeenCalledTimes(1);
    expect(mocks.acpCreateSession).not.toHaveBeenCalled();
    expect(mocks.acpSendMessage).not.toHaveBeenCalled();
  });

  it("passes the chosen harness through to session creation", async () => {
    await dispatchCommand(
      "sessions",
      { action: "create", prompt: "hi", harness_id: "codex-acp" },
      ctx,
    );

    expect(mocks.discoverAcpProviders).toHaveBeenCalledTimes(1);
    expect(mocks.acpCreateSession).toHaveBeenCalledWith(
      "codex-acp",
      "/resolved/cwd",
      {
        personaId: undefined,
        modelId: undefined,
        projectId: undefined,
        deferProviderSetup: false,
      },
    );
  });

  it("rejects an unknown harness with harness_not_found before creating", async () => {
    const error = await expectCommandError(
      dispatchCommand(
        "sessions",
        { action: "create", prompt: "hi", harness_id: "cursor" },
        ctx,
      ),
      "harness_not_found",
    );
    expect(error.message).toContain("codex-acp");
    expect(mocks.acpCreateSession).not.toHaveBeenCalled();
  });

  it("rejects a harness that is installed but not ready", async () => {
    mocks.readinessFromReport.mockReturnValue(
      new Map([["codex-acp", "not_installed"]]),
    );

    await expectCommandError(
      dispatchCommand(
        "sessions",
        { action: "create", prompt: "hi", harness_id: "codex-acp" },
        ctx,
      ),
      "harness_not_ready",
    );
    expect(mocks.acpCreateSession).not.toHaveBeenCalled();
  });

  it("resolves a goose model to its owning model provider", async () => {
    const modelProvider = getModelProviders()[0].id;
    seedModelCache(modelProvider, ["model-a"]);

    await dispatchCommand(
      "sessions",
      { action: "create", prompt: "hi", model_id: "model-a" },
      ctx,
    );

    // The session runs against the model's provider, like the in-app picker.
    expect(mocks.acpCreateSession).toHaveBeenCalledWith(
      modelProvider,
      "/resolved/cwd",
      expect.objectContaining({ modelId: "model-a" }),
    );

    await expectCommandError(
      dispatchCommand(
        "sessions",
        { action: "create", prompt: "hi", model_id: "nope" },
        ctx,
      ),
      "model_not_found",
    );
  });

  it("reports model_not_found when an explicit Goose model has no concrete provider", async () => {
    await expectCommandError(
      dispatchCommand(
        "sessions",
        {
          action: "create",
          prompt: "hi",
          harness_id: "goose",
          model_id: "unresolved-model",
        },
        ctx,
      ),
      "model_not_found",
    );
    expect(mocks.acpCreateSession).not.toHaveBeenCalled();
  });

  it("rejects a model the harness does not list with model_not_found", async () => {
    seedModelCache("codex-acp", ["gpt-6"]);

    await expectCommandError(
      dispatchCommand(
        "sessions",
        {
          action: "create",
          prompt: "hi",
          harness_id: "codex-acp",
          model_id: "nope",
        },
        ctx,
      ),
      "model_not_found",
    );
    expect(mocks.acpCreateSession).not.toHaveBeenCalled();

    // A listed model passes.
    await dispatchCommand(
      "sessions",
      {
        action: "create",
        prompt: "hi",
        harness_id: "codex-acp",
        model_id: "gpt-6",
      },
      ctx,
    );
    expect(mocks.acpCreateSession).toHaveBeenCalledWith(
      "codex-acp",
      "/resolved/cwd",
      expect.objectContaining({ modelId: "gpt-6" }),
    );
  });

  it("resolves the cwd from the project when project_id is given", async () => {
    const project = makeProject({ id: "project-1" });
    useProjectStore.setState({ projects: [project], hasFetchedProjects: true });
    mocks.listProjects.mockResolvedValue([project]);

    await dispatchCommand(
      "sessions",
      { action: "create", prompt: "hi", project_id: "project-1" },
      ctx,
    );

    expect(mocks.listProjects).toHaveBeenCalledTimes(1);
    expect(mocks.resolveSessionCwd).toHaveBeenCalledWith(
      expect.objectContaining({ id: "project-1" }),
    );
    expect(mocks.acpCreateSession).toHaveBeenCalledWith(
      "goose",
      "/resolved/cwd",
      expect.objectContaining({ projectId: "project-1" }),
    );
  });

  it("requires startup_name for a project with branch/worktree startup", async () => {
    const project = makeProject({ id: "project-1" });
    useProjectStore.setState({ projects: [project], hasFetchedProjects: true });
    mocks.listProjects.mockResolvedValue([project]);
    mocks.projectRequiresStartupWorkspaceName.mockReturnValue(true);

    await expectCommandError(
      dispatchCommand(
        "sessions",
        { action: "create", prompt: "hi", project_id: "project-1" },
        ctx,
      ),
      "workspace_name_required",
    );
    expect(mocks.planProjectChatWorkspaces).not.toHaveBeenCalled();
    expect(mocks.acpCreateSession).not.toHaveBeenCalled();
  });

  it("rejects startup_name when the project's startup mode is none", async () => {
    const project = makeProject({ id: "project-1" });
    useProjectStore.setState({ projects: [project], hasFetchedProjects: true });
    mocks.listProjects.mockResolvedValue([project]);

    await expectCommandError(
      dispatchCommand(
        "sessions",
        {
          action: "create",
          prompt: "hi",
          project_id: "project-1",
          startup_name: "unused",
        },
        ctx,
      ),
      "invalid_args",
    );
    expect(mocks.acpCreateSession).not.toHaveBeenCalled();
  });

  it("fetches projects when the store is empty and throws project_not_found for unknown ids", async () => {
    await expectCommandError(
      dispatchCommand(
        "sessions",
        { action: "create", prompt: "hi", project_id: "nope" },
        ctx,
      ),
      "project_not_found",
    );
    expect(mocks.listProjects).toHaveBeenCalledTimes(1);
    expect(mocks.acpCreateSession).not.toHaveBeenCalled();
  });

  it("does not create when validation stalls past the broker deadline", async () => {
    // findReadyHarnessOrThrow consults the doctor; stall it past the deadline.
    const start = Date.now();
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(start);
    mocks.runDoctor.mockImplementation(async () => {
      nowSpy.mockReturnValue(start + 901_000);
      return { checks: [] };
    });

    await expectCommandError(
      dispatchCommand(
        "sessions",
        { action: "create", prompt: "hi", harness_id: "codex-acp" },
        ctx,
      ),
      "timed_out",
    );
    expect(mocks.acpCreateSession).not.toHaveBeenCalled();
    nowSpy.mockRestore();
  });
});

describe("sessions.send", () => {
  it("prepares the target session, records provenance, sends in the background, and does not navigate", async () => {
    const project = makeProject({ id: "project-1" });
    mocks.listProjects.mockResolvedValue([project]);
    mocks.listPersonas.mockResolvedValue([
      {
        id: "agent-7",
        displayName: "Reviewer",
        systemPrompt: "Review the work carefully.",
        isBuiltin: false,
        writable: true,
      },
    ]);
    useChatSessionStore.setState({
      activeWorkspaceBySession: {
        "session-1": { path: "/workspace/target", branch: "main" },
      },
    });
    mockSessionFound({
      providerId: "codex-acp",
      modelId: "gpt-6",
      personaId: "agent-7",
      projectId: "project-1",
      workingDir: "/session/cwd",
    });
    useAgentStore.setState({
      agents: [
        {
          id: "fg-agent",
          name: "Foreground",
          provider: "claude-acp",
          model: "claude",
          connectionType: "acp",
          status: "online",
          isBuiltin: false,
          createdAt: "2026-04-01T00:00:00.000Z",
          updatedAt: "2026-04-01T00:00:00.000Z",
        },
      ],
      activeAgentId: "fg-agent",
    });

    const result = await dispatchCommand(
      "sessions",
      {
        action: "send",
        session_id: "session-1",
        prompt: "what changed in ci?",
      },
      ctx,
    );

    expect(result).toEqual({
      session_id: "session-1",
      send_status: "dispatched",
    });
    expect(mocks.resolveSessionCwd).toHaveBeenCalledWith(
      expect.objectContaining({ id: "project-1" }),
      "/workspace/target",
    );
    expect(mocks.loadSessionMessages).toHaveBeenCalledWith("session-1");
    expect(mocks.acpPrepareSession).toHaveBeenCalledWith(
      "session-1",
      "codex-acp",
      "/resolved/cwd",
      { modelId: "gpt-6" },
    );
    expect(controller.openSession).not.toHaveBeenCalled();

    const messages = useChatStore.getState().messagesBySession["session-1"];
    expect(messages).toHaveLength(1);
    expect(getTextContent(messages[0])).toBe("what changed in ci?");
    expect(messages[0]?.metadata).toMatchObject({
      origin: "berdctl_cross_session",
      targetPersonaId: "agent-7",
      targetPersonaName: "Reviewer",
    });
    expect(
      useChatStore.getState().getSessionRuntime("session-1")
        .pendingAssistantProviderId,
    ).toBe("codex-acp");
    await vi.waitFor(() => {
      expect(mocks.acpSendMessage).toHaveBeenCalledWith(
        "session-1",
        "what changed in ci?",
        expect.objectContaining({
          personaId: "agent-7",
          personaName: "Reviewer",
          systemPrompt: expect.stringContaining("Review the work carefully."),
          goose: { origin: "berdctl_cross_session" },
        }),
      );
    });
  });

  it("applies a pending cwd switch before preparing and dispatching", async () => {
    mockSessionFound({
      providerId: "codex-acp",
      workingDir: "/session/cwd",
    });
    queueSessionWorkspaceActivation({
      sessionId: "session-1",
      path: "/workspace/next",
      branch: "feature",
    });

    let releaseUpdate: (() => void) | undefined;
    mocks.updateWorkingDir.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          releaseUpdate = resolve;
        }),
    );

    const send = dispatchCommand(
      "sessions",
      {
        action: "send",
        session_id: "session-1",
        prompt: "continue there",
      },
      ctx,
    );

    await vi.waitFor(() => {
      expect(mocks.updateWorkingDir).toHaveBeenCalledWith(
        "session-1",
        "/workspace/next",
      );
    });
    expect(mocks.acpPrepareSession).not.toHaveBeenCalled();
    releaseUpdate?.();
    await send;

    expect(mocks.resolveSessionCwd).toHaveBeenCalledWith(
      null,
      "/workspace/next",
    );
    expect(mocks.acpPrepareSession).toHaveBeenCalledWith(
      "session-1",
      "codex-acp",
      "/resolved/cwd",
      {},
    );
    expect(getPendingSessionWorkspaceActivation("session-1")).toBeNull();
  });

  it("refreshes non-target session metadata during hydration without changing the attempt target", async () => {
    const refreshedProject = makeProject({ id: "project-refreshed" });
    mocks.listProjects.mockResolvedValue([refreshedProject]);
    mocks.listPersonas.mockResolvedValue([
      {
        id: "agent-refreshed",
        displayName: "Fresh Reviewer",
        systemPrompt: "Use refreshed instructions.",
        isBuiltin: false,
        writable: true,
      },
    ]);
    mockSessionFound({
      providerId: "old-provider",
      modelId: "old-model",
      workingDir: "/old/cwd",
    });
    mocks.loadSessionMessages.mockImplementationOnce(async () => {
      useChatSessionStore.getState().patchSession("session-1", {
        personaId: "agent-refreshed",
        projectId: "project-refreshed",
        workingDir: "/refreshed/cwd",
      });
      return true;
    });

    await dispatchCommand(
      "sessions",
      {
        action: "send",
        session_id: "session-1",
        prompt: "use current settings",
      },
      ctx,
    );

    expect(mocks.resolveSessionCwd).toHaveBeenCalledWith(
      expect.objectContaining({ id: "project-refreshed" }),
      "/refreshed/cwd",
    );
    expect(mocks.acpPrepareSession).toHaveBeenCalledWith(
      "session-1",
      "old-provider",
      "/resolved/cwd",
      { modelId: "old-model" },
    );
    await vi.waitFor(() => {
      expect(mocks.acpSendMessage).toHaveBeenCalledWith(
        "session-1",
        "use current settings",
        expect.objectContaining({
          personaId: "agent-refreshed",
          personaName: "Fresh Reviewer",
          systemPrompt: expect.stringContaining("Use refreshed instructions."),
        }),
      );
    });
  });

  it("commits hydrated history before injecting the background prompt", async () => {
    mockSessionFound({ providerId: "codex-acp" });
    mocks.loadSessionMessages.mockImplementationOnce(async (sessionId) => {
      useChatStore
        .getState()
        .setMessages(sessionId as string, [createUserMessage("older prompt")]);
      return true;
    });

    await dispatchCommand(
      "sessions",
      {
        action: "send",
        session_id: "session-1",
        prompt: "new monitor event",
      },
      ctx,
    );

    expect(
      useChatStore
        .getState()
        .messagesBySession["session-1"].map(getTextContent),
    ).toEqual(["older prompt", "new monitor event"]);
  });

  it("does not inject a prompt when history hydration fails", async () => {
    mockSessionFound({ providerId: "codex-acp" });
    mocks.loadSessionMessages.mockResolvedValueOnce(false);

    await expect(
      dispatchCommand(
        "sessions",
        {
          action: "send",
          session_id: "session-1",
          prompt: "what changed in ci?",
        },
        ctx,
      ),
    ).rejects.toThrow("Failed to load the target session before sending.");

    expect(mocks.acpPrepareSession).not.toHaveBeenCalled();
    expect(mocks.acpSendMessage).not.toHaveBeenCalled();
    expect(
      useChatStore.getState().messagesBySession["session-1"],
    ).toBeUndefined();
  });

  it("rejects startup_name after the first send is no longer available", async () => {
    mockSessionFound({ messageCount: 1 });

    await expectCommandError(
      dispatchCommand(
        "sessions",
        {
          action: "send",
          session_id: "session-1",
          prompt: "follow up",
          startup_name: "ignored-name",
        },
        ctx,
      ),
      "invalid_args",
    );

    expect(mocks.acpPrepareSession).not.toHaveBeenCalled();
    expect(mocks.acpSendMessage).not.toHaveBeenCalled();
  });

  it("rejects startup_name when an occupied first-send queue prevents workspace setup", async () => {
    mockSessionFound();
    useChatStore.getState().enqueueTransportReadyMessage("session-1", {
      persona: { kind: "inherit" },
      text: "already queued",
    });

    await expectCommandError(
      dispatchCommand(
        "sessions",
        {
          action: "send",
          session_id: "session-1",
          prompt: "follow up",
          startup_name: "ignored-name",
        },
        ctx,
      ),
      "invalid_args",
    );

    expect(
      useChatStore.getState().queuedMessageBySession["session-1"],
    ).toHaveLength(1);
  });

  it.each([
    { chatState: "streaming" as const, cancellationPending: false },
    { chatState: "idle" as const, cancellationPending: true },
  ])("refuses a target with chat=$chatState cancellation=$cancellationPending by default", async ({
    chatState,
    cancellationPending,
  }) => {
    mockSessionFound();
    useChatStore.getState().setChatState("session-1", chatState);
    useChatStore
      .getState()
      .setRunCancellationPending("session-1", cancellationPending);

    await expectCommandError(
      dispatchCommand(
        "sessions",
        {
          action: "send",
          session_id: "session-1",
          prompt: "follow up",
        },
        ctx,
      ),
      "target_session_running",
    );

    expect(mocks.acpPrepareSession).not.toHaveBeenCalled();
    expect(mocks.acpSendMessage).not.toHaveBeenCalled();
  });

  it("refuses pop-out target sessions even when steering or queueing is requested", async () => {
    for (const ifRunning of ["steer", "queue"] as const) {
      mockSessionFound();
      useSessionWindowStore
        .getState()
        .setSnapshot([{ sessionId: "session-1", windowLabel: "session" }]);

      await expectCommandError(
        dispatchCommand(
          "sessions",
          {
            action: "send",
            session_id: "session-1",
            prompt: "follow up",
            if_running: ifRunning,
          },
          ctx,
        ),
        "target_session_running",
      );
      useSessionWindowStore.getState().setSnapshot([]);
    }
  });

  it("refuses to steer a cancellation-pending target", async () => {
    mockSessionFound();
    useChatStore.getState().setActiveRunId("session-1", "run-1");
    useChatStore.getState().setRunCancellationPending("session-1", true);

    await expectCommandError(
      dispatchCommand(
        "sessions",
        {
          action: "send",
          session_id: "session-1",
          prompt: "make it shorter",
          if_running: "steer",
        },
        ctx,
      ),
      "target_session_running",
    );
    expect(mocks.acpSteerMessage).not.toHaveBeenCalled();
  });

  it("queues to a running session without loading its unavailable project", async () => {
    mockSessionFound({ projectId: "deleted-project" });
    useChatStore.getState().setChatState("session-1", "streaming");
    const result = await dispatchCommand(
      "sessions",
      {
        action: "send",
        session_id: "session-1",
        prompt: "queue despite missing project",
        if_running: "queue",
      },
      ctx,
    );

    expect(result).toEqual({ session_id: "session-1", send_status: "queued" });
    expect(mocks.listProjects).not.toHaveBeenCalled();
    expect(
      useChatStore.getState().queuedMessageBySession["session-1"]?.[0]?.payload
        .text,
    ).toBe("queue despite missing project");
  });

  it("queues exactly once if the target acquires a run before commit", async () => {
    let newerOwnerRuntime: unknown;
    mockSessionFound({ providerId: "codex-acp" });
    mocks.loadSessionMessages.mockImplementationOnce(async () => {
      return true;
    });
    mocks.acpSendMessage.mockImplementationOnce(() => {
      useChatStore.getState().setError("session-1", "newer owner error");
      useChatStore.getState().setChatState("session-1", "streaming");
      useChatStore
        .getState()
        .setPendingAssistantProvider("session-1", "newer-provider");
      useChatStore.getState().setActiveRunId("session-1", "racing-run");
      useChatStore.getState().setRunCancellationPending("session-1", true);
      newerOwnerRuntime = structuredClone(
        useChatStore.getState().getSessionRuntime("session-1"),
      );
      return Promise.resolve();
    });

    const result = await dispatchCommand(
      "sessions",
      {
        action: "send",
        session_id: "session-1",
        prompt: "preserve this prompt",
        if_running: "queue",
      },
      ctx,
    );

    expect(result).toEqual({ session_id: "session-1", send_status: "queued" });
    expect(
      useChatStore
        .getState()
        .queuedMessageBySession["session-1"]?.map(
          (record) => record.payload.text,
        ),
    ).toEqual(["preserve this prompt"]);
    expect(
      useChatStore.getState().messagesBySession["session-1"],
    ).toBeUndefined();
    expect(useChatStore.getState().getSessionRuntime("session-1")).toEqual(
      newerOwnerRuntime,
    );
  });

  it("queues behind a composer message that arrives before commit", async () => {
    mockSessionFound({ providerId: "codex-acp" });
    mocks.loadSessionMessages.mockImplementationOnce(async () => {
      return true;
    });
    mocks.acpSendMessage.mockImplementationOnce(() => {
      useChatStore.getState().enqueueTransportReadyMessage("session-1", {
        persona: { kind: "inherit" },
        text: "composer head",
      });
      return Promise.resolve();
    });

    const result = await dispatchCommand(
      "sessions",
      {
        action: "send",
        session_id: "session-1",
        prompt: "berdctl tail",
        if_running: "queue",
      },
      ctx,
    );

    expect(result).toEqual({ session_id: "session-1", send_status: "queued" });
    expect(
      useChatStore
        .getState()
        .queuedMessageBySession["session-1"]?.map(
          (record) => record.payload.text,
        ),
    ).toEqual(["composer head", "berdctl tail"]);
    expect(
      useChatStore.getState().messagesBySession["session-1"],
    ).toBeUndefined();
  });

  it("truthfully refuses if a composer message takes queue ownership before commit", async () => {
    mockSessionFound({ providerId: "codex-acp" });
    mocks.loadSessionMessages.mockImplementationOnce(async () => {
      return true;
    });
    mocks.acpSendMessage.mockImplementationOnce(() => {
      useChatStore.getState().enqueueTransportReadyMessage("session-1", {
        persona: { kind: "inherit" },
        text: "composer head",
      });
      return Promise.resolve();
    });

    await expectCommandError(
      dispatchCommand(
        "sessions",
        {
          action: "send",
          session_id: "session-1",
          prompt: "do not jump the head",
        },
        ctx,
      ),
      "target_session_running",
    );

    expect(
      useChatStore
        .getState()
        .queuedMessageBySession["session-1"]?.map(
          (record) => record.payload.text,
        ),
    ).toEqual(["composer head"]);
    expect(
      useChatStore.getState().messagesBySession["session-1"],
    ).toBeUndefined();
  });

  it("truthfully refuses if the target acquires a run before commit", async () => {
    let newerOwnerRuntime: unknown;
    mockSessionFound({ providerId: "codex-acp" });
    mocks.loadSessionMessages.mockImplementationOnce(async () => {
      return true;
    });
    mocks.acpSendMessage.mockImplementationOnce(() => {
      useChatStore.getState().setError("session-1", "newer owner error");
      useChatStore.getState().setChatState("session-1", "streaming");
      useChatStore
        .getState()
        .setPendingAssistantProvider("session-1", "newer-provider");
      useChatStore.getState().setActiveRunId("session-1", "racing-run");
      useChatStore.getState().setRunCancellationPending("session-1", true);
      newerOwnerRuntime = structuredClone(
        useChatStore.getState().getSessionRuntime("session-1"),
      );
      return Promise.resolve();
    });

    await expectCommandError(
      dispatchCommand(
        "sessions",
        {
          action: "send",
          session_id: "session-1",
          prompt: "do not overlap",
        },
        ctx,
      ),
      "target_session_running",
    );

    expect(
      useChatStore.getState().messagesBySession["session-1"],
    ).toBeUndefined();
    expect(useChatStore.getState().getSessionRuntime("session-1")).toEqual(
      newerOwnerRuntime,
    );
    expect(
      useChatStore.getState().queuedMessageBySession["session-1"],
    ).toBeUndefined();
  });

  it("queues a prompt while an idle session still owns an active run", async () => {
    mockSessionFound();
    useChatStore.getState().setActiveRunId("session-1", "run-1");

    const result = await dispatchCommand(
      "sessions",
      {
        action: "send",
        session_id: "session-1",
        prompt: "after active run",
        if_running: "queue",
      },
      ctx,
    );

    expect(result).toEqual({ session_id: "session-1", send_status: "queued" });
    expect(
      useChatStore.getState().queuedMessageBySession["session-1"]?.[0]?.payload
        .text,
    ).toBe("after active run");
    expect(mocks.acpSendMessage).not.toHaveBeenCalled();
  });

  it("queues a prompt while cancellation is pending", async () => {
    mockSessionFound();
    useChatStore.getState().setRunCancellationPending("session-1", true);

    const result = await dispatchCommand(
      "sessions",
      {
        action: "send",
        session_id: "session-1",
        prompt: "after cancellation",
        if_running: "queue",
      },
      ctx,
    );

    expect(result).toEqual({ session_id: "session-1", send_status: "queued" });
    expect(
      useChatStore.getState().queuedMessageBySession["session-1"]?.[0]?.payload
        .text,
    ).toBe("after cancellation");
  });

  it("reports steering without marking the message steered before delivery", async () => {
    mockSessionFound();
    useChatStore.getState().setChatState("session-1", "streaming");
    useChatStore.getState().setActiveRunId("session-1", "run-1");

    const result = await dispatchCommand(
      "sessions",
      {
        action: "send",
        session_id: "session-1",
        prompt: "make it shorter",
        if_running: "steer",
      },
      ctx,
    );

    expect(result).toEqual({
      session_id: "session-1",
      send_status: "steered",
    });
    const messages = useChatStore.getState().messagesBySession["session-1"];
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      id: "steer-message",
      metadata: {
        delivery: "steering",
        origin: "berdctl_cross_session",
      },
    });
    expect(mocks.acpSteerMessage).toHaveBeenCalledWith(
      "session-1",
      "run-1",
      "make it shorter",
      expect.objectContaining({
        goose: { origin: "berdctl_cross_session" },
      }),
    );
    expect(mocks.acpPrepareSession).not.toHaveBeenCalled();
    expect(mocks.acpSendMessage).not.toHaveBeenCalled();
  });

  it("appends running-target prompts to the shared queue", async () => {
    mockSessionFound();
    useChatStore.getState().setChatState("session-1", "streaming");

    const result = await dispatchCommand(
      "sessions",
      {
        action: "send",
        session_id: "session-1",
        prompt: "next prompt",
        if_running: "queue",
      },
      ctx,
    );

    expect(result).toEqual({
      session_id: "session-1",
      send_status: "queued",
    });
    expect(
      useChatStore.getState().queuedMessageBySession["session-1"]?.[0]?.payload,
    ).toEqual({
      persona: { kind: "inherit" },
      text: "next prompt",
      sendOptions: {
        userMessageMetadata: { origin: "berdctl_cross_session" },
        acpGooseMetadata: { origin: "berdctl_cross_session" },
      },
    });

    mockSessionFound();
    const secondResult = await dispatchCommand(
      "sessions",
      {
        action: "send",
        session_id: "session-1",
        prompt: "another prompt",
        if_running: "queue",
      },
      ctx,
    );

    expect(secondResult).toEqual({
      session_id: "session-1",
      send_status: "queued",
    });
    expect(
      useChatStore
        .getState()
        .queuedMessageBySession["session-1"]?.map(
          (record) => record.payload.text,
        ),
    ).toEqual(["next prompt", "another prompt"]);
  });

  it("preserves a visible sender label on queued prompts", async () => {
    mockSessionFound();
    useChatStore.getState().setChatState("session-1", "streaming");

    const result = await dispatchCommand(
      "sessions",
      {
        action: "send",
        session_id: "session-1",
        prompt: "[monitor: checks] complete",
        if_running: "queue",
        from: "the Berd session handling berd-monitor implementation",
        delivery_id: "monitor-event-1",
      },
      ctx,
    );

    expect(result).toEqual({ session_id: "session-1", send_status: "queued" });
    expect(
      useChatStore.getState().queuedMessageBySession["session-1"]?.[0]?.payload
        .sendOptions,
    ).toEqual({
      userMessageMetadata: {
        origin: "berdctl_cross_session",
        berdSenderLabel:
          "the Berd session handling berd-monitor implementation",
        berdDeliveryId: "monitor-event-1",
      },
      acpGooseMetadata: {
        origin: "berdctl_cross_session",
        berdSenderLabel:
          "the Berd session handling berd-monitor implementation",
        berdDeliveryId: "monitor-event-1",
      },
    });
  });

  it("accepts a repeated delivery id without queueing another user turn", async () => {
    mockSessionFound();
    useChatStore.getState().setChatState("session-1", "streaming");

    const first = await dispatchCommand(
      "sessions",
      {
        action: "send",
        session_id: "session-1",
        prompt: "monitor event",
        if_running: "queue",
        delivery_id: "monitor-event-1",
      },
      ctx,
    );
    const duplicate = await dispatchCommand(
      "sessions",
      {
        action: "send",
        session_id: "session-1",
        prompt: "monitor event retried",
        if_running: "queue",
        delivery_id: "monitor-event-1",
      },
      ctx,
    );

    expect(first).toEqual({ session_id: "session-1", send_status: "queued" });
    expect(duplicate).toEqual({
      session_id: "session-1",
      send_status: "deduplicated",
    });
    expect(
      useChatStore.getState().queuedMessageBySession["session-1"],
    ).toHaveLength(1);
  });

  it("serializes concurrent admission of the same delivery id", async () => {
    const session = makeAcpSession({
      sessionId: "session-1",
      providerId: "codex-acp",
    });
    let releaseLoads: (() => void) | undefined;
    const loadsReleased = new Promise<void>((resolve) => {
      releaseLoads = resolve;
    });
    let loadCount = 0;
    mocks.acpGetSessionInfo.mockImplementation(async () => {
      loadCount += 1;
      await loadsReleased;
      return session;
    });

    const send = (prompt: string) =>
      dispatchCommand(
        "sessions",
        {
          action: "send",
          session_id: "session-1",
          prompt,
          if_running: "queue",
          delivery_id: "monitor-event-1",
        },
        ctx,
      );
    const first = send("monitor event");
    const retry = send("monitor event retried concurrently");
    await vi.waitFor(() => expect(loadCount).toBe(2));
    releaseLoads?.();

    await expect(Promise.all([first, retry])).resolves.toEqual([
      { session_id: "session-1", send_status: "dispatched" },
      { session_id: "session-1", send_status: "deduplicated" },
    ]);
    expect(
      (useChatStore.getState().messagesBySession["session-1"] ?? []).length +
        (useChatStore.getState().queuedMessageBySession["session-1"]?.length ??
          0),
    ).toBe(1);
  });

  it("deduplicates a delivery id restored in the transcript before target guards", async () => {
    mockSessionFound();
    const accepted = createUserMessage("monitor event");
    accepted.metadata = {
      origin: "berdctl_cross_session",
      berdDeliveryId: "monitor-event-1",
    };
    useChatStore.getState().addMessage("session-1", accepted);
    useChatStore.getState().setChatState("session-1", "streaming");
    useSessionWindowStore
      .getState()
      .setSnapshot([{ sessionId: "session-1", windowLabel: "session" }]);

    const duplicate = await dispatchCommand(
      "sessions",
      {
        action: "send",
        session_id: "session-1",
        prompt: "monitor event retried after restart",
        delivery_id: "monitor-event-1",
      },
      ctx,
    );

    expect(duplicate).toEqual({
      session_id: "session-1",
      send_status: "deduplicated",
    });
    expect(mocks.acpSendMessage).not.toHaveBeenCalled();
    expect(mocks.acpSteerMessage).not.toHaveBeenCalled();
  });

  it("deduplicates a delivery id restored while hydrating a cold transcript", async () => {
    mockSessionFound({ providerId: "codex-acp" });
    mocks.loadSessionMessages.mockImplementationOnce(async () => {
      const accepted = createUserMessage("monitor event");
      accepted.metadata = {
        origin: "berdctl_cross_session",
        berdDeliveryId: "monitor-event-1",
      };
      useChatStore.getState().addMessage("session-1", accepted);
      return true;
    });

    const duplicate = await dispatchCommand(
      "sessions",
      {
        action: "send",
        session_id: "session-1",
        prompt: "monitor event retried after restart",
        delivery_id: "monitor-event-1",
      },
      ctx,
    );

    expect(duplicate).toEqual({
      session_id: "session-1",
      send_status: "deduplicated",
    });
    expect(useChatStore.getState().messagesBySession["session-1"]).toHaveLength(
      1,
    );
    expect(
      useChatStore.getState().queuedMessageBySession["session-1"],
    ).toBeUndefined();
    expect(mocks.acpSendMessage).not.toHaveBeenCalled();
    expect(mocks.acpSteerMessage).not.toHaveBeenCalled();
  });

  it("rejects multiline sender labels before dispatch", async () => {
    const error = await expectCommandError(
      dispatchCommand(
        "sessions",
        {
          action: "send",
          session_id: "session-1",
          prompt: "monitor update",
          if_running: "queue",
          from: "first line\nsecond line",
        },
        ctx,
      ),
      "invalid_args",
    );

    expect(error.message).toContain("single line");
  });
});

describe("sessions.open", () => {
  it("returns ok on success", async () => {
    mockSessionFound();

    const result = await dispatchCommand(
      "sessions",
      { action: "open", session_id: "session-1" },
      ctx,
    );
    expect(controller.openSession).toHaveBeenCalledWith("session-1");
    expect(result).toEqual({ ok: true });
  });

  it("loads the target session without paging the session list", async () => {
    mocks.acpGetSessionInfo.mockResolvedValue(
      makeAcpSession({ sessionId: "session-1" }),
    );

    await dispatchCommand(
      "sessions",
      { action: "open", session_id: "session-1" },
      ctx,
    );

    expect(mocks.acpGetSessionInfo).toHaveBeenCalledWith("session-1");
    expect(mocks.acpListSessionsPage).not.toHaveBeenCalled();
    expect(controller.openSession).toHaveBeenCalledWith("session-1");
  });

  it("maps a failed facade outcome to a CommandError with its reason code", async () => {
    // The facade reports these as outcomes; the command must throw so the
    // CLI exits non-zero instead of printing an exit-0 "success".
    for (const reason of [
      "session_not_found",
      "blocked_unsaved_changes",
      "focus_failed",
    ]) {
      mockSessionFound();
      controller.openSession.mockResolvedValue({ ok: false, reason });
      await expectCommandError(
        dispatchCommand(
          "sessions",
          { action: "open", session_id: "session-1" },
          ctx,
        ),
        reason,
      );
    }
  });
});

describe("sessions.list", () => {
  it("throws backend_read_failed when the backend session read fails", async () => {
    mocks.acpListSessionsPage.mockRejectedValue(new Error("backend down"));

    await expectCommandError(
      dispatchCommand("sessions", { action: "list" }, ctx),
      "backend_read_failed",
    );

    expect(useChatSessionStore.getState().hasHydratedSessions).toBe(false);
  });

  it("hydrates the session list before reading when not yet hydrated", async () => {
    mocks.acpListSessionsPage.mockResolvedValue({
      sessions: [
        {
          sessionId: "session-a",
          title: "Loaded Session",
          createdAt: "2026-04-01T00:00:00.000Z",
          updatedAt: "2026-04-02T00:00:00.000Z",
          archivedAt: null,
          userSetName: false,
          messageCount: 3,
          workingDir: null,
          projectId: null,
          providerId: null,
          modelId: null,
          personaId: null,
        },
      ],
      nextCursor: null,
    });

    useChatStore.getState().setChatState("session-a", "streaming");

    const result = await dispatchCommand("sessions", { action: "list" }, ctx);

    expect(mocks.acpListSessionsPage).toHaveBeenCalledTimes(1);
    expect(result).toEqual({
      sessions: [
        {
          session_id: "session-a",
          title: "Loaded Session",
          project_id: null,
          updated_at: "2026-04-02T00:00:00.000Z",
          is_running: true,
          chat_state: "streaming",
          message_count: 3,
        },
      ],
    });
  });

  it("exhausts paginated backend results before filtering", async () => {
    mockSessionPages(
      {
        sessions: [makeAcpSession({ sessionId: "s-1", title: "Build docs" })],
        nextCursor: "page-2",
      },
      {
        sessions: [
          makeAcpSession({
            sessionId: "s-2",
            title: "Fix login bug",
            updatedAt: "2026-04-02T00:00:00.000Z",
          }),
        ],
        nextCursor: null,
      },
    );

    const result = (await dispatchCommand(
      "sessions",
      { action: "list", query: "LOGIN" },
      ctx,
    )) as { sessions: Array<{ session_id: string }> };

    expect(mocks.acpListSessionsPage).toHaveBeenCalledTimes(2);
    expect(result.sessions.map((s) => s.session_id)).toEqual(["s-2"]);
  });

  it("excludes archived sessions and filters by project and query", async () => {
    const project = makeProject({ id: "p-1" });
    useProjectStore.setState({
      projects: [project],
      hasFetchedProjects: true,
    });
    mocks.listProjects.mockResolvedValue([project]);
    seedSessions(
      makeSession({ id: "s-1", title: "Fix login bug", projectId: "p-1" }),
      makeSession({ id: "s-2", title: "Fix logout bug", projectId: "p-2" }),
      makeSession({
        id: "s-3",
        title: "Fix login crash",
        projectId: "p-1",
        archivedAt: "2026-04-01T00:00:00.000Z",
      }),
      makeSession({ id: "s-4", title: "Write docs", projectId: "p-1" }),
    );

    const result = (await dispatchCommand(
      "sessions",
      { action: "list", project_id: "p-1", query: "LOGIN" },
      ctx,
    )) as { sessions: Array<{ session_id: string }> };

    expect(result.sessions.map((s) => s.session_id)).toEqual(["s-1"]);
  });

  it("throws project_not_found for an unknown project filter", async () => {
    // A typo'd project id must error instead of reading as "no sessions".
    seedSessions(makeSession({ id: "s-1", projectId: "p-1" }));

    await expectCommandError(
      dispatchCommand("sessions", { action: "list", project_id: "nope" }, ctx),
      "project_not_found",
    );
    expect(mocks.listProjects).toHaveBeenCalledTimes(1);
  });

  it("applies the default limit of 20 through dispatch", async () => {
    seedSessions(
      ...Array.from({ length: 25 }, (_, i) =>
        makeSession({ id: `s-${i}`, title: `Session ${i}` }),
      ),
    );

    const result = (await dispatchCommand(
      "sessions",
      { action: "list" },
      ctx,
    )) as { sessions: unknown[] };
    expect(result.sessions).toHaveLength(20);
  });
});

describe("sessions.get", () => {
  it("returns metadata without touching the export when messages is omitted", async () => {
    mockSessionFound({
      providerId: "codex-acp",
      modelId: "gpt-6",
      projectId: "p-1",
      workingDir: "/work",
    });

    const result = await dispatchCommand(
      "sessions",
      { action: "get", session_id: "session-1" },
      ctx,
    );

    expect(result).toEqual({
      session_id: "session-1",
      title: "Test Session",
      harness_id: "codex-acp",
      model_id: "gpt-6",
      agent_id: null,
      project_id: "p-1",
      working_dir: "/work",
      created_at: "2026-04-01T00:00:00.000Z",
      updated_at: "2026-04-01T00:00:00.000Z",
      archived: false,
      is_running: false,
      is_open_in_window: false,
      chat_state: "idle",
      message_count: 2,
    });
    expect(mocks.lastSessionMessages).not.toHaveBeenCalled();
  });

  it("reports whether the session chat is running", async () => {
    mockSessionFound();
    useChatStore.getState().setChatState("session-1", "streaming");

    const result = (await dispatchCommand(
      "sessions",
      { action: "get", session_id: "session-1" },
      ctx,
    )) as { is_running: boolean };

    expect(result.is_running).toBe(true);
  });

  it("does not treat a stale active run id as a running session", async () => {
    mockSessionFound();
    useChatStore.getState().setActiveRunId("session-1", "stale-run");

    const result = (await dispatchCommand(
      "sessions",
      { action: "get", session_id: "session-1" },
      ctx,
    )) as { is_running: boolean };

    expect(result.is_running).toBe(false);
  });

  it("reports a cancellation-pending idle session as running", async () => {
    mockSessionFound();
    useChatStore.getState().setActiveRunId("session-1", "run-1");
    useChatStore.getState().setRunCancellationPending("session-1", true);

    const result = (await dispatchCommand(
      "sessions",
      { action: "get", session_id: "session-1" },
      ctx,
    )) as { is_running: boolean };

    expect(result.is_running).toBe(true);
  });

  it.each([
    { chatState: "idle" as const, isOpenInWindow: false, isRunning: false },
    { chatState: "streaming" as const, isOpenInWindow: false, isRunning: true },
    { chatState: "idle" as const, isOpenInWindow: true, isRunning: false },
    { chatState: "streaming" as const, isOpenInWindow: true, isRunning: true },
  ])("reports chat=$chatState and open-window=$isOpenInWindow independently", async ({
    chatState,
    isOpenInWindow,
    isRunning,
  }) => {
    mockSessionFound();
    useChatStore.getState().setChatState("session-1", chatState);
    if (isOpenInWindow) {
      useSessionWindowStore
        .getState()
        .setSnapshot([{ sessionId: "session-1", windowLabel: "session" }]);
    }

    const result = (await dispatchCommand(
      "sessions",
      { action: "get", session_id: "session-1" },
      ctx,
    )) as { is_running: boolean; is_open_in_window: boolean };

    expect(result).toMatchObject({
      is_running: isRunning,
      is_open_in_window: isOpenInWindow,
    });
  });

  it("loads a deep session with one targeted backend request", async () => {
    mocks.acpGetSessionInfo.mockResolvedValue(
      makeAcpSession({
        sessionId: "session-1",
        title: "Loaded Directly",
        projectId: "p-1",
      }),
    );

    const result = await dispatchCommand(
      "sessions",
      { action: "get", session_id: "session-1" },
      ctx,
    );

    expect(mocks.acpGetSessionInfo).toHaveBeenCalledOnce();
    expect(mocks.acpGetSessionInfo).toHaveBeenCalledWith("session-1");
    expect(mocks.acpListSessionsPage).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      session_id: "session-1",
      title: "Loaded Directly",
      project_id: "p-1",
    });
  });

  it("does not finish full-list hydration after a targeted read", async () => {
    useChatSessionStore.setState({ isLoading: true });
    mocks.acpGetSessionInfo.mockResolvedValue(
      makeAcpSession({
        sessionId: "session-1",
        title: "Loaded Directly",
      }),
    );

    await dispatchCommand(
      "sessions",
      { action: "get", session_id: "session-1" },
      ctx,
    );

    const state = useChatSessionStore.getState();
    expect(state.getSession("session-1")?.title).toBe("Loaded Directly");
    expect(state.hasHydratedSessions).toBe(false);
    expect(state.isLoading).toBe(true);
    expect(state.sessionPageCursor).toBeNull();
    expect(state.hasMoreSessions).toBe(false);
  });

  it("does not validate a target from stale cache unless the targeted read confirms it", async () => {
    seedSessions(makeSession({ id: "session-1", title: "Stale Session" }));

    await expectCommandError(
      dispatchCommand(
        "sessions",
        { action: "get", session_id: "session-1" },
        ctx,
      ),
      "session_not_found",
    );
    expect(mocks.acpGetSessionInfo).toHaveBeenCalledWith("session-1");
    expect(mocks.acpListSessionsPage).not.toHaveBeenCalled();
  });

  it("includes the last N messages with long texts truncated", async () => {
    mockSessionFound();
    mocks.lastSessionMessages.mockResolvedValue([
      { role: "user", text: "summarize the repo" },
      { role: "assistant", text: "x".repeat(3000) },
    ]);

    const result = (await dispatchCommand(
      "sessions",
      { action: "get", session_id: "session-1", messages: 2 },
      ctx,
    )) as { messages: Array<{ role: string; text: string }> };

    expect(mocks.lastSessionMessages).toHaveBeenCalledWith("session-1", 2);
    expect(result.messages).toHaveLength(2);
    expect(result.messages[0]).toEqual({
      role: "user",
      text: "summarize the repo",
    });
    expect(result.messages[1].text).toHaveLength(2001); // 2000 + ellipsis
  });

  it("throws session_not_found for unknown sessions", async () => {
    seedSessions();
    await expectCommandError(
      dispatchCommand(
        "sessions",
        { action: "get", session_id: "missing" },
        ctx,
      ),
      "session_not_found",
    );
  });

  it("maps goose model-provider sessions back to harness_id goose", async () => {
    // Goose-managed sessions persist a model-provider id; reported raw it
    // would fail the round-trip into create's harness_id.
    mockSessionFound({ providerId: getModelProviders()[0].id });

    const result = (await dispatchCommand(
      "sessions",
      { action: "get", session_id: "session-1" },
      ctx,
    )) as { harness_id: string };

    expect(result.harness_id).toBe("goose");
  });
});

describe("sessions.rename", () => {
  it("renames via the session operation", async () => {
    mockSessionFound();

    const result = await dispatchCommand(
      "sessions",
      { action: "rename", session_id: "session-1", title: "New Title" },
      ctx,
    );

    expect(mocks.updateSessionTitle).toHaveBeenCalledWith(
      "session-1",
      "New Title",
    );
    expect(result).toEqual({ ok: true });
  });

  it("throws session_not_found for unknown sessions", async () => {
    await expectCommandError(
      dispatchCommand(
        "sessions",
        { action: "rename", session_id: "missing", title: "New" },
        ctx,
      ),
      "session_not_found",
    );
    expect(mocks.updateSessionTitle).not.toHaveBeenCalled();
  });
});

describe("sessions.fork", () => {
  it("forks via acpDuplicateSession and adds the copy to the store", async () => {
    mockSessionFound({ workingDir: "/projects/one" });
    mocks.acpDuplicateSession.mockResolvedValue(
      makeAcpSession({
        sessionId: "session-fork",
        title: "Alternate approach",
        messageCount: 2,
      }),
    );

    const result = await dispatchCommand(
      "sessions",
      { action: "fork", session_id: "session-1", title: "Alternate approach" },
      ctx,
    );

    expect(mocks.acpDuplicateSession).toHaveBeenCalledWith(
      "session-1",
      "/projects/one",
      "Alternate approach",
    );
    expect(result).toEqual({
      session_id: "session-fork",
      title: "Alternate approach",
      source_session_id: "session-1",
      message_count: 2,
    });
    expect(
      useChatSessionStore.getState().getSession("session-fork"),
    ).toBeDefined();
  });

  it("refuses a running session before forking", async () => {
    seedSessions(makeSession({ id: "session-1" }));
    useChatStore.getState().setChatState("session-1", "streaming");

    await expectCommandError(
      dispatchCommand(
        "sessions",
        { action: "fork", session_id: "session-1" },
        ctx,
      ),
      "target_session_running",
    );
    expect(mocks.acpDuplicateSession).not.toHaveBeenCalled();
  });

  it("throws session_not_found for unknown sessions", async () => {
    await expectCommandError(
      dispatchCommand(
        "sessions",
        { action: "fork", session_id: "missing" },
        ctx,
      ),
      "session_not_found",
    );
    expect(mocks.acpDuplicateSession).not.toHaveBeenCalled();
  });
});

describe("sessions.archive", () => {
  it("refuses a running session before touching the controller", async () => {
    seedSessions(makeSession({ id: "session-1" }));
    useChatStore.getState().setChatState("session-1", "streaming");

    await expectCommandError(
      dispatchCommand(
        "sessions",
        { action: "archive", session_id: "session-1" },
        ctx,
      ),
      "target_session_running",
    );
    expect(controller.archiveSession).not.toHaveBeenCalled();
  });

  it("refuses a session open in a pop-out window even when its runtime reads idle", async () => {
    // A pop-out-hosted session streams in a separate webview, so this
    // window's chatState stays "idle"; the window snapshot is the guard.
    seedSessions(makeSession({ id: "session-1" }));
    useSessionWindowStore
      .getState()
      .setSnapshot([{ sessionId: "session-1", windowLabel: "session-win-1" }]);

    const error = await expectCommandError(
      dispatchCommand(
        "sessions",
        { action: "archive", session_id: "session-1" },
        ctx,
      ),
      "target_session_running",
    );
    expect(error.message).toContain("separate window");
    expect(controller.archiveSession).not.toHaveBeenCalled();
  });

  it("archives through the facade", async () => {
    mockSessionFound({ title: "Old Chat" });

    const result = await dispatchCommand(
      "sessions",
      { action: "archive", session_id: "session-1" },
      ctx,
    );

    expect(controller.archiveSession).toHaveBeenCalledWith(
      "session-1",
      "reject",
      expect.any(Number),
    );
    expect(result).toEqual({ ok: true });
  });

  it("passes the explicit discard policy through the facade", async () => {
    mockSessionFound();
    const deadlineMs = Date.now() + 5_000;

    await dispatchCommand(
      "sessions",
      {
        action: "archive",
        session_id: "session-1",
        discard_changes: true,
      },
      { deadlineMs },
    );

    expect(controller.archiveSession).toHaveBeenCalledWith(
      "session-1",
      "discard",
      deadlineMs,
    );
  });

  it("tells callers how to opt into discarding changes", async () => {
    mockSessionFound();
    controller.archiveSession.mockResolvedValue({
      ok: false,
      reason: "cleanup_requires_discard",
    });

    const error = await expectCommandError(
      dispatchCommand(
        "sessions",
        { action: "archive", session_id: "session-1" },
        ctx,
      ),
      "cleanup_requires_discard",
    );

    expect(error.message).toContain("--discard-changes");
  });

  it("returns a failure after archival when Git cleanup is incomplete", async () => {
    mockSessionFound();
    controller.archiveSession.mockResolvedValue({
      ok: true,
      cleanupIncomplete: "workspace_cleanup_failed",
    });

    const error = await expectCommandError(
      dispatchCommand(
        "sessions",
        { action: "archive", session_id: "session-1" },
        ctx,
      ),
      "workspace_cleanup_failed",
    );

    expect(error.message).toContain("was archived");
  });

  it("maps a failed facade outcome to a CommandError with its reason code", async () => {
    mockSessionFound();
    controller.archiveSession.mockResolvedValue({
      ok: false,
      reason: "backend_archive_failed",
    });

    await expectCommandError(
      dispatchCommand(
        "sessions",
        { action: "archive", session_id: "session-1" },
        ctx,
      ),
      "backend_archive_failed",
    );
  });
});

describe("sessions.move", () => {
  it("refuses to move a running session", async () => {
    seedSessions(makeSession({ id: "session-1" }));
    useChatStore.getState().setChatState("session-1", "thinking");

    await expectCommandError(
      dispatchCommand(
        "sessions",
        { action: "move", session_id: "session-1", project_id: "p" },
        ctx,
      ),
      "target_session_running",
    );
    expect(mocks.moveSessionToProject).not.toHaveBeenCalled();
  });

  it("refuses to move a session open in a pop-out window", async () => {
    seedSessions(makeSession({ id: "session-1" }));
    useSessionWindowStore
      .getState()
      .setSnapshot([{ sessionId: "session-1", windowLabel: "session-win-1" }]);

    await expectCommandError(
      dispatchCommand(
        "sessions",
        { action: "move", session_id: "session-1", project_id: "p" },
        ctx,
      ),
      "target_session_running",
    );
    expect(mocks.moveSessionToProject).not.toHaveBeenCalled();
  });

  it("throws project_not_found for an unknown destination project", async () => {
    mockSessionFound();

    await expectCommandError(
      dispatchCommand(
        "sessions",
        { action: "move", session_id: "session-1", project_id: "nope" },
        ctx,
      ),
      "project_not_found",
    );
    expect(mocks.moveSessionToProject).not.toHaveBeenCalled();
  });

  it("moves the session into an existing project", async () => {
    const project = makeProject({ id: "p-1" });
    mockSessionFound();
    useProjectStore.setState({
      projects: [project],
      hasFetchedProjects: true,
    });
    mocks.listProjects.mockResolvedValue([project]);

    await dispatchCommand(
      "sessions",
      { action: "move", session_id: "session-1", project_id: "p-1" },
      ctx,
    );
    expect(mocks.moveSessionToProject).toHaveBeenCalledWith("session-1", "p-1");
  });

  it("moves the session out of any project with clear_project", async () => {
    mockSessionFound({ projectId: "p-1" });
    await dispatchCommand(
      "sessions",
      { action: "clear_project", session_id: "session-1" },
      ctx,
    );
    expect(mocks.moveSessionToProject).toHaveBeenCalledWith("session-1", null);
  });

  it("refuses to clear project for a running session", async () => {
    seedSessions(makeSession({ id: "session-1", projectId: "p-1" }));
    useChatStore.getState().setChatState("session-1", "thinking");

    await expectCommandError(
      dispatchCommand(
        "sessions",
        { action: "clear_project", session_id: "session-1" },
        ctx,
      ),
      "target_session_running",
    );
    expect(mocks.moveSessionToProject).not.toHaveBeenCalled();
  });
});

describe("sessions.move_to_group", () => {
  const projectWithGroups = () =>
    makeProject({
      id: "p-1",
      chatGroups: {
        groups: [
          { id: "group-a", name: "Backlog", chatIds: ["session-1"] },
          { id: "group-b", name: "Launch", chatIds: ["session-2"] },
        ],
      },
    });

  it("moves a session between existing groups in its current project", async () => {
    const project = projectWithGroups();
    mockSessionFound({ projectId: "p-1" });
    mocks.listProjects.mockResolvedValue([project]);

    const result = await dispatchCommand(
      "sessions",
      {
        action: "move_to_group",
        session_id: "session-1",
        group_id: "group-b",
      },
      ctx,
    );

    expect(mocks.updateProject).toHaveBeenCalledWith(project, {
      chatGroups: {
        groups: [
          {
            id: "group-b",
            name: "Launch",
            chatIds: ["session-2", "session-1"],
          },
        ],
      },
    });
    expect(result).toEqual({
      ok: true,
      project_id: "p-1",
      group_id: "group-b",
      group_name: "Launch",
    });
  });

  it("preserves unrelated groups that were already empty", async () => {
    const project = makeProject({
      id: "p-1",
      chatGroups: {
        groups: [
          { id: "group-a", name: "Backlog", chatIds: ["session-1"] },
          { id: "group-b", name: "Launch", chatIds: ["session-2"] },
          { id: "group-c", name: "Future", chatIds: [] },
        ],
      },
    });
    mockSessionFound({ projectId: "p-1" });
    mocks.listProjects.mockResolvedValue([project]);

    await dispatchCommand(
      "sessions",
      {
        action: "move_to_group",
        session_id: "session-1",
        group_id: "group-b",
      },
      ctx,
    );

    expect(mocks.updateProject).toHaveBeenCalledWith(project, {
      chatGroups: {
        groups: [
          {
            id: "group-b",
            name: "Launch",
            chatIds: ["session-2", "session-1"],
          },
          { id: "group-c", name: "Future", chatIds: [] },
        ],
      },
    });
  });

  it("serializes overlapping moves so the later write keeps the earlier move", async () => {
    let backendProject = makeProject({
      id: "p-1",
      chatGroups: {
        groups: [
          {
            id: "group-a",
            name: "Backlog",
            chatIds: ["session-1", "session-2"],
          },
          { id: "group-b", name: "Launch", chatIds: [] },
          { id: "group-c", name: "Follow-up", chatIds: ["session-3"] },
        ],
      },
    });
    mocks.acpGetSessionInfo.mockImplementation(async (sessionId: string) => {
      if (sessionId === "session-1" || sessionId === "session-2") {
        return makeAcpSession({ sessionId, projectId: "p-1" });
      }
      throw Object.assign(new Error("Resource not found"), { code: -32002 });
    });
    mocks.acpListSessionsPage.mockResolvedValue({
      sessions: [
        makeAcpSession({ sessionId: "session-1", projectId: "p-1" }),
        makeAcpSession({ sessionId: "session-2", projectId: "p-1" }),
      ],
      nextCursor: null,
    });
    mocks.listProjects.mockImplementation(async () => [backendProject]);

    let releaseFirstUpdate!: () => void;
    const firstUpdateBlocked = new Promise<void>((resolve) => {
      releaseFirstUpdate = resolve;
    });
    mocks.updateProject
      .mockImplementationOnce(async (project, updates) => {
        await firstUpdateBlocked;
        backendProject = { ...project, ...updates };
        return backendProject;
      })
      .mockImplementationOnce(async (project, updates) => {
        backendProject = { ...project, ...updates };
        return backendProject;
      });

    const first = dispatchCommand(
      "sessions",
      {
        action: "move_to_group",
        session_id: "session-1",
        group_id: "group-b",
      },
      ctx,
    );
    await vi.waitFor(() =>
      expect(mocks.updateProject).toHaveBeenCalledTimes(1),
    );

    const second = dispatchCommand(
      "sessions",
      {
        action: "move_to_group",
        session_id: "session-2",
        group_id: "group-c",
      },
      ctx,
    );
    await Promise.resolve();
    expect(mocks.updateProject).toHaveBeenCalledTimes(1);

    releaseFirstUpdate();
    await Promise.all([first, second]);

    expect(mocks.updateProject).toHaveBeenLastCalledWith(
      expect.objectContaining({
        chatGroups: {
          groups: [
            { id: "group-a", name: "Backlog", chatIds: ["session-2"] },
            { id: "group-b", name: "Launch", chatIds: ["session-1"] },
            { id: "group-c", name: "Follow-up", chatIds: ["session-3"] },
          ],
        },
      }),
      {
        chatGroups: {
          groups: [
            { id: "group-b", name: "Launch", chatIds: ["session-1"] },
            {
              id: "group-c",
              name: "Follow-up",
              chatIds: ["session-3", "session-2"],
            },
          ],
        },
      },
    );
  });

  it("removes a client session id before writing the canonical id", async () => {
    const project = makeProject({
      id: "p-1",
      chatGroups: {
        groups: [
          { id: "group-a", name: "Backlog", chatIds: ["client-1"] },
          { id: "group-b", name: "Launch", chatIds: [] },
        ],
      },
    });
    seedSessions(
      makeSession({
        id: "session-1",
        projectId: "p-1",
        clientSessionId: "client-1",
      }),
    );
    mockSessionFound({ projectId: "p-1" });
    mocks.listProjects.mockResolvedValue([project]);

    await dispatchCommand(
      "sessions",
      {
        action: "move_to_group",
        session_id: "session-1",
        group_id: "group-b",
      },
      ctx,
    );

    expect(mocks.updateProject).toHaveBeenCalledWith(project, {
      chatGroups: {
        groups: [{ id: "group-b", name: "Launch", chatIds: ["session-1"] }],
      },
    });
  });

  it("requires the session to already belong to a project", async () => {
    mockSessionFound({ projectId: null });

    await expectCommandError(
      dispatchCommand(
        "sessions",
        {
          action: "move_to_group",
          session_id: "session-1",
          group_id: "group-b",
        },
        ctx,
      ),
      "invalid_args",
    );
    expect(mocks.updateProject).not.toHaveBeenCalled();
  });

  it("rejects a group that is not in the session's project", async () => {
    const project = projectWithGroups();
    mockSessionFound({ projectId: "p-1" });
    mocks.listProjects.mockResolvedValue([project]);

    await expectCommandError(
      dispatchCommand(
        "sessions",
        {
          action: "move_to_group",
          session_id: "session-1",
          group_id: "other-project-group",
        },
        ctx,
      ),
      "invalid_args",
    );
    expect(mocks.updateProject).not.toHaveBeenCalled();
  });
});

describe("folders.attach", () => {
  it("attaches a classified workspace without changing the active cwd", async () => {
    mockSessionFound({ workingDir: "/repo" });
    mocks.canonicalizeAuthorizedWorkspaceDirectory.mockResolvedValue({
      path: "/repo-wt",
    });
    mocks.getGitState.mockResolvedValue({
      isGitRepo: true,
      currentBranch: "feature",
      dirtyFileCount: 0,
      incomingCommitCount: 0,
      worktrees: [
        { path: "/repo", branch: "main", isMain: true },
        { path: "/repo-wt", branch: "feature", isMain: false },
      ],
      isWorktree: true,
      mainWorktreePath: "/repo",
      localBranches: ["main", "feature"],
    });

    const result = await dispatchCommand(
      "folders",
      { action: "attach", session_id: "session-1", path: "/repo-wt" },
      ctx,
    );

    expect(result).toEqual({
      ok: true,
      path: "/repo-wt",
      kind: "git-linked-worktree",
      branch: "feature",
    });
    const session = useChatSessionStore.getState().getSession("session-1");
    expect(session?.workingDir).toBe("/repo");
    expect(session?.workspaceAttachments).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: "/repo-wt",
          branch: "feature",
          usedByAgent: true,
        }),
      ]),
    );
  });

  it("rejects a second distinct attachment while multi-workspace support is off", async () => {
    setMultiWorkspaceEnabled(false);
    mockSessionFound({ workingDir: "/repo" });
    mocks.canonicalizeAuthorizedWorkspaceDirectory.mockResolvedValue({
      path: "/repo-wt",
    });

    const error = await expectCommandError(
      dispatchCommand(
        "folders",
        { action: "attach", session_id: "session-1", path: "/repo-wt" },
        ctx,
      ),
      "invalid_args",
    );
    expect(error.message).toContain("Multi-workspace support is disabled");
  });

  it("does not attach an unverifiable path", async () => {
    mockSessionFound({ workingDir: "/repo" });
    mocks.canonicalizeAuthorizedWorkspaceDirectory.mockRejectedValue(
      new Error("outside allowed filesystem"),
    );

    await expectCommandError(
      dispatchCommand(
        "folders",
        {
          action: "attach",
          session_id: "session-1",
          path: "/private",
        },
        ctx,
      ),
      "invalid_args",
    );
    expect(
      useChatSessionStore
        .getState()
        .getSession("session-1")
        ?.workspaceAttachments?.some(
          (attachment) => attachment.path === "/private",
        ),
    ).toBe(false);
  });
  it("detaches by canonical path without changing the working directory", async () => {
    mockSessionFound({ workingDir: "/repo" });
    seedSessions({
      id: "session-1",
      title: "Test Session",
      createdAt: "2026-04-01T00:00:00.000Z",
      updatedAt: "2026-04-01T00:00:00.000Z",
      messageCount: 2,
      workingDir: "/repo",
      workspaceAttachments: [
        {
          id: "path:/repo-wt",
          path: "/repo-wt",
          kind: "git-linked-worktree",
          source: "selected",
          branch: "feature",
          usedByAgent: true,
        },
      ],
    });
    mocks.canonicalizeAuthorizedWorkspaceDirectory.mockResolvedValue({
      path: "/repo-wt",
    });
    mocks.getGitState.mockResolvedValue({
      isGitRepo: false,
      currentBranch: null,
      dirtyFileCount: 0,
      incomingCommitCount: 0,
      worktrees: [],
      isWorktree: false,
      mainWorktreePath: null,
      localBranches: [],
    });

    const result = await dispatchCommand(
      "folders",
      {
        action: "detach",
        session_id: "session-1",
        path: "/repo-wt/..//repo-wt",
      },
      ctx,
    );

    expect(result).toEqual({
      ok: true,
      path: "/repo-wt",
      detached: true,
      cwd: "/repo",
      cwdStatus: "unchanged",
    });
    const updated = useChatSessionStore.getState().getSession("session-1");
    expect(updated?.workingDir).toBe("/repo");
    expect(
      updated?.workspaceAttachments?.some((item) => item.path === "/repo-wt"),
    ).toBe(false);
  });

  it("is idempotent when an authorized folder is not attached", async () => {
    mockSessionFound({ workingDir: "/repo" });
    mocks.canonicalizeAuthorizedWorkspaceDirectory.mockResolvedValue({
      path: "/repo/missing",
    });
    mocks.getGitState.mockResolvedValue({
      isGitRepo: false,
      currentBranch: null,
      dirtyFileCount: 0,
      incomingCommitCount: 0,
      worktrees: [],
      isWorktree: false,
      mainWorktreePath: null,
      localBranches: [],
    });

    await expect(
      dispatchCommand(
        "folders",
        {
          action: "detach",
          session_id: "session-1",
          path: "/repo/missing",
        },
        ctx,
      ),
    ).resolves.toEqual({
      ok: true,
      path: "/repo/missing",
      detached: false,
      cwd: "/repo",
      cwdStatus: "unchanged",
    });
  });

  it("replaces one folder with another through the folder command group", async () => {
    mockSessionFound({ workingDir: "/repo" });
    seedSessions({
      id: "session-1",
      title: "Test Session",
      createdAt: "2026-04-01T00:00:00.000Z",
      updatedAt: "2026-04-01T00:00:00.000Z",
      messageCount: 2,
      workingDir: "/repo",
      workspaceAttachments: [
        {
          id: "path:/repo",
          path: "/repo",
          kind: "git-main-worktree",
          source: "selected",
          branch: "main",
          usedByAgent: true,
        },
      ],
    });
    mocks.canonicalizeAuthorizedWorkspaceDirectory.mockImplementation(
      async ({ path }: { path: string }) => ({ path }),
    );
    mocks.getGitState.mockResolvedValue({
      isGitRepo: true,
      currentBranch: "feature",
      dirtyFileCount: 0,
      incomingCommitCount: 0,
      worktrees: [
        { path: "/repo", branch: "main", isMain: true },
        { path: "/repo-wt", branch: "feature", isMain: false },
      ],
      isWorktree: true,
      mainWorktreePath: "/repo",
      localBranches: ["main", "feature"],
    });

    await expect(
      dispatchCommand(
        "folders",
        {
          action: "replace",
          session_id: "session-1",
          old_path: "/repo",
          new_path: "/repo-wt",
        },
        ctx,
      ),
    ).resolves.toEqual({
      ok: true,
      oldPath: "/repo",
      newPath: "/repo-wt",
      kind: "git-linked-worktree",
      branch: "feature",
      cwd: "/repo-wt",
      cwdStatus: "pending",
    });
  });

  it("refuses detach and replace for sessions owned by another window", async () => {
    mockSessionFound({ workingDir: "/repo" });
    useSessionWindowStore
      .getState()
      .setSnapshot([
        { sessionId: "session-1", windowLabel: "session-session-1" },
      ]);

    for (const args of [
      { action: "detach", session_id: "session-1", path: "/repo" },
      {
        action: "replace",
        session_id: "session-1",
        old_path: "/repo",
        new_path: "/repo-wt",
      },
    ] as const) {
      const error = await expectCommandError(
        dispatchCommand("folders", args, ctx),
        "target_session_running",
      );
      expect(error.message).toContain("separate window");
    }
  });

  it("lists attached folders and marks cwd", async () => {
    mockSessionFound({ workingDir: "/repo" });
    seedSessions({
      ...makeSession({ workingDir: "/repo" }),
      workspaceAttachments: [
        {
          id: "path:/repo",
          path: "/repo",
          kind: "git-main-worktree",
          source: "selected",
          branch: "main",
          usedByAgent: true,
        },
        {
          id: "path:/repo-wt",
          path: "/repo-wt",
          kind: "git-linked-worktree",
          source: "selected",
          branch: "feature",
          usedByAgent: true,
        },
      ],
    });

    await expect(
      dispatchCommand(
        "folders",
        { action: "list", session_id: "session-1" },
        ctx,
      ),
    ).resolves.toEqual({
      ok: true,
      cwd: "/repo",
      folders: [
        { path: "/repo", kind: "git-main-worktree", branch: "main", cwd: true },
        {
          path: "/repo-wt",
          kind: "git-linked-worktree",
          branch: "feature",
          cwd: false,
        },
      ],
    });
  });

  it("set-cwd implicitly attaches and applies while idle", async () => {
    mockSessionFound({ workingDir: "/repo" });
    mocks.canonicalizeAuthorizedWorkspaceDirectory.mockResolvedValue({
      path: "/repo-wt",
    });
    mocks.getGitState.mockResolvedValue({
      isGitRepo: true,
      currentBranch: "feature",
      dirtyFileCount: 0,
      incomingCommitCount: 0,
      worktrees: [
        { path: "/repo", branch: "main", isMain: true },
        { path: "/repo-wt", branch: "feature", isMain: false },
      ],
      isWorktree: true,
      mainWorktreePath: "/repo",
      localBranches: ["main", "feature"],
    });

    const result = await dispatchCommand(
      "folders",
      { action: "set_cwd", session_id: "session-1", path: "/repo-wt" },
      ctx,
    );

    expect(result).toMatchObject({
      ok: true,
      path: "/repo-wt",
      branch: "feature",
      status: "applied",
    });
    expect(mocks.updateWorkingDir).toHaveBeenCalledWith(
      "session-1",
      "/repo-wt",
    );
    expect(
      useChatSessionStore.getState().getSession("session-1")
        ?.workspaceAttachments,
    ).toEqual(
      expect.arrayContaining([expect.objectContaining({ path: "/repo-wt" })]),
    );
  });

  it("replaces the visible attachment when set-cwd runs in single-workspace mode", async () => {
    setMultiWorkspaceEnabled(false);
    seedSessions({
      ...makeSession({ workingDir: "/repo" }),
      workspaceAttachments: [
        {
          id: "path:/repo",
          path: "/repo",
          kind: "git-main-worktree",
          source: "selected",
          branch: "main",
          usedByAgent: true,
        },
      ],
      activeWorkspaceId: "path:/repo",
    });
    mockSessionFound({ workingDir: "/repo" });
    mocks.canonicalizeAuthorizedWorkspaceDirectory.mockResolvedValue({
      path: "/repo-wt",
    });

    await dispatchCommand(
      "folders",
      { action: "set_cwd", session_id: "session-1", path: "/repo-wt" },
      ctx,
    );

    expect(
      useChatSessionStore
        .getState()
        .getSession("session-1")
        ?.workspaceAttachments?.filter(
          (attachment) => attachment.source !== "excluded",
        )
        .map((attachment) => attachment.path),
    ).toEqual(["/repo-wt"]);
  });

  it("rolls back a newly attached folder when immediate set-cwd fails", async () => {
    mockSessionFound({ workingDir: "/repo" });
    mocks.canonicalizeAuthorizedWorkspaceDirectory.mockResolvedValue({
      path: "/repo-wt",
    });
    mocks.updateWorkingDir.mockRejectedValueOnce(
      new Error("backend rejected cwd"),
    );

    await expect(
      dispatchCommand(
        "folders",
        { action: "set_cwd", session_id: "session-1", path: "/repo-wt" },
        ctx,
      ),
    ).rejects.toThrow("backend rejected cwd");

    expect(
      useChatSessionStore
        .getState()
        .getSession("session-1")
        ?.workspaceAttachments?.some(
          (attachment) => attachment.path === "/repo-wt",
        ),
    ).not.toBe(true);
  });

  it("rolls back only set-cwd state when the immediate update fails", async () => {
    setMultiWorkspaceEnabled(false);
    seedSessions({
      ...makeSession({ workingDir: "/repo" }),
      workspaceAttachments: [
        {
          id: "path:/repo",
          path: "/repo",
          kind: "git-main-worktree",
          source: "selected",
          branch: "main",
          usedByAgent: true,
        },
      ],
      activeWorkspaceId: "path:/repo",
    });
    useChatSessionStore.getState().setActiveWorkspace("session-1", {
      path: "/repo",
      branch: "main",
    });
    mockSessionFound({ workingDir: "/repo" });
    mocks.canonicalizeAuthorizedWorkspaceDirectory.mockResolvedValue({
      path: "/repo-wt",
    });
    mocks.updateWorkingDir.mockImplementationOnce(async () => {
      useChatSessionStore.getState().attachWorkspace("session-1", {
        path: "/concurrent",
        source: "inferred",
        usedByAgent: true,
      });
      throw new Error("backend rejected cwd");
    });

    await expect(
      dispatchCommand(
        "folders",
        { action: "set_cwd", session_id: "session-1", path: "/repo-wt" },
        ctx,
      ),
    ).rejects.toThrow("backend rejected cwd");

    const state = useChatSessionStore.getState();
    expect(
      state
        .getSession("session-1")
        ?.workspaceAttachments?.filter(
          (attachment) => attachment.source !== "excluded",
        )
        .map((attachment) => attachment.path),
    ).toEqual(expect.arrayContaining(["/repo", "/concurrent"]));
    expect(
      state
        .getSession("session-1")
        ?.workspaceAttachments?.some(
          (attachment) => attachment.path === "/repo-wt",
        ),
    ).not.toBe(true);
    expect(state.activeWorkspaceBySession["session-1"]).toMatchObject({
      path: "/repo",
      branch: "main",
    });
  });

  it("preserves a newer set-cwd attachment when an older activation fails", async () => {
    setMultiWorkspaceEnabled(false);
    seedSessions({
      ...makeSession({ workingDir: "/repo" }),
      workspaceAttachments: [
        {
          id: "path:/repo",
          path: "/repo",
          kind: "git-main-worktree",
          source: "selected",
          branch: "main",
          usedByAgent: true,
        },
      ],
      activeWorkspaceId: "path:/repo",
    });
    useChatSessionStore.getState().setActiveWorkspace("session-1", {
      path: "/repo",
      branch: "main",
    });
    mockSessionFound({ workingDir: "/repo" });
    queueSessionWorkspaceActivation({
      sessionId: "session-1",
      path: "/older",
      branch: "older",
    });
    let rejectOlder: ((error: Error) => void) | undefined;
    mocks.updateWorkingDir.mockImplementationOnce(
      () =>
        new Promise<void>((_resolve, reject) => {
          rejectOlder = reject;
        }),
    );
    const olderActivation = applyPendingSessionWorkspaceActivation("session-1");
    await vi.waitFor(() => expect(rejectOlder).toBeTypeOf("function"));
    mocks.canonicalizeAuthorizedWorkspaceDirectory.mockResolvedValue({
      path: "/repo-wt",
    });

    const newerSetCwd = dispatchCommand(
      "folders",
      { action: "set_cwd", session_id: "session-1", path: "/repo-wt" },
      ctx,
    );
    await vi.waitFor(() =>
      expect(getPendingSessionWorkspaceActivation("session-1")).toMatchObject({
        path: "/repo-wt",
      }),
    );
    rejectOlder?.(new Error("older activation failed"));

    await expect(olderActivation).rejects.toThrow("older activation failed");
    await expect(newerSetCwd).rejects.toThrow("older activation failed");
    expect(getPendingSessionWorkspaceActivation("session-1")).toMatchObject({
      path: "/repo-wt",
    });
    expect(
      useChatSessionStore
        .getState()
        .getSession("session-1")
        ?.workspaceAttachments?.some(
          (attachment) => attachment.path === "/repo-wt",
        ),
    ).toBe(true);
    expect(
      useChatSessionStore.getState().activeWorkspaceBySession["session-1"],
    ).toMatchObject({ path: "/repo-wt" });
  });

  it("set-cwd queues safely while the chat is running", async () => {
    mockSessionFound({ workingDir: "/repo" });
    useChatStore.getState().setChatState("session-1", "streaming");
    mocks.canonicalizeAuthorizedWorkspaceDirectory.mockResolvedValue({
      path: "/repo-wt",
    });
    mocks.getGitState.mockResolvedValue({
      isGitRepo: true,
      currentBranch: "feature",
      dirtyFileCount: 0,
      incomingCommitCount: 0,
      worktrees: [],
      isWorktree: true,
      mainWorktreePath: "/repo",
      localBranches: ["main", "feature"],
    });

    await expect(
      dispatchCommand(
        "folders",
        { action: "set_cwd", session_id: "session-1", path: "/repo-wt" },
        ctx,
      ),
    ).resolves.toMatchObject({ status: "pending" });
    expect(mocks.updateWorkingDir).not.toHaveBeenCalled();
    expect(getPendingSessionWorkspaceActivation("session-1")).toMatchObject({
      path: "/repo-wt",
    });
  });

  it("does not detach an unverifiable path", async () => {
    mockSessionFound({ workingDir: "/repo" });
    mocks.canonicalizeAuthorizedWorkspaceDirectory.mockRejectedValue(
      new Error("outside allowed filesystem"),
    );

    await expectCommandError(
      dispatchCommand(
        "folders",
        { action: "detach", session_id: "session-1", path: "/private" },
        ctx,
      ),
      "invalid_args",
    );
  });
});

describe("projects", () => {
  it("create uses app defaults and returns the project identity", async () => {
    mocks.createProject.mockResolvedValue(makeProject({ id: "p-new" }));

    const result = await dispatchCommand(
      "projects",
      {
        action: "create",
        name: "My Project",
        instructions: "Be careful",
        working_dir: ["/work", "/docs"],
      },
      ctx,
    );

    expect(mocks.createProject).toHaveBeenCalledWith(
      "My Project",
      "",
      "Be careful",
      DEFAULT_PROJECT_ICON,
      DEFAULT_PROJECT_COLOR,
      ["/work", "/docs"],
      false,
      undefined,
    );
    expect(result).toEqual({ project_id: "p-new" });
  });

  it("list refetches from the backend and excludes archived projects", async () => {
    // Stale cache that the refetch must replace.
    useProjectStore.setState({ projects: [makeProject({ id: "stale" })] });
    mocks.listProjects.mockResolvedValue([
      makeProject({ id: "p-1", name: "Active" }),
      makeProject({
        id: "p-2",
        name: "Archived",
        archivedAt: "2026-04-01T00:00:00.000Z",
      }),
    ]);

    const result = await dispatchCommand("projects", { action: "list" }, ctx);

    expect(result).toEqual({
      projects: [
        {
          project_id: "p-1",
          name: "Active",
          description: "A test project",
          working_dirs: ["/projects/one"],
        },
      ],
    });
  });

  it("list throws backend_read_failed when the backend project read fails", async () => {
    const staleProject = makeProject({ id: "stale" });
    useProjectStore.setState({
      projects: [staleProject],
      hasFetchedProjects: false,
    });
    mocks.listProjects.mockRejectedValue(new Error("backend down"));

    await expectCommandError(
      dispatchCommand("projects", { action: "list" }, ctx),
      "backend_read_failed",
    );

    expect(useProjectStore.getState().hasFetchedProjects).toBe(false);
    expect(useProjectStore.getState().projects).toEqual([staleProject]);
  });

  it("get returns the project's details and live session count", async () => {
    const project = makeProject({
      id: "p-1",
      prompt: "Use feature branches only",
      chatGroups: {
        groups: [{ id: "group-1", name: "Launch", chatIds: ["s-1", "s-4"] }],
      },
    });
    useProjectStore.setState({
      projects: [project],
      hasFetchedProjects: true,
    });
    mocks.listProjects.mockResolvedValue([project]);
    mockSessionPages(
      {
        sessions: [makeAcpSession({ sessionId: "s-1", projectId: "p-1" })],
        nextCursor: "page-2",
      },
      {
        sessions: [
          makeAcpSession({
            sessionId: "s-2",
            projectId: "p-1",
            archivedAt: "2026-04-01T00:00:00.000Z",
          }),
          makeAcpSession({ sessionId: "s-3", projectId: "other" }),
          makeAcpSession({ sessionId: "s-4", projectId: "p-1" }),
        ],
        nextCursor: null,
      },
    );

    const result = await dispatchCommand(
      "projects",
      { action: "get", project_id: "p-1" },
      ctx,
    );

    expect(result).toEqual({
      project_id: "p-1",
      name: "Project One",
      description: "A test project",
      instructions: "Use feature branches only",
      working_dirs: ["/projects/one"],
      workspaces: [],
      archived: false,
      session_count: 2,
      chat_groups: [
        {
          group_id: "group-1",
          name: "Launch",
          session_ids: ["s-1", "s-4"],
        },
      ],
    });
    expect(mocks.acpListSessionsPage).toHaveBeenCalledTimes(2);
  });

  it("get returns canonical group session ids still assigned to the project", async () => {
    const project = makeProject({
      id: "p-1",
      chatGroups: {
        groups: [
          {
            id: "group-1",
            name: "Launch",
            chatIds: [
              "client-session-1",
              "archived-session",
              "moved-session",
              "missing-session",
            ],
          },
        ],
      },
    });
    mocks.listProjects.mockResolvedValue([project]);
    seedSessions(
      makeSession({
        id: "canonical-session-1",
        clientSessionId: "client-session-1",
        projectId: "p-1",
      }),
    );
    mockSessionPages({
      sessions: [
        makeAcpSession({ sessionId: "canonical-session-1", projectId: "p-1" }),
        makeAcpSession({
          sessionId: "archived-session",
          projectId: "p-1",
          archivedAt: "2026-04-01T00:00:00.000Z",
        }),
        makeAcpSession({ sessionId: "moved-session", projectId: "p-2" }),
      ],
      nextCursor: null,
    });

    const result = (await dispatchCommand(
      "projects",
      { action: "get", project_id: "p-1" },
      ctx,
    )) as { chat_groups: Array<{ session_ids: string[] }> };

    expect(result.chat_groups).toEqual([
      {
        group_id: "group-1",
        name: "Launch",
        session_ids: ["canonical-session-1"],
      },
    ]);
  });

  it("archive archives through the API and refetches the project list", async () => {
    const project = makeProject({ id: "p-1" });
    useProjectStore.setState({
      projects: [project],
      hasFetchedProjects: true,
    });
    mocks.archiveProject.mockResolvedValue(undefined);
    mocks.listProjects
      .mockResolvedValueOnce([project])
      // The post-archive refetch no longer returns the archived project.
      .mockResolvedValueOnce([]);

    const result = await dispatchCommand(
      "projects",
      { action: "archive", project_id: "p-1" },
      ctx,
    );

    expect(mocks.archiveProject).toHaveBeenCalledWith("p-1");
    expect(result).toEqual({ ok: true });
    expect(useProjectStore.getState().projects).toEqual([]);
  });

  it("archive rejects an unknown project before touching the API", async () => {
    const project = makeProject({ id: "p-1" });
    useProjectStore.setState({
      projects: [project],
      hasFetchedProjects: true,
    });
    mocks.listProjects.mockResolvedValue([project]);

    await expectCommandError(
      dispatchCommand(
        "projects",
        { action: "archive", project_id: "missing" },
        ctx,
      ),
      "project_not_found",
    );
    expect(mocks.archiveProject).not.toHaveBeenCalled();
  });

  it("archive maps a backend failure to backend_archive_failed", async () => {
    const project = makeProject({ id: "p-1" });
    useProjectStore.setState({
      projects: [project],
      hasFetchedProjects: true,
    });
    mocks.listProjects.mockResolvedValue([project]);
    mocks.archiveProject.mockRejectedValue(new Error("backend down"));

    const error = await expectCommandError(
      dispatchCommand(
        "projects",
        { action: "archive", project_id: "p-1" },
        ctx,
      ),
      "backend_archive_failed",
    );
    expect(error.message).toContain("berdctl project list");
  });

  describe("set_startup_mode", () => {
    const mainWorkspace = {
      id: "ws-main",
      path: "/projects/repo",
      kind: "git-main-worktree" as const,
      source: "selected" as const,
      branch: "main",
      usedByAgent: false,
      startupMode: "none" as const,
      repositoryPath: "/projects/repo",
      worktreePath: "/projects/repo",
    };
    const docsWorkspace = {
      id: "ws-docs",
      path: "/projects/docs",
      kind: "non-git-directory" as const,
      source: "selected" as const,
      branch: null,
      usedByAgent: false,
      startupMode: "none" as const,
    };

    it("enables isolated worktrees for Git workspaces without changing project folders", async () => {
      const project = makeProject({
        id: "p-1",
        workingDirs: [mainWorkspace.path, docsWorkspace.path],
        projectWorkspaces: [mainWorkspace, docsWorkspace],
      });
      useProjectStore.setState({
        projects: [project],
        hasFetchedProjects: true,
      });
      mocks.listProjects.mockResolvedValue([project]);
      mocks.getGitState
        .mockResolvedValueOnce({
          isGitRepo: true,
          currentBranch: "main",
          dirtyFileCount: 0,
          incomingCommitCount: 0,
          worktrees: [{ path: "/projects/repo", branch: "main", isMain: true }],
          isWorktree: false,
          mainWorktreePath: "/projects/repo",
          localBranches: ["main"],
        })
        .mockResolvedValueOnce({
          isGitRepo: false,
          currentBranch: null,
          dirtyFileCount: 0,
          incomingCommitCount: 0,
          worktrees: [],
          isWorktree: false,
          mainWorktreePath: null,
          localBranches: [],
        });

      const result = await dispatchCommand(
        "projects",
        { action: "set_startup_mode", project_id: "p-1", mode: "worktree" },
        ctx,
      );

      expect(mocks.updateProject).toHaveBeenCalledWith(
        expect.objectContaining({ id: "p-1" }),
        expect.objectContaining({
          workingDirs: ["/projects/repo", "/projects/docs"],
          useWorktrees: true,
          projectWorkspaces: [
            expect.objectContaining({
              id: "ws-main",
              path: "/projects/repo",
              startupMode: "auto-worktree",
            }),
            expect.objectContaining({
              id: "ws-docs",
              path: "/projects/docs",
              startupMode: "none",
            }),
          ],
        }),
      );
      expect(result).toEqual({
        ok: true,
        mode: "auto-worktree",
        workspaces: [
          { path: "/projects/repo", startup_mode: "auto-worktree" },
          { path: "/projects/docs", startup_mode: "none" },
        ],
      });
    });

    it("disables startup behavior without probing Git", async () => {
      const project = makeProject({
        id: "p-1",
        workingDirs: [mainWorkspace.path],
        projectWorkspaces: [{ ...mainWorkspace, startupMode: "worktree" }],
        useWorktrees: true,
      });
      useProjectStore.setState({
        projects: [project],
        hasFetchedProjects: true,
      });
      mocks.listProjects.mockResolvedValue([project]);

      await dispatchCommand(
        "projects",
        { action: "set_startup_mode", project_id: "p-1", mode: "none" },
        ctx,
      );

      expect(mocks.getGitState).not.toHaveBeenCalled();
      expect(mocks.updateProject).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          useWorktrees: false,
          projectWorkspaces: [expect.objectContaining({ startupMode: "none" })],
        }),
      );
    });

    it("migrates legacy branch mode to manual worktree management", async () => {
      const linkedWorkspace = {
        ...mainWorkspace,
        id: "ws-linked",
        path: "/projects/repo-linked",
        kind: "git-linked-worktree" as const,
        branch: "feature",
        worktreePath: "/projects/repo-linked",
      };
      const project = makeProject({
        id: "p-1",
        workingDirs: [mainWorkspace.path, linkedWorkspace.path],
        projectWorkspaces: [mainWorkspace, linkedWorkspace],
      });
      useProjectStore.setState({
        projects: [project],
        hasFetchedProjects: true,
      });
      mocks.listProjects.mockResolvedValue([project]);
      mocks.getGitState.mockImplementation(async (path: string) => ({
        isGitRepo: true,
        currentBranch: path.includes("linked") ? "feature" : "main",
        dirtyFileCount: 0,
        incomingCommitCount: 0,
        worktrees: [
          { path: "/projects/repo", branch: "main", isMain: true },
          {
            path: "/projects/repo-linked",
            branch: "feature",
            isMain: false,
          },
        ],
        isWorktree: path.includes("linked"),
        mainWorktreePath: "/projects/repo",
        localBranches: ["main", "feature"],
      }));

      const result = await dispatchCommand(
        "projects",
        { action: "set_startup_mode", project_id: "p-1", mode: "branch" },
        ctx,
      );

      expect(result).toMatchObject({ mode: "ask-worktree" });
      expect(mocks.updateProject).toHaveBeenCalled();
    });

    it("rejects branch/worktree mode when the project has no Git workspaces", async () => {
      const project = makeProject({
        id: "p-1",
        workingDirs: [docsWorkspace.path],
        projectWorkspaces: [docsWorkspace],
      });
      useProjectStore.setState({
        projects: [project],
        hasFetchedProjects: true,
      });
      mocks.listProjects.mockResolvedValue([project]);
      mocks.getGitState.mockResolvedValue({
        isGitRepo: false,
        currentBranch: null,
        dirtyFileCount: 0,
        incomingCommitCount: 0,
        worktrees: [],
        isWorktree: false,
        mainWorktreePath: null,
        localBranches: [],
      });

      await expectCommandError(
        dispatchCommand(
          "projects",
          { action: "set_startup_mode", project_id: "p-1", mode: "worktree" },
          ctx,
        ),
        "invalid_args",
      );
      expect(mocks.updateProject).not.toHaveBeenCalled();
    });

    it("does not overwrite a project whose folders change during Git inspection", async () => {
      const project = makeProject({
        id: "p-1",
        workingDirs: [mainWorkspace.path],
        projectWorkspaces: [mainWorkspace],
      });
      useProjectStore.setState({
        projects: [project],
        hasFetchedProjects: true,
      });
      mocks.listProjects.mockResolvedValue([project]);
      mocks.getGitState.mockImplementationOnce(async () => {
        useProjectStore.setState({
          projects: [
            makeProject({
              id: "p-1",
              workingDirs: [mainWorkspace.path, docsWorkspace.path],
              projectWorkspaces: [mainWorkspace, docsWorkspace],
            }),
          ],
        });
        return {
          isGitRepo: true,
          currentBranch: "main",
          dirtyFileCount: 0,
          incomingCommitCount: 0,
          worktrees: [],
          isWorktree: false,
          mainWorktreePath: mainWorkspace.path,
          localBranches: ["main"],
        };
      });

      await expectCommandError(
        dispatchCommand(
          "projects",
          { action: "set_startup_mode", project_id: "p-1", mode: "worktree" },
          ctx,
        ),
        "internal_error",
      );
      expect(mocks.updateProject).not.toHaveBeenCalled();
    });

    it("rejects an unknown project", async () => {
      mocks.listProjects.mockResolvedValue([]);
      await expectCommandError(
        dispatchCommand(
          "projects",
          {
            action: "set_startup_mode",
            project_id: "missing",
            mode: "worktree",
          },
          ctx,
        ),
        "project_not_found",
      );
      expect(mocks.getGitState).not.toHaveBeenCalled();
      expect(mocks.updateProject).not.toHaveBeenCalled();
    });
  });
});

describe("agents", () => {
  it("create makes the persona and returns its id", async () => {
    const persona = {
      id: "/agents/reviewer.md",
      displayName: "Reviewer",
      systemPrompt: "Review Kotlin code",
      isBuiltin: false,
      writable: true,
    };
    mocks.createPersona.mockResolvedValue(persona);

    const result = await dispatchCommand(
      "agents",
      {
        action: "create",
        name: "Reviewer",
        system_prompt: "Review Kotlin code",
        provider: "openai",
        model: "gpt-x",
      },
      ctx,
    );

    expect(mocks.createPersona).toHaveBeenCalledWith({
      displayName: "Reviewer",
      systemPrompt: "Review Kotlin code",
      provider: "openai",
      modelProviderId: "openai",
      model: "gpt-x",
    });
    expect(useAgentStore.getState().personas).toEqual([persona]);
    expect(result).toEqual({ agent_id: "/agents/reviewer.md" });
  });

  it("list returns persona identities with summarized prompts", async () => {
    mocks.listPersonas.mockResolvedValue([
      {
        id: "/agents/reviewer.md",
        displayName: "Reviewer",
        systemPrompt: `${"R".repeat(120)}\nSecond line`,
        isBuiltin: false,
        writable: true,
      },
    ]);

    const result = (await dispatchCommand(
      "agents",
      { action: "list" },
      ctx,
    )) as { agents: Array<{ agent_id: string; summary: string }> };

    expect(result.agents).toHaveLength(1);
    expect(result.agents[0].agent_id).toBe("/agents/reviewer.md");
    // First line only, truncated with an ellipsis.
    expect(result.agents[0].summary).toHaveLength(101);
    expect(result.agents[0].summary.endsWith("…")).toBe(true);
  });
});

describe("skills", () => {
  const skill = {
    id: "global:/skills/lint-fixer",
    name: "Lint Fixer",
    description: "Fixes lint errors",
    instructions: "# Lint Fixer\nRun the linter.",
    path: "/skills/lint-fixer",
    fileLocation: "/skills/lint-fixer/SKILL.md",
    sourceKind: "global" as const,
    sourceLabel: "Personal",
    projectLinks: [],
    readonly: false,
    color: null,
  };

  it("create uses the app default color and returns the skill id", async () => {
    mocks.createSkill.mockResolvedValue({ id: "global:/skills/foo" });

    const result = await dispatchCommand(
      "skills",
      {
        action: "create",
        name: "Lint Fixer",
        description: "Fixes lint errors",
        content: "# Lint Fixer\nRun the linter.",
      },
      ctx,
    );

    expect(mocks.createSkill).toHaveBeenCalledWith(
      "Lint Fixer",
      "Fixes lint errors",
      "# Lint Fixer\nRun the linter.",
      resolveSkillPillTone("Lint Fixer"),
    );
    expect(result).toEqual({ skill_id: "global:/skills/foo" });
  });

  it("list returns skill identities without instruction bodies", async () => {
    mocks.listSkills.mockResolvedValue([skill]);

    const result = await dispatchCommand("skills", { action: "list" }, ctx);

    expect(result).toEqual({
      skills: [
        {
          skill_id: "global:/skills/lint-fixer",
          name: "Lint Fixer",
          description: "Fixes lint errors",
          source: "global",
        },
      ],
    });
  });

  it("list scopes project skills to the given project's working dirs", async () => {
    const project = makeProject({ id: "p-1", workingDirs: ["/projects/one"] });
    useProjectStore.setState({
      projects: [project],
      hasFetchedProjects: true,
    });
    mocks.listProjects.mockResolvedValue([project]);

    await dispatchCommand("skills", { action: "list", project_id: "p-1" }, ctx);
    expect(mocks.listSkills).toHaveBeenCalledWith(["/projects/one"]);
  });

  it("get returns the skill including its instructions", async () => {
    mocks.listSkills.mockResolvedValue([skill]);

    const result = await dispatchCommand(
      "skills",
      { action: "get", skill_id: "global:/skills/lint-fixer" },
      ctx,
    );

    expect(result).toEqual({
      skill_id: "global:/skills/lint-fixer",
      name: "Lint Fixer",
      description: "Fixes lint errors",
      source: "global",
      instructions: "# Lint Fixer\nRun the linter.",
    });
  });

  it("get throws skill_not_found for unknown ids", async () => {
    mocks.listSkills.mockResolvedValue([skill]);
    await expectCommandError(
      dispatchCommand("skills", { action: "get", skill_id: "nope" }, ctx),
      "skill_not_found",
    );
  });
});

describe("info", () => {
  it("list_harnesses reports readiness and flags the default", async () => {
    mocks.readinessFromReport.mockReturnValue(
      new Map([
        ["goose", "ready"],
        ["claude-acp", "ready"],
        ["codex-acp", "not_installed"],
      ]),
    );

    const result = await dispatchCommand(
      "info",
      { action: "list_harnesses" },
      ctx,
    );

    expect(result).toEqual({
      harnesses: [
        {
          harness_id: "goose",
          name: "Goose (Default)",
          is_default: true,
          status: "ready",
        },
        {
          harness_id: "claude-acp",
          name: "Claude Code",
          is_default: false,
          status: "ready",
        },
        {
          harness_id: "codex-acp",
          name: "Codex",
          is_default: false,
          status: "not_installed",
        },
      ],
    });
  });

  it("list_models serves the model picker's cache for the requested harness", async () => {
    seedModelCache("codex-acp", ["gpt-6", "gpt-6-mini"]);

    const result = await dispatchCommand(
      "info",
      { action: "list_models", harness_id: "codex-acp" },
      ctx,
    );

    expect(result).toEqual({
      harnesses: [
        {
          harness_id: "codex-acp",
          models: [
            { model_id: "gpt-6", name: "gpt-6" },
            { model_id: "gpt-6-mini", name: "gpt-6-mini" },
          ],
        },
      ],
    });
  });

  it("list_models aggregates the goose harness across model providers", async () => {
    const modelProvider = getModelProviders()[0].id;
    seedModelCache(modelProvider, ["model-a"]);

    const result = await dispatchCommand(
      "info",
      { action: "list_models", harness_id: "goose" },
      ctx,
    );

    expect(result).toEqual({
      harnesses: [
        {
          harness_id: "goose",
          models: [
            { model_id: "model-a", name: "model-a", provider: modelProvider },
          ],
        },
      ],
    });
  });

  it("list_models covers every ready harness when harness_id is omitted", async () => {
    mocks.readinessFromReport.mockReturnValue(
      new Map([
        ["goose", "ready"],
        ["claude-acp", "not_ready"],
        ["codex-acp", "ready"],
      ]),
    );
    seedModelCache("codex-acp", ["gpt-6"]);

    const result = (await dispatchCommand(
      "info",
      { action: "list_models" },
      ctx,
    )) as { harnesses: Array<{ harness_id: string }> };

    // Unready harnesses (claude-acp) are excluded; goose + codex covered.
    expect(result.harnesses.map((h) => h.harness_id)).toEqual([
      "goose",
      "codex-acp",
    ]);
  });

  it("list_models reports a harness that manages its model outside the app as empty with a warning", async () => {
    // amp-acp's catalog entry has supportsModelList: false, so it exposes no
    // model list; the hint surfaces through `warning` instead of an error.
    mocks.discoverAcpProviders.mockResolvedValue([
      { id: "goose", label: "Goose (Default)" },
      { id: "amp-acp", label: "Amp" },
    ]);
    mocks.readinessFromReport.mockReturnValue(
      new Map([
        ["goose", "ready"],
        ["amp-acp", "ready"],
      ]),
    );

    const result = await dispatchCommand(
      "info",
      { action: "list_models", harness_id: "amp-acp" },
      ctx,
    );

    expect(result).toEqual({
      harnesses: [
        {
          harness_id: "amp-acp",
          models: [],
          warning: "Use the Amp CLI to configure the model.",
        },
      ],
    });
  });

  it("list_models rejects unknown and unready harnesses", async () => {
    await expectCommandError(
      dispatchCommand(
        "info",
        { action: "list_models", harness_id: "cursor" },
        ctx,
      ),
      "harness_not_found",
    );

    mocks.readinessFromReport.mockReturnValue(
      new Map([["claude-acp", "not_ready"]]),
    );
    await expectCommandError(
      dispatchCommand(
        "info",
        { action: "list_models", harness_id: "claude-acp" },
        ctx,
      ),
      "harness_not_ready",
    );
  });

  it("get_context reports app and active voice context", async () => {
    controller.getAppContext.mockReturnValue({
      view: "chat",
      activeSessionId: "session-2",
      activeProjectId: "project-9",
    });
    mocks.getVoiceConversationStatus.mockResolvedValue({
      available: true,
      unavailableReason: null,
      lifecycle: "running",
      sessionId: "session-2",
      ownerWindowLabel: "main",
      microphoneMuted: false,
      revision: 4,
    });

    const result = (await dispatchCommand(
      "info",
      { action: "get_context" },
      ctx,
    )) as {
      view: string;
      active_session_id: string | null;
      active_project_id: string | null;
      voice_session_active: boolean;
      app_version: string;
    };

    expect(result.view).toBe("chat");
    expect(result.active_session_id).toBe("session-2");
    expect(result.active_project_id).toBe("project-9");
    expect(result.voice_session_active).toBe(true);
    expect(result.app_version.length).toBeGreaterThan(0);
  });

  it("get_context preserves voice activity that starts during native refresh", async () => {
    let resolveStatus!: (status: {
      available: boolean;
      unavailableReason: null;
      lifecycle: "stopped";
      sessionId: null;
      ownerWindowLabel: null;
      microphoneMuted: boolean;
      revision: number;
    }) => void;
    mocks.getVoiceConversationStatus.mockReturnValue(
      new Promise((resolve) => {
        resolveStatus = resolve;
      }),
    );

    const contextRequest = dispatchCommand(
      "info",
      { action: "get_context" },
      ctx,
    );
    await vi.waitFor(() => {
      expect(mocks.getVoiceConversationStatus).toHaveBeenCalledOnce();
    });
    useVoiceConversationStore.setState({
      status: {
        available: true,
        unavailableReason: null,
        lifecycle: "running",
        sessionId: "session-2",
        ownerWindowLabel: "main",
        microphoneMuted: false,
        revision: 5,
      },
      uiState: "listening",
    });
    resolveStatus({
      available: false,
      unavailableReason: null,
      lifecycle: "stopped",
      sessionId: null,
      ownerWindowLabel: null,
      microphoneMuted: false,
      revision: 4,
    });

    await expect(contextRequest).resolves.toMatchObject({
      voice_session_active: true,
    });
  });

  it("get_context ignores renderer activity older than native voice state", async () => {
    useVoiceConversationStore.setState({
      status: {
        available: true,
        unavailableReason: null,
        lifecycle: "running",
        sessionId: "session-2",
        ownerWindowLabel: "main",
        microphoneMuted: false,
        revision: 3,
      },
      uiState: "listening",
    });
    mocks.getVoiceConversationStatus.mockResolvedValue({
      available: true,
      unavailableReason: null,
      lifecycle: "stopped",
      sessionId: null,
      ownerWindowLabel: null,
      microphoneMuted: false,
      revision: 4,
    });

    await expect(
      dispatchCommand("info", { action: "get_context" }, ctx),
    ).resolves.toMatchObject({ voice_session_active: false });
  });
});

describe("feedback schemas", () => {
  it("requires bounded report content and defaults diagnostics off", () => {
    for (const action of ["open", "submit"] as const) {
      const schema = ALL_TOOL_GROUPS.feedback.actions[action].schema;
      expect(
        schema.safeParse({ title: "Bug", description: "Details" }),
      ).toMatchObject({ success: true, data: { include_logs: false } });
      expect(
        schema.safeParse({ title: "", description: "Details" }).success,
      ).toBe(false);
      expect(
        schema.safeParse({ title: "Bug", description: "x".repeat(50_001) })
          .success,
      ).toBe(false);
    }
  });
});

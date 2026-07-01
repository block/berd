import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  clearAppNavigationController,
  registerAppNavigationController,
} from "@/features/berdctl/bridge/appNavigationController";
import {
  dispatchCommand,
  TOOL_GROUPS,
} from "@/features/berdctl/commands/registry";
import {
  CommandError,
  type AppCommand,
} from "@/features/berdctl/commands/types";
import { useAgentStore } from "@/features/agents/stores/agentStore";
import { DEFAULT_CHAT_TITLE } from "@/features/chat/lib/sessionTitle";
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
import { resolveSkillPillTone } from "@/features/skills/lib/resolveSkillPillTone";
import type { AcpSessionInfo, AcpSessionsPage } from "@/shared/api/acp";
import { getTextContent } from "@/shared/types/messages";

const mocks = vi.hoisted(() => ({
  acpCreateSession: vi.fn(),
  acpDuplicateSession: vi.fn(),
  acpListSessionsPage: vi.fn(),
  acpPrepareSession: vi.fn(),
  acpSendMessage: vi.fn(),
  acpSetModel: vi.fn(),
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
  resolveSessionCwd: vi.fn(),
  createPersona: vi.fn(),
  listPersonas: vi.fn(),
  createSkill: vi.fn(),
  listSkills: vi.fn(),
}));

vi.mock("@/shared/api/acp", () => ({
  acpCreateSession: (...args: unknown[]) => mocks.acpCreateSession(...args),
  acpDuplicateSession: (...args: unknown[]) =>
    mocks.acpDuplicateSession(...args),
  acpListSessionsPage: (...args: unknown[]) =>
    mocks.acpListSessionsPage(...args),
  acpPrepareSession: (...args: unknown[]) => mocks.acpPrepareSession(...args),
  acpSendMessage: (...args: unknown[]) => mocks.acpSendMessage(...args),
  acpSetModel: (...args: unknown[]) => mocks.acpSetModel(...args),
  acpSteerMessage: (...args: unknown[]) => mocks.acpSteerMessage(...args),
  discoverAcpProviders: (...args: unknown[]) =>
    mocks.discoverAcpProviders(...args),
}));

vi.mock("@/shared/api/acpApi", () => ({
  archiveSession: vi.fn(),
  unarchiveSession: vi.fn(),
  renameSession: vi.fn().mockResolvedValue(undefined),
  updateSessionProject: vi.fn().mockResolvedValue(undefined),
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

vi.mock("@/features/projects/api/projects", () => ({
  listProjects: (...args: unknown[]) => mocks.listProjects(...args),
  createProject: (...args: unknown[]) => mocks.createProject(...args),
  archiveProject: (...args: unknown[]) => mocks.archiveProject(...args),
  updateProject: vi.fn(),
  deleteProject: vi.fn(),
  reorderProjects: vi.fn(),
}));

vi.mock("@/features/projects/lib/sessionCwdSelection", () => ({
  resolveSessionCwd: (...args: unknown[]) => mocks.resolveSessionCwd(...args),
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
  archiveSessionWithCleanup: vi.fn(),
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
  mockSessionPages({
    sessions: [makeAcpSession({ sessionId: "session-1", ...overrides })],
    nextCursor: null,
  });
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

  vi.clearAllMocks();
  mocks.resolveSessionCwd.mockResolvedValue("/resolved/cwd");
  mocks.acpCreateSession.mockResolvedValue({ sessionId: "session-new" });
  mocks.acpPrepareSession.mockResolvedValue(undefined);
  mocks.acpSendMessage.mockResolvedValue(undefined);
  mocks.acpSetModel.mockResolvedValue(undefined);
  mocks.acpSteerMessage.mockResolvedValue("run-steered");
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
  mocks.updateSessionTitle.mockResolvedValue(undefined);
  mocks.moveSessionToProject.mockResolvedValue(undefined);

  controller.openSession.mockResolvedValue({ ok: true });
  controller.archiveSessionWithCleanup.mockResolvedValue({ ok: true });
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
      "sessions.clear_project": { session_id: "s1" },
      "sessions.fork": { session_id: "s1" },
      "sessions.archive": { session_id: "s1" },
      "projects.create": { name: "Project" },
      "projects.list": {},
      "projects.get": { project_id: "p1" },
      "projects.archive": { project_id: "p1" },
      "agents.create": { name: "Agent", system_prompt: "Be helpful" },
      "agents.list": {},
      "skills.create": { name: "Skill", description: "Does X", content: "#" },
      "skills.list": {},
      "skills.get": { skill_id: "global:/skills/x" },
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
  it("keeps every no-auth command non-destructive and visible when mutating", () => {
    for (const [groupName, group] of Object.entries(TOOL_GROUPS)) {
      for (const [actionName, command] of Object.entries(group.actions)) {
        const key = `${groupName}.${actionName}`;
        const metadata = command as AppCommand<unknown, unknown>;

        expect(metadata.destructive, `${key} destructive`).toBe(false);
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
  it("creates the session, sends the prompt in the background, and does not navigate", async () => {
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
      },
      ctx,
    );

    expect(mocks.resolveSessionCwd).toHaveBeenCalledWith(null);
    expect(mocks.acpCreateSession).toHaveBeenCalledWith(
      "goose",
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

    // Fire-and-forget: the user message is recorded and the send dispatched,
    // but nothing was opened and nothing was queued for a ChatView to flush.
    const messages = useChatStore.getState().messagesBySession["session-new"];
    expect(messages).toHaveLength(1);
    expect(getTextContent(messages[0])).toBe("what is 1+1");
    expect(controller.openSession).not.toHaveBeenCalled();
    expect(
      useChatStore.getState().queuedMessageBySession["session-new"],
    ).toBeUndefined();
    // The pending-assistant hint is the new session's provider, not the
    // foreground active agent's.
    expect(
      useChatStore.getState().getSessionRuntime("session-new")
        .pendingAssistantProviderId,
    ).toBe("goose");
    await vi.waitFor(() => {
      expect(mocks.acpSendMessage).toHaveBeenCalledWith(
        "session-new",
        "what is 1+1",
        expect.objectContaining({
          personaId: "agent-7",
          personaName: "Reviewer",
          systemPrompt: "Review the work carefully.",
        }),
      );
    });
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

  it("reports a failed background send on the session instead of rejecting", async () => {
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    mocks.acpSendMessage.mockRejectedValue(new Error("provider down"));

    const result = (await dispatchCommand(
      "sessions",
      { action: "create", prompt: "hi" },
      ctx,
    )) as { send_status: string };

    expect(result.send_status).toBe("dispatched");
    await vi.waitFor(() => {
      const runtime = useChatStore.getState().getSessionRuntime("session-new");
      expect(runtime.error).toContain("provider down");
      expect(runtime.chatState).toBe("idle");
      // A stale streaming id would make the session's next turn stream into
      // this turn's assistant message.
      expect(runtime.streamingMessageId).toBeNull();
    });
    consoleError.mockRestore();
  });

  it("does not create when validation stalls past the broker deadline", async () => {
    // findReadyHarnessOrThrow consults the doctor; stall it past the deadline.
    const start = Date.now();
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(start);
    mocks.runDoctor.mockImplementation(async () => {
      nowSpy.mockReturnValue(start + 120_000);
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
    expect(mocks.acpPrepareSession).toHaveBeenCalledWith(
      "session-1",
      "codex-acp",
      "/resolved/cwd",
    );
    expect(mocks.acpSetModel).toHaveBeenCalledWith("session-1", "gpt-6");
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
          systemPrompt: "Review the work carefully.",
          goose: { origin: "berdctl_cross_session" },
        }),
      );
    });
  });

  it("refuses a running target by default", async () => {
    mockSessionFound();
    useChatStore.getState().setChatState("session-1", "streaming");

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

  it("steers a running target with provenance metadata", async () => {
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
    expect(messages[0]?.metadata).toMatchObject({
      delivery: "steer",
      origin: "berdctl_cross_session",
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

  it("queues one running-target prompt and reports queue_full for a second", async () => {
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
    expect(useChatStore.getState().queuedMessageBySession["session-1"]).toEqual(
      {
        text: "next prompt",
        sendOptions: {
          userMessageMetadata: { origin: "berdctl_cross_session" },
          acpGooseMetadata: { origin: "berdctl_cross_session" },
        },
      },
    );

    mockSessionFound();
    await expectCommandError(
      dispatchCommand(
        "sessions",
        {
          action: "send",
          session_id: "session-1",
          prompt: "another prompt",
          if_running: "queue",
        },
        ctx,
      ),
      "queue_full",
    );
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

  it("loads session pages until the target session is found", async () => {
    mockSessionPages(
      {
        sessions: [makeAcpSession({ sessionId: "older-session" })],
        nextCursor: "page-2",
      },
      {
        sessions: [makeAcpSession({ sessionId: "session-1" })],
        nextCursor: "page-3",
      },
      {
        sessions: [makeAcpSession({ sessionId: "newer-session" })],
        nextCursor: null,
      },
    );

    await dispatchCommand(
      "sessions",
      { action: "open", session_id: "session-1" },
      ctx,
    );

    expect(mocks.acpListSessionsPage).toHaveBeenCalledTimes(2);
    expect(mocks.acpListSessionsPage).toHaveBeenNthCalledWith(1, {
      cursor: null,
    });
    expect(mocks.acpListSessionsPage).toHaveBeenNthCalledWith(2, {
      cursor: "page-2",
    });
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

    const result = await dispatchCommand("sessions", { action: "list" }, ctx);

    expect(mocks.acpListSessionsPage).toHaveBeenCalledTimes(1);
    expect(result).toEqual({
      sessions: [
        {
          session_id: "session-a",
          title: "Loaded Session",
          project_id: null,
          updated_at: "2026-04-02T00:00:00.000Z",
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
      message_count: 2,
    });
    expect(mocks.lastSessionMessages).not.toHaveBeenCalled();
  });

  it("finds sessions beyond the first backend page", async () => {
    mockSessionPages(
      {
        sessions: [makeAcpSession({ sessionId: "s-first" })],
        nextCursor: "page-2",
      },
      {
        sessions: [
          makeAcpSession({
            sessionId: "session-1",
            title: "Loaded Late",
            projectId: "p-1",
          }),
        ],
        nextCursor: null,
      },
    );

    const result = await dispatchCommand(
      "sessions",
      { action: "get", session_id: "session-1" },
      ctx,
    );

    expect(mocks.acpListSessionsPage).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({
      session_id: "session-1",
      title: "Loaded Late",
      project_id: "p-1",
    });
  });

  it("does not validate a target from stale cache unless a fetched page confirms it", async () => {
    seedSessions(makeSession({ id: "session-1", title: "Stale Session" }));
    mockSessionPages(
      {
        sessions: [makeAcpSession({ sessionId: "other-session" })],
        nextCursor: "page-2",
      },
      {
        sessions: [],
        nextCursor: null,
      },
    );

    await expectCommandError(
      dispatchCommand(
        "sessions",
        { action: "get", session_id: "session-1" },
        ctx,
      ),
      "session_not_found",
    );
    expect(mocks.acpListSessionsPage).toHaveBeenCalledTimes(2);
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
    expect(controller.archiveSessionWithCleanup).not.toHaveBeenCalled();
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
    expect(controller.archiveSessionWithCleanup).not.toHaveBeenCalled();
  });

  it("archives through the facade", async () => {
    mockSessionFound({ title: "Old Chat" });

    const result = await dispatchCommand(
      "sessions",
      { action: "archive", session_id: "session-1" },
      ctx,
    );

    expect(controller.archiveSessionWithCleanup).toHaveBeenCalledWith(
      "session-1",
    );
    expect(result).toEqual({ ok: true });
  });

  it("maps a failed facade outcome to a CommandError with its reason code", async () => {
    mockSessionFound();
    controller.archiveSessionWithCleanup.mockResolvedValue({
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

describe("projects", () => {
  it("create uses app defaults and returns the project identity", async () => {
    mocks.createProject.mockResolvedValue(makeProject({ id: "p-new" }));

    const result = await dispatchCommand(
      "projects",
      {
        action: "create",
        name: "My Project",
        instructions: "Be careful",
        working_dir: "/work",
      },
      ctx,
    );

    expect(mocks.createProject).toHaveBeenCalledWith(
      "My Project",
      "",
      "Be careful",
      DEFAULT_PROJECT_ICON,
      DEFAULT_PROJECT_COLOR,
      ["/work"],
      false,
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
      archived: false,
      session_count: 2,
    });
    expect(mocks.acpListSessionsPage).toHaveBeenCalledTimes(2);
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
        provider: "goose",
        model: "gpt-x",
      },
      ctx,
    );

    expect(mocks.createPersona).toHaveBeenCalledWith({
      displayName: "Reviewer",
      systemPrompt: "Review Kotlin code",
      provider: "goose",
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

  it("get_context reports the app context from the navigation controller", async () => {
    controller.getAppContext.mockReturnValue({
      view: "chat",
      activeSessionId: "session-2",
      activeProjectId: "project-9",
    });

    const result = (await dispatchCommand(
      "info",
      { action: "get_context" },
      ctx,
    )) as {
      view: string;
      active_session_id: string | null;
      active_project_id: string | null;
      app_version: string;
    };

    expect(result.view).toBe("chat");
    expect(result.active_session_id).toBe("session-2");
    expect(result.active_project_id).toBe("project-9");
    expect(result.app_version.length).toBeGreaterThan(0);
  });
});

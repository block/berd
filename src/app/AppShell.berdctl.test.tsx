import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAgentStore } from "@/features/agents/stores/agentStore";
import {
  getAppNavigationController,
  type CommandOutcome,
} from "@/features/berdctl/navigation";
import { useChatStore } from "@/features/chat/stores/chatStore";
import { gooseServeSelectionFromExecutionTarget } from "@/features/chat/lib/gooseServeExecutionTarget";
import { useChatSessionStore } from "@/features/chat/stores/chatSessionStore";
import type { ChatSession } from "@/features/chat/stores/chatSessionStore";
import { useProjectStore } from "@/features/projects/stores/projectStore";
import { dispatchOnboarding } from "@/features/onboarding/model";
import { useShortcutsDialogStore } from "@/features/shortcuts/stores/shortcutsDialogStore";
import { useRuntimeConfigStore } from "@/shared/runtime-config/runtimeConfigStore";
import { useDefaultProviderReadinessStore } from "@/features/providers/stores/defaultProviderReadinessStore";
import {
  DEFAULT_RUNTIME_CONFIG,
  type RuntimeConfig,
} from "@/shared/runtime-config/schema";
import type { NavigationPanesViewProps } from "@/app/views/NavigationPanesView";
import { AppShell } from "./AppShell";
import type { AppShellContent as AppShellContentType } from "./ui/AppShellContent";

const mockAcpCreateSession = vi.hoisted(() => vi.fn());
const mockAcpListSessionsPage = vi.hoisted(() => vi.fn());
const mockAcpLoadSession = vi.hoisted(() => vi.fn());
const mockAcpArchiveSession = vi.hoisted(() => vi.fn());
const mockCheckDirectoriesExist = vi.hoisted(() => vi.fn());
const mockCreatePersonaSource = vi.hoisted(() => vi.fn());
const mockListPersonaSources = vi.hoisted(() => vi.fn());
const mockReadAgentSourceFile = vi.hoisted(() => vi.fn());
const mockDeletePersonaSource = vi.hoisted(() => vi.fn());
const mockLoadSessionMessages = vi.hoisted(() => vi.fn());
const mockToastError = vi.hoisted(() => vi.fn());

vi.mock(
  "@/features/voice-conversation/api/voiceConversation",
  async (importOriginal) => ({
    ...(await importOriginal<
      typeof import("@/features/voice-conversation/api/voiceConversation")
    >()),
    blockNativeVoiceConversationStarts: vi
      .fn()
      .mockResolvedValue("archive-token"),
    releaseNativeVoiceConversationStartBlock: vi
      .fn()
      .mockResolvedValue(undefined),
    setVoiceConversationForegroundSession: vi.fn().mockResolvedValue(undefined),
  }),
);

vi.mock("sonner", () => ({
  toast: {
    error: (...args: unknown[]) => mockToastError(...args),
  },
}));

vi.mock("@/shared/lib/platform", () => ({
  getPlatform: () => "mac",
}));

vi.mock("./hooks/useAppStartup", () => ({
  useAppStartup: () => ({ ready: true }),
}));

vi.mock("@/features/migration/hooks/useMigrationGate", () => ({
  useMigrationGate: () => ({ status: "ready", retry: vi.fn() }),
}));

vi.mock("@/features/migration/hooks/useDefaultModelGate", () => ({
  useDefaultModelGate: () => ({ status: "ok", retry: vi.fn() }),
}));

vi.mock("@/app/views/NavigationPanesView", () => ({
  NavigationPanesView: ({
    onNavigate,
    onSettingsClick,
  }: NavigationPanesViewProps) => (
    <nav aria-label="mock sidebar">
      <button type="button" onClick={() => onNavigate?.("skills")}>
        Sidebar skills
      </button>
      <button type="button" onClick={() => onNavigate?.("automations")}>
        Sidebar automations
      </button>
      <button type="button" onClick={() => onNavigate?.("agents")}>
        Sidebar agents
      </button>
      <button type="button" onClick={onSettingsClick}>
        Sidebar settings
      </button>
    </nav>
  ),
}));

vi.mock("@/shared/api/acp", () => ({
  acpCreateSession: (...args: unknown[]) => mockAcpCreateSession(...args),
  acpListSessionsPage: (...args: unknown[]) => mockAcpListSessionsPage(...args),
  acpLoadSession: (...args: unknown[]) => mockAcpLoadSession(...args),
  discoverAcpProviders: vi.fn().mockResolvedValue([]),
}));

vi.mock("@/shared/api/acpApi", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/shared/api/acpApi")>();
  return {
    ...actual,
    archiveSession: (...args: unknown[]) => mockAcpArchiveSession(...args),
  };
});

vi.mock("@/features/chat/lib/sessionActivation", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("@/features/chat/lib/sessionActivation")
    >();
  return {
    ...actual,
    loadSessionMessages: (...args: unknown[]) =>
      mockLoadSessionMessages(...args),
    loadSessionMessagesAndPrepare: (...args: unknown[]) =>
      mockLoadSessionMessages(...args),
  };
});

vi.mock("@/shared/api/agents", () => ({
  createPersonaSource: (...args: unknown[]) => mockCreatePersonaSource(...args),
  listPersonaSources: (...args: unknown[]) => mockListPersonaSources(...args),
  readAgentSourceFile: (...args: unknown[]) => mockReadAgentSourceFile(...args),
  deletePersonaSource: (...args: unknown[]) => mockDeletePersonaSource(...args),
  promotePersonaSource: vi.fn().mockResolvedValue(null),
}));

vi.mock("@/shared/api/pathResolver", () => ({
  resolvePath: async ({ parts }: { parts: string[] }) => ({
    path: parts.join("/") || "/tmp",
  }),
  checkDirectoriesExist: (...args: unknown[]) =>
    mockCheckDirectoriesExist(...args),
}));

vi.mock("@/features/updates/ui/UpdateButton", () => ({
  UpdateButton: () => null,
}));

vi.mock("@/features/updates/ui/ChannelSwitchDialog", () => ({
  ChannelSwitchDialog: () => null,
}));

vi.mock("@/features/updates/ui/BetaBadge", () => ({
  BetaBadge: () => null,
}));

vi.mock("@/features/providers/hooks/useAgentProviderStatus", () => ({
  useAgentProviderStatus: () => ({
    readyAgentIds: new Set(["goose"]),
    agentReadiness: new Map([["goose", "ready"]]),
    agentChecks: new Map(),
    loading: false,
    refresh: vi.fn().mockResolvedValue(undefined),
  }),
}));

vi.mock("./ui/AppShellContent", () => ({
  AppShellContent: (({
    targetLocation,
    onNavigateAutomations,
    onAutomationBuilderLeaveActionChange,
    onCreatePersona,
    onArchiveChat,
  }) => {
    const activeView = targetLocation.view;
    const activeAutomationsRoute =
      targetLocation.view === "automations"
        ? targetLocation.route
        : { surface: "overview" };

    return (
      <section>
        <div data-testid="active-view">{activeView}</div>
        <button type="button" onClick={() => onArchiveChat("session-1")}>
          Archive session
        </button>
        <button
          type="button"
          onClick={() =>
            onNavigateAutomations({
              surface: "builder",
              automationId: "automation-1",
            })
          }
        >
          Open automation builder
        </button>
        {activeView === "automations" &&
        activeAutomationsRoute.surface === "builder" ? (
          <button
            type="button"
            onClick={() =>
              onAutomationBuilderLeaveActionChange?.({
                hasUnsavedChanges: true,
                save: async () => true,
                discard: () => {},
              })
            }
          >
            Mark automation edits unsaved
          </button>
        ) : null}
        {activeView === "agents" ? (
          <button type="button" onClick={onCreatePersona}>
            Create agent
          </button>
        ) : null}
      </section>
    );
  }) satisfies typeof AppShellContentType,
}));

function makeSession(overrides: Partial<ChatSession> = {}): ChatSession {
  const now = "2026-06-09T00:00:00.000Z";
  return {
    id: "session-1",
    title: "Calling chat",
    executionTarget: { harnessId: "goose" },
    workingDir: "/tmp/session-1",
    createdAt: now,
    updatedAt: now,
    messageCount: 1,
    ...overrides,
  };
}

function setReadyRuntimeConfig(config: RuntimeConfig = DEFAULT_RUNTIME_CONFIG) {
  useRuntimeConfigStore.setState({
    loaded: true,
    result: {
      status: "ready",
      source: "fakeEndpoint",
      config,
    },
    config,
  });
}

/** Starts a controller command inside act() so prompt-open state updates flush. */
function startCommand(
  start: () => Promise<CommandOutcome>,
): Promise<CommandOutcome> {
  let outcome!: Promise<CommandOutcome>;
  act(() => {
    outcome = start();
  });
  return outcome;
}

async function runCommand(
  start: () => Promise<CommandOutcome>,
): Promise<CommandOutcome> {
  let outcome!: CommandOutcome;
  await act(async () => {
    outcome = await start();
  });
  return outcome;
}

describe("AppShell berdctl integration", () => {
  beforeEach(() => {
    vi.stubEnv("VITE_AUTOMATIONS", "1");
    window.history.replaceState(null, "", "/");
    window.localStorage.clear();
    dispatchOnboarding({ type: "complete" });
    useShortcutsDialogStore.setState({ open: false });
    mockAcpCreateSession.mockReset();
    mockAcpCreateSession.mockResolvedValue({ sessionId: "created-session" });
    mockAcpListSessionsPage.mockReset();
    mockAcpListSessionsPage.mockImplementation(async () => ({
      sessions: useChatSessionStore.getState().sessions.map((session) => {
        const selection = gooseServeSelectionFromExecutionTarget(
          session.executionTarget,
        );
        return {
          sessionId: session.id,
          title: session.title,
          updatedAt: session.updatedAt,
          createdAt: session.createdAt,
          lastMessageAt: session.lastMessageAt ?? null,
          archivedAt: session.archivedAt ?? null,
          userSetName: session.userSetName ?? false,
          messageCount: session.messageCount,
          subtitle: session.subtitle ?? null,
          workingDir: session.workingDir ?? null,
          projectId: session.projectId ?? null,
          providerId: selection.providerId ?? null,
          modelId: selection.modelId ?? null,
          personaId: session.personaId ?? null,
        };
      }),
      nextCursor: null,
    }));
    mockAcpLoadSession.mockReset();
    mockAcpLoadSession.mockResolvedValue(undefined);
    mockAcpArchiveSession.mockReset();
    mockAcpArchiveSession.mockResolvedValue(undefined);
    mockCheckDirectoriesExist.mockReset();
    mockCheckDirectoriesExist.mockResolvedValue([]);
    mockCreatePersonaSource.mockReset();
    mockCreatePersonaSource.mockResolvedValue({
      type: "agent",
      path: "/Users/test/.agents/agents/untitled-agent-created-session.md",
      name: "Untitled agent created-sess",
      description: "Draft",
      content: "Draft in progress.",
      global: true,
      writable: true,
      properties: { draft: true, builderSessionId: "created-session" },
    });
    mockListPersonaSources.mockReset();
    mockListPersonaSources.mockResolvedValue([]);
    mockReadAgentSourceFile.mockReset();
    mockReadAgentSourceFile.mockRejectedValue(new Error("not found"));
    mockDeletePersonaSource.mockReset();
    mockDeletePersonaSource.mockResolvedValue(undefined);
    mockLoadSessionMessages.mockReset();
    mockLoadSessionMessages.mockResolvedValue(true);
    mockToastError.mockReset();
    useChatStore.setState({
      messagesBySession: {},
      sessionStateById: {},
      draftsBySession: {},
      queuedMessageBySession: {},
      scrollTargetMessageBySession: {},
      activeSessionId: null,
      isConnected: true,
    });
    useChatSessionStore.setState({
      sessions: [],
      activeSessionId: null,
      isLoading: false,
      hasHydratedSessions: false,
      isRightRailOpen: false,
      activeWorkspaceBySession: {},
      archiveMutationBySessionId: {},
    });
    useAgentStore.setState({
      selectedProvider: "goose",
    });
    useDefaultProviderReadinessStore.setState({
      readiness: { status: "ready", providerId: "goose" },
    });
    useProjectStore.setState({
      projects: [],
      loading: false,
      activeProjectId: null,
    });
    setReadyRuntimeConfig({
      ...DEFAULT_RUNTIME_CONFIG,
      kgoose: { baseUrl: "https://kgoose.example.test" },
    });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("registers the controller after mount and clears it on unmount", () => {
    const { unmount } = render(<AppShell />);

    expect(() => getAppNavigationController()).not.toThrow();

    unmount();

    expect(() => getAppNavigationController()).toThrow(
      "AppNavigationController not registered",
    );
  });

  it("openSession activates both stores and switches to chat view", async () => {
    useChatSessionStore.setState({ sessions: [makeSession()] });
    render(<AppShell />);

    const outcome = await runCommand(() =>
      getAppNavigationController().openSession("session-1"),
    );

    expect(outcome).toEqual({ ok: true });
    await waitFor(() => {
      expect(screen.getByTestId("active-view")).toHaveTextContent("chat");
    });
    expect(useChatSessionStore.getState().activeSessionId).toBe("session-1");
    expect(useChatStore.getState().activeSessionId).toBe("session-1");
    expect(mockLoadSessionMessages).toHaveBeenCalledWith("session-1");
  });

  it("openSession returns to chat when the session is active but another view is showing", async () => {
    const user = userEvent.setup();
    useChatSessionStore.setState({ sessions: [makeSession()] });
    render(<AppShell />);

    await runCommand(() =>
      getAppNavigationController().openSession("session-1"),
    );
    await waitFor(() => {
      expect(screen.getByTestId("active-view")).toHaveTextContent("chat");
    });

    // Settings keeps the session active while hiding the chat surface.
    await user.click(screen.getByRole("button", { name: "Sidebar settings" }));
    await waitFor(() => {
      expect(screen.getByTestId("active-view")).toHaveTextContent("settings");
    });
    expect(useChatSessionStore.getState().activeSessionId).toBe("session-1");

    const outcome = await runCommand(() =>
      getAppNavigationController().openSession("session-1"),
    );

    expect(outcome).toEqual({ ok: true });
    await waitFor(() => {
      expect(screen.getByTestId("active-view")).toHaveTextContent("chat");
    });
    expect(useChatSessionStore.getState().activeSessionId).toBe("session-1");
  });

  it("openSession of an unknown session resolves session_not_found", async () => {
    render(<AppShell />);

    const outcome = await runCommand(() =>
      getAppNavigationController().openSession("missing-session"),
    );

    expect(outcome).toEqual({ ok: false, reason: "session_not_found" });
    expect(screen.getByTestId("active-view")).toHaveTextContent("home");
    expect(useChatSessionStore.getState().activeSessionId).toBeNull();
  });

  it("getAppContext reflects the real view, session, and project after openSession", async () => {
    useChatSessionStore.setState({
      sessions: [makeSession({ projectId: "project-1" })],
    });
    render(<AppShell />);

    expect(getAppNavigationController().getAppContext()).toEqual({
      view: "home",
      activeSessionId: null,
      activeProjectId: null,
    });

    await runCommand(() =>
      getAppNavigationController().openSession("session-1"),
    );
    await waitFor(() => {
      expect(screen.getByTestId("active-view")).toHaveTextContent("chat");
    });

    expect(getAppNavigationController().getAppContext()).toEqual({
      view: "chat",
      activeSessionId: "session-1",
      activeProjectId: "project-1",
    });
  });

  it("archiveSession ignores session pagination failures", async () => {
    mockAcpListSessionsPage.mockRejectedValue(new Error("list failed"));
    useChatSessionStore.setState({ sessions: [makeSession()] });
    render(<AppShell />);

    const outcome = await runCommand(() =>
      getAppNavigationController().archiveSession("session-1", "reject"),
    );

    expect(outcome).toEqual({ ok: true });
    expect(mockAcpArchiveSession).toHaveBeenCalledWith("session-1");
    expect(mockAcpListSessionsPage).not.toHaveBeenCalled();
  });

  it("archiveSession reports backend failure and keeps the session unarchived", async () => {
    // ACP-shaped error: the formatted detail must surface the `data` payload,
    // not String(error)'s "Error: Internal error".
    mockAcpArchiveSession.mockRejectedValue(
      Object.assign(new Error("Internal error"), {
        code: -32603,
        data: "session row missing",
      }),
    );
    useChatSessionStore.setState({ sessions: [makeSession()] });
    render(<AppShell />);

    const outcome = await runCommand(() =>
      getAppNavigationController().archiveSession("session-1", "reject"),
    );

    expect(outcome).toEqual({
      ok: false,
      reason: "backend_archive_failed",
      detail: "session row missing",
    });
    expect(
      useChatSessionStore.getState().getSession("session-1")?.archivedAt,
    ).toBeUndefined();
  });

  it("archiveSession of the active session waits for backend success before local UI cleanup", async () => {
    useChatSessionStore.setState({ sessions: [makeSession()] });
    render(<AppShell />);

    await runCommand(() =>
      getAppNavigationController().openSession("session-1"),
    );
    await waitFor(() => {
      expect(screen.getByTestId("active-view")).toHaveTextContent("chat");
    });

    mockAcpArchiveSession.mockRejectedValue(new Error("backend down"));
    const outcome = await runCommand(() =>
      getAppNavigationController().archiveSession("session-1", "reject"),
    );

    expect(outcome).toEqual({
      ok: false,
      reason: "backend_archive_failed",
      detail: "backend down",
    });
    expect(useChatSessionStore.getState().activeSessionId).toBe("session-1");
    expect(screen.getByTestId("active-view")).toHaveTextContent("chat");
    expect(
      useChatSessionStore.getState().getSession("session-1")?.archivedAt,
    ).toBeUndefined();
  });

  it("UI archive waits for backend success before cleaning up local state and reports failure", async () => {
    const user = userEvent.setup();
    let rejectArchive!: (error: Error) => void;
    mockAcpArchiveSession.mockReturnValue(
      new Promise((_resolve, reject) => {
        rejectArchive = reject;
      }),
    );
    useChatSessionStore.setState({ sessions: [makeSession()] });
    render(<AppShell />);

    await runCommand(() =>
      getAppNavigationController().openSession("session-1"),
    );
    await waitFor(() => {
      expect(screen.getByTestId("active-view")).toHaveTextContent("chat");
    });

    await user.click(screen.getByRole("button", { name: "Archive session" }));

    expect(
      useChatSessionStore.getState().getSession("session-1")?.archivedAt,
    ).toEqual(expect.any(String));
    expect(useChatSessionStore.getState().activeSessionId).toBe("session-1");
    expect(screen.getByTestId("active-view")).toHaveTextContent("chat");

    await act(async () => {
      rejectArchive(new Error("backend down"));
    });

    await waitFor(() => {
      expect(
        useChatSessionStore.getState().getSession("session-1")?.archivedAt,
      ).toBeUndefined();
    });
    expect(useChatSessionStore.getState().activeSessionId).toBe("session-1");
    expect(screen.getByTestId("active-view")).toHaveTextContent("chat");
    expect(mockToastError).toHaveBeenCalledWith("backend down");
  });

  it("keeps a newly selected session active when archival finishes", async () => {
    let resolveArchive!: () => void;
    mockAcpArchiveSession.mockReturnValue(
      new Promise<void>((resolve) => {
        resolveArchive = resolve;
      }),
    );
    useChatSessionStore.setState({
      sessions: [makeSession(), makeSession({ id: "session-2" })],
    });
    render(<AppShell />);

    await runCommand(() =>
      getAppNavigationController().openSession("session-1"),
    );
    const outcome = startCommand(() =>
      getAppNavigationController().archiveSession("session-1", "reject"),
    );
    await waitFor(() => {
      expect(mockAcpArchiveSession).toHaveBeenCalledWith("session-1");
    });

    await act(async () => {
      useChatSessionStore.getState().setActiveSession("session-2");
      useChatStore.getState().setActiveSession("session-2");
      resolveArchive();
      await outcome;
    });

    await expect(outcome).resolves.toEqual({ ok: true });
    expect(mockAcpListSessionsPage).not.toHaveBeenCalled();
    expect(useChatSessionStore.getState().activeSessionId).toBe("session-2");
    expect(useChatStore.getState().activeSessionId).toBe("session-2");
    expect(screen.getByTestId("active-view")).toHaveTextContent("chat");
  });

  it("archiveSession of an unknown session resolves session_not_found", async () => {
    render(<AppShell />);

    const outcome = await runCommand(() =>
      getAppNavigationController().archiveSession("missing", "reject"),
    );

    expect(outcome).toEqual({ ok: false, reason: "session_not_found" });
    expect(mockAcpArchiveSession).not.toHaveBeenCalled();
  });

  it("archiveSession navigates home when the session was active", async () => {
    useChatSessionStore.setState({ sessions: [makeSession()] });
    render(<AppShell />);

    await runCommand(() =>
      getAppNavigationController().openSession("session-1"),
    );
    await waitFor(() => {
      expect(screen.getByTestId("active-view")).toHaveTextContent("chat");
    });

    const outcome = await runCommand(() =>
      getAppNavigationController().archiveSession("session-1", "reject"),
    );

    expect(outcome).toEqual({ ok: true });
    expect(mockAcpArchiveSession).toHaveBeenCalledWith("session-1");
    expect(
      useChatSessionStore.getState().getSession("session-1")?.archivedAt,
    ).toEqual(expect.any(String));
    expect(useChatSessionStore.getState().activeSessionId).toBeNull();
    await waitFor(() => {
      expect(screen.getByTestId("active-view")).toHaveTextContent("home");
    });
  });

  it("openSession resolves blocked_unsaved_changes when the automation guard is cancelled", async () => {
    const user = userEvent.setup();
    useChatSessionStore.setState({ sessions: [makeSession()] });
    render(<AppShell />);

    await user.click(
      screen.getByRole("button", { name: "Sidebar automations" }),
    );
    await user.click(
      screen.getByRole("button", { name: "Open automation builder" }),
    );
    await user.click(
      screen.getByRole("button", { name: "Mark automation edits unsaved" }),
    );

    const outcome = startCommand(() =>
      getAppNavigationController().openSession("session-1"),
    );

    expect(
      await screen.findByText("Unsaved automation changes"),
    ).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Keep editing" }));

    await expect(outcome).resolves.toEqual({
      ok: false,
      reason: "blocked_unsaved_changes",
    });
    expect(screen.getByTestId("active-view")).toHaveTextContent("automations");
  });

  it("settles a superseded pending guard entry as cancelled when a second guarded navigation arrives", async () => {
    const user = userEvent.setup();
    useChatSessionStore.setState({
      sessions: [
        makeSession(),
        makeSession({ id: "session-2", workingDir: "/tmp/session-2" }),
      ],
    });
    render(<AppShell />);

    await user.click(
      screen.getByRole("button", { name: "Sidebar automations" }),
    );
    await user.click(
      screen.getByRole("button", { name: "Open automation builder" }),
    );
    await user.click(
      screen.getByRole("button", { name: "Mark automation edits unsaved" }),
    );

    const first = startCommand(() =>
      getAppNavigationController().openSession("session-1"),
    );
    expect(
      await screen.findByText("Unsaved automation changes"),
    ).toBeInTheDocument();

    // A second guarded navigation supersedes the first pending entry; the
    // first command must settle (cancelled) instead of dying by timeout.
    const second = startCommand(() =>
      getAppNavigationController().openSession("session-2"),
    );

    await expect(first).resolves.toEqual({
      ok: false,
      reason: "blocked_unsaved_changes",
    });

    // The second entry is still live and resolves through the prompt.
    await user.click(screen.getByRole("button", { name: "Keep editing" }));
    await expect(second).resolves.toEqual({
      ok: false,
      reason: "blocked_unsaved_changes",
    });
    expect(screen.getByTestId("active-view")).toHaveTextContent("automations");
  });

  it("openSession resolves blocked_unsaved_changes when the agent draft guard is cancelled", async () => {
    const user = userEvent.setup();
    useChatSessionStore.setState({ sessions: [makeSession()] });
    render(<AppShell />);

    await user.click(screen.getByRole("button", { name: "Sidebar agents" }));
    await user.click(screen.getByRole("button", { name: "Create agent" }));
    await waitFor(() => {
      expect(screen.getByTestId("active-view")).toHaveTextContent("chat");
    });

    useChatStore.getState().setDraft("created-session", "make me a reviewer");

    const outcome = startCommand(() =>
      getAppNavigationController().openSession("session-1"),
    );

    expect(
      await screen.findByText("Save this agent draft?"),
    ).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Keep editing" }));

    await expect(outcome).resolves.toEqual({
      ok: false,
      reason: "blocked_unsaved_changes",
    });
    expect(screen.getByTestId("active-view")).toHaveTextContent("chat");
  });

  it("settles a superseded agent draft guard entry as cancelled when a second guarded navigation arrives", async () => {
    const user = userEvent.setup();
    useChatSessionStore.setState({
      sessions: [
        makeSession(),
        makeSession({ id: "session-2", workingDir: "/tmp/session-2" }),
      ],
    });
    render(<AppShell />);

    await user.click(screen.getByRole("button", { name: "Sidebar agents" }));
    await user.click(screen.getByRole("button", { name: "Create agent" }));
    await waitFor(() => {
      expect(screen.getByTestId("active-view")).toHaveTextContent("chat");
    });

    useChatStore.getState().setDraft("created-session", "make me a reviewer");

    const first = startCommand(() =>
      getAppNavigationController().openSession("session-1"),
    );
    expect(
      await screen.findByText("Save this agent draft?"),
    ).toBeInTheDocument();

    const second = startCommand(() =>
      getAppNavigationController().openSession("session-2"),
    );

    await expect(first).resolves.toEqual({
      ok: false,
      reason: "blocked_unsaved_changes",
    });

    await user.click(screen.getByRole("button", { name: "Keep editing" }));
    await expect(second).resolves.toEqual({
      ok: false,
      reason: "blocked_unsaved_changes",
    });
    expect(screen.getByTestId("active-view")).toHaveTextContent("chat");
  });
});

import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useAgentStore } from "@/features/agents/stores/agentStore";
import { resetAgentBuilderSourceLifecycleForTests } from "@/features/agents/lib/agentBuilderSourceLifecycle";
import { useChatStore } from "@/features/chat/stores/chatStore";
import { useChatSessionStore } from "@/features/chat/stores/chatSessionStore";
import type { ChatSession } from "@/features/chat/stores/chatSessionStore";
import type { Message } from "@/shared/types/messages";
import { DEFAULT_CHAT_TITLE } from "@/features/chat/lib/sessionTitle";
import {
  MULTI_WORKSPACE_EXPERIMENT_ID,
  SIDEBAR_DETACHABLE_CHATS_EXPERIMENT_ID,
} from "@/features/experiments/experimentDefinitions";
import { setExperimentEnabled } from "@/features/experiments/experimentPreferences";
import { OPEN_SETTINGS_EVENT } from "@/features/settings/lib/settingsEvents";
import { SHORTCUT_PREFERENCES_STORAGE_KEY } from "@/features/shortcuts/lib/shortcutRegistry";
import { useShortcutsDialogStore } from "@/features/shortcuts/stores/shortcutsDialogStore";
import { useProjectStore } from "@/features/projects/stores/projectStore";
import type { ProjectInfo } from "@/features/projects/api/projects";
import { BUILDERBOT_SURFACE_EXPERIMENT_ID } from "@/features/experiments/experimentDefinitions";
import {
  EXPERIMENT_PREFERENCES_STORAGE_KEY,
  EXPERIMENT_PREFERENCES_STORAGE_VERSION,
} from "@/features/experiments/experimentPreferences";
import { ThemeProvider } from "@/shared/theme/ThemeProvider";
import { useDefaultProviderReadinessStore } from "@/features/providers/stores/defaultProviderReadinessStore";
import { useRuntimeConfigStore } from "@/shared/runtime-config/runtimeConfigStore";
import {
  DEFAULT_RUNTIME_CONFIG,
  type RuntimeConfig,
} from "@/shared/runtime-config/schema";
import {
  AppShell,
  getPrototypeSecondaryWidthForDockedLayout,
} from "./AppShell";
import type { AppShellContent as AppShellContentType } from "./ui/AppShellContent";

const mockAcpCreateSession = vi.hoisted(() => vi.fn());
const mockBuildFeatures = vi.hoisted(() => ({ byoKeyProviders: false }));
const mockAcpArchiveSession = vi.hoisted(() => vi.fn());
const mockAcpGetSessionInfo = vi.hoisted(() => vi.fn());
const mockAcpLoadSession = vi.hoisted(() => vi.fn());
const mockCheckDirectoriesExist = vi.hoisted(() => vi.fn());
const mockPathExists = vi.hoisted(() => vi.fn());
const mockCheckAllProviderStatus = vi.hoisted(() => vi.fn());
const gitMocks = vi.hoisted(() => ({
  createBranch: vi.fn(),
  createWorktree: vi.fn(),
  deleteBranch: vi.fn(),
  getGitState: vi.fn(),
  removeWorktree: vi.fn(),
}));
const mockIsExternalAgentReady = vi.hoisted(() => vi.fn());
const mockAgentStatus = vi.hoisted(() => ({
  readyAgentIds: new Set<string>(["goose"]),
}));
const mockCreatePersonaSource = vi.hoisted(() => vi.fn());
const mockListPersonaSources = vi.hoisted(() => vi.fn());
const mockReadAgentSourceFile = vi.hoisted(() => vi.fn());
const mockDeletePersonaSource = vi.hoisted(() => vi.fn());
const mockAutomationBuilderSave = vi.hoisted(() => vi.fn());
const mockToastError = vi.hoisted(() => vi.fn());
const mockListenSessionDeepLinkErrors = vi.hoisted(() => vi.fn());
const mockAfterNextPaint = vi.hoisted(() => ({
  callbacks: [] as Array<{ callback: () => void; cancelled: boolean }>,
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, reject, resolve };
}

function rect(left = 0, top = 0, width = 100, height = 100): DOMRect {
  return {
    x: left,
    y: top,
    left,
    top,
    right: left + width,
    bottom: top + height,
    width,
    height,
    toJSON: () => ({}),
  } as DOMRect;
}

function mockVisibleRegionRects() {
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue(
    rect(),
  );
}

function flushAfterNextPaintCallbacks() {
  const entries = mockAfterNextPaint.callbacks.splice(0);
  for (const entry of entries) {
    if (!entry.cancelled) {
      entry.callback();
    }
  }
}

function appShellWithTheme(children?: ReactNode) {
  return (
    <ThemeProvider>
      <AppShell>{children}</AppShell>
    </ThemeProvider>
  );
}

function renderAppShell(children?: ReactNode) {
  return render(appShellWithTheme(children));
}

async function openCenteredComposerFromChat() {
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "Sidebar new chat" }));
  await waitFor(() => {
    expect(screen.getByTestId("active-view")).toHaveTextContent("chat");
  });
  await user.keyboard("{Meta>}n{/Meta}");
  const textbox = await screen.findByPlaceholderText("Start a conversation");
  await waitFor(() => {
    expect(textbox.closest("[data-placement]")).toHaveAttribute(
      "data-placement",
      "centered",
    );
  });
  return { textbox, user };
}

async function waitForCreatedAgentBuilderTarget() {
  await waitFor(() => {
    expect(useChatSessionStore.getState().getActiveSession()).toMatchObject({
      id: "created-session",
      intent: "build-agent",
      targetAgentPath:
        "/Users/test/.agents/agents/untitled-agent-created-session.md",
      targetAgentDraftState: null,
    });
  });
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

function requireByoDefaultProviderSetup() {
  mockBuildFeatures.byoKeyProviders = true;
  useDefaultProviderReadinessStore.setState({
    readiness: { status: "needs_setup", reason: "missing_defaults" },
  });
}

function selectCodexProvider() {
  useAgentStore.setState({
    providers: [
      { id: "goose", label: "Goose" },
      { id: "codex-acp", label: "Codex" },
    ],
    selectedProvider: "codex-acp",
  });
}

vi.mock("@/shared/profile/buildProfile", () => ({
  filterExperimentRegistryForBuildProfile: <T,>(registry: readonly T[]) =>
    registry,
  getBuildFeatureState: () => ({
    authGate: false,
    agentToolsTip: true,
    automations: true,
    builderbot: true,
    telemetry: true,
    voiceDictation: true,
    kgooseConnections: true,
    securityMl: true,
    updater: true,
    ...mockBuildFeatures,
  }),
}));

const mockGetPlatform = vi.hoisted(() => vi.fn(() => "mac"));
vi.mock("@/shared/lib/platform", () => ({
  getPlatform: mockGetPlatform,
}));

const mockDesignSystemExplorerEnabled = vi.hoisted(() => vi.fn(() => false));
vi.mock("@/features/design-system/lib/designSystemEnabled", () => ({
  isDesignSystemExplorerEnabled: mockDesignSystemExplorerEnabled,
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
  NAV_PROTOTYPE_PANEL_GAP_PX: 0,
  NAV_PROTOTYPE_PANEL_OVERLAP_PX: 1,
  NAV_PROTOTYPE_PRIMARY_COLLAPSED_WIDTH_PX: 48,
  NAV_PROTOTYPE_PRIMARY_EXPANDED_WIDTH_PX: 230,
  NAV_PROTOTYPE_SECONDARY_WIDTH_PX: 230,
  NavigationPanesView: ({
    collapsed,
    detachableSessionListEnabled,
    onNavigate,
    onNewChat,
    onNewChatInProject,
    onSettingsClick,
    onSettingsSectionChange,
    onPrototypeSecondaryTargetChange,
    prototypeSecondaryTarget,
    width,
  }: {
    collapsed?: boolean;
    detachableSessionListEnabled?: boolean;
    onNavigate?: (view: string) => void;
    onNewChat?: () => void;
    onNewChatInProject?: (projectId: string) => void;
    onSettingsClick?: () => void;
    onSettingsSectionChange?: (section: "providers") => void;
    onPrototypeSecondaryTargetChange?: (
      target: { kind: "chats" } | { kind: "project"; projectId: string },
    ) => void;
    prototypeSecondaryTarget?: unknown;
    width?: number;
  }) => (
    <nav aria-label="mock sidebar">
      <div data-testid="mock-sidebar-collapsed">{String(collapsed)}</div>
      <div data-testid="mock-sidebar-width">{String(width)}</div>
      <div data-testid="mock-sidebar-detachable-enabled">
        {String(detachableSessionListEnabled)}
      </div>
      <div data-testid="mock-sidebar-prototype-secondary-target">
        {JSON.stringify(prototypeSecondaryTarget)}
      </div>
      <button type="button" onClick={onNewChat}>
        Sidebar new chat
      </button>
      <button type="button" onClick={() => onNewChatInProject?.("project-2")}>
        Sidebar new project 2 chat
      </button>
      <button type="button" onClick={() => onNavigate?.("skills")}>
        Sidebar skills
      </button>
      <button type="button" onClick={() => onNavigate?.("automations")}>
        Sidebar automations
      </button>
      <button type="button" onClick={() => onNavigate?.("builderbot")}>
        Sidebar builderbot
      </button>
      <button type="button" onClick={() => onNavigate?.("agents")}>
        Sidebar agents
      </button>
      <button
        type="button"
        onClick={() => onPrototypeSecondaryTargetChange?.({ kind: "chats" })}
      >
        Sidebar chats
      </button>
      <button
        type="button"
        onClick={() =>
          onPrototypeSecondaryTargetChange?.({
            kind: "project",
            projectId: "project-2",
          })
        }
      >
        Sidebar project 2
      </button>
      <button type="button" onClick={onSettingsClick}>
        Sidebar settings
      </button>
      <button type="button" onClick={() => onNavigate?.("design-system")}>
        Sidebar design system
      </button>
      <button
        type="button"
        onClick={() => onSettingsSectionChange?.("providers")}
      >
        Sidebar providers
      </button>
    </nav>
  ),
}));

vi.mock("@/features/providers/api/credentials", () => ({
  checkAllProviderStatus: (...args: unknown[]) =>
    mockCheckAllProviderStatus(...args),
}));

vi.mock("@/features/chat/lib/externalAgentReadiness", () => ({
  isExternalAgentReady: (...args: unknown[]) =>
    mockIsExternalAgentReady(...args),
}));

vi.mock("@/shared/api/acp", () => ({
  acpCreateSession: (...args: unknown[]) => mockAcpCreateSession(...args),
  acpGetSessionInfo: (...args: unknown[]) => mockAcpGetSessionInfo(...args),
  acpLoadSession: (...args: unknown[]) => mockAcpLoadSession(...args),
  discoverAcpProviders: vi.fn().mockResolvedValue([]),
}));

vi.mock("@/shared/api/acpApi", () => ({
  DEFAULT_PROVIDER: { id: "goose", label: "Goose (Default)" },
  archiveSession: (...args: unknown[]) => mockAcpArchiveSession(...args),
  renameSession: vi.fn().mockResolvedValue(undefined),
  unarchiveSession: vi.fn().mockResolvedValue(undefined),
  updateSessionProject: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/shared/api/git", () => ({
  createBranch: (...args: unknown[]) => gitMocks.createBranch(...args),
  createWorktree: (...args: unknown[]) => gitMocks.createWorktree(...args),
  deleteBranch: (...args: unknown[]) => gitMocks.deleteBranch(...args),
  getGitState: (...args: unknown[]) => gitMocks.getGitState(...args),
  removeWorktree: (...args: unknown[]) => gitMocks.removeWorktree(...args),
}));
vi.mock("sonner", () => ({
  toast: {
    error: (...args: unknown[]) => mockToastError(...args),
    info: vi.fn(),
  },
}));

vi.mock("./lib/sessionDeepLinkErrors", () => ({
  listenSessionDeepLinkErrors: (...args: unknown[]) =>
    mockListenSessionDeepLinkErrors(...args),
}));

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

vi.mock("@/shared/api/system", () => ({
  getHomeDir: vi.fn().mockResolvedValue("/Users/test"),
  pathExists: (...args: unknown[]) => mockPathExists(...args),
}));

vi.mock("@/features/updates/ui/UpdateButton", () => ({
  UpdateButton: () => null,
}));

vi.mock("@/features/providers/hooks/useAgentProviderStatus", () => ({
  useAgentProviderStatus: () => ({
    readyAgentIds: mockAgentStatus.readyAgentIds,
    agentReadiness: new Map(),
    agentChecks: new Map(),
    loading: false,
    refresh: vi.fn().mockResolvedValue(undefined),
  }),
}));

vi.mock("./lib/scheduleAfterNextPaint", () => ({
  scheduleAfterNextPaint: (callback: () => void) => {
    const entry = { callback, cancelled: false };
    mockAfterNextPaint.callbacks.push(entry);
    return () => {
      entry.cancelled = true;
    };
  },
}));

vi.mock("./ui/AppShellContent", () => ({
  AppShellContent: (({
    targetLocation,
    renderedLocation,
    isPreparingContent,
    renderedSession,
    onCloseDesignSystem,
    onNavigateSkills,
    onNavigateAgents,
    onNavigateAutomations,
    onNavigateBuilderbot,
    onSkillsBreadcrumbLabelChange,
    onAgentsBreadcrumbLabelChange,
    onAutomationsBreadcrumbLabelChange,
    onBuilderbotBreadcrumbLabelChange,
    onAutomationBuilderLeaveActionChange,
    onCreatePersona,
    onExitSearch,
    onArchiveChat,
    onOpenAgent,
    onTagHomeComposerAgent,
    onTagHomeComposerProject,
    onTagHomeComposerSkill,
    onSelectSession,
    onStartProjectChat,
  }) => {
    const activeView = targetLocation.view;
    const activeSettingsSection =
      targetLocation.view === "settings"
        ? targetLocation.settingsSection
        : "general";
    const activeSkillsSkillId =
      targetLocation.view === "skills" ? targetLocation.skillId : null;
    const activeAgentsPersonaId =
      targetLocation.view === "agents" ? targetLocation.personaId : null;
    const activeAutomationsRoute =
      targetLocation.view === "automations"
        ? targetLocation.route
        : { surface: "overview" };
    const activeBuilderbotRoute =
      targetLocation.view === "builderbot"
        ? targetLocation.route
        : { surface: "overview" };

    return (
      <section>
        <div data-testid="active-view">{activeView}</div>
        <div data-testid="rendered-view">{renderedLocation.view}</div>
        <div data-testid="preparing-content">{String(isPreparingContent)}</div>
        <div data-testid="rendered-session-id">
          {renderedSession?.id ?? "none"}
        </div>
        <div data-testid="settings-section">{activeSettingsSection}</div>
        <div data-testid="skill-route">{activeSkillsSkillId ?? "list"}</div>
        <div data-testid="agent-route">{activeAgentsPersonaId ?? "list"}</div>
        <div data-testid="automation-route">
          {JSON.stringify(activeAutomationsRoute)}
        </div>
        <div data-testid="builderbot-route">
          {JSON.stringify(activeBuilderbotRoute)}
        </div>
        <button
          type="button"
          onClick={() => onStartProjectChat?.("project-startup")}
        >
          Start project chat
        </button>
        <button
          type="button"
          onClick={() => {
            onSkillsBreadcrumbLabelChange?.("Code Review");
            onNavigateSkills("skill-1");
          }}
        >
          Open skill detail
        </button>
        <button
          type="button"
          onClick={() => {
            onAgentsBreadcrumbLabelChange?.("Reviewer");
            onNavigateAgents("persona-1");
          }}
        >
          Open agent detail
        </button>
        <button
          type="button"
          onClick={() => {
            onAutomationsBreadcrumbLabelChange?.("History");
            onNavigateAutomations({ surface: "history", selectedRun: null });
          }}
        >
          Open automation history
        </button>
        <button
          type="button"
          onClick={() => {
            onAutomationsBreadcrumbLabelChange?.("Add automation");
            onNavigateAutomations({
              surface: "builder",
              automationId: "automation-1",
            });
          }}
        >
          Open automation builder
        </button>
        <button
          type="button"
          onClick={() => {
            onBuilderbotBreadcrumbLabelChange?.("TASK-1");
            onNavigateBuilderbot({ surface: "task", taskKey: "TASK-1" });
          }}
        >
          Open builderbot task
        </button>
        <button
          type="button"
          onClick={() => {
            onBuilderbotBreadcrumbLabelChange?.("Daily docs");
            onNavigateBuilderbot({
              surface: "automation",
              automationId: "daily-docs",
            });
          }}
        >
          Open builderbot automation
        </button>
        {activeView === "automations" &&
        activeAutomationsRoute.surface === "builder" ? (
          <button
            type="button"
            onClick={() =>
              onAutomationBuilderLeaveActionChange?.({
                hasUnsavedChanges: true,
                save: async () => {
                  mockAutomationBuilderSave();
                  return true;
                },
                discard: () => {},
              })
            }
          >
            Mark automation edits unsaved
          </button>
        ) : null}
        <button type="button" onClick={() => onOpenAgent?.("persona-resolves")}>
          Start chat with resolving agent
        </button>
        <button
          type="button"
          onClick={() => onOpenAgent?.("persona-unresolved")}
        >
          Start chat with unresolved agent
        </button>
        <button
          type="button"
          onClick={() => onTagHomeComposerAgent?.("persona-resolves")}
        >
          Tag home composer agent
        </button>
        <button
          type="button"
          onClick={() => onTagHomeComposerProject?.("project-1")}
        >
          Tag home composer project
        </button>
        <button
          type="button"
          onClick={() =>
            onTagHomeComposerSkill?.({
              id: "global:/Users/test/.agents/skills/code-review/SKILL.md",
              name: "code-review",
              description: "Review code before PR",
              instructions: "",
              path: "/Users/test/.agents/skills/code-review",
              fileLocation: "/Users/test/.agents/skills/code-review/SKILL.md",
              sourceKind: "global",
              sourceLabel: "Personal",
              projectLinks: [],
              readonly: false,
              color: null,
            })
          }
        >
          Tag home composer skill
        </button>
        <button
          type="button"
          onClick={() => onSelectSession?.("missing-session")}
        >
          Open missing session
        </button>
        <button type="button" onClick={() => onSelectSession?.("session-1")}>
          Open session 1
        </button>
        <button type="button" onClick={() => onCloseDesignSystem?.()}>
          Close design system
        </button>
        <button type="button" onClick={() => onSelectSession?.("session-2")}>
          Open session 2
        </button>
        <button type="button" onClick={() => onArchiveChat("session-1")}>
          Archive session 1
        </button>
        {activeView === "agents" ? (
          <button type="button" onClick={onCreatePersona}>
            Create agent
          </button>
        ) : null}
        {activeView === "search" ? (
          <button type="button" onClick={onExitSearch}>
            Exit search
          </button>
        ) : null}
        <input aria-label="Mock search input" />
      </section>
    );
  }) satisfies typeof AppShellContentType,
}));

function enableBuilderbotExperiment() {
  window.localStorage.setItem(
    EXPERIMENT_PREFERENCES_STORAGE_KEY,
    JSON.stringify({
      version: EXPERIMENT_PREFERENCES_STORAGE_VERSION,
      experiments: {
        [BUILDERBOT_SURFACE_EXPERIMENT_ID]: { enabled: true },
      },
    }),
  );
}

describe("AppShell global navigation", () => {
  it("clamps pushed prototype secondary width to available viewport space", () => {
    expect(
      getPrototypeSecondaryWidthForDockedLayout({
        dockedPrimaryWidth: 48,
        requestedSecondaryWidth: 420,
        secondaryPush: true,
        viewportWidth: 1000,
      }),
    ).toBe(393);

    expect(
      getPrototypeSecondaryWidthForDockedLayout({
        dockedPrimaryWidth: 48,
        requestedSecondaryWidth: 420,
        secondaryPush: false,
        viewportWidth: 1000,
      }),
    ).toBe(420);
  });

  beforeEach(() => {
    window.history.replaceState(null, "", "/");
    window.localStorage.clear();
    mockBuildFeatures.byoKeyProviders = false;
    mockGetPlatform.mockReturnValue("mac");
    mockDesignSystemExplorerEnabled.mockReturnValue(false);
    mockAfterNextPaint.callbacks = [];
    resetAgentBuilderSourceLifecycleForTests();
    useShortcutsDialogStore.setState({ open: false });
    document.documentElement.removeAttribute("data-global-composer-visible");
    mockAcpCreateSession.mockReset();
    mockAcpCreateSession.mockResolvedValue({ sessionId: "created-session" });
    mockAcpArchiveSession.mockReset();
    mockAcpArchiveSession.mockResolvedValue(undefined);
    mockAcpGetSessionInfo.mockReset();
    mockAcpGetSessionInfo.mockResolvedValue(null);
    mockAcpLoadSession.mockReset();
    mockAcpLoadSession.mockResolvedValue(undefined);
    mockToastError.mockReset();
    mockListenSessionDeepLinkErrors.mockReset();
    mockListenSessionDeepLinkErrors.mockResolvedValue(vi.fn());
    gitMocks.getGitState.mockReset();
    gitMocks.getGitState.mockResolvedValue({
      isGitRepo: true,
      currentBranch: "main",
      dirtyFileCount: 0,
      incomingCommitCount: 0,
      worktrees: [{ path: "/repo", branch: "main", isMain: true }],
      isWorktree: false,
      mainWorktreePath: "/repo",
      localBranches: ["main"],
    });
    gitMocks.createBranch.mockReset();
    gitMocks.createBranch.mockResolvedValue(undefined);
    gitMocks.createWorktree.mockReset();
    gitMocks.createWorktree.mockResolvedValue({
      path: "/repo-worktrees/chat-123",
      branch: "chat-123",
    });
    gitMocks.deleteBranch.mockReset();
    gitMocks.deleteBranch.mockResolvedValue(undefined);
    gitMocks.removeWorktree.mockReset();
    gitMocks.removeWorktree.mockResolvedValue(undefined);
    mockPathExists.mockReset();
    mockPathExists.mockResolvedValue(false);
    mockCheckDirectoriesExist.mockReset();
    mockCheckDirectoriesExist.mockResolvedValue([]);
    mockCheckAllProviderStatus.mockReset();
    mockCheckAllProviderStatus.mockResolvedValue([]);
    mockIsExternalAgentReady.mockReset();
    mockIsExternalAgentReady.mockResolvedValue(false);
    mockAgentStatus.readyAgentIds = new Set(["goose"]);
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
    mockAutomationBuilderSave.mockReset();
    useChatStore.setState({
      messagesBySession: {},
      sessionStateById: {},
      draftsBySession: {},
      nonEmptyDraftSessionIds: new Set(),
      skillDraftsBySession: {},
      draftAttachmentsBySession: {},
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
      modelSelectionIntentBySession: {},
    });
    useAgentStore.setState({
      selectedProvider: "goose",
    });
    useProjectStore.setState({
      projects: [],
      loading: false,
      activeProjectId: null,
    });
    useDefaultProviderReadinessStore.setState({
      readiness: { status: "ready", providerId: "goose" },
    });
    setReadyRuntimeConfig();
  });

  it("starts a full blank chat from the sidebar new chat action", async () => {
    const user = userEvent.setup();
    const { container } = renderAppShell();

    await user.click(screen.getByRole("button", { name: "Sidebar new chat" }));

    await waitFor(() => {
      expect(screen.getByTestId("active-view")).toHaveTextContent("chat");
    });
    expect(mockAcpCreateSession).toHaveBeenCalledWith(
      "goose",
      "~/goose artifacts",
      {
        deferProviderSetup: true,
        modelId: undefined,
        projectId: undefined,
      },
    );
    expect(
      (container.firstElementChild as HTMLElement).style.getPropertyValue(
        "--project-tint",
      ),
    ).toBe("transparent");
  });

  it("keeps the default sidebar expanded for empty default-title chats", async () => {
    const user = userEvent.setup();
    setExperimentEnabled(SIDEBAR_DETACHABLE_CHATS_EXPERIMENT_ID, true);
    useChatSessionStore.setState({
      sessions: [
        {
          id: "session-1",
          title: DEFAULT_CHAT_TITLE,
          providerId: "goose",
          workingDir: "~/goose artifacts",
          createdAt: "2026-06-09T00:00:00.000Z",
          updatedAt: "2026-06-09T00:00:00.000Z",
          messageCount: 0,
        },
      ],
      activeSessionId: null,
    });

    renderAppShell();
    await user.click(screen.getByRole("button", { name: "Open session 1" }));

    await waitFor(() => {
      expect(screen.getByTestId("active-view")).toHaveTextContent("chat");
    });
    expect(screen.getByTestId("mock-sidebar-collapsed")).toHaveTextContent(
      "false",
    );
    expect(
      screen.getByTestId("mock-sidebar-detachable-enabled"),
    ).toHaveTextContent("true");
  });

  it("opens navigation from an empty chat without carrying it to new chats", async () => {
    const user = userEvent.setup();
    useProjectStore.setState({
      projects: [
        {
          id: "project-2",
          path: "/tmp/project-2.yaml",
          name: "Project Two",
          description: "",
          prompt: "",
          icon: "",
          color: "",
          workingDirs: ["/workspace/project-2"],
          projectWorkspaces: [],
          useWorktrees: false,
          order: 0,
          archivedAt: null,
        },
      ],
    });
    useChatSessionStore.setState({
      sessions: [
        {
          id: "session-1",
          title: DEFAULT_CHAT_TITLE,
          projectId: "project-1",
          providerId: "goose",
          workingDir: "~/goose artifacts",
          createdAt: "2026-06-09T00:00:00.000Z",
          updatedAt: "2026-06-09T00:00:00.000Z",
          messageCount: 0,
        },
      ],
      activeSessionId: null,
    });

    renderAppShell();
    await user.click(screen.getByRole("button", { name: "Open session 1" }));

    await waitFor(() => {
      expect(screen.getByTestId("active-view")).toHaveTextContent("chat");
    });
    expect(
      screen.getByTestId("mock-sidebar-prototype-secondary-target"),
    ).toHaveTextContent("null");

    await user.click(screen.getByRole("button", { name: "Sidebar chats" }));
    expect(
      screen.getByTestId("mock-sidebar-prototype-secondary-target"),
    ).toHaveTextContent(JSON.stringify({ kind: "chats" }));

    await user.click(screen.getByRole("button", { name: "Sidebar project 2" }));
    expect(
      screen.getByTestId("mock-sidebar-prototype-secondary-target"),
    ).toHaveTextContent(
      JSON.stringify({ kind: "project", projectId: "project-2" }),
    );

    await user.click(screen.getByRole("button", { name: "Sidebar new chat" }));
    await waitFor(() => {
      expect(
        screen.getByTestId("mock-sidebar-prototype-secondary-target"),
      ).toHaveTextContent("null");
    });

    await user.click(screen.getByRole("button", { name: "Sidebar chats" }));
    await user.click(
      screen.getByRole("button", { name: "Sidebar new project 2 chat" }),
    );
    await waitFor(() => {
      expect(
        screen.getByTestId("mock-sidebar-prototype-secondary-target"),
      ).toHaveTextContent("null");
    });
  });

  it("keeps secondary chat target for default-titled chats with messages", async () => {
    const user = userEvent.setup();
    useChatSessionStore.setState({
      sessions: [
        {
          id: "session-1",
          title: DEFAULT_CHAT_TITLE,
          providerId: "goose",
          workingDir: "~/goose artifacts",
          createdAt: "2026-06-09T00:00:00.000Z",
          updatedAt: "2026-06-09T00:00:00.000Z",
          messageCount: 1,
        },
      ],
      activeSessionId: null,
    });

    renderAppShell();
    await user.click(screen.getByRole("button", { name: "Open session 1" }));

    await waitFor(() => {
      expect(screen.getByTestId("active-view")).toHaveTextContent("chat");
    });
    expect(
      screen.getByTestId("mock-sidebar-prototype-secondary-target"),
    ).toHaveTextContent(JSON.stringify({ kind: "chats" }));
  });

  it("does not create a chat when BYO default provider setup is required", async () => {
    requireByoDefaultProviderSetup();
    const user = userEvent.setup();
    renderAppShell();

    await user.click(screen.getByRole("button", { name: "Sidebar new chat" }));

    await waitFor(() => {
      expect(screen.getByTestId("active-view")).toHaveTextContent("settings");
    });
    expect(screen.getByTestId("settings-section")).toHaveTextContent(
      "providers",
    );
    expect(mockAcpCreateSession).not.toHaveBeenCalled();
  });

  it("allows chat creation when BYO default provider is ready", async () => {
    mockBuildFeatures.byoKeyProviders = true;
    useDefaultProviderReadinessStore.setState({
      readiness: { status: "ready", providerId: "openai", modelId: "gpt-4o" },
    });
    mockCheckAllProviderStatus.mockResolvedValue([
      { providerId: "openai", isConfigured: true },
    ]);
    const user = userEvent.setup();
    renderAppShell();

    await user.click(screen.getByRole("button", { name: "Sidebar new chat" }));

    await waitFor(() => {
      expect(screen.getByTestId("active-view")).toHaveTextContent("chat");
    });
    expect(mockAcpCreateSession).toHaveBeenCalled();
  });

  it("allows a configured concrete provider when the BYO default is missing", async () => {
    requireByoDefaultProviderSetup();
    useAgentStore.setState({
      selectedProvider: "goose",
      providers: [
        { id: "goose", label: "Goose" },
        { id: "databricks_v2", label: "Databricks AI Gateway" },
      ],
      personas: [
        {
          id: "persona-resolves",
          displayName: "Reviewer",
          systemPrompt: "Review code.",
          provider: "databricks_v2",
          isBuiltin: false,
          writable: true,
        },
      ],
    });
    mockCheckAllProviderStatus.mockResolvedValue([
      { providerId: "databricks_v2", isConfigured: true },
    ]);
    const user = userEvent.setup();
    renderAppShell();

    await user.click(
      screen.getByRole("button", { name: "Start chat with resolving agent" }),
    );

    await waitFor(() => {
      expect(screen.getByTestId("active-view")).toHaveTextContent("chat");
    });
    expect(mockAcpCreateSession).toHaveBeenCalledWith(
      "databricks_v2",
      "~/goose artifacts",
      {
        deferProviderSetup: true,
        modelId: undefined,
        projectId: undefined,
      },
    );
  });

  it("starts general chats with the resolved provider when a stored agent is unavailable", async () => {
    useAgentStore.setState({
      providers: [
        { id: "goose", label: "Goose" },
        { id: "codex-acp", label: "Codex" },
      ],
      selectedProvider: "codex-acp",
    });
    const user = userEvent.setup();
    renderAppShell();

    await user.click(screen.getByRole("button", { name: "Sidebar new chat" }));

    await waitFor(() => {
      expect(screen.getByTestId("active-view")).toHaveTextContent("chat");
    });
    expect(mockAcpCreateSession).toHaveBeenCalledWith(
      "goose",
      "~/goose artifacts",
      {
        deferProviderSetup: true,
        modelId: undefined,
        projectId: undefined,
      },
    );
  });

  it("allows a ready external ACP agent when the BYO default is missing", async () => {
    requireByoDefaultProviderSetup();
    selectCodexProvider();
    mockIsExternalAgentReady.mockResolvedValue(true);
    mockAgentStatus.readyAgentIds = new Set(["goose", "codex-acp"]);
    const user = userEvent.setup();
    renderAppShell();

    await user.click(screen.getByRole("button", { name: "Sidebar new chat" }));

    await waitFor(() => {
      expect(screen.getByTestId("active-view")).toHaveTextContent("chat");
    });
    expect(mockAcpCreateSession).toHaveBeenCalledWith(
      "codex-acp",
      "~/goose artifacts",
      {
        deferProviderSetup: true,
        modelId: undefined,
        projectId: undefined,
      },
    );
  });

  it("routes an auth-failed external ACP agent to Providers settings", async () => {
    requireByoDefaultProviderSetup();
    selectCodexProvider();
    mockIsExternalAgentReady.mockResolvedValue(false);
    mockAgentStatus.readyAgentIds = new Set(["goose", "codex-acp"]);
    const user = userEvent.setup();
    renderAppShell();

    await user.click(screen.getByRole("button", { name: "Sidebar new chat" }));

    await waitFor(() => {
      expect(screen.getByTestId("active-view")).toHaveTextContent("settings");
    });
    expect(screen.getByTestId("settings-section")).toHaveTextContent(
      "providers",
    );
    expect(mockAcpCreateSession).not.toHaveBeenCalled();
  });

  it("starts general chats with goose when the stored provider is unknown", async () => {
    useAgentStore.setState({
      providers: [{ id: "goose", label: "Goose" }],
      selectedProvider: "ghost-provider",
    });
    const user = userEvent.setup();
    renderAppShell();

    await user.click(screen.getByRole("button", { name: "Sidebar new chat" }));

    await waitFor(() => {
      expect(screen.getByTestId("active-view")).toHaveTextContent("chat");
    });
    expect(mockAcpCreateSession).toHaveBeenCalledWith(
      "goose",
      "~/goose artifacts",
      {
        deferProviderSetup: true,
        modelId: undefined,
        projectId: undefined,
      },
    );
  });

  it("shows a toast when project workspace startup planning fails", async () => {
    setExperimentEnabled(MULTI_WORKSPACE_EXPERIMENT_ID, true);
    gitMocks.getGitState.mockResolvedValueOnce({
      isGitRepo: false,
      currentBranch: null,
      dirtyFileCount: 0,
      incomingCommitCount: 0,
      worktrees: [],
      isWorktree: false,
      mainWorktreePath: null,
      localBranches: [],
    });
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    const user = userEvent.setup();

    const project: ProjectInfo = {
      id: "project-startup",
      path: "/tmp/project-startup.md",
      name: "Project Startup",
      description: "",
      prompt: "",
      icon: "tabler:folder-code",
      color: "olive",
      projectWorkspaces: [
        {
          id: "path:/not-a-repo/builderbot",
          path: "/not-a-repo/builderbot",
          kind: "directory",
          source: "selected",
          branch: null,
          repositoryPath: null,
          worktreePath: null,
          usedByAgent: false,
          startupMode: "branch",
        },
      ],
      workingDirs: ["/not-a-repo/builderbot"],
      useWorktrees: false,
      order: 0,
      archivedAt: null,
      artifact: null,
    };
    useProjectStore.setState({ projects: [project] });

    try {
      renderAppShell();

      await user.click(
        screen.getByRole("button", { name: "Start project chat" }),
      );
      const startupNameInput = document.getElementById(
        "project-workspace-startup-name",
      );
      if (!startupNameInput) {
        throw new Error("Startup name input not found.");
      }
      await user.type(startupNameInput, "chat-123");
      const startupNameForm = document.getElementById(
        "project-workspace-startup-name-form",
      );
      if (!startupNameForm) {
        throw new Error("Startup name form not found.");
      }
      fireEvent.submit(startupNameForm);

      await waitFor(() => {
        expect(mockToastError).toHaveBeenCalledWith(
          "Project workspace startup requires a Git repository, but /not-a-repo/builderbot is not inside one.",
        );
      });

      expect(mockAcpCreateSession).not.toHaveBeenCalled();
      expect(useChatSessionStore.getState().sessions).toEqual([]);
    } finally {
      consoleError.mockRestore();
    }
  });

  it("creates a project chat from a startup worktree plan", async () => {
    setExperimentEnabled(MULTI_WORKSPACE_EXPERIMENT_ID, true);
    const createSession = deferred<{ sessionId: string }>();
    mockAcpCreateSession.mockReturnValueOnce(createSession.promise);
    const user = userEvent.setup();

    const project: ProjectInfo = {
      id: "project-startup",
      path: "/tmp/project-startup.md",
      name: "Project Startup",
      description: "",
      prompt: "",
      icon: "tabler:folder-code",
      color: "olive",
      projectWorkspaces: [
        {
          id: "path:/repo/builderbot",
          path: "/repo/builderbot",
          kind: "subdirectory",
          source: "selected",
          branch: "main",
          repositoryPath: "/repo",
          worktreePath: "/repo",
          usedByAgent: false,
          startupMode: "worktree",
        },
      ],
      workingDirs: ["/repo/builderbot"],
      useWorktrees: false,
      order: 0,
      archivedAt: null,
      artifact: null,
    };
    useProjectStore.setState({ projects: [project] });

    renderAppShell();

    await user.click(
      screen.getByRole("button", { name: "Start project chat" }),
    );
    const startupNameInput = document.getElementById(
      "project-workspace-startup-name",
    );
    if (!startupNameInput) {
      throw new Error("Startup name input not found.");
    }
    await user.type(startupNameInput, "chat-123");
    const startupNameForm = document.getElementById(
      "project-workspace-startup-name-form",
    );
    if (!startupNameForm) {
      throw new Error("Startup name form not found.");
    }
    fireEvent.submit(startupNameForm);

    await waitFor(() => {
      expect(gitMocks.createWorktree).toHaveBeenCalledWith(
        "/repo",
        "chat-123",
        "chat-123",
        true,
        "main",
      );
    });
    expect(mockAcpCreateSession).toHaveBeenCalledWith(
      "goose",
      "/repo-worktrees/chat-123/builderbot",
      {
        deferProviderSetup: true,
        modelId: undefined,
        projectId: "project-startup",
      },
    );

    const draft = useChatSessionStore.getState().sessions[0];
    expect(draft).toEqual(
      expect.objectContaining({
        projectId: "project-startup",
        workingDir: "/repo-worktrees/chat-123/builderbot",
        creationState: "pending",
      }),
    );
    expect(draft?.workspaceAttachments).toEqual([
      expect.objectContaining({
        path: "/repo-worktrees/chat-123/builderbot",
        kind: "subdirectory",
        source: "created",
        branch: "chat-123",
        repositoryPath: "/repo",
        worktreePath: "/repo-worktrees/chat-123",
      }),
    ]);

    createSession.resolve({ sessionId: "created-session" });
    await waitFor(() => {
      expect(useChatSessionStore.getState().sessions[0]?.id).toBe(
        "created-session",
      );
    });
  });

  it("rolls back startup worktrees when project chat session creation fails", async () => {
    setExperimentEnabled(MULTI_WORKSPACE_EXPERIMENT_ID, true);
    mockAcpCreateSession.mockRejectedValueOnce(new Error("backend down"));
    const user = userEvent.setup();

    const project: ProjectInfo = {
      id: "project-startup",
      path: "/tmp/project-startup.md",
      name: "Project Startup",
      description: "",
      prompt: "",
      icon: "tabler:folder-code",
      color: "olive",
      projectWorkspaces: [
        {
          id: "path:/repo/builderbot",
          path: "/repo/builderbot",
          kind: "subdirectory",
          source: "selected",
          branch: "main",
          repositoryPath: "/repo",
          worktreePath: "/repo",
          usedByAgent: false,
          startupMode: "worktree",
        },
      ],
      workingDirs: ["/repo/builderbot"],
      useWorktrees: false,
      order: 0,
      archivedAt: null,
      artifact: null,
    };
    useProjectStore.setState({ projects: [project] });

    renderAppShell();

    await user.click(
      screen.getByRole("button", { name: "Start project chat" }),
    );
    const startupNameInput = document.getElementById(
      "project-workspace-startup-name",
    );
    if (!startupNameInput) {
      throw new Error("Startup name input not found.");
    }
    await user.type(startupNameInput, "chat-123");
    const startupNameForm = document.getElementById(
      "project-workspace-startup-name-form",
    );
    if (!startupNameForm) {
      throw new Error("Startup name form not found.");
    }
    fireEvent.submit(startupNameForm);

    await waitFor(() => {
      expect(gitMocks.createWorktree).toHaveBeenCalledWith(
        "/repo",
        "chat-123",
        "chat-123",
        true,
        "main",
      );
    });
    await waitFor(() => {
      expect(gitMocks.removeWorktree).toHaveBeenCalledWith(
        "/repo",
        "/repo-worktrees/chat-123",
        false,
      );
    });
    expect(gitMocks.deleteBranch).toHaveBeenCalledWith(
      "/repo",
      "chat-123",
      false,
      "main",
    );
    expect(useChatSessionStore.getState().sessions[0]).toEqual(
      expect.objectContaining({
        creationState: "failed",
        creationError: "backend down",
      }),
    );
  });

  it("skips project workspace startup planning when using the default configuration", async () => {
    setExperimentEnabled(MULTI_WORKSPACE_EXPERIMENT_ID, true);
    const user = userEvent.setup();

    const project: ProjectInfo = {
      id: "project-startup",
      path: "/tmp/project-startup.md",
      name: "Project Startup",
      description: "",
      prompt: "",
      icon: "tabler:folder-code",
      color: "olive",
      projectWorkspaces: [
        {
          id: "path:/repo/builderbot",
          path: "/repo/builderbot",
          kind: "subdirectory",
          source: "selected",
          branch: "main",
          repositoryPath: "/repo",
          worktreePath: "/repo",
          usedByAgent: false,
          startupMode: "worktree",
        },
        {
          id: "path:/repo/bbsubscriber",
          path: "/repo/bbsubscriber",
          kind: "subdirectory",
          source: "selected",
          branch: "main",
          repositoryPath: "/repo",
          worktreePath: "/repo",
          usedByAgent: false,
          startupMode: "branch",
        },
      ],
      workingDirs: ["/repo/builderbot", "/repo/bbsubscriber"],
      useWorktrees: false,
      order: 0,
      archivedAt: null,
      artifact: null,
    };
    useProjectStore.setState({ projects: [project] });

    renderAppShell();

    await user.click(
      screen.getByRole("button", { name: "Start project chat" }),
    );
    await user.click(
      screen.getByRole("button", {
        name: "Skip and use as-is",
      }),
    );

    await waitFor(() => {
      expect(mockAcpCreateSession).toHaveBeenCalledWith(
        "goose",
        "/repo/builderbot",
        {
          deferProviderSetup: true,
          modelId: undefined,
          projectId: "project-startup",
        },
      );
    });

    expect(gitMocks.getGitState).not.toHaveBeenCalled();
    expect(gitMocks.createWorktree).not.toHaveBeenCalled();
    expect(gitMocks.createBranch).not.toHaveBeenCalled();
    expect(useChatSessionStore.getState().sessions[0]).toEqual(
      expect.objectContaining({
        projectId: "project-startup",
        workingDir: "/repo/builderbot",
      }),
    );
    expect(
      useChatSessionStore
        .getState()
        .sessions[0]?.workspaceAttachments?.map((attachment) => ({
          path: attachment.path,
          source: attachment.source,
          branch: attachment.branch,
        })),
    ).toEqual([
      { path: "/repo/builderbot", source: "inferred", branch: "main" },
      { path: "/repo/bbsubscriber", source: "inferred", branch: "main" },
    ]);
  });

  it("reuses project drafts with hidden startup metadata when multi-workspace is disabled", async () => {
    setExperimentEnabled(MULTI_WORKSPACE_EXPERIMENT_ID, false);
    const user = userEvent.setup();
    const project: ProjectInfo = {
      id: "project-startup",
      path: "/tmp/project-startup.md",
      name: "Project Startup",
      description: "",
      prompt: "",
      icon: "tabler:folder-code",
      color: "olive",
      projectWorkspaces: [
        {
          id: "path:/repo/builderbot",
          path: "/repo/builderbot",
          kind: "subdirectory",
          source: "selected",
          branch: "main",
          repositoryPath: "/repo",
          worktreePath: "/repo",
          usedByAgent: false,
          startupMode: "worktree",
        },
      ],
      workingDirs: ["/repo/builderbot"],
      useWorktrees: false,
      order: 0,
      archivedAt: null,
      artifact: null,
    };
    const draft: ChatSession = {
      id: "existing-project-draft",
      title: "New chat",
      projectId: "project-startup",
      providerId: "goose",
      workingDir: "/repo/builderbot",
      createdAt: "2026-04-01T00:00:00.000Z",
      updatedAt: "2026-04-01T00:00:00.000Z",
      messageCount: 0,
    };
    useProjectStore.setState({ projects: [project] });
    useChatSessionStore.setState({ sessions: [draft] });
    useChatStore.setState({
      draftsBySession: { "existing-project-draft": "continue this draft" },
    });

    renderAppShell();

    await user.click(
      screen.getByRole("button", { name: "Start project chat" }),
    );

    expect(mockAcpCreateSession).not.toHaveBeenCalled();
    expect(gitMocks.createWorktree).not.toHaveBeenCalled();
    expect(
      document.getElementById("project-workspace-startup-name"),
    ).not.toBeInTheDocument();
    expect(useChatSessionStore.getState().activeSessionId).toBe(
      "existing-project-draft",
    );
  });

  it("opens pane jump mode and focuses app regions by badge key", () => {
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
      function (this: HTMLElement) {
        if (this.tagName === "HEADER") {
          return rect(0, 0, 1000, 48);
        }
        if (this.tagName === "MAIN") {
          return rect(260, 48, 740, 652);
        }
        if (this.querySelector('nav[aria-label="mock sidebar"]')) {
          return rect(0, 48, 260, 652);
        }
        return rect(760, 580, 220, 100);
      },
    );
    renderAppShell();

    fireEvent.keyDown(window, { key: ";", ctrlKey: true });
    expect(screen.getByTestId("pane-jump-overlay")).toBeInTheDocument();
    expect(screen.getByText("s")).toBeInTheDocument();
    expect(screen.getByText("sidebar")).toBeInTheDocument();

    fireEvent.keyDown(window, { key: "s" });
    expect(
      screen.getByRole("button", { name: "Sidebar new chat" }),
    ).toHaveFocus();

    fireEvent.keyDown(window, { key: ";", ctrlKey: true });
    fireEvent.keyDown(window, { key: "l" });
    expect(screen.getByPlaceholderText("Start a conversation")).toHaveFocus();
    expect(screen.queryByTestId("pane-jump-overlay")).not.toBeInTheDocument();
  });

  it("starts pane jump mode from the main composer", () => {
    mockVisibleRegionRects();
    renderAppShell();

    screen.getByPlaceholderText("Start a conversation").focus();
    fireEvent.keyDown(screen.getByPlaceholderText("Start a conversation"), {
      key: ";",
      ctrlKey: true,
    });

    expect(screen.getByTestId("pane-jump-overlay")).toBeInTheDocument();
  });

  it("starts a full blank chat from the saved artifact location", async () => {
    window.localStorage.setItem(
      "goose:artifact-root-path",
      "/Users/test/goose artifacts test",
    );
    const user = userEvent.setup();

    renderAppShell();

    await user.click(screen.getByRole("button", { name: "Sidebar new chat" }));

    await waitFor(() => {
      expect(screen.getByTestId("active-view")).toHaveTextContent("chat");
    });
    expect(mockAcpCreateSession).toHaveBeenCalledWith(
      "goose",
      "/Users/test/goose artifacts test",
      {
        deferProviderSetup: true,
        modelId: undefined,
        projectId: undefined,
      },
    );
    expect(
      useChatSessionStore
        .getState()
        .getSession(useChatSessionStore.getState().activeSessionId ?? ""),
    ).toMatchObject({
      workingDir: "/Users/test/goose artifacts test",
    });
  });

  it("opens an existing session with a missing saved cwd using the artifact fallback warning", async () => {
    const user = userEvent.setup();
    const session: ChatSession = {
      id: "missing-session",
      title: "Missing cwd chat",
      providerId: "goose",
      workingDir: "/missing/session",
      createdAt: "2026-06-09T00:00:00.000Z",
      updatedAt: "2026-06-09T00:00:00.000Z",
      messageCount: 1,
    };
    useChatSessionStore.setState({
      sessions: [session],
      activeSessionId: null,
    });
    mockCheckDirectoriesExist.mockResolvedValue(["/missing/session"]);

    renderAppShell();

    await user.click(
      screen.getByRole("button", { name: "Open missing session" }),
    );

    await waitFor(() => {
      expect(screen.getByTestId("active-view")).toHaveTextContent("chat");
      expect(mockAcpLoadSession).toHaveBeenCalledWith(
        "missing-session",
        "~/goose artifacts",
      );
    });

    const messages =
      useChatStore.getState().messagesBySession["missing-session"] ?? [];
    expect(messages).toHaveLength(1);
    expect(messages[0]?.content[0]).toMatchObject({
      type: "systemNotification",
      notificationType: "warning",
      action: { type: "openContextPanel" },
    });
  });

  it("shows a toast when a session deep link cannot open its target", async () => {
    let handler:
      | ((payload: { sessionId: string; message: string }) => void)
      | undefined;
    const unlisten = vi.fn();
    mockListenSessionDeepLinkErrors.mockImplementation(
      (nextHandler: typeof handler) => {
        handler = nextHandler;
        return Promise.resolve(unlisten);
      },
    );

    renderAppShell();

    await waitFor(() => {
      expect(handler).toBeDefined();
    });

    act(() => {
      handler?.({
        sessionId: "missing-session",
        message: 'No session "missing-session".',
      });
    });

    expect(mockToastError).toHaveBeenCalledWith(
      'No session "missing-session".',
    );
  });

  it("cleans up the session deep link error listener on unmount", async () => {
    const unlisten = vi.fn();
    mockListenSessionDeepLinkErrors.mockResolvedValue(unlisten);

    const { unmount } = renderAppShell();

    await waitFor(() => {
      expect(mockListenSessionDeepLinkErrors).toHaveBeenCalled();
    });
    await act(async () => {});

    unmount();

    expect(unlisten).toHaveBeenCalledTimes(1);
  });

  it("cleans up the session deep link error listener when setup finishes after unmount", async () => {
    const listenDeferred = deferred<() => void>();
    const unlisten = vi.fn();
    mockListenSessionDeepLinkErrors.mockReturnValue(listenDeferred.promise);

    const { unmount } = renderAppShell();

    await waitFor(() => {
      expect(mockListenSessionDeepLinkErrors).toHaveBeenCalled();
    });

    unmount();

    await act(async () => {
      listenDeferred.resolve(unlisten);
      await listenDeferred.promise;
    });

    expect(unlisten).toHaveBeenCalledTimes(1);
  });

  it("renders the target chat immediately without app-level staging", async () => {
    const user = userEvent.setup();
    const session: ChatSession = {
      id: "session-1",
      title: "Active chat",
      providerId: "goose",
      workingDir: "~/goose artifacts",
      createdAt: "2026-06-09T00:00:00.000Z",
      updatedAt: "2026-06-09T00:00:00.000Z",
      messageCount: 1,
    };
    useChatSessionStore.setState({
      sessions: [session],
      activeSessionId: null,
    });

    renderAppShell();

    await user.click(screen.getByRole("button", { name: "Open session 1" }));

    expect(screen.getByTestId("active-view")).toHaveTextContent("chat");
    expect(screen.getByTestId("preparing-content")).toHaveTextContent("false");
    expect(screen.getByTestId("rendered-view")).toHaveTextContent("chat");
    expect(screen.getByTestId("rendered-session-id")).toHaveTextContent(
      "session-1",
    );

    await act(async () => {
      flushAfterNextPaintCallbacks();
    });

    expect(screen.getByTestId("preparing-content")).toHaveTextContent("false");
    expect(screen.getByTestId("rendered-view")).toHaveTextContent("chat");
    expect(screen.getByTestId("rendered-session-id")).toHaveTextContent(
      "session-1",
    );
  });

  it("renders session-to-session chat changes immediately", async () => {
    const user = userEvent.setup();
    const sessionBase = {
      providerId: "goose",
      workingDir: "~/goose artifacts",
      createdAt: "2026-06-09T00:00:00.000Z",
      updatedAt: "2026-06-09T00:00:00.000Z",
      messageCount: 1,
    } satisfies Partial<ChatSession>;
    useChatSessionStore.setState({
      sessions: [
        { ...sessionBase, id: "session-1", title: "First chat" },
        { ...sessionBase, id: "session-2", title: "Second chat" },
      ] as ChatSession[],
      activeSessionId: "session-1",
    });

    renderAppShell();

    await user.click(screen.getByRole("button", { name: "Open session 2" }));

    expect(screen.getByTestId("active-view")).toHaveTextContent("chat");
    expect(screen.getByTestId("preparing-content")).toHaveTextContent("false");
    expect(screen.getByTestId("rendered-view")).toHaveTextContent("chat");
    expect(screen.getByTestId("rendered-session-id")).toHaveTextContent(
      "session-2",
    );
  });

  it("cleans up archive UI optimistically and rolls back archivedAt on backend failure", async () => {
    const user = userEvent.setup();
    const archive = deferred<void>();
    mockAcpArchiveSession.mockReturnValueOnce(archive.promise);
    const session: ChatSession = {
      id: "session-1",
      title: "Active chat",
      providerId: "goose",
      workingDir: "~/goose artifacts",
      createdAt: "2026-06-09T00:00:00.000Z",
      updatedAt: "2026-06-09T00:00:00.000Z",
      messageCount: 1,
    };
    const message: Message = {
      id: "message-1",
      role: "user",
      created: Date.now(),
      content: [{ type: "text", text: "hello" }],
    };
    useChatSessionStore.setState({
      sessions: [session],
      activeSessionId: null,
    });
    useChatStore.setState({
      messagesBySession: { "session-1": [message] },
    });

    renderAppShell();

    await user.click(screen.getByRole("button", { name: "Open session 1" }));
    await waitFor(() => {
      expect(screen.getByTestId("active-view")).toHaveTextContent("chat");
    });

    await user.click(screen.getByRole("button", { name: "Archive session 1" }));

    await waitFor(() => {
      expect(screen.getByTestId("active-view")).toHaveTextContent("home");
    });
    expect(mockAcpArchiveSession).toHaveBeenCalledWith("session-1");
    expect(useChatSessionStore.getState().activeSessionId).toBeNull();
    expect(
      useChatSessionStore.getState().getSession("session-1")?.archivedAt,
    ).toEqual(expect.any(String));
    expect(useChatStore.getState().messagesBySession["session-1"]).toBe(
      undefined,
    );

    act(() => {
      archive.reject(new Error("backend down"));
    });

    await waitFor(() => {
      expect(
        useChatSessionStore.getState().getSession("session-1")?.archivedAt,
      ).toBeUndefined();
    });
    expect(mockToastError).toHaveBeenCalledWith("backend down");
  });

  it("archives the active session with Cmd+E", async () => {
    const user = userEvent.setup();
    const session: ChatSession = {
      id: "session-1",
      title: "Active chat",
      providerId: "goose",
      workingDir: "~/goose artifacts",
      createdAt: "2026-06-09T00:00:00.000Z",
      updatedAt: "2026-06-09T00:00:00.000Z",
      messageCount: 1,
    };
    useChatSessionStore.setState({
      sessions: [session],
      activeSessionId: null,
    });

    renderAppShell();

    await user.click(screen.getByRole("button", { name: "Open session 1" }));
    await waitFor(() => {
      expect(screen.getByTestId("active-view")).toHaveTextContent("chat");
    });

    fireEvent.keyDown(window, { key: "e", metaKey: true });

    await waitFor(() => {
      expect(screen.getByTestId("active-view")).toHaveTextContent("home");
    });
    expect(mockAcpArchiveSession).toHaveBeenCalledWith("session-1");
    expect(useChatSessionStore.getState().activeSessionId).toBeNull();
    expect(
      useChatSessionStore.getState().getSession("session-1")?.archivedAt,
    ).toEqual(expect.any(String));
  });

  it("archives the active session with Cmd+E while the chat composer is focused", async () => {
    const user = userEvent.setup();
    const session: ChatSession = {
      id: "session-1",
      title: "Active chat",
      providerId: "goose",
      workingDir: "~/goose artifacts",
      createdAt: "2026-06-09T00:00:00.000Z",
      updatedAt: "2026-06-09T00:00:00.000Z",
      messageCount: 1,
    };
    useChatSessionStore.setState({
      sessions: [session],
      activeSessionId: null,
    });

    renderAppShell();

    await user.click(screen.getByRole("button", { name: "Open session 1" }));
    await waitFor(() => {
      expect(screen.getByTestId("active-view")).toHaveTextContent("chat");
    });

    // The real composer textarea (ChatInput) carries data-chat-composer.
    const composer = document.createElement("textarea");
    composer.setAttribute("data-chat-composer", "");
    document.body.appendChild(composer);

    composer.focus();
    fireEvent.keyDown(composer, { key: "e", metaKey: true });

    await waitFor(() => {
      expect(screen.getByTestId("active-view")).toHaveTextContent("home");
    });
    expect(mockAcpArchiveSession).toHaveBeenCalledWith("session-1");
    expect(
      useChatSessionStore.getState().getSession("session-1")?.archivedAt,
    ).toEqual(expect.any(String));
  });

  it("does not archive with Cmd+E from editable fields outside the composer", async () => {
    const user = userEvent.setup();
    const session: ChatSession = {
      id: "session-1",
      title: "Active chat",
      providerId: "goose",
      workingDir: "~/goose artifacts",
      createdAt: "2026-06-09T00:00:00.000Z",
      updatedAt: "2026-06-09T00:00:00.000Z",
      messageCount: 1,
    };
    useChatSessionStore.setState({
      sessions: [session],
      activeSessionId: null,
    });

    renderAppShell();

    await user.click(screen.getByRole("button", { name: "Open session 1" }));
    await waitFor(() => {
      expect(screen.getByTestId("active-view")).toHaveTextContent("chat");
    });

    const renameInput = document.createElement("input");
    renameInput.type = "text";
    document.body.appendChild(renameInput);

    renameInput.focus();
    fireEvent.keyDown(renameInput, { key: "e", metaKey: true });

    expect(screen.getByTestId("active-view")).toHaveTextContent("chat");
    expect(mockAcpArchiveSession).not.toHaveBeenCalled();
    expect(
      useChatSessionStore.getState().getSession("session-1")?.archivedAt,
    ).toBeUndefined();
  });

  it("does not archive from Ctrl+E inside the terminal on non-mac platforms", async () => {
    mockGetPlatform.mockReturnValue("windows");
    const user = userEvent.setup();
    const session: ChatSession = {
      id: "session-1",
      title: "Active chat",
      providerId: "goose",
      workingDir: "~/goose artifacts",
      createdAt: "2026-06-09T00:00:00.000Z",
      updatedAt: "2026-06-09T00:00:00.000Z",
      messageCount: 1,
    };
    useChatSessionStore.setState({
      sessions: [session],
      activeSessionId: null,
    });

    renderAppShell();

    await user.click(screen.getByRole("button", { name: "Open session 1" }));
    await waitFor(() => {
      expect(screen.getByTestId("active-view")).toHaveTextContent("chat");
    });

    const terminal = document.createElement("div");
    terminal.className = "xterm";
    const terminalInput = document.createElement("textarea");
    terminal.appendChild(terminalInput);
    document.body.appendChild(terminal);

    terminalInput.focus();
    fireEvent.keyDown(terminalInput, { key: "e", ctrlKey: true });

    expect(screen.getByTestId("active-view")).toHaveTextContent("chat");
    expect(mockAcpArchiveSession).not.toHaveBeenCalled();
    expect(useChatSessionStore.getState().activeSessionId).toBe("session-1");
    expect(
      useChatSessionStore.getState().getSession("session-1")?.archivedAt,
    ).toBeUndefined();
  });

  it("reserves toast space only while the global composer is visible", async () => {
    const user = userEvent.setup();
    renderAppShell();

    await waitFor(() => {
      expect(document.documentElement).toHaveAttribute(
        "data-global-composer-visible",
        "true",
      );
    });

    await user.click(screen.getByRole("button", { name: "Sidebar new chat" }));

    await waitFor(() => {
      expect(screen.getByTestId("active-view")).toHaveTextContent("chat");
    });
    expect(document.documentElement).not.toHaveAttribute(
      "data-global-composer-visible",
    );
  });

  it("keeps the current view and focuses a centered global composer with Cmd+N from chat", async () => {
    const user = userEvent.setup();
    renderAppShell();

    await user.click(screen.getByRole("button", { name: "Sidebar new chat" }));
    await waitFor(() => {
      expect(screen.getByTestId("active-view")).toHaveTextContent("chat");
    });
    await waitFor(() => {
      expect(mockAcpCreateSession).toHaveBeenCalledTimes(1);
    });
    mockAcpCreateSession.mockClear();

    await user.keyboard("{Meta>}n{/Meta}");

    await act(async () => {
      flushAfterNextPaintCallbacks();
    });
    expect(screen.getByTestId("active-view")).toHaveTextContent("chat");
    const textbox = await screen.findByPlaceholderText("Start a conversation");
    await waitFor(() => {
      expect(textbox).toHaveFocus();
    });
    expect(textbox.closest("[data-placement]")).toHaveAttribute(
      "data-placement",
      "centered",
    );
    expect(mockAcpCreateSession).not.toHaveBeenCalled();
  });

  it("dismisses the centered global composer from the backdrop and global Escape", async () => {
    for (const dismiss of ["backdrop", "escape"] as const) {
      const { container, unmount } = renderAppShell();

      await openCenteredComposerFromChat();
      if (dismiss === "backdrop") {
        const shim = container.querySelector(".global-composer-shim");
        expect(shim).not.toBeNull();
        fireEvent.click(shim as Element);
      } else {
        fireEvent.keyDown(window, { key: "Escape" });
      }

      await waitFor(() => {
        expect(
          screen.queryByPlaceholderText("Start a conversation"),
        ).not.toBeInTheDocument();
      });
      unmount();
    }
  });

  it("lets nested centered-composer pickers consume Escape before the composer dismisses", async () => {
    renderAppShell();

    const { textbox, user } = await openCenteredComposerFromChat();
    await user.click(
      screen.getByRole("button", { name: /choose agent and model/i }),
    );
    await screen.findByText("Agent");

    await user.keyboard("{Escape}");

    await waitFor(() => {
      expect(screen.queryByText("Agent")).not.toBeInTheDocument();
    });
    expect(textbox).toBeInTheDocument();
    expect(textbox.closest("[data-placement]")).toHaveAttribute(
      "data-placement",
      "centered",
    );

    fireEvent.keyDown(window, { key: "Escape" });
    await waitFor(() => {
      expect(
        screen.queryByPlaceholderText("Start a conversation"),
      ).not.toBeInTheDocument();
    });
  });

  it("preserves the suggested agent tag when starting chat from the global composer", async () => {
    renderAppShell();

    fireEvent.click(screen.getByRole("button", { name: "Open agent detail" }));
    await act(async () => {
      flushAfterNextPaintCallbacks();
    });
    expect(screen.getByTestId("agent-route")).toHaveTextContent("persona-1");

    const textbox = screen.getByPlaceholderText("Start a conversation");
    fireEvent.change(textbox, {
      target: { value: "ask the tagged agent" },
    });
    fireEvent.keyDown(textbox, { key: "Enter" });

    await waitFor(() => {
      expect(useChatStore.getState().queuedMessageBySession).toMatchObject({
        "created-session": {
          text: "ask the tagged agent",
          personaId: "persona-1",
        },
      });
      expect(
        useChatSessionStore.getState().getSession("created-session"),
      ).toMatchObject({
        personaId: "persona-1",
      });
    });
  });

  it("starts centered composer sends on a background draft before the visual handoff changes chat", async () => {
    vi.useFakeTimers();
    try {
      const session: ChatSession = {
        id: "session-1",
        title: "Active chat",
        providerId: "goose",
        workingDir: "~/goose artifacts",
        createdAt: "2026-06-09T00:00:00.000Z",
        updatedAt: "2026-06-09T00:00:00.000Z",
        messageCount: 1,
      };
      useChatSessionStore.setState({
        sessions: [session],
        activeSessionId: null,
      });
      renderAppShell();

      fireEvent.click(screen.getByRole("button", { name: "Open session 1" }));
      expect(useChatSessionStore.getState().activeSessionId).toBe("session-1");
      fireEvent.click(screen.getByRole("button", { name: "Sidebar chats" }));
      expect(
        screen.getByTestId("mock-sidebar-prototype-secondary-target"),
      ).toHaveTextContent(JSON.stringify({ kind: "chats" }));
      mockAcpCreateSession.mockClear();

      fireEvent.keyDown(window, { key: "n", metaKey: true });
      const textbox = screen.getByPlaceholderText("Start a conversation");
      fireEvent.change(textbox, {
        target: { value: "send behind the animation" },
      });
      fireEvent.keyDown(textbox, { key: "Enter" });
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });

      const queuedMessages = useChatStore.getState().queuedMessageBySession;
      const [draftSessionId] = Object.keys(queuedMessages);
      expect(draftSessionId).toEqual(expect.any(String));
      expect(draftSessionId).not.toBe("session-1");
      expect(queuedMessages[draftSessionId]).toMatchObject({
        text: "send behind the animation",
      });
      expect(useChatSessionStore.getState().activeSessionId).toBe("session-1");
      expect(screen.getByTestId("rendered-session-id")).toHaveTextContent(
        "session-1",
      );

      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(mockAcpCreateSession).toHaveBeenCalledTimes(1);

      act(() => {
        vi.advanceTimersByTime(220);
      });
      expect(useChatSessionStore.getState().activeSessionId).not.toBe(
        "session-1",
      );
      expect(
        screen.getByTestId("mock-sidebar-prototype-secondary-target"),
      ).toHaveTextContent("null");
    } finally {
      vi.useRealTimers();
    }
  });

  it("uses project startup planning for centered composer sends to startup worktree projects", async () => {
    setExperimentEnabled(MULTI_WORKSPACE_EXPERIMENT_ID, true);
    const createSession = deferred<{ sessionId: string }>();
    mockAcpCreateSession.mockReturnValueOnce(createSession.promise);
    const project: ProjectInfo = {
      id: "project-1",
      path: "/tmp/project-startup.md",
      name: "Project Startup",
      description: "",
      prompt: "",
      icon: "tabler:folder-code",
      color: "olive",
      projectWorkspaces: [
        {
          id: "path:/repo/builderbot",
          path: "/repo/builderbot",
          kind: "subdirectory",
          source: "selected",
          branch: "main",
          repositoryPath: "/repo",
          worktreePath: "/repo",
          usedByAgent: false,
          startupMode: "worktree",
        },
      ],
      workingDirs: ["/repo/builderbot"],
      useWorktrees: false,
      order: 0,
      archivedAt: null,
      artifact: null,
    };
    useProjectStore.setState({ projects: [project] });
    const user = userEvent.setup();
    renderAppShell();

    await user.click(screen.getByRole("button", { name: "Sidebar new chat" }));
    await waitFor(() => {
      expect(screen.getByTestId("active-view")).toHaveTextContent("chat");
    });
    mockAcpCreateSession.mockClear();
    await user.keyboard("{Meta>}n{/Meta}");
    const textbox = await screen.findByPlaceholderText("Start a conversation");
    await waitFor(() => {
      expect(textbox.closest("[data-placement]")).toHaveAttribute(
        "data-placement",
        "centered",
      );
    });

    await user.click(screen.getByRole("button", { name: /select project/i }));
    await user.click(
      screen.getByRole("menuitem", { name: /Project Startup/i }),
    );
    expect(await screen.findByText("Project Startup")).toBeInTheDocument();
    await user.type(textbox, "send from centered composer");
    await user.keyboard("{Enter}");

    const startupNameInput = await waitFor(() => {
      const input = document.getElementById("project-workspace-startup-name");
      if (!input) {
        throw new Error("Startup name input not found.");
      }
      return input;
    });
    expect(mockAcpCreateSession).not.toHaveBeenCalled();
    expect(gitMocks.createWorktree).not.toHaveBeenCalled();

    await user.type(startupNameInput, "chat-123");
    const startupNameForm = document.getElementById(
      "project-workspace-startup-name-form",
    );
    if (!startupNameForm) {
      throw new Error("Startup name form not found.");
    }
    fireEvent.submit(startupNameForm);

    await waitFor(() => {
      expect(gitMocks.createWorktree).toHaveBeenCalledWith(
        "/repo",
        "chat-123",
        "chat-123",
        true,
        "main",
      );
    });
    const draftSessionId = useChatSessionStore.getState().sessions[0]?.id;
    expect(draftSessionId).toEqual(expect.any(String));
    expect(useChatStore.getState().queuedMessageBySession).toMatchObject({
      [draftSessionId as string]: {
        text: "send from centered composer",
      },
    });

    createSession.resolve({ sessionId: "created-session" });
    await waitFor(() => {
      expect(useChatStore.getState().queuedMessageBySession).toMatchObject({
        "created-session": {
          text: "send from centered composer",
        },
      });
    });
  });

  it("attaches all as-is project workspaces for centered composer sends", async () => {
    setExperimentEnabled(MULTI_WORKSPACE_EXPERIMENT_ID, true);
    const createSession = deferred<{ sessionId: string }>();
    mockAcpCreateSession.mockReturnValueOnce(createSession.promise);
    const project: ProjectInfo = {
      id: "project-1",
      path: "/tmp/project-startup.md",
      name: "Project Startup",
      description: "",
      prompt: "",
      icon: "tabler:folder-code",
      color: "olive",
      projectWorkspaces: [
        {
          id: "path:/repo/builderbot",
          path: "/repo/builderbot",
          kind: "subdirectory",
          source: "selected",
          branch: "main",
          repositoryPath: "/repo",
          worktreePath: "/repo",
          usedByAgent: false,
          startupMode: "none",
        },
        {
          id: "path:/repo/bbsubscriber",
          path: "/repo/bbsubscriber",
          kind: "subdirectory",
          source: "selected",
          branch: "main",
          repositoryPath: "/repo",
          worktreePath: "/repo",
          usedByAgent: false,
          startupMode: "none",
        },
      ],
      workingDirs: ["/repo/builderbot", "/repo/bbsubscriber"],
      useWorktrees: false,
      order: 0,
      archivedAt: null,
      artifact: null,
    };
    useProjectStore.setState({ projects: [project] });
    const user = userEvent.setup();
    renderAppShell();

    await user.click(screen.getByRole("button", { name: "Sidebar new chat" }));
    await waitFor(() => {
      expect(screen.getByTestId("active-view")).toHaveTextContent("chat");
    });
    mockAcpCreateSession.mockClear();
    await user.keyboard("{Meta>}n{/Meta}");
    const textbox = await screen.findByPlaceholderText("Start a conversation");
    await waitFor(() => {
      expect(textbox.closest("[data-placement]")).toHaveAttribute(
        "data-placement",
        "centered",
      );
    });

    await user.click(screen.getByRole("button", { name: /select project/i }));
    await user.click(
      screen.getByRole("menuitem", { name: /Project Startup/i }),
    );
    expect(await screen.findByText("Project Startup")).toBeInTheDocument();
    await user.type(textbox, "send with all folders");
    await user.keyboard("{Enter}");

    await waitFor(() => {
      expect(mockAcpCreateSession).toHaveBeenCalledWith(
        "goose",
        "/repo/builderbot",
        {
          deferProviderSetup: true,
          modelId: undefined,
          projectId: "project-1",
        },
      );
    });
    expect(gitMocks.getGitState).not.toHaveBeenCalled();
    expect(gitMocks.createWorktree).not.toHaveBeenCalled();
    expect(gitMocks.createBranch).not.toHaveBeenCalled();

    const draftSessionId = useChatSessionStore.getState().sessions[0]?.id;
    expect(draftSessionId).toEqual(expect.any(String));
    expect(
      useChatSessionStore
        .getState()
        .sessions[0]?.workspaceAttachments?.map((attachment) => ({
          path: attachment.path,
          source: attachment.source,
        })),
    ).toEqual([
      { path: "/repo/builderbot", source: "inferred" },
      { path: "/repo/bbsubscriber", source: "inferred" },
    ]);
    expect(useChatStore.getState().queuedMessageBySession).toMatchObject({
      [draftSessionId as string]: {
        text: "send with all folders",
      },
    });

    createSession.resolve({ sessionId: "created-session" });
    await waitFor(() => {
      expect(useChatStore.getState().queuedMessageBySession).toMatchObject({
        "created-session": {
          text: "send with all folders",
        },
      });
    });
  });

  it("skips the centered composer handoff delay for reduced-motion users", async () => {
    const originalMatchMedia = window.matchMedia;
    window.matchMedia = vi.fn().mockImplementation((query: string) => ({
      matches: query === "(prefers-reduced-motion: reduce)",
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    }));

    try {
      const session: ChatSession = {
        id: "session-1",
        title: "Active chat",
        providerId: "goose",
        workingDir: "~/goose artifacts",
        createdAt: "2026-06-09T00:00:00.000Z",
        updatedAt: "2026-06-09T00:00:00.000Z",
        messageCount: 1,
      };
      useChatSessionStore.setState({
        sessions: [session],
        activeSessionId: null,
      });
      renderAppShell();

      fireEvent.click(screen.getByRole("button", { name: "Open session 1" }));
      fireEvent.keyDown(window, { key: "n", metaKey: true });
      const textbox = screen.getByPlaceholderText("Start a conversation");
      fireEvent.change(textbox, {
        target: { value: "send without animation" },
      });
      fireEvent.keyDown(textbox, { key: "Enter" });
      await waitFor(() => {
        expect(useChatSessionStore.getState().activeSessionId).not.toBe(
          "session-1",
        );
      });

      expect(screen.getByTestId("active-view")).toHaveTextContent("chat");
      expect(useChatSessionStore.getState().activeSessionId).not.toBe(
        "session-1",
      );
      expect(
        screen.queryByPlaceholderText("Start a conversation"),
      ).not.toBeInTheDocument();
    } finally {
      window.matchMedia = originalMatchMedia;
    }
  });

  it("keeps centered composer send activation after navigation resets the visual handoff", async () => {
    vi.useFakeTimers();
    try {
      const session: ChatSession = {
        id: "session-1",
        title: "Active chat",
        providerId: "goose",
        workingDir: "~/goose artifacts",
        createdAt: "2026-06-09T00:00:00.000Z",
        updatedAt: "2026-06-09T00:00:00.000Z",
        messageCount: 1,
      };
      useChatSessionStore.setState({
        sessions: [session],
        activeSessionId: null,
      });
      renderAppShell();

      fireEvent.click(screen.getByRole("button", { name: "Open session 1" }));
      fireEvent.keyDown(window, { key: "n", metaKey: true });
      const textbox = screen.getByPlaceholderText("Start a conversation");
      fireEvent.change(textbox, {
        target: { value: "send then navigate quickly" },
      });
      fireEvent.keyDown(textbox, { key: "Enter" });
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });

      const [draftSessionId] = Object.keys(
        useChatStore.getState().queuedMessageBySession,
      );
      expect(draftSessionId).toEqual(expect.any(String));

      fireEvent.click(screen.getByRole("button", { name: "Sidebar skills" }));
      expect(screen.getByTestId("active-view")).toHaveTextContent("skills");

      act(() => {
        vi.advanceTimersByTime(220);
      });

      expect(screen.getByTestId("active-view")).toHaveTextContent("chat");
      expect(useChatSessionStore.getState().activeSessionId).not.toBe(
        "session-1",
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not queue Cmd+N focus when the global composer remains hidden", async () => {
    const user = userEvent.setup();
    const { rerender } = renderAppShell(<div>Custom shell content</div>);

    await user.click(screen.getByRole("button", { name: "Sidebar new chat" }));
    await waitFor(() => {
      expect(mockAcpCreateSession).toHaveBeenCalledTimes(1);
    });
    expect(
      screen.queryByPlaceholderText("Start a conversation"),
    ).not.toBeInTheDocument();

    await user.keyboard("{Meta>}n{/Meta}");

    expect(useChatSessionStore.getState().activeSessionId).not.toBeNull();
    rerender(appShellWithTheme());
    await act(async () => {
      flushAfterNextPaintCallbacks();
    });

    expect(
      screen.queryByPlaceholderText("Start a conversation"),
    ).not.toBeInTheDocument();
  });

  it("opens a blank chat before ACP session creation finishes", async () => {
    const pendingSession = deferred<{ sessionId: string }>();
    mockAcpCreateSession.mockReturnValueOnce(pendingSession.promise);
    const user = userEvent.setup();
    renderAppShell();

    await user.click(screen.getByRole("button", { name: "Sidebar new chat" }));

    await waitFor(() => {
      expect(screen.getByTestId("active-view")).toHaveTextContent("chat");
    });
    await waitFor(() => {
      expect(mockAcpCreateSession).toHaveBeenCalled();
    });

    const draftSessionId = useChatSessionStore.getState().activeSessionId;
    expect(draftSessionId).toEqual(expect.any(String));
    expect(draftSessionId).not.toBe("created-session");
    expect(
      useChatSessionStore.getState().getSession(draftSessionId ?? ""),
    ).toMatchObject({
      creationState: "pending",
      workingDir: "~/goose artifacts",
    });
    const draftWorkingDir = useChatSessionStore
      .getState()
      .getSession(draftSessionId ?? "")?.workingDir;

    act(() => {
      pendingSession.resolve({ sessionId: "created-session" });
    });

    await waitFor(() => {
      expect(useChatSessionStore.getState().activeSessionId).toBe(
        "created-session",
      );
    });
    expect(
      useChatSessionStore.getState().getSession("created-session"),
    ).toMatchObject({
      creationState: undefined,
      workingDir: draftWorkingDir,
    });
  });

  it("reuses the active blank chat when the sidebar new chat action is repeated", async () => {
    const pendingSession = deferred<{ sessionId: string }>();
    mockAcpCreateSession.mockReturnValueOnce(pendingSession.promise);
    const user = userEvent.setup();
    renderAppShell();

    await user.click(screen.getByRole("button", { name: "Sidebar new chat" }));

    await waitFor(() => {
      expect(mockAcpCreateSession).toHaveBeenCalledTimes(1);
    });
    const draftSessionId = useChatSessionStore.getState().activeSessionId;

    await user.click(screen.getByRole("button", { name: "Sidebar new chat" }));

    expect(useChatSessionStore.getState().activeSessionId).toBe(draftSessionId);
    expect(useChatSessionStore.getState().sessions).toHaveLength(1);
    expect(mockAcpCreateSession).toHaveBeenCalledTimes(1);

    act(() => {
      pendingSession.resolve({ sessionId: "created-session" });
    });
  });

  it("shows ACP error data when draft session creation fails", async () => {
    const error = new Error("Internal error") as Error & { data: string };
    error.name = "RequestError";
    error.data = "Failed to create session: provider config is missing";
    mockAcpCreateSession.mockRejectedValueOnce(error);
    const user = userEvent.setup();
    renderAppShell();

    await user.click(screen.getByRole("button", { name: "Sidebar new chat" }));

    await waitFor(() => {
      const draftSessionId = useChatSessionStore.getState().activeSessionId;
      expect(
        useChatSessionStore.getState().getSession(draftSessionId ?? ""),
      ).toMatchObject({
        creationState: "failed",
        creationError: "Failed to create session: provider config is missing",
      });
    });

    const draftSessionId = useChatSessionStore.getState().activeSessionId ?? "";
    const messages = useChatStore.getState().messagesBySession[draftSessionId];
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      role: "system",
      content: [
        {
          type: "systemNotification",
          notificationType: "error",
          text: "Failed to create session: provider config is missing",
        },
      ],
    });
  });

  it("goes back and forward through Skills detail subroutes", async () => {
    const user = userEvent.setup();
    renderAppShell();

    await user.click(screen.getByRole("button", { name: "Sidebar skills" }));
    await user.click(screen.getByRole("button", { name: "Open skill detail" }));

    expect(screen.getByTestId("active-view")).toHaveTextContent("skills");
    expect(screen.getByTestId("skill-route")).toHaveTextContent("skill-1");

    await user.click(screen.getByRole("button", { name: "Back" }));

    await waitFor(() => {
      expect(screen.getByTestId("skill-route")).toHaveTextContent("list");
    });

    await user.click(screen.getByRole("button", { name: "Forward" }));

    await waitFor(() => {
      expect(screen.getByTestId("skill-route")).toHaveTextContent("skill-1");
    });
  });

  it("goes back and forward with the navigation history shortcuts", async () => {
    const user = userEvent.setup();
    renderAppShell();

    await user.click(screen.getByRole("button", { name: "Sidebar skills" }));
    await user.click(screen.getByRole("button", { name: "Open skill detail" }));

    expect(screen.getByTestId("skill-route")).toHaveTextContent("skill-1");

    fireEvent.keyDown(window, { key: "[", metaKey: true });
    await waitFor(() => {
      expect(screen.getByTestId("skill-route")).toHaveTextContent("list");
    });

    fireEvent.keyDown(window, { key: "]", metaKey: true });
    await waitFor(() => {
      expect(screen.getByTestId("skill-route")).toHaveTextContent("skill-1");
    });
  });

  it("uses Alt+Left and Alt+Right for navigation history on Windows", async () => {
    mockGetPlatform.mockReturnValue("windows");
    const user = userEvent.setup();
    renderAppShell();

    await user.click(screen.getByRole("button", { name: "Sidebar skills" }));
    await user.click(screen.getByRole("button", { name: "Open skill detail" }));

    fireEvent.keyDown(window, { key: "ArrowLeft", altKey: true });
    await waitFor(() => {
      expect(screen.getByTestId("skill-route")).toHaveTextContent("list");
    });

    fireEvent.keyDown(window, { key: "ArrowRight", altKey: true });
    await waitFor(() => {
      expect(screen.getByTestId("skill-route")).toHaveTextContent("skill-1");
    });
  });

  it("does not navigate history while an embedded terminal has focus", async () => {
    mockGetPlatform.mockReturnValue("windows");
    const user = userEvent.setup();
    renderAppShell();

    await user.click(screen.getByRole("button", { name: "Sidebar skills" }));
    await user.click(screen.getByRole("button", { name: "Open skill detail" }));

    const terminal = document.createElement("div");
    terminal.className = "xterm";
    document.body.append(terminal);
    try {
      fireEvent.keyDown(terminal, { key: "ArrowLeft", altKey: true });
      expect(screen.getByTestId("skill-route")).toHaveTextContent("skill-1");
    } finally {
      terminal.remove();
    }
  });

  it("allows Cmd+[ to navigate history while an embedded terminal has focus", async () => {
    const user = userEvent.setup();
    renderAppShell();

    await user.click(screen.getByRole("button", { name: "Sidebar skills" }));
    await user.click(screen.getByRole("button", { name: "Open skill detail" }));

    const terminal = document.createElement("div");
    terminal.className = "xterm";
    document.body.append(terminal);
    try {
      fireEvent.keyDown(terminal, { key: "[", metaKey: true });
      await waitFor(() => {
        expect(screen.getByTestId("skill-route")).toHaveTextContent("list");
      });
    } finally {
      terminal.remove();
    }
  });

  it("goes back and forward through Automations tabs", async () => {
    const user = userEvent.setup();
    renderAppShell();

    await user.click(
      screen.getByRole("button", { name: "Sidebar automations" }),
    );
    await user.click(
      screen.getByRole("button", { name: "Open automation history" }),
    );

    expect(screen.getByTestId("automation-route")).toHaveTextContent(
      '"surface":"history"',
    );

    await user.click(screen.getByRole("button", { name: "Back" }));

    await waitFor(() => {
      expect(screen.getByTestId("automation-route")).toHaveTextContent(
        '"surface":"overview"',
      );
    });

    await user.click(screen.getByRole("button", { name: "Forward" }));

    await waitFor(() => {
      expect(screen.getByTestId("automation-route")).toHaveTextContent(
        '"surface":"history"',
      );
    });
  });

  it("goes back and forward through Builderbot detail subroutes", async () => {
    enableBuilderbotExperiment();
    const user = userEvent.setup();
    renderAppShell();

    await user.click(
      screen.getByRole("button", { name: "Sidebar builderbot" }),
    );
    await user.click(
      screen.getByRole("button", { name: "Open builderbot task" }),
    );

    expect(screen.getByTestId("active-view")).toHaveTextContent("builderbot");
    expect(screen.getByTestId("builderbot-route")).toHaveTextContent(
      '"surface":"task"',
    );
    expect(screen.getByTestId("builderbot-route")).toHaveTextContent(
      '"taskKey":"TASK-1"',
    );

    await user.click(screen.getByRole("button", { name: "Back" }));

    await waitFor(() => {
      expect(screen.getByTestId("builderbot-route")).toHaveTextContent(
        '"surface":"overview"',
      );
    });

    await user.click(screen.getByRole("button", { name: "Forward" }));

    await waitFor(() => {
      expect(screen.getByTestId("builderbot-route")).toHaveTextContent(
        '"surface":"task"',
      );
    });
  });

  it("goes back and forward through Agents detail subroutes", async () => {
    const user = userEvent.setup();
    renderAppShell();

    await user.click(screen.getByRole("button", { name: "Sidebar agents" }));
    await user.click(screen.getByRole("button", { name: "Open agent detail" }));

    expect(screen.getByTestId("active-view")).toHaveTextContent("agents");
    expect(screen.getByTestId("agent-route")).toHaveTextContent("persona-1");

    await user.click(screen.getByRole("button", { name: "Back" }));

    await waitFor(() => {
      expect(screen.getByTestId("agent-route")).toHaveTextContent("list");
    });

    await user.click(screen.getByRole("button", { name: "Forward" }));

    await waitFor(() => {
      expect(screen.getByTestId("agent-route")).toHaveTextContent("persona-1");
    });
  });

  it("starts a new agent builder session without prompting against itself", async () => {
    const user = userEvent.setup();
    renderAppShell();

    await user.click(screen.getByRole("button", { name: "Sidebar agents" }));
    await user.click(screen.getByRole("button", { name: "Create agent" }));

    await waitFor(() => {
      expect(screen.getByTestId("active-view")).toHaveTextContent("chat");
    });
    expect(
      screen.queryByText("Save this agent draft?"),
    ).not.toBeInTheDocument();
    await waitForCreatedAgentBuilderTarget();
  });

  it("shows the new agent builder before the draft target is ready", async () => {
    const user = userEvent.setup();
    const draft = deferred<{
      type: "agent";
      path: string;
      name: string;
      description: string;
      content: string;
      global: boolean;
      writable: boolean;
      properties: { draft: boolean; builderSessionId: string };
    }>();
    mockCreatePersonaSource.mockImplementation(() => draft.promise);
    renderAppShell();

    await user.click(screen.getByRole("button", { name: "Sidebar agents" }));
    await user.click(screen.getByRole("button", { name: "Create agent" }));

    await waitFor(() => {
      expect(mockAcpCreateSession).toHaveBeenCalled();
    });
    await waitFor(() => {
      expect(screen.getByTestId("active-view")).toHaveTextContent("chat");
    });
    await waitFor(() => {
      expect(useChatSessionStore.getState().activeSessionId).toBe(
        "created-session",
      );
    });
    expect(useChatSessionStore.getState().getActiveSession()).toMatchObject({
      id: "created-session",
      intent: "build-agent",
      targetAgentPath: null,
      targetAgentSlug: null,
      targetAgentDraftState: "preparing",
    });

    draft.resolve({
      type: "agent",
      path: "/Users/test/.agents/agents/untitled-agent-created-session.md",
      name: "Untitled agent created-sess",
      description: "Draft",
      content: "Draft in progress.",
      global: true,
      writable: true,
      properties: { draft: true, builderSessionId: "created-session" },
    });

    await waitFor(() => {
      expect(screen.getByTestId("active-view")).toHaveTextContent("chat");
    });
    await waitForCreatedAgentBuilderTarget();
  });

  it("prompts when navigating away from a dirty new agent draft", async () => {
    const user = userEvent.setup();
    renderAppShell();

    await user.click(screen.getByRole("button", { name: "Sidebar agents" }));
    await user.click(screen.getByRole("button", { name: "Create agent" }));
    await waitFor(() => {
      expect(screen.getByTestId("active-view")).toHaveTextContent("chat");
    });
    await waitForCreatedAgentBuilderTarget();

    const dirtyDraft = {
      type: "agent",
      path: "/Users/test/.agents/agents/untitled-agent-created-session.md",
      name: "Reviewer",
      description: "Draft",
      content: "Review code carefully.",
      global: true,
      writable: true,
      properties: { draft: true, builderSessionId: "created-session" },
    };
    mockListPersonaSources.mockResolvedValue([dirtyDraft]);
    mockReadAgentSourceFile.mockResolvedValue(dirtyDraft);

    await user.click(screen.getByRole("button", { name: "Sidebar agents" }));

    await waitFor(() => {
      expect(screen.getByText("Save this agent draft?")).toBeInTheDocument();
    });
    expect(screen.getByTestId("active-view")).toHaveTextContent("chat");
  });

  it("does not prompt when navigating away from an untouched new agent draft", async () => {
    const user = userEvent.setup();
    renderAppShell();

    await user.click(screen.getByRole("button", { name: "Sidebar agents" }));
    await user.click(screen.getByRole("button", { name: "Create agent" }));
    await waitFor(() => {
      expect(screen.getByTestId("active-view")).toHaveTextContent("chat");
    });

    await user.click(screen.getByRole("button", { name: "Sidebar skills" }));

    await waitFor(() => {
      expect(screen.getByTestId("active-view")).toHaveTextContent("skills");
    });
    expect(
      screen.queryByText("Save this agent draft?"),
    ).not.toBeInTheDocument();
  });

  it("returns to agent builder mode after going back then forward", async () => {
    const user = userEvent.setup();
    renderAppShell();

    await user.click(screen.getByRole("button", { name: "Sidebar agents" }));
    await user.click(screen.getByRole("button", { name: "Create agent" }));
    await waitFor(() => {
      expect(screen.getByTestId("active-view")).toHaveTextContent("chat");
    });
    await waitFor(() => {
      expect(useChatSessionStore.getState().getActiveSession()).toMatchObject({
        id: "created-session",
        intent: "build-agent",
      });
    });

    await user.click(screen.getByRole("button", { name: "Back" }));
    await waitFor(() => {
      expect(screen.getByTestId("active-view")).toHaveTextContent("agents");
    });

    await user.click(screen.getByRole("button", { name: "Forward" }));
    await waitFor(() => {
      expect(screen.getByTestId("active-view")).toHaveTextContent("chat");
    });
    await waitFor(() => {
      expect(useChatSessionStore.getState().getActiveSession()).toMatchObject({
        id: "created-session",
        intent: "build-agent",
        targetAgentPath:
          "/Users/test/.agents/agents/untitled-agent-created-session.md",
      });
    });
  });

  it("prompts when navigating away after typing in the agent builder chat", async () => {
    const user = userEvent.setup();
    renderAppShell();

    await user.click(screen.getByRole("button", { name: "Sidebar agents" }));
    await user.click(screen.getByRole("button", { name: "Create agent" }));
    await waitFor(() => {
      expect(screen.getByTestId("active-view")).toHaveTextContent("chat");
    });
    await waitForCreatedAgentBuilderTarget();

    useChatStore.getState().setDraft("created-session", "make me a reviewer");

    await user.click(screen.getByRole("button", { name: "Sidebar skills" }));

    await waitFor(() => {
      expect(screen.getByText("Save this agent draft?")).toBeInTheDocument();
    });
    expect(screen.getByTestId("active-view")).toHaveTextContent("chat");
  });

  it("returns from provider setup settings to the dirty agent draft without prompting", async () => {
    const user = userEvent.setup();
    renderAppShell();

    await user.click(screen.getByRole("button", { name: "Sidebar agents" }));
    await user.click(screen.getByRole("button", { name: "Create agent" }));
    await waitFor(() => {
      expect(screen.getByTestId("active-view")).toHaveTextContent("chat");
    });
    await waitForCreatedAgentBuilderTarget();

    const dirtyDraft = {
      type: "agent",
      path: "/Users/test/.agents/agents/untitled-agent-created-session.md",
      name: "Reviewer",
      description: "Draft",
      content: "Review code carefully.",
      global: true,
      writable: true,
      properties: { draft: true, builderSessionId: "created-session" },
    };
    mockListPersonaSources.mockResolvedValue([dirtyDraft]);
    mockReadAgentSourceFile.mockResolvedValue(dirtyDraft);

    act(() => {
      window.dispatchEvent(
        new CustomEvent(OPEN_SETTINGS_EVENT, {
          detail: {
            section: "providers",
            returnTarget: {
              type: "agent-builder-provider-setup",
              sessionId: "created-session",
              providerId: "claude-acp",
            },
          },
        }),
      );
    });

    await waitFor(() => {
      expect(screen.getByTestId("active-view")).toHaveTextContent("settings");
    });

    await user.click(screen.getByRole("button", { name: "Back" }));

    await waitFor(() => {
      expect(screen.getByTestId("active-view")).toHaveTextContent("chat");
    });
    expect(
      screen.queryByText("Save this agent draft?"),
    ).not.toBeInTheDocument();
  });

  it("discarding a dirty agent draft continues the pending navigation", async () => {
    const user = userEvent.setup();
    renderAppShell();

    await user.click(screen.getByRole("button", { name: "Sidebar agents" }));
    await user.click(screen.getByRole("button", { name: "Create agent" }));
    await waitFor(() => {
      expect(screen.getByTestId("active-view")).toHaveTextContent("chat");
    });
    await waitForCreatedAgentBuilderTarget();

    const dirtyDraft = {
      type: "agent",
      path: "/Users/test/.agents/agents/untitled-agent-created-session.md",
      name: "Reviewer",
      description: "Draft",
      content: "Review code carefully.",
      global: true,
      writable: true,
      properties: { draft: true, builderSessionId: "created-session" },
    };
    mockListPersonaSources.mockResolvedValue([dirtyDraft]);
    mockReadAgentSourceFile.mockResolvedValue(dirtyDraft);

    await user.click(screen.getByRole("button", { name: "Sidebar skills" }));
    await user.click(await screen.findByRole("button", { name: "Discard" }));

    await waitFor(() => {
      expect(screen.getByTestId("active-view")).toHaveTextContent("skills");
    });
    expect(mockDeletePersonaSource).toHaveBeenCalledWith(dirtyDraft.path);
  });

  it("keeping a dirty agent draft continues the pending navigation without deleting it", async () => {
    const user = userEvent.setup();
    renderAppShell();

    await user.click(screen.getByRole("button", { name: "Sidebar agents" }));
    await user.click(screen.getByRole("button", { name: "Create agent" }));
    await waitFor(() => {
      expect(screen.getByTestId("active-view")).toHaveTextContent("chat");
    });
    await waitForCreatedAgentBuilderTarget();

    const dirtyDraft = {
      type: "agent",
      path: "/Users/test/.agents/agents/untitled-agent-created-session.md",
      name: "Reviewer",
      description: "Draft",
      content: "Review code carefully.",
      global: true,
      writable: true,
      properties: { draft: true, builderSessionId: "created-session" },
    };
    mockListPersonaSources.mockResolvedValue([dirtyDraft]);
    mockReadAgentSourceFile.mockResolvedValue(dirtyDraft);
    mockDeletePersonaSource.mockClear();

    await user.click(screen.getByRole("button", { name: "Sidebar skills" }));
    await user.click(await screen.findByRole("button", { name: "Save draft" }));

    await waitFor(() => {
      expect(screen.getByTestId("active-view")).toHaveTextContent("skills");
    });
    expect(mockDeletePersonaSource).not.toHaveBeenCalled();
  });

  it("prompts before leaving unsaved automation builder changes", async () => {
    const user = userEvent.setup();
    renderAppShell();

    await user.click(
      screen.getByRole("button", { name: "Sidebar automations" }),
    );
    await user.click(
      screen.getByRole("button", { name: "Open automation builder" }),
    );
    await user.click(
      screen.getByRole("button", { name: "Mark automation edits unsaved" }),
    );

    await user.click(screen.getByRole("button", { name: "Sidebar skills" }));

    expect(
      await screen.findByText("Unsaved automation changes"),
    ).toBeInTheDocument();
    expect(screen.getByTestId("active-view")).toHaveTextContent("automations");

    await user.click(screen.getByRole("button", { name: "Keep editing" }));

    expect(
      screen.queryByText("Unsaved automation changes"),
    ).not.toBeInTheDocument();
    expect(screen.getByTestId("active-view")).toHaveTextContent("automations");
  });

  it("discarding unsaved automation builder changes continues navigation", async () => {
    const user = userEvent.setup();
    renderAppShell();

    await user.click(
      screen.getByRole("button", { name: "Sidebar automations" }),
    );
    await user.click(
      screen.getByRole("button", { name: "Open automation builder" }),
    );
    await user.click(
      screen.getByRole("button", { name: "Mark automation edits unsaved" }),
    );

    await user.click(screen.getByRole("button", { name: "Sidebar skills" }));
    await user.click(await screen.findByRole("button", { name: "Discard" }));

    await waitFor(() => {
      expect(screen.getByTestId("active-view")).toHaveTextContent("skills");
    });
  });

  it("saving unsaved automation builder changes continues navigation", async () => {
    const user = userEvent.setup();
    renderAppShell();

    await user.click(
      screen.getByRole("button", { name: "Sidebar automations" }),
    );
    await user.click(
      screen.getByRole("button", { name: "Open automation builder" }),
    );
    await user.click(
      screen.getByRole("button", { name: "Mark automation edits unsaved" }),
    );

    await user.click(screen.getByRole("button", { name: "Sidebar skills" }));
    await user.click(
      await screen.findByRole("button", { name: "Save changes" }),
    );

    expect(mockAutomationBuilderSave).toHaveBeenCalledTimes(1);
    await waitFor(() => {
      expect(screen.getByTestId("active-view")).toHaveTextContent("skills");
    });
  });

  it("prompts before leaving unsaved automation builder changes with keyboard search navigation", async () => {
    const user = userEvent.setup();
    renderAppShell();

    await user.click(
      screen.getByRole("button", { name: "Sidebar automations" }),
    );
    await user.click(
      screen.getByRole("button", { name: "Open automation builder" }),
    );
    await user.click(
      screen.getByRole("button", { name: "Mark automation edits unsaved" }),
    );

    await user.keyboard("{Meta>}k{/Meta}");

    expect(
      await screen.findByText("Unsaved automation changes"),
    ).toBeInTheDocument();
    expect(screen.getByTestId("active-view")).toHaveTextContent("automations");
  });

  it("prompts before opening the centered composer from unsaved automation builder changes", async () => {
    const user = userEvent.setup();
    renderAppShell();

    await user.click(
      screen.getByRole("button", { name: "Sidebar automations" }),
    );
    await user.click(
      screen.getByRole("button", { name: "Open automation builder" }),
    );
    await user.click(
      screen.getByRole("button", { name: "Mark automation edits unsaved" }),
    );

    await user.keyboard("{Meta>}n{/Meta}");

    expect(
      await screen.findByText("Unsaved automation changes"),
    ).toBeInTheDocument();
    expect(screen.getByTestId("active-view")).toHaveTextContent("automations");

    await user.click(screen.getByRole("button", { name: "Discard" }));

    await waitFor(() => {
      expect(screen.getByTestId("active-view")).toHaveTextContent("home");
    });
    const textbox = await screen.findByPlaceholderText("Start a conversation");
    await waitFor(() => {
      expect(textbox).toHaveFocus();
    });
    expect(textbox.closest("[data-placement]")).toHaveAttribute(
      "data-placement",
      "centered",
    );
  });

  it("resets a centered composer when entering a route that hides it", async () => {
    const user = userEvent.setup();
    renderAppShell();

    await user.click(
      screen.getByRole("button", { name: "Sidebar automations" }),
    );
    await user.keyboard("{Meta>}n{/Meta}");

    const centeredTextbox = await screen.findByPlaceholderText(
      "Start a conversation",
    );
    expect(centeredTextbox.closest("[data-placement]")).toHaveAttribute(
      "data-placement",
      "centered",
    );

    await user.click(
      screen.getByRole("button", { name: "Open automation builder" }),
    );
    expect(
      screen.queryByPlaceholderText("Start a conversation"),
    ).not.toBeInTheDocument();

    await user.click(
      screen.getByRole("button", { name: "Open automation history" }),
    );
    await act(async () => {
      flushAfterNextPaintCallbacks();
    });

    const dockedTextbox = await screen.findByPlaceholderText(
      "Start a conversation",
    );
    expect(dockedTextbox.closest("[data-placement]")).toHaveAttribute(
      "data-placement",
      "docked",
    );
  });

  it("keeps Settings section navigation in the global stack", async () => {
    const user = userEvent.setup();
    renderAppShell();

    await user.click(screen.getByRole("button", { name: "Sidebar settings" }));
    await user.click(screen.getByRole("button", { name: "Sidebar providers" }));

    expect(screen.getByTestId("active-view")).toHaveTextContent("settings");
    expect(screen.getByTestId("settings-section")).toHaveTextContent(
      "providers",
    );

    await user.click(screen.getByRole("button", { name: "Back" }));

    await waitFor(() => {
      expect(screen.getByTestId("settings-section")).toHaveTextContent(
        "general",
      );
    });
  });

  it("redirects a disabled deep-linked Doctor settings section to General", async () => {
    window.history.replaceState(null, "", "/settings?section=doctor");
    setReadyRuntimeConfig({
      ...DEFAULT_RUNTIME_CONFIG,
      doctor: { enabled: false },
    });

    renderAppShell();

    await waitFor(() => {
      expect(screen.getByTestId("active-view")).toHaveTextContent("settings");
      expect(screen.getByTestId("settings-section")).toHaveTextContent(
        "general",
      );
    });
    expect(window.location.pathname).toBe("/settings");
    expect(new URLSearchParams(window.location.search).get("section")).toBe(
      "general",
    );
  });

  it("closes the design system takeover back to the previous view", async () => {
    const user = userEvent.setup();
    mockDesignSystemExplorerEnabled.mockReturnValue(true);
    renderAppShell();

    await user.click(screen.getByRole("button", { name: "Sidebar agents" }));
    expect(screen.getByTestId("active-view")).toHaveTextContent("agents");

    await user.click(
      screen.getByRole("button", { name: "Sidebar design system" }),
    );
    expect(screen.getByTestId("active-view")).toHaveTextContent(
      "design-system",
    );
    expect(window.location.pathname).toBe("/design-system");

    await user.click(
      screen.getByRole("button", { name: "Close design system" }),
    );
    await waitFor(() => {
      expect(screen.getByTestId("active-view")).toHaveTextContent("agents");
    });
    expect(window.location.pathname).not.toBe("/design-system");
  });

  it("closes the design system takeover back to settings with its section URL", async () => {
    const user = userEvent.setup();
    mockDesignSystemExplorerEnabled.mockReturnValue(true);
    renderAppShell();

    await user.click(screen.getByRole("button", { name: "Sidebar settings" }));
    expect(screen.getByTestId("active-view")).toHaveTextContent("settings");
    await user.click(screen.getByRole("button", { name: "Sidebar providers" }));
    expect(screen.getByTestId("settings-section")).toHaveTextContent(
      "providers",
    );

    await user.click(
      screen.getByRole("button", { name: "Sidebar design system" }),
    );
    expect(screen.getByTestId("active-view")).toHaveTextContent(
      "design-system",
    );

    await user.click(
      screen.getByRole("button", { name: "Close design system" }),
    );
    await waitFor(() => {
      expect(screen.getByTestId("active-view")).toHaveTextContent("settings");
    });
    expect(window.location.pathname).toBe("/settings");
    expect(new URLSearchParams(window.location.search).get("section")).toBe(
      "providers",
    );
  });

  it("opens search from the top bar and returns to the previous view", async () => {
    const user = userEvent.setup();
    renderAppShell();

    await user.click(screen.getByRole("button", { name: "Sidebar agents" }));
    expect(screen.getByTestId("active-view")).toHaveTextContent("agents");

    await user.click(screen.getByRole("button", { name: "Search" }));
    expect(screen.getByTestId("active-view")).toHaveTextContent("search");

    await user.click(screen.getByRole("button", { name: "Exit search" }));
    await waitFor(() => {
      expect(screen.getByTestId("active-view")).toHaveTextContent("agents");
    });
  });

  it("shows the page title as the top bar header on subpages", async () => {
    const user = userEvent.setup();
    renderAppShell();

    await user.click(screen.getByRole("button", { name: "Sidebar agents" }));
    expect(screen.getByTestId("active-view")).toHaveTextContent("agents");

    expect(
      screen.queryByRole("link", { name: "goose" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("link", { name: "Home" }),
    ).not.toBeInTheDocument();
    expect(screen.getByText("Agents")).toBeInTheDocument();
  });

  it("shows and navigates from third-level Skills breadcrumbs", async () => {
    const user = userEvent.setup();
    renderAppShell();

    await user.click(screen.getByRole("button", { name: "Sidebar skills" }));
    await user.click(screen.getByRole("button", { name: "Open skill detail" }));

    expect(screen.getByRole("link", { name: "Skills" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Code Review" })).toHaveAttribute(
      "aria-current",
      "page",
    );

    await user.click(screen.getByRole("link", { name: "Skills" }));

    await waitFor(() => {
      expect(screen.getByTestId("skill-route")).toHaveTextContent("list");
    });
  });

  it("shows Automations history as a third-level breadcrumb", async () => {
    const user = userEvent.setup();
    renderAppShell();

    await user.click(
      screen.getByRole("button", { name: "Sidebar automations" }),
    );
    await user.click(
      screen.getByRole("button", { name: "Open automation history" }),
    );

    expect(
      screen.getByRole("link", { name: "Automations" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "History" })).toHaveAttribute(
      "aria-current",
      "page",
    );
  });

  it("shows and navigates from Builderbot task breadcrumbs", async () => {
    enableBuilderbotExperiment();
    const user = userEvent.setup();
    renderAppShell();

    await user.click(
      screen.getByRole("button", { name: "Sidebar builderbot" }),
    );
    await user.click(
      screen.getByRole("button", { name: "Open builderbot task" }),
    );

    expect(
      screen.getByRole("link", { name: "Builderbot" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Tasks" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "TASK-1" })).toHaveAttribute(
      "aria-current",
      "page",
    );

    await user.click(screen.getByRole("link", { name: "Tasks" }));

    await waitFor(() => {
      expect(screen.getByTestId("builderbot-route")).toHaveTextContent(
        '"surface":"overview"',
      );
    });
    expect(screen.getByTestId("builderbot-route")).toHaveTextContent(
      '"tab":"tasks"',
    );
  });

  it("shows and navigates from Builderbot automation breadcrumbs", async () => {
    enableBuilderbotExperiment();
    const user = userEvent.setup();
    renderAppShell();

    await user.click(
      screen.getByRole("button", { name: "Sidebar builderbot" }),
    );
    await user.click(
      screen.getByRole("button", { name: "Open builderbot automation" }),
    );

    expect(
      screen.getByRole("link", { name: "Builderbot" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: "Automations" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Daily docs" })).toHaveAttribute(
      "aria-current",
      "page",
    );

    await user.click(screen.getByRole("link", { name: "Automations" }));

    await waitFor(() => {
      expect(screen.getByTestId("builderbot-route")).toHaveTextContent(
        '"surface":"overview"',
      );
    });
    expect(screen.getByTestId("builderbot-route")).toHaveTextContent(
      '"tab":"automations"',
    );
  });

  it("shows Chat / project / session title for a chat inside a project", async () => {
    const user = userEvent.setup();
    const { container } = renderAppShell();

    await user.click(screen.getByRole("button", { name: "Sidebar new chat" }));
    await waitFor(() => {
      expect(screen.getByTestId("active-view")).toHaveTextContent("chat");
    });

    const project: ProjectInfo = {
      id: "proj-1",
      path: "/tmp/sample-project",
      name: "Sample Project",
      description: "",
      prompt: "",
      icon: "folder",
      color: "blue",
      projectWorkspaces: [],
      workingDirs: [],
      useWorktrees: false,
      order: 0,
      archivedAt: null,
    };
    const now = new Date().toISOString();
    const session: ChatSession = {
      id: "created-session",
      title: "MCPs vs Extensions",
      projectId: "proj-1",
      createdAt: now,
      updatedAt: now,
      messageCount: 0,
    };

    act(() => {
      useProjectStore.setState({ projects: [project] });
      useChatSessionStore.setState({
        sessions: [session],
        activeSessionId: "created-session",
        hasHydratedSessions: true,
      });
    });

    await waitFor(() => {
      expect(screen.getByText("Chat")).toBeInTheDocument();
      expect(screen.getByText("Sample Project")).toBeInTheDocument();
      expect(screen.getByText("MCPs vs Extensions")).toBeInTheDocument();
    });
    expect(
      (container.firstElementChild as HTMLElement).style.getPropertyValue(
        "--project-tint",
      ),
    ).toBe("var(--color-pill-blue)");
  });

  it("forwards a persona's provider and model when the provider resolves", async () => {
    useAgentStore.setState({
      selectedProvider: "goose",
      providers: [{ id: "goose", label: "Goose" }],
      personas: [
        {
          id: "persona-resolves",
          displayName: "Reviewer",
          systemPrompt: "Review code.",
          provider: "goose",
          model: "goose-model",
          isBuiltin: false,
          writable: true,
        },
      ],
    });
    const user = userEvent.setup();
    renderAppShell();

    await user.click(
      screen.getByRole("button", { name: "Start chat with resolving agent" }),
    );

    await waitFor(() => {
      expect(mockAcpCreateSession).toHaveBeenCalledWith(
        "goose",
        "~/goose artifacts",
        {
          deferProviderSetup: false,
          modelId: "goose-model",
          projectId: undefined,
        },
      );
    });
  });

  it("does not forward a persona's model when its provider does not resolve", async () => {
    useAgentStore.setState({
      selectedProvider: "goose",
      providers: [{ id: "goose", label: "Goose" }],
      personas: [
        {
          id: "persona-unresolved",
          displayName: "Reviewer",
          systemPrompt: "Review code.",
          provider: "totally-unknown-provider",
          model: "unresolved-model",
          isBuiltin: false,
          writable: true,
        },
      ],
    });
    const user = userEvent.setup();
    renderAppShell();

    await user.click(
      screen.getByRole("button", { name: "Start chat with unresolved agent" }),
    );

    await waitFor(() => {
      expect(mockAcpCreateSession).toHaveBeenCalledWith(
        "goose",
        "~/goose artifacts",
        {
          deferProviderSetup: true,
          modelId: undefined,
          projectId: undefined,
        },
      );
    });
  });

  it("tags a Home agent starter in the composer instead of opening a blank chat", async () => {
    useAgentStore.setState({
      selectedProvider: "goose",
      providers: [{ id: "goose", label: "Goose" }],
      personas: [
        {
          id: "persona-resolves",
          displayName: "Reviewer",
          systemPrompt: "Review code.",
          provider: "goose",
          model: "goose-model",
          isBuiltin: false,
          writable: true,
        },
      ],
    });
    const user = userEvent.setup();
    renderAppShell();

    await user.click(
      screen.getByRole("button", { name: "Tag home composer agent" }),
    );

    await waitFor(() => {
      expect(screen.getByTestId("active-view")).toHaveTextContent("home");
      expect(screen.getByText("Reviewer")).toBeInTheDocument();
    });
    expect(mockAcpCreateSession).not.toHaveBeenCalled();
  });

  it("tags a Home skill starter in the composer instead of opening a blank chat", async () => {
    const user = userEvent.setup();
    renderAppShell();

    await user.click(
      screen.getByRole("button", { name: "Tag home composer skill" }),
    );

    await waitFor(() => {
      expect(screen.getByTestId("active-view")).toHaveTextContent("home");
      expect(screen.getByText("code-review")).toBeInTheDocument();
    });
    expect(mockAcpCreateSession).not.toHaveBeenCalled();
  });

  it("tags a Home project starter in the composer instead of opening a blank chat", async () => {
    useProjectStore.setState({
      projects: [
        {
          id: "project-1",
          path: "/tmp/project.yaml",
          name: "Project One",
          description: "",
          prompt: "",
          icon: "",
          color: "",
          workingDirs: ["/workspace/project"],
          projectWorkspaces: [],
          useWorktrees: false,
          order: 0,
          archivedAt: null,
        },
      ],
      loading: false,
      activeProjectId: null,
    });
    const user = userEvent.setup();
    renderAppShell();

    await user.click(
      screen.getByRole("button", { name: "Tag home composer project" }),
    );

    await waitFor(() => {
      expect(screen.getByTestId("active-view")).toHaveTextContent("home");
      expect(screen.getByText("Project One")).toBeInTheDocument();
    });
    expect(mockAcpCreateSession).not.toHaveBeenCalled();
  });

  it("expands the Home composer into a full chat with the current draft context", async () => {
    useAgentStore.setState({
      selectedProvider: "goose",
      providers: [{ id: "goose", label: "Goose" }],
      personas: [
        {
          id: "persona-resolves",
          displayName: "Reviewer",
          systemPrompt: "Review code.",
          provider: "goose",
          model: "goose-model",
          isBuiltin: false,
          writable: true,
        },
      ],
    });
    useProjectStore.setState({
      projects: [
        {
          id: "project-1",
          path: "/tmp/project.yaml",
          name: "Project One",
          description: "",
          prompt: "",
          icon: "",
          color: "",
          workingDirs: ["/workspace/project"],
          projectWorkspaces: [],
          useWorktrees: false,
          order: 0,
          archivedAt: null,
        },
      ],
      loading: false,
      activeProjectId: null,
    });
    const user = userEvent.setup();
    renderAppShell();

    await user.click(
      screen.getByRole("button", { name: "Tag home composer agent" }),
    );
    await user.click(
      screen.getByRole("button", { name: "Tag home composer project" }),
    );
    await user.click(
      screen.getByRole("button", { name: "Tag home composer skill" }),
    );

    const textbox = screen.getByPlaceholderText("Start a conversation");
    await user.type(textbox, "expand this");
    await user.click(
      screen.getByRole("button", { name: "Expand to full chat" }),
    );

    await waitFor(() => {
      expect(screen.getByTestId("active-view")).toHaveTextContent("chat");
      expect(useChatSessionStore.getState().getActiveSession()).toMatchObject({
        id: "created-session",
        projectId: "project-1",
        personaId: "persona-resolves",
        modelId: "goose-model",
      });
      expect(useChatStore.getState().draftsBySession).toMatchObject({
        "created-session": "expand this",
      });
      expect(useChatStore.getState().skillDraftsBySession).toMatchObject({
        "created-session": [
          expect.objectContaining({
            id: "global:/Users/test/.agents/skills/code-review/SKILL.md",
            name: "code-review",
          }),
        ],
      });
    });
  });

  it("applies later Home starters after consuming the previous starter request", async () => {
    useAgentStore.setState({
      selectedProvider: "goose",
      providers: [{ id: "goose", label: "Goose" }],
      personas: [
        {
          id: "persona-resolves",
          displayName: "Reviewer",
          systemPrompt: "Review code.",
          provider: "goose",
          model: "goose-model",
          isBuiltin: false,
          writable: true,
        },
      ],
    });
    useProjectStore.setState({
      projects: [
        {
          id: "project-1",
          path: "/tmp/project.yaml",
          name: "Project One",
          description: "",
          prompt: "",
          icon: "",
          color: "",
          workingDirs: ["/workspace/project"],
          projectWorkspaces: [],
          useWorktrees: false,
          order: 0,
          archivedAt: null,
        },
      ],
      loading: false,
      activeProjectId: null,
    });
    const user = userEvent.setup();
    renderAppShell();

    await user.click(
      screen.getByRole("button", { name: "Tag home composer agent" }),
    );
    await waitFor(() => {
      expect(screen.getByText("Reviewer")).toBeInTheDocument();
    });

    await user.click(
      screen.getByRole("button", { name: "Tag home composer project" }),
    );

    await waitFor(() => {
      expect(screen.getByText("Project One")).toBeInTheDocument();
    });
    expect(screen.getByTestId("active-view")).toHaveTextContent("home");
    expect(mockAcpCreateSession).not.toHaveBeenCalled();
  });

  it("opens search with Cmd+K", async () => {
    const user = userEvent.setup();
    renderAppShell();

    await user.keyboard("{Meta>}k{/Meta}");

    await waitFor(() => {
      expect(screen.getByTestId("active-view")).toHaveTextContent("search");
    });
  });

  it("opens search with Ctrl+K off macOS", async () => {
    mockGetPlatform.mockReturnValue("windows");
    const user = userEvent.setup();
    renderAppShell();

    await user.keyboard("{Control>}k{/Control}");

    await waitFor(() => {
      expect(screen.getByTestId("active-view")).toHaveTextContent("search");
    });
  });

  it("toggles the dev design system inspector with Cmd+D", async () => {
    mockDesignSystemExplorerEnabled.mockReturnValue(true);
    renderAppShell();

    expect(
      screen.queryByRole("button", { name: "Inspect (⌘I)" }),
    ).not.toBeInTheDocument();

    fireEvent.keyDown(window, {
      key: "d",
      metaKey: true,
    });

    expect(
      screen.getByRole("button", { name: "Inspect (⌘I)" }),
    ).toBeInTheDocument();

    fireEvent.keyDown(window, {
      key: "d",
      metaKey: true,
    });

    await waitFor(() => {
      expect(
        screen.queryByRole("button", { name: "Inspect (⌘I)" }),
      ).not.toBeInTheDocument();
    });
  });

  it("toggles design system inspect mode with Cmd+I", async () => {
    mockDesignSystemExplorerEnabled.mockReturnValue(true);
    renderAppShell();

    expect(
      screen.queryByRole("button", { name: "Inspect (⌘I)" }),
    ).not.toBeInTheDocument();

    fireEvent.keyDown(window, {
      key: "i",
      metaKey: true,
    });

    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: "Inspecting (⌘I)" }),
      ).toHaveAttribute("aria-pressed", "true");
    });

    fireEvent.keyDown(window, {
      key: "i",
      metaKey: true,
    });

    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: "Inspect (⌘I)" }),
      ).toHaveAttribute("aria-pressed", "false");
    });
  });

  it("does not toggle the design system inspector outside dev explorer mode", () => {
    renderAppShell();

    fireEvent.keyDown(window, {
      key: "d",
      metaKey: true,
    });

    expect(
      screen.queryByRole("button", { name: "Inspect (⌘I)" }),
    ).not.toBeInTheDocument();

    fireEvent.keyDown(window, {
      key: "i",
      metaKey: true,
    });

    expect(
      screen.queryByRole("button", { name: "Inspect (⌘I)" }),
    ).not.toBeInTheDocument();
  });

  it("toggles the keyboard shortcuts reference with Cmd+/", async () => {
    renderAppShell();

    fireEvent.keyDown(window, { key: "/", code: "Slash", metaKey: true });
    await waitFor(() => {
      expect(useShortcutsDialogStore.getState().open).toBe(true);
    });

    fireEvent.keyDown(window, { key: "/", code: "Slash", metaKey: true });
    await waitFor(() => {
      expect(useShortcutsDialogStore.getState().open).toBe(false);
    });
  });

  it("opens the shortcuts reference with Ctrl+/ off macOS", async () => {
    mockGetPlatform.mockReturnValue("windows");
    renderAppShell();

    fireEvent.keyDown(window, { key: "/", code: "Slash", ctrlKey: true });

    await waitFor(() => {
      expect(useShortcutsDialogStore.getState().open).toBe(true);
    });
  });

  it("ignores Cmd on a non-Slash physical key that types '/'", async () => {
    renderAppShell();

    // QWERTZ layouts type "/" from Shift+7; the shortcut must not fire.
    fireEvent.keyDown(window, { key: "/", code: "Digit7", metaKey: true });

    expect(useShortcutsDialogStore.getState().open).toBe(false);
  });

  it("opens search with an overridden combo instead of the default", async () => {
    window.localStorage.setItem(
      SHORTCUT_PREFERENCES_STORAGE_KEY,
      JSON.stringify({
        version: 1,
        overrides: { "navigation.search": "meta+shift+x" },
      }),
    );
    const user = userEvent.setup();
    renderAppShell();

    await user.keyboard("{Meta>}k{/Meta}");
    expect(screen.getByTestId("active-view")).toHaveTextContent("home");

    await user.keyboard("{Meta>}{Shift>}x{/Shift}{/Meta}");
    await waitFor(() => {
      expect(screen.getByTestId("active-view")).toHaveTextContent("search");
    });
  });

  it("toggles the shortcuts reference with an overridden combo, including while it is open", async () => {
    window.localStorage.setItem(
      SHORTCUT_PREFERENCES_STORAGE_KEY,
      JSON.stringify({
        version: 1,
        overrides: { "help.shortcuts": "meta+shift+h" },
      }),
    );
    renderAppShell();

    // The default no longer fires once overridden.
    fireEvent.keyDown(window, { key: "/", code: "Slash", metaKey: true });
    expect(useShortcutsDialogStore.getState().open).toBe(false);

    fireEvent.keyDown(window, { key: "h", metaKey: true, shiftKey: true });
    await waitFor(() => {
      expect(useShortcutsDialogStore.getState().open).toBe(true);
    });
    // The dialog is a keyboard-owning layer; the toggle must still close it.
    await screen.findByRole("dialog");

    fireEvent.keyDown(window, { key: "h", metaKey: true, shiftKey: true });
    await waitFor(() => {
      expect(useShortcutsDialogStore.getState().open).toBe(false);
    });
  });

  it("does not run global shortcuts while a keyboard-owning layer is open", async () => {
    renderAppShell();

    fireEvent.keyDown(window, { key: "/", code: "Slash", metaKey: true });
    await screen.findByRole("dialog");

    fireEvent.keyDown(window, { key: "k", metaKey: true });
    expect(screen.getByTestId("active-view")).toHaveTextContent("home");
  });

  it("opens the session quick switcher with Cmd+P, honoring an override over the default", async () => {
    renderAppShell();

    // The default combo opens the switcher.
    fireEvent.keyDown(window, { key: "p", metaKey: true });
    const input = await screen.findByPlaceholderText("Jump to session...");

    fireEvent.keyDown(input, { key: "Escape" });
    await waitFor(() => {
      expect(
        screen.queryByPlaceholderText("Jump to session..."),
      ).not.toBeInTheDocument();
    });

    // Once overridden, the default stops firing and the override opens it.
    window.localStorage.setItem(
      SHORTCUT_PREFERENCES_STORAGE_KEY,
      JSON.stringify({
        version: 1,
        overrides: { "session.quickSwitch": "meta+shift+p" },
      }),
    );
    fireEvent.keyDown(window, { key: "p", metaKey: true });
    expect(
      screen.queryByPlaceholderText("Jump to session..."),
    ).not.toBeInTheDocument();

    fireEvent.keyDown(window, { key: "p", metaKey: true, shiftKey: true });
    expect(
      await screen.findByPlaceholderText("Jump to session..."),
    ).toBeInTheDocument();
  });

  it("cycles sessions with Ctrl+Tab and Ctrl+Shift+Tab", async () => {
    const user = userEvent.setup();
    const sessionBase = {
      providerId: "goose",
      workingDir: "~/goose artifacts",
      createdAt: "2026-06-09T00:00:00.000Z",
      messageCount: 1,
    } satisfies Partial<ChatSession>;
    useChatSessionStore.setState({
      sessions: [
        {
          ...sessionBase,
          id: "session-1",
          title: "Newest chat",
          updatedAt: "2026-06-09T12:00:00.000Z",
        },
        {
          ...sessionBase,
          id: "session-2",
          title: "Older chat",
          updatedAt: "2026-06-09T10:00:00.000Z",
        },
      ] as ChatSession[],
      activeSessionId: null,
    });

    renderAppShell();

    // From home, Ctrl+Tab enters the list at the most recent session.
    fireEvent.keyDown(window, { key: "Tab", ctrlKey: true });
    await waitFor(() => {
      expect(screen.getByTestId("rendered-session-id")).toHaveTextContent(
        "session-1",
      );
    });

    // Forward wraps through the older session.
    fireEvent.keyDown(window, { key: "Tab", ctrlKey: true });
    await waitFor(() => {
      expect(screen.getByTestId("rendered-session-id")).toHaveTextContent(
        "session-2",
      );
    });

    // Backward returns to the newer one.
    fireEvent.keyDown(window, { key: "Tab", ctrlKey: true, shiftKey: true });
    await waitFor(() => {
      expect(screen.getByTestId("rendered-session-id")).toHaveTextContent(
        "session-1",
      );
    });

    // Plain Tab (no ctrl) never cycles.
    await user.keyboard("{Tab}");
    expect(screen.getByTestId("rendered-session-id")).toHaveTextContent(
      "session-1",
    );
  });
});

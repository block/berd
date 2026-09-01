import { getModelSelectionIntent } from "@/features/chat/model-selection/modelSelectionIntent";
import { beginModelSelectionIntent } from "@/features/chat/model-selection/modelSelectionIntent";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { i18n } from "@/shared/i18n";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAgentStore } from "@/features/agents/stores/agentStore";
import { getAppNavigationController } from "@/features/berdctl/navigation";
import { resetAgentBuilderSourceLifecycleForTests } from "@/features/agents/lib/agentBuilderSourceLifecycle";
import { useChatStore } from "@/features/chat/stores/chatStore";
import { useChatSessionStore } from "@/features/chat/stores/chatSessionStore";
import { ensureReplayBuffer } from "@/features/chat/hooks/replayBuffer";
import { createUserMessage } from "@/shared/types/messages";
import { useSessionWindowStore } from "@/features/chat/stores/sessionWindowStore";
import type { ChatSession } from "@/features/chat/stores/chatSessionStore";
import type { Message } from "@/shared/types/messages";
import type { GitState } from "@/shared/types/git";
import { setMultiWorkspaceEnabled } from "@/features/workspaces/multiWorkspacePreference";
import { OPEN_SETTINGS_EVENT } from "@/features/settings/lib/settingsEvents";
import { SHORTCUT_PREFERENCES_STORAGE_KEY } from "@/features/shortcuts/lib/shortcutRegistry";
import { useShortcutsDialogStore } from "@/features/shortcuts/stores/shortcutsDialogStore";
import { useProjectStore } from "@/features/projects/stores/projectStore";
import {
  useVoiceConversationStore,
  VOICE_CONVERSATION_OFF_STATUS,
} from "@/features/voice-conversation/stores/voiceConversationStore";
import {
  blockNativeVoiceConversationStarts,
  releaseNativeVoiceConversationStartBlock,
  setVoiceConversationForegroundSession,
} from "@/features/voice-conversation/api/voiceConversation";
import { dispatchOnboarding } from "@/features/onboarding/model";
import {
  resetHomeWidgetStoreForTests,
  useHomeWidgetStore,
} from "@/features/home/stores/homeWidgetStore";
import { useStarterTasks } from "@/features/home/onboarding/StarterTasksContext";
import {
  hasStarterWidgetPickerRequest,
  resetStarterWidgetPickerRequestForTests,
} from "@/features/home/onboarding/starterWidgetTask";
import type { ProjectInfo } from "@/features/projects/api/projects";
import { BUILDERBOT_SURFACE_EXPERIMENT_ID } from "@/features/experiments/experimentDefinitions";
import {
  EXPERIMENT_PREFERENCES_STORAGE_KEY,
  EXPERIMENT_PREFERENCES_STORAGE_VERSION,
} from "@/features/experiments/experimentPreferences";
import { ThemeProvider } from "@/shared/theme/ThemeProvider";
import { useDefaultProviderReadinessStore } from "@/features/providers/stores/defaultProviderReadinessStore";
import { useProviderModelCacheStore } from "@/features/providers/stores/providerModelCacheStore";
import { useProviderCatalogStore } from "@/features/providers/stores/providerCatalogStore";
import { useRuntimeConfigStore } from "@/shared/runtime-config/runtimeConfigStore";
import { gooseServeSelectionFromExecutionTarget } from "@/features/chat/lib/gooseServeExecutionTarget";
import { ASSISTIVE_UX_STORAGE_KEY } from "@/shared/assistive-ux/registry";

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

import {
  DEFAULT_RUNTIME_CONFIG,
  type RuntimeConfig,
} from "@/shared/runtime-config/schema";
import {
  AppShell,
  shouldStopVoiceConversationOnExperimentChange,
} from "./AppShell";
import type { NavigationPanesViewProps } from "@/app/views/NavigationPanesView";
import type { AppShellContent as AppShellContentType } from "./ui/AppShellContent";

const mockAcpCreateSession = vi.hoisted(() => vi.fn());
const mockAcpPrepareSession = vi.hoisted(() => vi.fn());
const mockAcpSetSessionConfigOption = vi.hoisted(() => vi.fn());
const mockAcpListSessionsPage = vi.hoisted(() => vi.fn());
const mockAcpSearchSessions = vi.hoisted(() => vi.fn());
const mockBuildFeatures = vi.hoisted(() => ({
  byoKeyProviders: false,
  voiceConversation: false,
}));
const mockAcpArchiveSession = vi.hoisted(() => vi.fn());
const mockAcpGetSessionInfo = vi.hoisted(() => vi.fn());
const mockAcpLoadSession = vi.hoisted(() => vi.fn());
const mockListExtensions = vi.hoisted(() => vi.fn());
const mockCheckDirectoriesExist = vi.hoisted(() => vi.fn());
const mockPathExists = vi.hoisted(() => vi.fn());
const mockCheckAllProviderStatus = vi.hoisted(() => vi.fn());
const mockRepairManagedGooseModelSelection = vi.hoisted(() => vi.fn());
const gitMocks = vi.hoisted(() => ({
  countBranchCommitsNotInBase: vi.fn(),
  hasIgnoredFiles: vi.fn(),
  createBranch: vi.fn(),
  createWorktree: vi.fn(),
  deleteBranch: vi.fn(),
  getGitState: vi.fn(),
  removeWorktree: vi.fn(),
}));
const mockIsExternalAgentReady = vi.hoisted(() => vi.fn());
const originalStopVoiceConversation = useVoiceConversationStore.getState().stop;
const mockAgentStatus = vi.hoisted(() => ({
  readyAgentIds: new Set<string>(["goose"]),
}));
const mockCreatePersonaSource = vi.hoisted(() => vi.fn());
const mockListPersonaSources = vi.hoisted(() => vi.fn());
const mockReadAgentSourceFile = vi.hoisted(() => vi.fn());
const mockDeletePersonaSource = vi.hoisted(() => vi.fn());
const mockListPersonas = vi.hoisted(() => vi.fn());
const mockRepairBundledAgent = vi.hoisted(() => vi.fn());
const mockAutomationBuilderSave = vi.hoisted(() => vi.fn());
const mockToastError = vi.hoisted(() => vi.fn());
const mockListenSessionDeepLinkErrors = vi.hoisted(() => vi.fn());
const mockAfterNextPaint = vi.hoisted(() => ({
  callbacks: [] as Array<{ callback: () => void; cancelled: boolean }>,
}));
const mockSessionWindowSupport = vi.hoisted(() => ({ supported: false }));
const mockFocusSessionWindow = vi.hoisted(() => vi.fn());
const mockVoiceSetupReadiness = vi.hoisted(() => ({
  ready: false,
}));
const mockVoiceSettingsEnabled = vi.hoisted(() => ({ enabled: false }));

vi.mock("@/features/settings/ui/settingsSections", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("@/features/settings/ui/settingsSections")
    >();
  return {
    ...actual,
    resolveEnabledSettingsSection: (
      section: Parameters<typeof actual.resolveEnabledSettingsSection>[0],
      capabilities: Parameters<typeof actual.resolveEnabledSettingsSection>[1],
    ) =>
      section === "voice" && mockVoiceSettingsEnabled.enabled
        ? "voice"
        : actual.resolveEnabledSettingsSection(section, capabilities),
  };
});

vi.mock("@/features/voice-conversation/lib/voiceSetupReadiness", () => ({
  isVoiceSetupReady: () => mockVoiceSetupReadiness.ready,
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
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return (
    <QueryClientProvider client={queryClient}>
      <ThemeProvider>
        <AppShell>{children}</AppShell>
      </ThemeProvider>
    </QueryClientProvider>
  );
}

function renderAppShell(children?: ReactNode) {
  return render(appShellWithTheme(children));
}

function managedWorktreeGitState(
  branch: string,
  worktreePath = `/repo-worktrees/${branch}`,
): GitState {
  return {
    isGitRepo: true,
    currentBranch: branch,
    dirtyFileCount: 0,
    incomingCommitCount: 0,
    worktrees: [
      { path: "/repo", branch: "main", isMain: true },
      { path: worktreePath, branch, isMain: false },
    ],
    isWorktree: true,
    mainWorktreePath: "/repo",
    localBranches: ["main", branch],
  };
}

function makeManagedWorktreeSession(
  branch: string,
  worktreePath = `/repo-worktrees/${branch}`,
): ChatSession {
  return {
    id: "session-1",
    title: branch,
    executionTarget: { harnessId: "goose" },
    workingDir: worktreePath,
    workspaceAttachments: [
      {
        id: `path:${worktreePath}`,
        path: worktreePath,
        kind: "git-linked-worktree",
        source: "created",
        branch,
        repositoryPath: "/repo",
        worktreePath,
        usedByAgent: true,
        lifecycle: {
          owner: "goose",
          cleanup: "worktree",
          branch,
          baseBranch: "main",
          repositoryPath: "/repo",
          worktreePath,
          createdBranch: true,
        },
      },
    ],
    createdAt: "2026-07-10T00:00:00.000Z",
    updatedAt: "2026-07-10T00:00:00.000Z",
    messageCount: 1,
  };
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

function setResolvingPersona(
  model?: string,
  provider = "databricks_v2",
  modelProviderId?: string,
) {
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
        provider,
        ...(modelProviderId ? { modelProviderId } : {}),
        ...(model ? { model } : {}),
        isBuiltin: false,
        writable: true,
      },
    ],
  });
}

function seedProviderModels(
  providerId: string,
  models: Array<{ id: string; name: string; recommended?: boolean }>,
) {
  useProviderModelCacheStore.getState().seedRuntimeModels(
    new Map([
      [
        providerId,
        models.map((model) => ({
          ...model,
          displayName: model.name,
          providerId,
        })),
      ],
    ]),
  );
}

vi.mock("@/shared/profile/buildProfile", () => ({
  getBuildFeatureState: () => ({
    authGate: false,
    agentTools: true,
    automations: true,
    builderbot: true,
    telemetry: true,
    voiceDictation: true,
    managedConnections: true,
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
  NavigationPanesView: ({
    collapsed,
    onNavigate,
    onNewChat,
    onNewChatInProject,
    onSettingsClick,
    onSettingsSectionChange,
    width,
  }: NavigationPanesViewProps) => (
    <nav aria-label="mock sidebar">
      <div data-testid="mock-sidebar-collapsed">{String(collapsed)}</div>
      <div data-testid="mock-sidebar-width">{String(width)}</div>
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

vi.mock("@/features/chat/hooks/useSessionWindowSupport", () => ({
  useSessionWindowSupport: () => mockSessionWindowSupport,
}));

vi.mock("@/features/chat/lib/sessionWindowCommands", () => ({
  focusSessionWindow: (...args: unknown[]) => mockFocusSessionWindow(...args),
  releaseSession: vi.fn(),
}));

vi.mock("@/features/extensions/api/extensions", () => ({
  listExtensions: (...args: unknown[]) => mockListExtensions(...args),
}));

vi.mock("@/features/providers/api/credentials", () => ({
  checkAllProviderStatus: (...args: unknown[]) =>
    mockCheckAllProviderStatus(...args),
}));

vi.mock("@/features/chat/lib/externalAgentReadiness", () => ({
  isExternalAgentReady: (...args: unknown[]) =>
    mockIsExternalAgentReady(...args),
}));

vi.mock("@/features/providers/lib/managedModelSelectionRepair", () => ({
  repairManagedGooseModelSelection: (...args: unknown[]) =>
    mockRepairManagedGooseModelSelection(...args),
}));

vi.mock("@/shared/api/acp", () => ({
  acpCreateSession: (...args: unknown[]) => mockAcpCreateSession(...args),
  acpPrepareSession: (...args: unknown[]) => mockAcpPrepareSession(...args),
  acpSetSessionConfigOption: (...args: unknown[]) =>
    mockAcpSetSessionConfigOption(...args),
  acpGetSessionInfo: (...args: unknown[]) => mockAcpGetSessionInfo(...args),
  acpListSessionsPage: (...args: unknown[]) => mockAcpListSessionsPage(...args),
  acpLoadSession: (...args: unknown[]) => mockAcpLoadSession(...args),
  acpSearchSessions: (...args: unknown[]) => mockAcpSearchSessions(...args),
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
  countBranchCommitsNotInBase: (...args: unknown[]) =>
    gitMocks.countBranchCommitsNotInBase(...args),
  hasIgnoredFiles: (...args: unknown[]) => gitMocks.hasIgnoredFiles(...args),
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
  listPersonas: (...args: unknown[]) => mockListPersonas(...args),
  repairBundledAgent: (...args: unknown[]) => mockRepairBundledAgent(...args),
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

vi.mock("@/features/chat/hooks/useMentionHandlers", () => ({
  useMentionHandlers: () => ({
    mentionOpen: false,
    atMentionCategory: "agents",
    mentionSelectedIndex: 0,
    filteredPersonas: [],
    filteredSkills: [],
    filteredFiles: [],
    fileMentionsLoading: false,
    fileMentionsError: null,
    detectMention: vi.fn(),
    closeMention: vi.fn(),
    navigateMention: vi.fn(),
    setAtMentionCategory: vi.fn(),
    handleMentionCategoryKey: vi.fn(),
    confirmMention: vi.fn(),
    handleMentionConfirm: vi.fn(),
  }),
}));

vi.mock("@/shared/api/system", () => ({
  getHomeDir: vi.fn().mockResolvedValue("/Users/test"),
  pathExists: (...args: unknown[]) => mockPathExists(...args),
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
    readyAgentIds: mockAgentStatus.readyAgentIds,
    agentReadiness: new Map(
      [...mockAgentStatus.readyAgentIds].map((providerId) => [
        providerId,
        "ready" as const,
      ]),
    ),
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
    onAgentBuilderCompleted,
    onExitSearch,
    onArchiveChat,
    onOpenAgent,
    onTagHomeComposerAgent,
    onTagHomeComposerProject,
    onTagHomeComposerSkill,
    onSelectSession,
    onStartProjectChat,
    onResolveBerdyAgent,
    onStartConnectionSetupChat,
  }) => {
    const starterTasks = useStarterTasks();
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
        <button
          type="button"
          onClick={() =>
            onStartConnectionSetupChat({
              title: "Add a connection",
              prompt: "Which connection?",
            })
          }
        >
          Test connection setup
        </button>
        <div data-testid="skill-route">{activeSkillsSkillId ?? "list"}</div>
        <div data-testid="agent-route">{activeAgentsPersonaId ?? "list"}</div>
        <div data-testid="automation-route">
          {JSON.stringify(activeAutomationsRoute)}
        </div>
        <div data-testid="builderbot-route">
          {JSON.stringify(activeBuilderbotRoute)}
        </div>
        <div data-testid="starter-tasks-visible">
          {String(starterTasks?.visible)}
        </div>
        <div data-testid="starter-tasks-docked">
          {String(starterTasks?.docked)}
        </div>
        <div data-testid="starter-task-selection">
          {starterTasks?.selectedTaskId ?? "none"}
        </div>
        <button
          type="button"
          onClick={() => starterTasks?.onTaskSelect("connect-provider")}
        >
          Select provider starter task
        </button>
        <button
          type="button"
          onClick={() => starterTasks?.onTaskSelect("add-widget")}
        >
          Select add widget starter task
        </button>
        <button
          type="button"
          onClick={() => starterTasks?.onTaskSelect("create-project")}
        >
          Open project starter task
        </button>
        <button type="button" onClick={() => starterTasks?.onDismiss()}>
          Dismiss starter tasks
        </button>
        <button type="button" onClick={() => starterTasks?.onRestore()}>
          Restore starter tasks
        </button>
        <button
          type="button"
          onClick={() => onStartProjectChat?.("project-startup")}
        >
          Start project chat
        </button>
        <button
          type="button"
          onClick={() => {
            void onResolveBerdyAgent?.().then((personaId) => {
              if (personaId) onTagHomeComposerAgent?.(personaId);
            });
          }}
        >
          Ask Berdy from Home
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
        {activeView === "chat" ? (
          <button
            type="button"
            onClick={() => onAgentBuilderCompleted?.("/saved-agent.md")}
          >
            Complete agent builder
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
  it("does no Voice native cleanup on startup-off and cleans up an on-to-off transition", () => {
    expect(
      shouldStopVoiceConversationOnExperimentChange({
        wasEnabled: false,
        isEnabled: false,
      }),
    ).toBe(false);
    expect(
      shouldStopVoiceConversationOnExperimentChange({
        wasEnabled: true,
        isEnabled: false,
      }),
    ).toBe(true);
    expect(
      shouldStopVoiceConversationOnExperimentChange({
        wasEnabled: true,
        isEnabled: true,
      }),
    ).toBe(false);
  });

  afterEach(cleanup);

  beforeEach(() => {
    dispatchOnboarding({ type: "complete" });
    resetHomeWidgetStoreForTests();
    resetStarterWidgetPickerRequestForTests();
    mockRepairManagedGooseModelSelection.mockReset();
    mockRepairManagedGooseModelSelection.mockImplementation(
      async (selection: unknown) => selection,
    );
    window.history.replaceState(null, "", "/");
    window.localStorage.clear();
    mockBuildFeatures.byoKeyProviders = false;
    mockBuildFeatures.voiceConversation = false;
    mockGetPlatform.mockReturnValue("mac");
    mockDesignSystemExplorerEnabled.mockReturnValue(false);
    mockAfterNextPaint.callbacks = [];
    resetAgentBuilderSourceLifecycleForTests();
    useShortcutsDialogStore.setState({ open: false });
    document.documentElement.removeAttribute("data-global-composer-visible");
    mockSessionWindowSupport.supported = false;
    mockVoiceSetupReadiness.ready = false;
    mockVoiceSettingsEnabled.enabled = false;
    mockFocusSessionWindow.mockReset();
    useSessionWindowStore.getState().setSnapshot([]);
    useVoiceConversationStore.setState({
      status: VOICE_CONVERSATION_OFF_STATUS,
      microphoneMuted: false,
      stop: originalStopVoiceConversation,
    });
    vi.mocked(blockNativeVoiceConversationStarts)
      .mockReset()
      .mockResolvedValue("archive-token");
    vi.mocked(releaseNativeVoiceConversationStartBlock)
      .mockReset()
      .mockResolvedValue(undefined);
    vi.mocked(setVoiceConversationForegroundSession)
      .mockReset()
      .mockResolvedValue(undefined);
    mockListExtensions.mockReset();
    mockListExtensions.mockResolvedValue([]);
    mockAcpCreateSession.mockReset();
    mockAcpCreateSession.mockResolvedValue({ sessionId: "created-session" });
    mockAcpPrepareSession.mockReset();
    mockAcpPrepareSession.mockResolvedValue({});
    mockAcpSetSessionConfigOption.mockReset();
    mockAcpSetSessionConfigOption.mockResolvedValue({});
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
    mockAcpArchiveSession.mockReset();
    mockAcpArchiveSession.mockResolvedValue(undefined);
    mockAcpGetSessionInfo.mockReset();
    mockAcpGetSessionInfo.mockResolvedValue(null);
    mockAcpLoadSession.mockReset();
    mockAcpLoadSession.mockResolvedValue(undefined);
    mockAcpSearchSessions.mockReset();
    // Default: the server matches nothing; tests that exercise discovery
    // override with their own match set.
    mockAcpSearchSessions.mockImplementation(async () => ({
      results: [],
      searchedIds: [],
      failedIds: [],
      matchedInfos: [],
    }));
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
    gitMocks.countBranchCommitsNotInBase.mockReset();
    gitMocks.countBranchCommitsNotInBase.mockResolvedValue(0);
    gitMocks.hasIgnoredFiles.mockReset();
    gitMocks.hasIgnoredFiles.mockResolvedValue(false);
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
    mockListPersonas.mockReset();
    mockListPersonas.mockResolvedValue([]);
    mockRepairBundledAgent.mockReset();
    mockRepairBundledAgent.mockResolvedValue(undefined);
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
      archiveMutationBySessionId: {},
    });
    useVoiceConversationStore.setState({ requestedStartSessionId: null });
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
    useProviderModelCacheStore.setState({
      providers: new Map(),
      refreshingProviderIds: new Set(),
      runtimeManagedProviderIds: new Set(),
    });
    useProviderCatalogStore.getState().reset();
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
        deferProviderSetup: false,
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

  it("repairs an obsolete managed model before creating Home", async () => {
    setReadyRuntimeConfig({
      schemaVersion: 1,
      goose: {
        defaultModelProviderId: "databricks_v2",
        defaultModelId: "goose-gpt-5-5",
        modelProviders: [
          {
            id: "databricks_v2",
            displayName: "Databricks",
            models: [
              { id: "goose-gpt-5-5", name: "GPT-5.5" },
              { id: "legacy-v1-model", name: "Legacy" },
            ],
          },
        ],
      },
    });
    useDefaultProviderReadinessStore.setState({
      readiness: {
        status: "ready",
        providerId: "databricks_v2",
        modelId: "legacy-v1-model",
      },
    });
    mockRepairManagedGooseModelSelection.mockResolvedValue({
      providerId: "databricks_v2",
      modelId: "goose-gpt-5-5",
    });
    useChatSessionStore.setState({ hasHydratedSessions: true });

    renderAppShell();

    await waitFor(() => {
      expect(mockAcpCreateSession).toHaveBeenCalledWith(
        "databricks_v2",
        "~/goose artifacts",
        expect.objectContaining({ modelId: "goose-gpt-5-5" }),
      );
    });
    expect(mockAcpCreateSession).not.toHaveBeenCalledWith(
      "databricks_v2",
      "~/goose artifacts",
      expect.objectContaining({ modelId: "legacy-v1-model" }),
    );
    expect(
      useChatSessionStore.getState().getSession("created-session"),
    ).toMatchObject({
      executionTarget: {
        harnessId: "goose",
        modelProviderId: "databricks_v2",
        modelId: "goose-gpt-5-5",
      },
    });
  });

  it("keeps a newer Home picker choice while managed repair is pending", async () => {
    const repair = deferred<{
      providerId: string;
      modelId: string;
    }>();
    setReadyRuntimeConfig({
      schemaVersion: 1,
      goose: {
        defaultModelProviderId: "databricks_v2",
        defaultModelId: "goose-gpt-5-5",
        modelProviders: [
          {
            id: "databricks_v2",
            displayName: "Databricks",
            models: [
              { id: "goose-gpt-5-5", name: "GPT-5.5" },
              { id: "goose-gpt-5-6", name: "GPT-5.6" },
              { id: "legacy-v1-model", name: "Legacy" },
            ],
          },
        ],
      },
    });
    seedProviderModels("databricks_v2", [
      { id: "goose-gpt-5-5", name: "GPT-5.5" },
      { id: "goose-gpt-5-6", name: "GPT-5.6" },
    ]);
    useDefaultProviderReadinessStore.setState({
      readiness: {
        status: "ready",
        providerId: "databricks_v2",
        modelId: "legacy-v1-model",
      },
    });
    mockRepairManagedGooseModelSelection
      .mockReturnValueOnce(repair.promise)
      .mockImplementation(
        async (selection: { providerId?: string; modelId?: string }) => ({
          providerId: selection.providerId ?? "databricks_v2",
          modelId: selection.modelId ?? "goose-gpt-5-5",
        }),
      );
    useChatSessionStore.setState({ hasHydratedSessions: true });
    const user = userEvent.setup();

    renderAppShell();

    await user.click(screen.getByPlaceholderText("Start a conversation"));
    await user.click(
      screen.getByRole("button", { name: /choose agent and model/i }),
    );
    await user.click(screen.getByRole("button", { name: "GPT-5.6" }));

    await act(async () => {
      repair.resolve({
        providerId: "databricks_v2",
        modelId: "goose-gpt-5-5",
      });
      await repair.promise;
    });

    await waitFor(() => {
      expect(mockAcpCreateSession).toHaveBeenCalledWith(
        "databricks_v2",
        "~/goose artifacts",
        expect.objectContaining({ modelId: "goose-gpt-5-6" }),
      );
    });
    expect(
      useChatSessionStore.getState().getSession("created-session"),
    ).toMatchObject({
      executionTarget: {
        harnessId: "goose",
        modelProviderId: "databricks_v2",
        modelId: "goose-gpt-5-6",
      },
    });
  });

  it("keeps a fresh-start picker selection when Home appears with its default model", async () => {
    const homeCreation = deferred<{
      sessionId: string;
      configOptionsSnapshot: {
        model: { modelId: string; modelName: string };
      };
    }>();
    seedProviderModels("databricks_v2", [
      { id: "goose-gpt-5-5", name: "GPT-5.5", recommended: true },
      { id: "goose-gpt-5-6", name: "GPT-5.6", recommended: true },
    ]);
    useDefaultProviderReadinessStore.setState({
      readiness: {
        status: "ready",
        providerId: "databricks_v2",
        modelId: "goose-gpt-5-5",
      },
    });
    useChatSessionStore.setState({ hasHydratedSessions: true });
    mockAcpCreateSession.mockReturnValueOnce(homeCreation.promise);
    const user = userEvent.setup();

    renderAppShell();

    await waitFor(() => {
      expect(mockAcpCreateSession).toHaveBeenCalledWith(
        "databricks_v2",
        "~/goose artifacts",
        expect.objectContaining({ modelId: "goose-gpt-5-5" }),
      );
    });
    expect(useChatSessionStore.getState().sessions).toHaveLength(0);

    await user.click(screen.getByPlaceholderText("Start a conversation"));
    await user.click(
      screen.getByRole("button", { name: /choose agent and model/i }),
    );
    await user.click(screen.getByRole("button", { name: "GPT-5.6" }));
    expect(
      screen.getByRole("button", { name: /choose agent and model/i }),
    ).toHaveTextContent("GPT-5.6");

    await act(async () => {
      homeCreation.resolve({
        sessionId: "home-session",
        configOptionsSnapshot: {
          model: { modelId: "goose-gpt-5-5", modelName: "GPT-5.5" },
        },
      });
      await homeCreation.promise;
    });

    await waitFor(() => {
      expect(
        useChatSessionStore.getState().getSession("home-session"),
      ).toMatchObject({
        executionTarget: {
          harnessId: "goose",
          modelProviderId: "databricks_v2",
          modelId: "goose-gpt-5-6",
          modelName: "GPT-5.6",
        },
      });
    });
    expect(
      screen.getByRole("button", { name: /choose agent and model/i }),
    ).toHaveTextContent("GPT-5.6");
  });

  it("keeps an external agent as the Home model harness", async () => {
    selectCodexProvider();
    mockAgentStatus.readyAgentIds = new Set(["codex-acp"]);
    seedProviderModels("codex-acp", [
      { id: "gpt-5.5", name: "GPT-5.5", recommended: true },
    ]);
    useChatSessionStore.setState({ hasHydratedSessions: true });
    const user = userEvent.setup();
    renderAppShell();

    await waitFor(() => {
      expect(
        useChatSessionStore.getState().getSession("created-session"),
      ).toMatchObject({ executionTarget: { harnessId: "codex-acp" } });
    });
    await user.click(screen.getByPlaceholderText("Start a conversation"));
    await user.click(
      screen.getByRole("button", { name: /choose agent and model/i }),
    );
    await user.click(screen.getByRole("button", { name: "GPT-5.5" }));

    await waitFor(() => {
      expect(
        useChatSessionStore.getState().getSession("created-session"),
      ).toMatchObject({
        executionTarget: {
          harnessId: "codex-acp",
          modelProviderId: "codex-acp",
          modelId: "gpt-5.5",
        },
      });
    });
  });

  it("does not reseed an explicitly unresolved Home session", async () => {
    window.localStorage.setItem("goose:home-session-id", "home-unresolved");
    useDefaultProviderReadinessStore.setState({
      readiness: {
        status: "ready",
        providerId: "databricks_v2",
        modelId: "goose-gpt-5-5",
      },
    });
    useChatSessionStore.setState({
      sessions: [
        {
          id: "home-unresolved",
          title: "Home",
          executionTargetSource: "ui",
          workingDir: "~/goose artifacts",
          createdAt: "2026-08-06T00:00:00.000Z",
          updatedAt: "2026-08-06T00:00:00.000Z",
          messageCount: 0,
        },
      ],
      hasHydratedSessions: true,
    });

    renderAppShell();
    await screen.findByPlaceholderText("Start a conversation");

    expect(mockAcpPrepareSession).not.toHaveBeenCalled();
    expect(mockAcpCreateSession).not.toHaveBeenCalled();
    const unresolved = useChatSessionStore
      .getState()
      .getSession("home-unresolved");
    expect(unresolved?.executionTarget).toBeUndefined();
    expect(unresolved?.executionTargetSource).toBe("ui");
  });

  it("preserves a UI-owned provider-only Home target", async () => {
    window.localStorage.setItem("goose:home-session-id", "home-provider");
    useDefaultProviderReadinessStore.setState({
      readiness: {
        status: "ready",
        providerId: "databricks_v2",
        modelId: "goose-gpt-5-5",
      },
    });
    mockCheckAllProviderStatus.mockResolvedValue([
      { providerId: "openai", isConfigured: true },
    ]);
    useChatSessionStore.setState({
      sessions: [
        {
          id: "home-provider",
          title: "Home",
          executionTarget: {
            harnessId: "goose",
            modelProviderId: "openai",
          },
          executionTargetSource: "ui",
          workingDir: "~/goose artifacts",
          createdAt: "2026-08-06T00:00:00.000Z",
          updatedAt: "2026-08-06T00:00:00.000Z",
          messageCount: 0,
        },
      ],
      hasHydratedSessions: true,
    });

    renderAppShell();

    await waitFor(() => {
      expect(mockAcpPrepareSession).toHaveBeenCalledWith(
        "home-provider",
        "openai",
        "~/goose artifacts",
        expect.any(Object),
      );
    });
    expect(
      useChatSessionStore.getState().getSession("home-provider"),
    ).toMatchObject({
      executionTarget: {
        harnessId: "goose",
        modelProviderId: "openai",
      },
      executionTargetSource: "ui",
    });
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
    setResolvingPersona();
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
        deferProviderSetup: false,
        modelId: undefined,
        projectId: undefined,
      },
    );
  });

  it("uses a configured explicit Goose model provider when Goose defaults need setup", async () => {
    requireByoDefaultProviderSetup();
    setResolvingPersona("goose-model", "goose", "databricks_v2");
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
        deferProviderSetup: false,
        modelId: "goose-model",
        projectId: undefined,
      },
    );
  });

  it("blocks an unconfigured explicit Goose model provider when the Goose default is ready", async () => {
    mockBuildFeatures.byoKeyProviders = true;
    useDefaultProviderReadinessStore.setState({
      readiness: {
        status: "ready",
        providerId: "openai",
        modelId: "gpt-4o",
      },
    });
    setResolvingPersona("goose-model", "goose", "databricks_v2");
    mockCheckAllProviderStatus.mockResolvedValue([
      { providerId: "openai", isConfigured: true },
      { providerId: "databricks_v2", isConfigured: false },
    ]);
    const user = userEvent.setup();
    renderAppShell();

    await user.click(
      screen.getByRole("button", { name: "Start chat with resolving agent" }),
    );

    await waitFor(() => {
      expect(screen.getByTestId("active-view")).toHaveTextContent("settings");
    });
    expect(screen.getByTestId("settings-section")).toHaveTextContent(
      "providers",
    );
    expect(mockAcpCreateSession).not.toHaveBeenCalled();
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
        deferProviderSetup: false,
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
        deferProviderSetup: false,
        modelId: undefined,
        projectId: undefined,
      },
    );
  });

  it("materializes an external ACP default model when promoting a draft", async () => {
    selectCodexProvider();
    mockAgentStatus.readyAgentIds = new Set(["codex-acp"]);
    mockAcpCreateSession.mockResolvedValueOnce({
      sessionId: "created-session",
      configOptionsSnapshot: {
        model: { modelId: "gpt-5.5", modelName: "GPT-5.5" },
        reasoningEffort: null,
      },
    });
    const user = userEvent.setup();
    renderAppShell();

    await user.click(screen.getByRole("button", { name: "Sidebar new chat" }));

    await waitFor(() => {
      expect(
        useChatSessionStore.getState().getSession("created-session"),
      ).toMatchObject({
        executionTarget: {
          harnessId: "codex-acp",
          modelProviderId: "codex-acp",
          modelId: "gpt-5.5",
          modelName: "GPT-5.5",
        },
      });
    });
  });

  it("preserves the stored model for a ready external ACP agent", async () => {
    requireByoDefaultProviderSetup();
    selectCodexProvider();
    mockAgentStatus.readyAgentIds = new Set(["codex-acp"]);
    window.localStorage.setItem(
      "goose:preferredModelsByAgent",
      JSON.stringify({
        "codex-acp": {
          modelId: "gpt-5.5",
          modelName: "GPT-5.5",
          providerId: "codex-acp",
        },
      }),
    );
    const user = userEvent.setup();
    renderAppShell();

    await user.click(screen.getByRole("button", { name: "Sidebar new chat" }));

    await waitFor(() => {
      expect(mockAcpCreateSession).toHaveBeenCalledWith(
        "codex-acp",
        "~/goose artifacts",
        {
          deferProviderSetup: false,
          modelId: "gpt-5.5",
          projectId: undefined,
        },
      );
    });
  });

  it("routes an auth-failed external ACP agent to Providers settings", async () => {
    requireByoDefaultProviderSetup();
    selectCodexProvider();
    mockIsExternalAgentReady.mockResolvedValue(false);
    mockAgentStatus.readyAgentIds = new Set(["goose"]);
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
        deferProviderSetup: false,
        modelId: undefined,
        projectId: undefined,
      },
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

  it("starts pane jump mode from the main composer", async () => {
    mockVisibleRegionRects();
    renderAppShell();

    await act(async () => {
      screen.getByPlaceholderText("Start a conversation").focus();
    });
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
        deferProviderSetup: false,
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
      executionTarget: { harnessId: "goose" },
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
    mockAcpLoadSession.mockImplementationOnce(async () => {
      ensureReplayBuffer("missing-session").push(
        createUserMessage("Existing history"),
      );
    });

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
    expect(messages).toHaveLength(2);
    expect(messages[1]?.content[0]).toMatchObject({
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
      executionTarget: { harnessId: "goose" },
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
      executionTarget: { harnessId: "goose" },
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
    await waitFor(() =>
      expect(setVoiceConversationForegroundSession).toHaveBeenLastCalledWith(
        "session-2",
      ),
    );
  });

  it("keeps archive UI active until the backend succeeds and rolls back archivedAt on failure", async () => {
    const user = userEvent.setup();
    const archive = deferred<void>();
    mockAcpArchiveSession.mockReturnValueOnce(archive.promise);
    const session: ChatSession = {
      id: "session-1",
      title: "Active chat",
      executionTarget: { harnessId: "goose" },
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
      expect(mockAcpArchiveSession).toHaveBeenCalledWith("session-1");
    });
    expect(screen.getByTestId("active-view")).toHaveTextContent("chat");
    expect(useChatSessionStore.getState().activeSessionId).toBe("session-1");
    expect(
      useChatSessionStore.getState().getSession("session-1")?.archivedAt,
    ).toEqual(expect.any(String));
    expect(useChatStore.getState().messagesBySession["session-1"]).toEqual([
      message,
    ]);

    act(() => {
      archive.reject(new Error("backend down"));
    });

    await waitFor(() => {
      expect(
        useChatSessionStore.getState().getSession("session-1")?.archivedAt,
      ).toBeUndefined();
    });
    expect(screen.getByTestId("active-view")).toHaveTextContent("chat");
    expect(useChatSessionStore.getState().activeSessionId).toBe("session-1");
    expect(useChatStore.getState().messagesBySession["session-1"]).toEqual([
      message,
    ]);
    expect(mockToastError).toHaveBeenCalledWith("backend down");
  });

  it("removes a pinned chat from Home only after archive succeeds", async () => {
    const user = userEvent.setup();
    const archive = deferred<void>();
    mockAcpArchiveSession.mockReturnValueOnce(archive.promise);
    useChatSessionStore.setState({
      sessions: [
        {
          id: "session-1",
          title: "Pinned chat",
          executionTarget: { harnessId: "goose" },
          workingDir: "~/goose artifacts",
          createdAt: "2026-06-09T00:00:00.000Z",
          updatedAt: "2026-06-09T00:00:00.000Z",
          messageCount: 1,
        },
      ],
    });
    useHomeWidgetStore.setState({
      loadStatus: "ready",
      itemRevision: 1,
      instances: [
        {
          id: "chat-pin-1",
          type: "chatPin",
          x: 0,
          y: 0,
          z: 1,
          state: { sessionId: "session-1" },
        },
      ],
    });

    renderAppShell();
    await user.click(screen.getByRole("button", { name: "Archive session 1" }));
    expect(useHomeWidgetStore.getState().instances).toHaveLength(1);

    await act(async () => archive.resolve(undefined));
    await waitFor(() => {
      expect(useHomeWidgetStore.getState().instances).toHaveLength(0);
    });
  });

  it("archives chats without managed Git resources when session pagination fails", async () => {
    const user = userEvent.setup();
    mockAcpListSessionsPage.mockRejectedValue(new Error("list failed"));
    useChatSessionStore.setState({
      sessions: [
        {
          id: "session-1",
          title: "Plain chat",
          executionTarget: { harnessId: "goose" },
          workingDir: "/tmp/plain-chat",
          createdAt: "2026-07-10T00:00:00.000Z",
          updatedAt: "2026-07-10T00:00:00.000Z",
          messageCount: 1,
        },
      ],
    });
    renderAppShell();

    await user.click(screen.getByRole("button", { name: "Open session 1" }));
    await user.click(screen.getByRole("button", { name: "Archive session 1" }));

    await waitFor(() => {
      expect(mockAcpArchiveSession).toHaveBeenCalledWith("session-1");
    });
    expect(mockAcpListSessionsPage).not.toHaveBeenCalled();
    expect(mockToastError).not.toHaveBeenCalled();
  });

  it("rejects noninteractive archive before local-file loss", async () => {
    const worktreePath = "/repo-worktrees/cli-reject";
    mockPathExists.mockResolvedValue(true);
    gitMocks.hasIgnoredFiles.mockResolvedValue(true);
    gitMocks.getGitState.mockResolvedValue({
      isGitRepo: true,
      currentBranch: "cli-reject",
      dirtyFileCount: 0,
      incomingCommitCount: 0,
      worktrees: [
        { path: "/repo", branch: "main", isMain: true },
        { path: worktreePath, branch: "cli-reject", isMain: false },
      ],
      isWorktree: true,
      mainWorktreePath: "/repo",
      localBranches: ["main", "cli-reject"],
    });
    useChatSessionStore.setState({
      sessions: [
        {
          id: "session-1",
          title: "CLI reject",
          executionTarget: { harnessId: "goose" },
          workingDir: worktreePath,
          workspaceAttachments: [
            {
              id: `path:${worktreePath}`,
              path: worktreePath,
              kind: "git-linked-worktree",
              source: "created",
              branch: "cli-reject",
              repositoryPath: "/repo",
              worktreePath,
              usedByAgent: true,
              lifecycle: {
                owner: "goose",
                cleanup: "worktree",
                branch: "cli-reject",
                baseBranch: "main",
                repositoryPath: "/repo",
                worktreePath,
                createdBranch: true,
              },
            },
          ],
          createdAt: "2026-07-10T00:00:00.000Z",
          updatedAt: "2026-07-10T00:00:00.000Z",
          messageCount: 1,
        },
      ],
    });
    renderAppShell();

    const outcome = await getAppNavigationController().archiveSession(
      "session-1",
      "reject",
    );

    expect(outcome).toEqual({
      ok: false,
      reason: "cleanup_requires_discard",
    });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(mockAcpArchiveSession).not.toHaveBeenCalled();
    expect(gitMocks.removeWorktree).not.toHaveBeenCalled();
  });

  it("noninteractive discard archives and cleans without a dialog", async () => {
    const worktreePath = "/repo-worktrees/cli-discard";
    mockPathExists.mockResolvedValue(true);
    gitMocks.hasIgnoredFiles.mockResolvedValue(true);
    gitMocks.getGitState.mockResolvedValue({
      isGitRepo: true,
      currentBranch: "cli-discard",
      dirtyFileCount: 0,
      incomingCommitCount: 0,
      worktrees: [
        { path: "/repo", branch: "main", isMain: true },
        { path: worktreePath, branch: "cli-discard", isMain: false },
      ],
      isWorktree: true,
      mainWorktreePath: "/repo",
      localBranches: ["main", "cli-discard"],
    });
    useChatSessionStore.setState({
      sessions: [
        {
          id: "session-1",
          title: "CLI discard",
          executionTarget: { harnessId: "goose" },
          workingDir: worktreePath,
          workspaceAttachments: [
            {
              id: `path:${worktreePath}`,
              path: worktreePath,
              kind: "git-linked-worktree",
              source: "created",
              branch: "cli-discard",
              repositoryPath: "/repo",
              worktreePath,
              usedByAgent: true,
              lifecycle: {
                owner: "goose",
                cleanup: "worktree",
                branch: "cli-discard",
                baseBranch: "main",
                repositoryPath: "/repo",
                worktreePath,
                createdBranch: true,
              },
            },
          ],
          createdAt: "2026-07-10T00:00:00.000Z",
          updatedAt: "2026-07-10T00:00:00.000Z",
          messageCount: 1,
        },
      ],
    });
    renderAppShell();

    let outcome: unknown;
    await act(async () => {
      outcome = await getAppNavigationController().archiveSession(
        "session-1",
        "discard",
      );
    });

    expect(outcome).toEqual({ ok: true });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(mockAcpArchiveSession).toHaveBeenCalledWith("session-1");
    expect(gitMocks.removeWorktree).toHaveBeenCalledWith(
      "/repo",
      worktreePath,
      true,
    );
  });

  it("blocks destructive Git cleanup and chat archival until confirmed", async () => {
    const user = userEvent.setup();
    const worktreePath = "/repo-worktrees/dirty-chat";
    mockPathExists.mockResolvedValue(true);
    gitMocks.getGitState.mockResolvedValue({
      isGitRepo: true,
      currentBranch: "dirty-chat",
      dirtyFileCount: 2,
      incomingCommitCount: 0,
      worktrees: [
        { path: "/repo", branch: "main", isMain: true },
        { path: worktreePath, branch: "dirty-chat", isMain: false },
      ],
      isWorktree: true,
      mainWorktreePath: "/repo",
      localBranches: ["main", "dirty-chat"],
    });
    const session: ChatSession = {
      id: "session-1",
      title: "Dirty chat",
      executionTarget: { harnessId: "goose" },
      workingDir: worktreePath,
      workspaceAttachments: [
        {
          id: `path:${worktreePath}`,
          path: worktreePath,
          kind: "git-linked-worktree",
          source: "created",
          branch: "dirty-chat",
          repositoryPath: "/repo",
          worktreePath,
          usedByAgent: true,
          lifecycle: {
            owner: "goose",
            cleanup: "worktree",
            branch: "dirty-chat",
            baseBranch: "main",
            repositoryPath: "/repo",
            worktreePath,
            createdBranch: true,
          },
        },
      ],
      createdAt: "2026-07-10T00:00:00.000Z",
      updatedAt: "2026-07-10T00:00:00.000Z",
      messageCount: 1,
    };
    useChatSessionStore.setState({ sessions: [session] });
    renderAppShell();

    await user.click(screen.getByRole("button", { name: "Open session 1" }));
    await user.click(screen.getByRole("button", { name: "Archive session 1" }));

    expect(
      await screen.findByRole("dialog", {
        name: "Archive chat and remove its worktrees?",
      }),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/discard local files and changes/i),
    ).toBeInTheDocument();
    expect(gitMocks.removeWorktree).not.toHaveBeenCalled();
    expect(mockAcpArchiveSession).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "Cancel" }));

    await waitFor(() => {
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });
    expect(gitMocks.removeWorktree).not.toHaveBeenCalled();
    expect(mockAcpArchiveSession).not.toHaveBeenCalled();
    expect(useChatSessionStore.getState().activeSessionId).toBe("session-1");
    expect(
      useChatSessionStore.getState().getSession("session-1")?.archivedAt,
    ).toBeUndefined();

    await user.click(screen.getByRole("button", { name: "Archive session 1" }));
    await user.click(
      await screen.findByRole("button", { name: "Archive and remove" }),
    );

    await waitFor(() => {
      expect(mockAcpArchiveSession).toHaveBeenCalledWith("session-1");
    });
    expect(gitMocks.removeWorktree).toHaveBeenCalledWith(
      "/repo",
      worktreePath,
      true,
    );
    expect(gitMocks.deleteBranch).toHaveBeenCalledWith(
      "/repo",
      "dirty-chat",
      true,
      "main",
    );
    expect(mockAcpArchiveSession.mock.invocationCallOrder[0]).toBeLessThan(
      gitMocks.removeWorktree.mock.invocationCallOrder[0] ?? Infinity,
    );
    expect(screen.getByTestId("active-view")).toHaveTextContent("home");
  });

  it("blocks archive with pre-archive copy when Git inspection fails", async () => {
    const user = userEvent.setup();
    const worktreePath = "/repo-worktrees/inspect-fails";
    mockPathExists.mockResolvedValue(true);
    mockAcpListSessionsPage.mockRejectedValue(new Error("list failed"));
    useChatSessionStore.setState({
      sessions: [
        {
          id: "session-1",
          title: "Inspect fails",
          executionTarget: { harnessId: "goose" },
          workingDir: worktreePath,
          workspaceAttachments: [
            {
              id: `path:${worktreePath}`,
              path: worktreePath,
              kind: "git-linked-worktree",
              source: "created",
              branch: "inspect-fails",
              repositoryPath: "/repo",
              worktreePath,
              usedByAgent: true,
              lifecycle: {
                owner: "goose",
                cleanup: "worktree",
                branch: "inspect-fails",
                baseBranch: "main",
                repositoryPath: "/repo",
                worktreePath,
                createdBranch: true,
              },
            },
          ],
          createdAt: "2026-07-10T00:00:00.000Z",
          updatedAt: "2026-07-10T00:00:00.000Z",
          messageCount: 1,
        },
      ],
    });
    renderAppShell();

    await user.click(screen.getByRole("button", { name: "Open session 1" }));
    await user.click(screen.getByRole("button", { name: "Archive session 1" }));

    await waitFor(() => {
      expect(mockToastError).toHaveBeenCalledWith(
        "Couldn't inspect the worktrees or branches. The chat wasn't archived.",
        { description: "list failed" },
      );
    });
    expect(mockAcpArchiveSession).not.toHaveBeenCalled();
  });

  it("prompts before removing a worktree with only ignored files", async () => {
    const user = userEvent.setup();
    const worktreePath = "/repo-worktrees/ignored-files";
    mockPathExists.mockResolvedValue(true);
    gitMocks.hasIgnoredFiles.mockResolvedValue(true);
    gitMocks.getGitState.mockResolvedValue({
      isGitRepo: true,
      currentBranch: "ignored-files",
      dirtyFileCount: 0,
      incomingCommitCount: 0,
      worktrees: [
        { path: "/repo", branch: "main", isMain: true },
        { path: worktreePath, branch: "ignored-files", isMain: false },
      ],
      isWorktree: true,
      mainWorktreePath: "/repo",
      localBranches: ["main", "ignored-files"],
    });
    useChatSessionStore.setState({
      sessions: [
        {
          id: "session-1",
          title: "Ignored files",
          executionTarget: { harnessId: "goose" },
          workingDir: worktreePath,
          workspaceAttachments: [
            {
              id: `path:${worktreePath}`,
              path: worktreePath,
              kind: "git-linked-worktree",
              source: "created",
              branch: "ignored-files",
              repositoryPath: "/repo",
              worktreePath,
              usedByAgent: true,
              lifecycle: {
                owner: "goose",
                cleanup: "worktree",
                branch: "ignored-files",
                baseBranch: "main",
                repositoryPath: "/repo",
                worktreePath,
                createdBranch: true,
              },
            },
          ],
          createdAt: "2026-07-10T00:00:00.000Z",
          updatedAt: "2026-07-10T00:00:00.000Z",
          messageCount: 1,
        },
      ],
    });
    renderAppShell();

    await user.click(screen.getByRole("button", { name: "Open session 1" }));
    await user.click(screen.getByRole("button", { name: "Archive session 1" }));

    expect(
      await screen.findByRole("dialog", {
        name: "Archive chat and remove its worktrees?",
      }),
    ).toBeInTheDocument();
    expect(mockAcpArchiveSession).not.toHaveBeenCalled();
    expect(gitMocks.removeWorktree).not.toHaveBeenCalled();
  });

  it("reports cleanup failure as an archived chat with incomplete cleanup", async () => {
    const user = userEvent.setup();
    const worktreePath = "/repo-worktrees/cleanup-fails";
    mockPathExists.mockResolvedValue(true);
    gitMocks.getGitState.mockResolvedValue(
      managedWorktreeGitState("cleanup-fails", worktreePath),
    );
    gitMocks.removeWorktree.mockRejectedValue(new Error("cleanup failed"));
    const session = makeManagedWorktreeSession("cleanup-fails", worktreePath);
    useChatSessionStore.setState({ sessions: [session] });
    renderAppShell();

    await user.click(screen.getByRole("button", { name: "Open session 1" }));
    let outcome: unknown;
    await act(async () => {
      outcome = await getAppNavigationController().archiveSession(
        "session-1",
        "confirm",
      );
    });

    expect(outcome).toEqual({
      ok: true,
      cleanupIncomplete: "workspace_cleanup_failed",
    });
    expect(gitMocks.removeWorktree).toHaveBeenCalled();
    expect(mockToastError).toHaveBeenCalledWith("cleanup failed");
    expect(mockAcpArchiveSession).toHaveBeenCalledWith("session-1");
    expect(useChatSessionStore.getState().activeSessionId).toBeNull();
    expect(
      useChatSessionStore.getState().getSession("session-1")?.archivedAt,
    ).toEqual(expect.any(String));
    expect(screen.getByTestId("active-view")).toHaveTextContent("home");
  });

  it("reports noninteractive cleanup as incomplete if the session starts running after archival", async () => {
    let resolveArchive!: () => void;
    mockAcpArchiveSession.mockReturnValue(
      new Promise<void>((resolve) => {
        resolveArchive = resolve;
      }),
    );
    mockPathExists.mockResolvedValue(true);
    gitMocks.getGitState.mockResolvedValue(
      managedWorktreeGitState("runs-after-archive"),
    );
    useChatSessionStore.setState({
      sessions: [makeManagedWorktreeSession("runs-after-archive")],
    });
    renderAppShell();

    let outcome!: Promise<unknown>;
    act(() => {
      outcome = getAppNavigationController().archiveSession(
        "session-1",
        "reject",
      );
    });
    await waitFor(() => {
      expect(mockAcpArchiveSession).toHaveBeenCalledWith("session-1");
    });

    await act(async () => {
      useChatStore.getState().setChatState("session-1", "thinking");
      resolveArchive();
      await outcome;
    });

    await expect(outcome).resolves.toEqual({
      ok: true,
      cleanupIncomplete: "target_session_running",
    });
    expect(gitMocks.removeWorktree).not.toHaveBeenCalled();
  });

  it("does not start noninteractive archival inside the deadline margin", async () => {
    useChatSessionStore.setState({
      sessions: [makeManagedWorktreeSession("near-deadline")],
    });
    renderAppShell();

    const outcome = await getAppNavigationController().archiveSession(
      "session-1",
      "reject",
      Date.now() + 2_999,
    );

    expect(outcome).toEqual({ ok: false, reason: "timed_out" });
    expect(mockAcpArchiveSession).not.toHaveBeenCalled();
    expect(gitMocks.removeWorktree).not.toHaveBeenCalled();
  });

  it("releases a late voice-start lease without archiving after the deadline", async () => {
    vi.useFakeTimers();
    const lease = deferred<string>();
    vi.mocked(blockNativeVoiceConversationStarts).mockReturnValueOnce(
      lease.promise,
    );
    useChatSessionStore.setState({
      sessions: [makeManagedWorktreeSession("stalled-voice-lease")],
    });
    renderAppShell();

    const outcome = getAppNavigationController().archiveSession(
      "session-1",
      "reject",
      Date.now() + 4_000,
    );
    await vi.advanceTimersByTimeAsync(1_000);

    await expect(outcome).resolves.toEqual({
      ok: false,
      reason: "timed_out",
    });
    expect(mockAcpArchiveSession).not.toHaveBeenCalled();

    lease.resolve("late-archive-token");
    await vi.waitFor(() =>
      expect(releaseNativeVoiceConversationStartBlock).toHaveBeenCalledWith(
        "session-1",
        "late-archive-token",
      ),
    );
    vi.useRealTimers();
  });

  it.each([
    "reject",
    "discard",
  ] as const)("does not use the %s archive policy on a background voice session", async (cleanupPolicy) => {
    const stopVoiceConversation = vi.fn().mockResolvedValue(undefined);
    useChatSessionStore.setState({
      sessions: [makeManagedWorktreeSession("background-voice")],
    });
    useVoiceConversationStore.setState({
      status: {
        available: true,
        unavailableReason: null,
        lifecycle: "running",
        sessionId: "session-1",
        ownerWindowLabel: "main",
        microphoneMuted: false,
        revision: 1,
      },
      stop: stopVoiceConversation,
    });
    renderAppShell();

    const outcome = await getAppNavigationController().archiveSession(
      "session-1",
      cleanupPolicy,
    );

    expect(outcome).toEqual({
      ok: false,
      reason: "target_session_running",
    });
    expect(mockAcpArchiveSession).not.toHaveBeenCalled();
    expect(stopVoiceConversation).not.toHaveBeenCalled();
  });

  it("stops active voice before confirmed archival", async () => {
    const stoppedStatus = {
      available: true,
      unavailableReason: null,
      lifecycle: "stopped" as const,
      sessionId: null,
      ownerWindowLabel: null,
      microphoneMuted: false,
      revision: 2,
    };
    const stopRequest = deferred<typeof stoppedStatus>();
    const stopVoiceConversation = vi.fn(async () => {
      const status = await stopRequest.promise;
      useVoiceConversationStore.setState({ status });
      return status;
    });
    useChatSessionStore.setState({
      sessions: [
        {
          id: "session-1",
          title: "Voice archive",
          executionTarget: { harnessId: "goose" },
          workingDir: "~/voice-archive",
          createdAt: "2026-08-21T00:00:00.000Z",
          updatedAt: "2026-08-21T00:00:00.000Z",
          messageCount: 1,
        },
      ],
    });
    useVoiceConversationStore.setState({
      status: {
        available: true,
        unavailableReason: null,
        lifecycle: "running",
        sessionId: "session-1",
        ownerWindowLabel: "main",
        microphoneMuted: false,
        revision: 1,
      },
      stop: stopVoiceConversation as never,
    });
    renderAppShell();

    const outcome = getAppNavigationController().archiveSession(
      "session-1",
      "confirm",
    );
    await waitFor(() => expect(stopVoiceConversation).toHaveBeenCalledOnce());
    expect(mockAcpArchiveSession).not.toHaveBeenCalled();

    stopRequest.resolve(stoppedStatus);
    await expect(outcome).resolves.toEqual({ ok: true });
    expect(mockAcpArchiveSession).toHaveBeenCalledWith("session-1");
    expect(stopVoiceConversation.mock.invocationCallOrder[0]).toBeLessThan(
      mockAcpArchiveSession.mock.invocationCallOrder[0],
    );
  });

  it("keeps the session unarchived when voice restarts during shutdown", async () => {
    const replacementStatus = {
      available: true,
      unavailableReason: null,
      lifecycle: "running" as const,
      sessionId: "session-1",
      ownerWindowLabel: "main",
      microphoneMuted: false,
      revision: 2,
    };
    const stopVoiceConversation = vi.fn(async () => {
      useVoiceConversationStore.setState({ status: replacementStatus });
      return replacementStatus;
    });
    useChatSessionStore.setState({
      sessions: [
        {
          id: "session-1",
          title: "Voice archive",
          executionTarget: { harnessId: "goose" },
          workingDir: "~/voice-archive",
          createdAt: "2026-08-21T00:00:00.000Z",
          updatedAt: "2026-08-21T00:00:00.000Z",
          messageCount: 1,
        },
      ],
    });
    useVoiceConversationStore.setState({
      status: { ...replacementStatus, revision: 1 },
      stop: stopVoiceConversation,
    });
    renderAppShell();

    await expect(
      getAppNavigationController().archiveSession("session-1", "confirm"),
    ).resolves.toEqual({ ok: false, reason: "voice_stop_failed" });

    expect(mockAcpArchiveSession).not.toHaveBeenCalled();
    expect(mockToastError).toHaveBeenCalledWith(
      "Couldn't stop voice, so the chat wasn't archived",
      { description: "Voice is still active for this chat." },
    );
  });

  it("rechecks the archive deadline after a delayed voice stop", async () => {
    vi.useFakeTimers();
    const stoppedStatus = {
      available: true,
      unavailableReason: null,
      lifecycle: "stopped" as const,
      sessionId: null,
      ownerWindowLabel: null,
      microphoneMuted: false,
      revision: 2,
    };
    const stopRequest = deferred<typeof stoppedStatus>();
    const stopVoiceConversation = vi.fn(async () => {
      const status = await stopRequest.promise;
      useVoiceConversationStore.setState({ status });
      return status;
    });
    useChatSessionStore.setState({
      sessions: [
        {
          id: "session-1",
          title: "Voice archive deadline",
          executionTarget: { harnessId: "goose" },
          workingDir: "~/voice-archive-deadline",
          createdAt: "2026-08-21T00:00:00.000Z",
          updatedAt: "2026-08-21T00:00:00.000Z",
          messageCount: 1,
        },
      ],
    });
    useVoiceConversationStore.setState({
      status: {
        ...stoppedStatus,
        lifecycle: "running",
        sessionId: "session-1",
        ownerWindowLabel: "main",
        revision: 1,
      },
      stop: stopVoiceConversation as never,
    });
    renderAppShell();

    const outcome = getAppNavigationController().archiveSession(
      "session-1",
      "confirm",
      Date.now() + 5_000,
    );
    await vi.waitFor(
      () => expect(stopVoiceConversation).toHaveBeenCalledOnce(),
      {
        timeout: 500,
      },
    );
    await vi.advanceTimersByTimeAsync(2_000);
    stopRequest.resolve(stoppedStatus);

    await expect(outcome).resolves.toEqual({
      ok: false,
      reason: "timed_out",
    });
    expect(mockAcpArchiveSession).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it("keeps the session unarchived when voice cannot stop", async () => {
    const stopError = new Error("microphone shutdown failed");
    const stopVoiceConversation = vi.fn().mockRejectedValue(stopError);
    useChatSessionStore.setState({
      sessions: [
        {
          id: "session-1",
          title: "Voice archive",
          executionTarget: { harnessId: "goose" },
          workingDir: "~/voice-archive",
          createdAt: "2026-08-21T00:00:00.000Z",
          updatedAt: "2026-08-21T00:00:00.000Z",
          messageCount: 1,
        },
      ],
    });
    useVoiceConversationStore.setState({
      status: {
        available: true,
        unavailableReason: null,
        lifecycle: "running",
        sessionId: "session-1",
        ownerWindowLabel: "main",
        microphoneMuted: false,
        revision: 1,
      },
      stop: stopVoiceConversation,
    });
    renderAppShell();

    await expect(
      getAppNavigationController().archiveSession("session-1", "confirm"),
    ).resolves.toEqual({ ok: false, reason: "voice_stop_failed" });
    expect(mockAcpArchiveSession).not.toHaveBeenCalled();
    expect(mockToastError).toHaveBeenCalledWith(
      "Couldn't stop voice, so the chat wasn't archived",
      { description: "microphone shutdown failed" },
    );
  });

  it("rechecks background voice immediately before auto-archive", async () => {
    const inspection = deferred<GitState>();
    mockPathExists.mockResolvedValue(true);
    gitMocks.getGitState.mockReturnValue(inspection.promise);
    useChatSessionStore.setState({
      sessions: [makeManagedWorktreeSession("voice-starts-during-inspection")],
    });
    renderAppShell();

    const outcome = getAppNavigationController().archiveSession(
      "session-1",
      "reject",
    );
    await waitFor(() => {
      expect(gitMocks.getGitState).toHaveBeenCalled();
    });

    useVoiceConversationStore.setState({
      status: {
        available: true,
        unavailableReason: null,
        lifecycle: "running",
        sessionId: "session-1",
        ownerWindowLabel: "main",
        microphoneMuted: false,
        revision: 1,
      },
    });
    inspection.resolve(
      managedWorktreeGitState("voice-starts-during-inspection"),
    );

    await expect(outcome).resolves.toEqual({
      ok: false,
      reason: "target_session_running",
    });
    expect(mockAcpArchiveSession).not.toHaveBeenCalled();
  });

  it("rechecks running state before noninteractive archival", async () => {
    const inspection = deferred<GitState>();
    mockPathExists.mockResolvedValue(true);
    gitMocks.getGitState.mockReturnValue(inspection.promise);
    useChatSessionStore.setState({
      sessions: [makeManagedWorktreeSession("starts-running")],
    });
    renderAppShell();

    const outcome = getAppNavigationController().archiveSession(
      "session-1",
      "reject",
    );
    await waitFor(() => {
      expect(gitMocks.getGitState).toHaveBeenCalled();
    });

    act(() => {
      useChatStore.getState().setChatState("session-1", "thinking");
      inspection.resolve(managedWorktreeGitState("starts-running"));
    });

    await expect(outcome).resolves.toEqual({
      ok: false,
      reason: "target_session_running",
    });
    expect(mockAcpArchiveSession).not.toHaveBeenCalled();
    expect(gitMocks.removeWorktree).not.toHaveBeenCalled();
  });

  it("archives the active session with Cmd+E", async () => {
    const user = userEvent.setup();
    const stopVoiceConversation = vi.fn(async () => {
      const status = {
        available: true,
        unavailableReason: null,
        lifecycle: "stopped" as const,
        sessionId: null,
        ownerWindowLabel: null,
        microphoneMuted: false,
        revision: 2,
      };
      useVoiceConversationStore.setState({ status });
      return status;
    });
    const session: ChatSession = {
      id: "session-1",
      title: "Active chat",
      executionTarget: { harnessId: "goose" },
      workingDir: "~/goose artifacts",
      createdAt: "2026-06-09T00:00:00.000Z",
      updatedAt: "2026-06-09T00:00:00.000Z",
      messageCount: 1,
    };
    useChatSessionStore.setState({
      sessions: [session],
      activeSessionId: null,
    });
    useVoiceConversationStore.setState({
      status: {
        available: true,
        unavailableReason: null,
        lifecycle: "running",
        sessionId: "session-1",
        ownerWindowLabel: "main",
        microphoneMuted: false,
        revision: 1,
      },
      stop: stopVoiceConversation,
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
    expect(stopVoiceConversation).toHaveBeenCalledOnce();
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
      executionTarget: { harnessId: "goose" },
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
      executionTarget: { harnessId: "goose" },
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
      executionTarget: { harnessId: "goose" },
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

  it("opens Voice settings without creating a chat when global voice is unready", async () => {
    mockBuildFeatures.voiceConversation = true;
    renderAppShell();

    const { textbox, user } = await openCenteredComposerFromChat();
    mockAcpCreateSession.mockClear();
    await user.type(textbox, "keep this voice draft");
    await user.click(
      screen.getByRole("button", { name: "Start voice conversation" }),
    );

    await waitFor(() => {
      expect(screen.getByTestId("active-view")).toHaveTextContent("settings");
    });
    await act(async () => {
      flushAfterNextPaintCallbacks();
    });
    expect(screen.getByTestId("settings-section")).toHaveTextContent("voice");
    expect(mockAcpCreateSession).not.toHaveBeenCalled();
    expect(
      useVoiceConversationStore.getState().requestedStartSessionId,
    ).toBeNull();
    expect(
      await screen.findByPlaceholderText("Start a conversation"),
    ).toHaveValue("keep this voice draft");
    expect(
      screen.getByPlaceholderText("Start a conversation"),
    ).not.toHaveFocus();

    await user.click(screen.getByRole("button", { name: "Back" }));
    await waitFor(() => {
      expect(screen.getByTestId("active-view")).toHaveTextContent("chat");
    });
    expect(
      screen
        .getByPlaceholderText("Start a conversation")
        .closest("[data-placement]"),
    ).toHaveStyle({ display: "none" });
    await user.keyboard("{Meta>}n{/Meta}");
    const restoredTextbox = await screen.findByPlaceholderText(
      "Start a conversation",
    );
    await waitFor(() => {
      expect(restoredTextbox.closest("[data-placement]")).toHaveAttribute(
        "data-placement",
        "centered",
      );
    });
    expect(restoredTextbox).toHaveValue("keep this voice draft");
    expect(restoredTextbox.closest("[data-placement]")).not.toHaveStyle({
      display: "none",
    });
  });

  it("queues a ready global voice start for the created chat", async () => {
    mockBuildFeatures.voiceConversation = true;
    mockVoiceSetupReadiness.ready = true;
    renderAppShell();

    const { textbox, user } = await openCenteredComposerFromChat();
    mockAcpCreateSession.mockClear();
    mockAcpCreateSession.mockResolvedValueOnce({ sessionId: "voice-session" });
    await user.type(textbox, "start this voice chat");
    await user.click(
      screen.getByRole("button", { name: "Start voice conversation" }),
    );

    await waitFor(() => {
      expect(useChatSessionStore.getState().activeSessionId).toBe(
        "voice-session",
      );
    });
    expect(useVoiceConversationStore.getState().requestedStartSessionId).toBe(
      "voice-session",
    );
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
        "created-session": [
          {
            payload: {
              text: "ask the tagged agent",
              persona: { kind: "persona", id: "persona-1" },
            },
          },
        ],
      });
      expect(
        useChatSessionStore.getState().getSession("created-session"),
      ).toMatchObject({
        personaId: "persona-1",
      });
    });
  });

  it.each([
    {
      label: "explicit no persona",
      selectPersona: false,
      expectedPersonaId: null,
    },
    {
      label: "a captured persona",
      selectPersona: true,
      expectedPersonaId: "persona-1",
    },
  ])("preserves $label through global admission, Home handoff, and release", async ({
    selectPersona,
    expectedPersonaId,
  }) => {
    renderAppShell();

    if (selectPersona) {
      fireEvent.click(
        screen.getByRole("button", { name: "Open agent detail" }),
      );
      await act(async () => {
        flushAfterNextPaintCallbacks();
      });
    }

    const textbox = screen.getByPlaceholderText("Start a conversation");
    fireEvent.change(textbox, { target: { value: "preserve my intent" } });
    fireEvent.keyDown(textbox, { key: "Enter" });

    await waitFor(() => {
      expect(
        useChatStore.getState().queuedMessageBySession["created-session"]?.[0]
          ?.payload.persona,
      ).toEqual(
        expectedPersonaId === null
          ? { kind: "none" }
          : { kind: "persona", id: expectedPersonaId },
      );
    });

    const chat = useChatStore.getState();
    const record = chat.queuedMessageBySession["created-session"]?.[0];
    expect(record?.kind).toBe("transport-ready");
    expect(record?.recordId).toEqual(expect.any(String));

    act(() => {
      useChatSessionStore.getState().patchSession("created-session", {
        personaId: "later-session-persona",
      });
      expect(
        chat.deferTransportReadyMessage(
          "created-session",
          record?.recordId ?? "missing",
          { type: "compaction", status: "pending" },
        ),
      ).toBe(true);
      expect(
        useChatStore
          .getState()
          .releaseDeferredMessage(
            "created-session",
            record?.recordId ?? "missing",
          ),
      ).toBe(true);
    });

    expect(
      useChatStore.getState().queuedMessageBySession["created-session"]?.[0],
    ).toMatchObject({
      kind: "transport-ready",
      releasedFromDeferred: true,
      payload: {
        text: "preserve my intent",
        persona:
          expectedPersonaId === null
            ? { kind: "none" }
            : { kind: "persona", id: expectedPersonaId },
      },
    });
  });

  it("resolves the bundled Berdy persona for Home", async () => {
    const personaId = "/Users/test/.agents/agents/berdy.md";
    useAgentStore.setState({
      personas: [
        {
          id: personaId,
          displayName: "Berdy",
          avatar: "app-avatar:gloopies-22",
          systemPrompt: "Help people use Berd.",
          isBuiltin: false,
          writable: true,
          sourceProperties: { metadata: { berdBundled: true } },
        },
      ],
    });
    renderAppShell();

    fireEvent.click(
      screen.getByRole("button", { name: "Ask Berdy from Home" }),
    );

    await waitFor(() => {
      expect(screen.getByText("Berdy")).toBeInTheDocument();
    });
  });

  it("restores a missing bundled Berdy agent before tagging it", async () => {
    const personaId = "/Users/test/.agents/agents/berdy.md";
    mockListPersonas.mockResolvedValue([
      {
        id: personaId,
        displayName: "Berdy",
        avatar: "app-avatar:gloopies-22",
        systemPrompt: "Help people use Berd.",
        isBuiltin: false,
        writable: false,
        sourceProperties: { metadata: { berdBundled: true } },
      },
    ]);
    useAgentStore.setState({ personas: [], personasLoading: false });
    renderAppShell();

    fireEvent.click(
      screen.getByRole("button", { name: "Ask Berdy from Home" }),
    );

    await waitFor(() => {
      expect(mockRepairBundledAgent).toHaveBeenCalledWith("berdy.md");
      expect(screen.getByText("Berdy")).toBeInTheDocument();
    });
    expect(mockRepairBundledAgent.mock.invocationCallOrder[0]).toBeLessThan(
      mockListPersonas.mock.invocationCallOrder[0],
    );
    expect(mockToastError).not.toHaveBeenCalledWith(
      "Berdy couldn't start a chat. Try again.",
    );
  });

  it("refreshes personas when repair reports an error after changing disk", async () => {
    const personaId = "/Users/test/.agents/agents/berdy.md";
    mockRepairBundledAgent.mockRejectedValue(new Error("marker write failed"));
    mockListPersonas.mockResolvedValue([
      {
        id: personaId,
        displayName: "Berdy",
        avatar: "app-avatar:gloopies-22",
        systemPrompt: "Help people use Berd.",
        isBuiltin: false,
        writable: false,
        sourceProperties: { metadata: { berdBundled: true } },
      },
    ]);
    useAgentStore.setState({ personas: [], personasLoading: false });
    renderAppShell();

    fireEvent.click(
      screen.getByRole("button", { name: "Ask Berdy from Home" }),
    );

    await waitFor(() => {
      expect(mockListPersonas).toHaveBeenCalled();
      expect(screen.getByText("Berdy")).toBeInTheDocument();
    });
  });

  it.each([
    {
      multiWorkspaceEnabled: true,
      expectedAttachments: [
        { path: "/repo/builderbot", source: "inferred" },
        { path: "/repo/bbsubscriber", source: "inferred" },
      ],
    },
    {
      multiWorkspaceEnabled: false,
      expectedAttachments: [{ path: "/repo/builderbot", source: "inferred" }],
    },
  ])("gates as-is project workspace attachments for centered composer sends (multi=$multiWorkspaceEnabled)", async ({
    multiWorkspaceEnabled,
    expectedAttachments,
  }) => {
    setMultiWorkspaceEnabled(multiWorkspaceEnabled);
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
          deferProviderSetup: false,
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
    ).toEqual(expectedAttachments);
    expect(useChatStore.getState().queuedMessageBySession).toMatchObject({
      [draftSessionId as string]: [
        { payload: { text: "send with all folders" } },
      ],
    });

    createSession.resolve({ sessionId: "created-session" });
    await waitFor(() => {
      expect(useChatStore.getState().queuedMessageBySession).toMatchObject({
        "created-session": [{ payload: { text: "send with all folders" } }],
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
        executionTarget: { harnessId: "goose" },
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
        executionTarget: { harnessId: "goose" },
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

  it("activates a centered composer handoff while reasoning configuration is pending", async () => {
    vi.useFakeTimers();
    const configUpdate = deferred<Record<string, never>>();
    mockAcpSetSessionConfigOption.mockReturnValue(configUpdate.promise);
    window.localStorage.setItem("goose:home-session-id", "home-session");

    try {
      const homeSession: ChatSession = {
        id: "home-session",
        title: "Home",
        executionTarget: { harnessId: "goose" },
        workingDir: "~/goose artifacts",
        reasoningEffort: {
          configId: "thinking_effort",
          currentValue: "high",
          options: [
            { id: "low", name: "low" },
            { id: "high", name: "high" },
          ],
        },
        createdAt: "2026-06-09T00:00:00.000Z",
        updatedAt: "2026-06-09T00:00:00.000Z",
        messageCount: 0,
      };
      const activeSession: ChatSession = {
        ...homeSession,
        id: "session-1",
        title: "Active chat",
        reasoningEffort: undefined,
        messageCount: 1,
      };
      const reusableDraft: ChatSession = {
        ...homeSession,
        id: "reusable-draft",
        title: "New Chat",
      };
      useChatSessionStore.setState({
        sessions: [homeSession, activeSession, reusableDraft],
        activeSessionId: null,
      });
      useChatStore.setState((state) => ({
        draftsBySession: {
          ...state.draftsBySession,
          "reusable-draft": "preserve this draft",
        },
      }));
      renderAppShell();

      fireEvent.click(screen.getByRole("button", { name: "Open session 1" }));
      fireEvent.keyDown(window, { key: "n", metaKey: true });
      const textbox = screen.getByPlaceholderText("Start a conversation");
      fireEvent.change(textbox, { target: { value: "Think before sending" } });
      fireEvent.keyDown(textbox, { key: "Enter" });

      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(mockAcpSetSessionConfigOption).toHaveBeenCalled();

      await act(async () => {
        vi.advanceTimersByTime(220);
      });

      expect(screen.getByTestId("active-view")).toHaveTextContent("chat");
      expect(useChatSessionStore.getState().activeSessionId).not.toBe(
        "session-1",
      );
    } finally {
      await act(async () => {
        configUpdate.resolve({});
      });
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

  it("applies the latest pending draft selection before promotion", async () => {
    const pendingSession = deferred<{ sessionId: string }>();
    const pendingPrepare = deferred<Record<string, never>>();
    mockAcpCreateSession.mockReturnValueOnce(pendingSession.promise);
    mockAcpPrepareSession.mockReturnValueOnce(pendingPrepare.promise);
    const user = userEvent.setup();
    renderAppShell();

    await user.click(screen.getByRole("button", { name: "Sidebar new chat" }));
    await waitFor(() => expect(mockAcpCreateSession).toHaveBeenCalled());
    const draftSessionId = useChatSessionStore.getState().activeSessionId ?? "";

    act(() => {
      const target = {
        harnessId: "codex-acp",
        modelProviderId: "codex-acp",
        modelId: "gpt-5.4-mini",
        modelName: "GPT-5.4 mini",
      } as const;
      beginModelSelectionIntent(draftSessionId, {
        requestId: "pending-model",
        target,
        preferenceAgentId: "codex-acp",
      });
      pendingSession.resolve({ sessionId: "created-session" });
    });

    await waitFor(() => {
      expect(mockAcpPrepareSession).toHaveBeenCalledWith(
        "created-session",
        "codex-acp",
        "~/goose artifacts",
        expect.objectContaining({ modelId: "gpt-5.4-mini" }),
      );
    });
    act(() => pendingPrepare.resolve({}));

    await waitFor(() => {
      expect(
        useChatSessionStore.getState().getSession("created-session"),
      ).toMatchObject({
        executionTarget: {
          harnessId: "codex-acp",
          modelProviderId: "codex-acp",
          modelId: "gpt-5.4-mini",
          modelName: "GPT-5.4 mini",
        },
      });
    });
    expect(
      JSON.parse(localStorage.getItem("goose:preferredModelsByAgent") ?? "{}"),
    ).toMatchObject({
      "codex-acp": {
        modelId: "gpt-5.4-mini",
        modelName: "GPT-5.4 mini",
        providerId: "codex-acp",
      },
    });
    expect(getModelSelectionIntent("created-session")).toBeUndefined();
  });

  it("adopts a repaired pending draft selection before promotion", async () => {
    const pendingSession = deferred<{ sessionId: string }>();
    mockAcpCreateSession.mockReturnValueOnce(pendingSession.promise);
    mockRepairManagedGooseModelSelection.mockImplementation(
      async (selection: { providerId?: string; modelId?: string }) =>
        selection.modelId === "legacy-v1-model"
          ? { providerId: "databricks_v2", modelId: "goose-gpt-5-5" }
          : selection,
    );
    const user = userEvent.setup();
    renderAppShell();

    await user.click(screen.getByRole("button", { name: "Sidebar new chat" }));
    await waitFor(() => expect(mockAcpCreateSession).toHaveBeenCalled());
    const draftSessionId = useChatSessionStore.getState().activeSessionId ?? "";

    act(() => {
      useChatSessionStore
        .getState()
        .replaceSessionExecutionTarget(draftSessionId, {
          harnessId: "goose",
          modelProviderId: "databricks_v2",
          modelId: "legacy-v1-model",
          modelName: "Legacy",
        });
      pendingSession.resolve({ sessionId: "created-session" });
    });

    await waitFor(() => {
      expect(mockAcpPrepareSession).toHaveBeenCalledWith(
        "created-session",
        "databricks_v2",
        "~/goose artifacts",
        expect.objectContaining({ modelId: "goose-gpt-5-5" }),
      );
    });
    await waitFor(() => {
      expect(
        useChatSessionStore.getState().getSession("created-session"),
      ).toMatchObject({
        executionTarget: {
          harnessId: "goose",
          modelProviderId: "databricks_v2",
          modelId: "goose-gpt-5-5",
          modelName: "goose-gpt-5-5",
        },
      });
    });
  });

  it("does not restore a draft target after the UI explicitly clears it", async () => {
    const pendingSession = deferred<{ sessionId: string }>();
    mockAcpCreateSession.mockReturnValueOnce(pendingSession.promise);
    const user = userEvent.setup();
    renderAppShell();

    await user.click(screen.getByRole("button", { name: "Sidebar new chat" }));
    await waitFor(() => expect(mockAcpCreateSession).toHaveBeenCalled());
    const draftSessionId = useChatSessionStore.getState().activeSessionId ?? "";

    act(() => {
      useChatSessionStore
        .getState()
        .replaceSessionExecutionTarget(draftSessionId, undefined);
      pendingSession.resolve({ sessionId: "created-session" });
    });

    await waitFor(() => {
      expect(mockAcpArchiveSession).toHaveBeenCalledWith("created-session");
      expect(
        useChatSessionStore.getState().getSession(draftSessionId),
      ).toMatchObject({
        creationState: "failed",
        executionTarget: undefined,
        executionTargetSource: "ui",
      });
    });
    expect(
      useChatSessionStore.getState().getSession("created-session"),
    ).toBeUndefined();
  });

  it("archives the backend session when post-creation reconciliation fails", async () => {
    const pendingSession = deferred<{ sessionId: string }>();
    mockAcpCreateSession.mockReturnValueOnce(pendingSession.promise);
    mockAcpPrepareSession.mockRejectedValueOnce(new Error("switch failed"));
    const user = userEvent.setup();
    renderAppShell();

    await user.click(screen.getByRole("button", { name: "Sidebar new chat" }));
    await waitFor(() => expect(mockAcpCreateSession).toHaveBeenCalled());
    const draftSessionId = useChatSessionStore.getState().activeSessionId ?? "";
    act(() => {
      useChatSessionStore
        .getState()
        .replaceSessionExecutionTarget(draftSessionId, {
          harnessId: "codex-acp",
          modelProviderId: "codex-acp",
          modelId: "gpt-5.4-mini",
          modelName: "GPT-5.4 mini",
        });
      pendingSession.resolve({ sessionId: "created-session" });
    });

    await waitFor(() => {
      expect(mockAcpArchiveSession).toHaveBeenCalledWith("created-session");
      expect(
        useChatSessionStore.getState().getSession(draftSessionId),
      ).toMatchObject({ creationState: "failed" });
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

    await act(async () => {
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

  it("opens the saved agent detail after finishing the agent builder", async () => {
    const user = userEvent.setup();
    renderAppShell();

    await user.click(screen.getByRole("button", { name: "Sidebar agents" }));
    await user.click(screen.getByRole("button", { name: "Create agent" }));
    await waitFor(() => {
      expect(screen.getByTestId("active-view")).toHaveTextContent("chat");
    });

    await user.click(
      screen.getByRole("button", { name: "Complete agent builder" }),
    );

    await waitFor(() => {
      expect(screen.getByTestId("active-view")).toHaveTextContent("agents");
      expect(screen.getByTestId("agent-route")).toHaveTextContent(
        "/saved-agent.md",
      );
    });
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

  it("returns from voice setup to its session and cancels an unready start", async () => {
    const user = userEvent.setup();
    const session = useChatSessionStore.getState().createDraftSession({
      title: "Voice setup target",
      workingDir: "/tmp/voice-setup-target",
    });
    useVoiceConversationStore.getState().requestStart(session.id);
    mockVoiceSettingsEnabled.enabled = true;
    renderAppShell();

    act(() => {
      window.dispatchEvent(
        new CustomEvent(OPEN_SETTINGS_EVENT, {
          detail: {
            section: "voice",
            returnTarget: {
              type: "voice-setup",
              sessionId: session.id,
            },
          },
        }),
      );
    });

    await waitFor(() => {
      expect(screen.getByTestId("active-view")).toHaveTextContent("settings");
    });
    expect(
      useVoiceConversationStore.getState().requestedStartSessionId,
    ).toBeNull();
    await user.click(screen.getByRole("button", { name: "Back" }));

    await waitFor(() => {
      expect(screen.getByTestId("active-view")).toHaveTextContent("chat");
    });
    expect(useChatSessionStore.getState().activeSessionId).toBe(session.id);
    expect(
      useVoiceConversationStore.getState().requestedStartSessionId,
    ).toBeNull();

    await user.click(screen.getByRole("button", { name: "Forward" }));
    await waitFor(() => {
      expect(screen.getByTestId("active-view")).toHaveTextContent("settings");
    });
  });

  it("cancels a voice start when navigating away from setup", async () => {
    const user = userEvent.setup();
    const session = useChatSessionStore.getState().createDraftSession({
      title: "Voice setup target",
      workingDir: "/tmp/voice-setup-target",
    });
    useVoiceConversationStore.getState().requestStart(session.id);
    mockVoiceSettingsEnabled.enabled = true;
    renderAppShell();

    act(() => {
      window.dispatchEvent(
        new CustomEvent(OPEN_SETTINGS_EVENT, {
          detail: {
            section: "voice",
            returnTarget: {
              type: "voice-setup",
              sessionId: session.id,
            },
          },
        }),
      );
    });
    await waitFor(() => {
      expect(screen.getByTestId("active-view")).toHaveTextContent("settings");
    });

    await user.click(screen.getByRole("button", { name: "Sidebar skills" }));
    await waitFor(() => {
      expect(screen.getByTestId("active-view")).toHaveTextContent("skills");
    });
    expect(
      useVoiceConversationStore.getState().requestedStartSessionId,
    ).toBeNull();
  });

  it("cancels a voice start when another settings section replaces Voice setup", async () => {
    const user = userEvent.setup();
    const session = useChatSessionStore.getState().createDraftSession({
      title: "Voice setup target",
      workingDir: "/tmp/voice-setup-target",
    });
    useVoiceConversationStore.getState().requestStart(session.id);
    mockVoiceSettingsEnabled.enabled = true;
    renderAppShell();

    act(() => {
      window.dispatchEvent(
        new CustomEvent(OPEN_SETTINGS_EVENT, {
          detail: {
            section: "voice",
            returnTarget: {
              type: "voice-setup",
              sessionId: session.id,
            },
          },
        }),
      );
    });
    await waitFor(() => {
      expect(screen.getByTestId("active-view")).toHaveTextContent("settings");
    });

    await user.click(screen.getByRole("button", { name: "Sidebar providers" }));

    await waitFor(() => {
      expect(screen.getByTestId("settings-section")).toHaveTextContent(
        "providers",
      );
    });
    expect(
      useVoiceConversationStore.getState().requestedStartSessionId,
    ).toBeNull();
  });

  it("cancels a voice start when setup becomes ready before returning", async () => {
    const user = userEvent.setup();
    const session = useChatSessionStore.getState().createDraftSession({
      title: "Voice setup target",
      workingDir: "/tmp/voice-setup-target",
    });
    useVoiceConversationStore.getState().requestStart(session.id);
    mockVoiceSettingsEnabled.enabled = true;
    const view = renderAppShell();

    act(() => {
      window.dispatchEvent(
        new CustomEvent(OPEN_SETTINGS_EVENT, {
          detail: {
            section: "voice",
            returnTarget: {
              type: "voice-setup",
              sessionId: session.id,
            },
          },
        }),
      );
    });
    await waitFor(() => {
      expect(screen.getByTestId("active-view")).toHaveTextContent("settings");
    });

    mockVoiceSetupReadiness.ready = true;
    view.rerender(appShellWithTheme());
    await user.click(screen.getByRole("button", { name: "Back" }));

    await waitFor(() => {
      expect(screen.getByTestId("active-view")).toHaveTextContent("chat");
    });
    expect(useChatSessionStore.getState().activeSessionId).toBe(session.id);
    expect(
      useVoiceConversationStore.getState().requestedStartSessionId,
    ).toBeNull();
  });

  it("guards Voice setup navigation from a dirty agent draft", async () => {
    const user = userEvent.setup();
    renderAppShell();

    await user.click(screen.getByRole("button", { name: "Sidebar agents" }));
    await user.click(screen.getByRole("button", { name: "Create agent" }));
    await waitFor(() => {
      expect(screen.getByTestId("active-view")).toHaveTextContent("chat");
    });
    await waitForCreatedAgentBuilderTarget();

    const dirtyDraft = {
      type: "agent" as const,
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
    mockVoiceSettingsEnabled.enabled = true;

    const openVoiceSetup = () => {
      useVoiceConversationStore.getState().requestStart("created-session");
      window.dispatchEvent(
        new CustomEvent(OPEN_SETTINGS_EVENT, {
          detail: {
            section: "voice",
            returnTarget: {
              type: "voice-setup",
              sessionId: "created-session",
            },
          },
        }),
      );
    };

    act(openVoiceSetup);
    await waitFor(() => {
      expect(screen.getByText("Save this agent draft?")).toBeInTheDocument();
    });
    expect(screen.getByTestId("active-view")).toHaveTextContent("chat");

    await user.click(screen.getByRole("button", { name: "Keep editing" }));
    expect(screen.getByTestId("active-view")).toHaveTextContent("chat");
    expect(
      useVoiceConversationStore.getState().requestedStartSessionId,
    ).toBeNull();

    act(openVoiceSetup);
    await user.click(await screen.findByRole("button", { name: "Discard" }));
    await waitFor(() => {
      expect(screen.getByTestId("active-view")).toHaveTextContent("settings");
    });
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

  it("keeps a saved agent draft visible in recent chats", async () => {
    const user = userEvent.setup();
    renderAppShell();

    await user.click(screen.getByRole("button", { name: "Sidebar agents" }));
    await user.click(screen.getByRole("button", { name: "Create agent" }));
    await waitFor(() => {
      expect(screen.getByTestId("active-view")).toHaveTextContent("chat");
    });
    await waitForCreatedAgentBuilderTarget();

    const sessionBeforeSave = useChatSessionStore
      .getState()
      .getSession("created-session");
    expect(sessionBeforeSave).toMatchObject({
      messageCount: 0,
      intent: "build-agent",
    });

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
    await user.click(await screen.findByRole("button", { name: "Save draft" }));

    await waitFor(() => {
      expect(screen.getByTestId("active-view")).toHaveTextContent("skills");
    });

    const savedSession = useChatSessionStore
      .getState()
      .getSession("created-session");
    expect(savedSession).toMatchObject({
      messageCount: 0,
      intent: "build-agent",
      targetAgentPath: dirtyDraft.path,
      targetAgentDraftSaved: true,
    });
    expect(savedSession?.updatedAt).toEqual(expect.any(String));
  });

  it("opens Agent Builder without also opening Context", async () => {
    const user = userEvent.setup();
    useChatSessionStore.setState({
      sessions: [
        {
          id: "session-1",
          title: "New agent",
          executionTarget: { harnessId: "goose" },
          workingDir: "~/goose artifacts",
          createdAt: "2026-06-09T00:00:00.000Z",
          updatedAt: "2026-06-09T00:00:00.000Z",
          messageCount: 0,
          intent: "build-agent",
          targetAgentPath: "/Users/test/.agents/agents/draft-session.md",
          targetAgentSlug: "draft-session",
          targetAgentDraftState: null,
          targetAgentDraftSaved: true,
        },
      ],
      activeSessionId: null,
      isRightRailOpen: false,
    });
    renderAppShell();

    await user.click(screen.getByRole("button", { name: "Open session 1" }));

    await waitFor(() => {
      expect(screen.getByTestId("active-view")).toHaveTextContent("chat");
    });
    expect(useChatSessionStore.getState().getActiveSession()).toMatchObject({
      id: "session-1",
      intent: "build-agent",
    });
    expect(useChatSessionStore.getState().isRightRailOpen).toBe(false);
  });

  it("navigates a starter task to its relevant settings page", async () => {
    const user = userEvent.setup();
    renderAppShell();

    await user.click(
      screen.getByRole("button", { name: "Select provider starter task" }),
    );

    expect(screen.getByTestId("active-view")).toHaveTextContent("settings");
    expect(screen.getByTestId("settings-section")).toHaveTextContent(
      "providers",
    );
  });

  it("keeps background content inert and clears project selection after exit", async () => {
    const user = userEvent.setup();
    const appRoot = document.createElement("div");
    appRoot.id = "root";
    document.body.append(appRoot);
    render(appShellWithTheme(), { container: appRoot });

    await user.click(
      screen.getByRole("button", { name: "Open project starter task" }),
    );
    expect(screen.getByTestId("starter-task-selection")).toHaveTextContent(
      "create-project",
    );
    expect(appRoot.inert).toBe(true);
    await user.click(await screen.findByRole("button", { name: "Close" }));

    await waitFor(
      () => {
        expect(screen.getByTestId("starter-task-selection")).toHaveTextContent(
          "none",
        );
      },
      { timeout: 1000 },
    );
    expect(screen.getByTestId("starter-tasks-docked")).toHaveTextContent(
      "false",
    );
    expect(appRoot.inert).toBeFalsy();
  });

  it("persists restoring dismissed starter tasks", async () => {
    const user = userEvent.setup();
    renderAppShell();

    await user.click(
      screen.getByRole("button", { name: "Dismiss starter tasks" }),
    );
    expect(screen.getByTestId("starter-tasks-visible")).toHaveTextContent(
      "false",
    );

    await user.click(
      screen.getByRole("button", { name: "Restore starter tasks" }),
    );
    expect(screen.getByTestId("starter-tasks-visible")).toHaveTextContent(
      "true",
    );
    const persisted = JSON.parse(
      window.localStorage.getItem(ASSISTIVE_UX_STORAGE_KEY) ?? "{}",
    );
    expect(persisted.moments?.["home.starterTasks"]).not.toMatchObject({
      retiredReason: "dismissed",
    });
  });

  it("guards the add-widget starter task against unsaved automation changes", async () => {
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
    await user.click(
      screen.getByRole("button", { name: "Select add widget starter task" }),
    );

    expect(
      await screen.findByText("Unsaved automation changes"),
    ).toBeInTheDocument();
    expect(screen.getByTestId("active-view")).toHaveTextContent("automations");
    expect(hasStarterWidgetPickerRequest()).toBe(false);

    await user.click(screen.getByRole("button", { name: "Keep editing" }));
    expect(screen.getByTestId("active-view")).toHaveTextContent("automations");
    expect(screen.getByTestId("starter-tasks-docked")).toHaveTextContent(
      "false",
    );
    expect(screen.getByTestId("starter-task-selection")).toHaveTextContent(
      "none",
    );
    expect(hasStarterWidgetPickerRequest()).toBe(false);
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

  it("opens search over unsaved automation builder changes without navigating", async () => {
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
      await screen.findByRole("textbox", { name: "Universal search" }),
    ).toBeInTheDocument();
    expect(screen.queryByText("Unsaved automation changes")).toBeNull();
    expect(screen.getByTestId("active-view")).toHaveTextContent("automations");
  });

  it("guards settings results selected over unsaved automation changes", async () => {
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
    const search = await screen.findByRole("textbox", {
      name: "Universal search",
    });
    await user.type(search, "animated avatars");
    await user.click(
      await screen.findByRole("button", {
        name: "Open Animated avatars settings",
      }),
    );

    expect(
      await screen.findByText("Unsaved automation changes"),
    ).toBeInTheDocument();
    expect(screen.getByTestId("active-view")).toHaveTextContent("automations");

    await user.click(screen.getByRole("button", { name: "Keep editing" }));

    expect(screen.getByTestId("active-view")).toHaveTextContent("automations");
    expect(
      screen.getByRole("textbox", { name: "Universal search" }),
    ).toBeInTheDocument();
  });

  it("keeps search open when guarded agent navigation is cancelled", async () => {
    const user = userEvent.setup();
    useAgentStore.setState({
      personas: [
        {
          id: "agent-reviewer",
          displayName: "Reviewer",
          systemPrompt: "Review code changes",
          isBuiltin: true,
          writable: false,
        },
      ],
    });
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
    const search = await screen.findByRole("textbox", {
      name: "Universal search",
    });
    await user.type(search, "reviewer");
    await user.click(
      await screen.findByRole("button", { name: "Start chat with Reviewer" }),
    );

    expect(
      await screen.findByText("Unsaved automation changes"),
    ).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Keep editing" }));

    expect(search).toBeInTheDocument();
    expect(search).toHaveValue("reviewer");
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
        "appearance",
      );
    });
  });

  it("redirects a legacy deep-linked Doctor settings section to System", async () => {
    // rev 4: Doctor is a dialog opened from a row inside System, not a
    // settings section -- `?section=doctor` is a legacy URL now, resolved
    // to System (where that row lives) via LEGACY_SECTION_REDIRECTS at
    // initial parse time. That resolution only affects which section
    // renders, not the URL string itself (nothing rewrites the URL unless a
    // capability-gating effect fires, which System has no reason to), so
    // the address bar keeps showing the legacy `?section=doctor` param.
    window.history.replaceState(null, "", "/settings?section=doctor");

    renderAppShell();

    await waitFor(() => {
      expect(screen.getByTestId("active-view")).toHaveTextContent("settings");
      expect(screen.getByTestId("settings-section")).toHaveTextContent(
        "system",
      );
    });
    expect(window.location.pathname).toBe("/settings");
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

  it("hydrates a server-discovered session into the store when selected from search", async () => {
    // The store starts EMPTY: the discovered session is known only to the
    // server. Clicking its result must insert it synchronously — activation
    // renders the chat only for store sessions.
    useChatSessionStore.setState({ sessions: [] });
    mockAcpSearchSessions.mockImplementation(async () => ({
      results: [],
      searchedIds: [],
      failedIds: [],
      matchedInfos: [
        {
          sessionId: "server-1",
          title: "Server match",
          updatedAt: "2026-07-28T12:00:00.000Z",
          createdAt: "2026-07-28T11:00:00.000Z",
          lastMessageAt: null,
          archivedAt: null,
          userSetName: false,
          messageCount: 2,
          subtitle: null,
          workingDir: "/tmp/project",
          projectId: null,
          providerId: null,
          modelId: null,
          personaId: null,
        },
      ],
    }));
    const user = userEvent.setup();
    renderAppShell();

    await user.click(screen.getByRole("button", { name: "Search" }));
    const search = screen.getByRole("textbox", { name: "Universal search" });
    await user.type(search, "server match");

    await user.click(
      await screen.findByRole("button", { name: /Open chat Server match/ }),
    );

    const stored = useChatSessionStore.getState().getSession("server-1");
    expect(stored).toBeDefined();
    expect(useChatSessionStore.getState().activeSessionId).toBe("server-1");
    expect(screen.getByTestId("active-view")).toHaveTextContent("chat");
  });

  it("focuses a detached chat selected from search", async () => {
    mockSessionWindowSupport.supported = true;
    useSessionWindowStore
      .getState()
      .setSnapshot([
        { sessionId: "session-1", windowLabel: "session-session-1" },
      ]);
    useChatSessionStore.setState({
      sessions: [
        {
          id: "session-1",
          title: "Detached planning",
          createdAt: "2026-07-28T11:00:00.000Z",
          updatedAt: "2026-07-28T12:00:00.000Z",
          messageCount: 2,
        },
      ],
    });
    const user = userEvent.setup();
    renderAppShell();
    await act(async () => {
      useSessionWindowStore
        .getState()
        .setSnapshot([
          { sessionId: "session-1", windowLabel: "session-session-1" },
        ]);
    });

    await user.click(screen.getByRole("button", { name: "Search" }));
    const search = screen.getByRole("textbox", { name: "Universal search" });
    await user.type(search, "detached planning");
    await user.click(
      await screen.findByRole("button", {
        name: "Open chat Detached planning",
      }),
    );

    await waitFor(() => {
      expect(mockFocusSessionWindow).toHaveBeenCalledWith("session-1");
    });
    expect(screen.getByTestId("active-view")).toHaveTextContent("home");
    expect(useChatSessionStore.getState().activeSessionId).toBeNull();
  });

  it("starts connection setup as an editable draft in the selected harness", async () => {
    selectCodexProvider();
    mockAgentStatus.readyAgentIds = new Set(["codex-acp"]);
    seedProviderModels("codex-acp", [
      { id: "gpt-5.5", name: "GPT-5.5", recommended: true },
    ]);
    const user = userEvent.setup();
    renderAppShell();

    await user.click(
      screen.getByRole("button", { name: "Test connection setup" }),
    );

    await waitFor(() => {
      expect(mockAcpCreateSession).toHaveBeenCalledWith(
        "codex-acp",
        expect.any(String),
        expect.any(Object),
      );
    });
    expect(useChatStore.getState().draftsBySession["created-session"]).toBe(
      "Which connection?",
    );
  });

  it("opens extension search results in Settings Connections", async () => {
    mockListExtensions.mockResolvedValue([
      {
        config_key: "glean-stdio",
        type: "stdio",
        name: "Glean",
        description: "Search internal documents",
        cmd: "glean",
        args: [],
        enabled: true,
      },
    ]);
    const user = userEvent.setup();
    renderAppShell();

    await user.click(screen.getByRole("button", { name: "Search" }));
    const search = screen.getByRole("textbox", { name: "Universal search" });
    await user.type(search, "glean");
    await user.click(
      await screen.findByRole("button", { name: "Open extension Glean" }),
    );

    await waitFor(() => {
      expect(screen.getByTestId("active-view")).toHaveTextContent("settings");
    });
    expect(screen.getByTestId("settings-section")).toHaveTextContent(
      "connections",
    );
    expect(window.location.pathname).toBe("/settings");
    expect(new URLSearchParams(window.location.search).get("section")).toBe(
      "connections",
    );
  });

  it("opens search from the top bar and returns to the previous view", async () => {
    const user = userEvent.setup();
    renderAppShell();

    await user.click(screen.getByRole("button", { name: "Sidebar agents" }));
    expect(screen.getByTestId("active-view")).toHaveTextContent("agents");

    await user.click(screen.getByRole("button", { name: "Search" }));
    expect(
      screen.getByRole("textbox", { name: "Universal search" }),
    ).toBeInTheDocument();
    expect(screen.getByTestId("active-view")).toHaveTextContent("agents");

    await user.keyboard("{Escape}");
    await waitFor(() => {
      expect(
        screen.queryByRole("textbox", { name: "Universal search" }),
      ).not.toBeInTheDocument();
    });
    expect(screen.getByTestId("active-view")).toHaveTextContent("agents");
  });

  it("clears a focused search query before Escape closes the dialog", async () => {
    const user = userEvent.setup();
    renderAppShell();

    await user.click(screen.getByRole("button", { name: "Search" }));
    const search = screen.getByRole("textbox", { name: "Universal search" });
    await user.type(search, "reviewer");
    await user.keyboard("{Escape}");

    expect(search).toHaveValue("");
    expect(search).toBeInTheDocument();
  });

  it("closes search with Escape when focus is on the dialog", async () => {
    const user = userEvent.setup();
    renderAppShell();

    await user.click(screen.getByRole("button", { name: "Search" }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.focus(dialog);
    fireEvent.keyDown(dialog, { key: "Escape" });

    await waitFor(() => {
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });
  });

  it("localizes the Skills title in the top bar", async () => {
    await i18n.changeLanguage("es");
    const user = userEvent.setup();
    renderAppShell();

    await user.click(screen.getByRole("button", { name: "Sidebar skills" }));

    expect(screen.getByText("Habilidades")).toBeInTheDocument();
  });

  it("shows the Agents and Skills titles but keeps detail breadcrumbs out of the top bar", async () => {
    const user = userEvent.setup();
    renderAppShell();

    await user.click(screen.getByRole("button", { name: "Sidebar agents" }));
    expect(screen.getByTestId("active-view")).toHaveTextContent("agents");
    expect(screen.getByText("Agents")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Sidebar skills" }));
    expect(screen.getByText("Skills")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Open skill detail" }));
    expect(screen.getByText("Skills")).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Skills" })).toBeNull();
    expect(screen.queryByRole("link", { name: "Code Review" })).toBeNull();

    await user.click(
      screen.getByRole("button", { name: "Sidebar automations" }),
    );
    await user.click(
      screen.getByRole("button", { name: "Open automation history" }),
    );
    expect(screen.queryByRole("link", { name: "Automations" })).toBeNull();
    expect(screen.queryByRole("link", { name: "History" })).toBeNull();

    enableBuilderbotExperiment();
    await user.click(
      screen.getByRole("button", { name: "Sidebar builderbot" }),
    );
    await user.click(
      screen.getByRole("button", { name: "Open builderbot task" }),
    );
    expect(screen.queryByRole("link", { name: "Builderbot" })).toBeNull();
    expect(screen.queryByRole("link", { name: "TASK-1" })).toBeNull();

    await user.click(
      screen.getByRole("button", { name: "Open builderbot automation" }),
    );
    expect(screen.queryByRole("link", { name: "Daily docs" })).toBeNull();
  });

  it("shows only the session title for a project chat", async () => {
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
      expect(screen.getByText("MCPs vs Extensions")).toBeInTheDocument();
    });
    expect(screen.queryByText("Sample Project")).toBeNull();
    expect(screen.queryByText("Chat")).toBeNull();
    expect(
      (container.firstElementChild as HTMLElement).style.getPropertyValue(
        "--project-tint",
      ),
    ).toBe("var(--color-pill-blue)");
  });

  it("repairs an explicit persona model before creating its session", async () => {
    setResolvingPersona("legacy-v1-model");
    useAgentStore.setState({
      selectedProvider: "codex-acp",
      providers: [
        { id: "goose", label: "Goose" },
        { id: "codex-acp", label: "Codex" },
        { id: "databricks_v2", label: "Databricks AI Gateway" },
      ],
    });
    mockCheckAllProviderStatus.mockResolvedValue([
      { providerId: "databricks_v2", isConfigured: true },
    ]);
    mockRepairManagedGooseModelSelection.mockImplementation(
      async (selection: { providerId?: string; modelId?: string }) =>
        selection.modelId === "legacy-v1-model"
          ? { providerId: "databricks_v2", modelId: "goose-gpt-5-5" }
          : selection,
    );
    const user = userEvent.setup();
    renderAppShell();

    await user.click(
      screen.getByRole("button", { name: "Start chat with resolving agent" }),
    );

    await waitFor(() => {
      expect(mockAcpCreateSession).toHaveBeenCalledWith(
        "databricks_v2",
        "~/goose artifacts",
        expect.objectContaining({ modelId: "goose-gpt-5-5" }),
      );
    });
    expect(mockAcpCreateSession).not.toHaveBeenCalledWith(
      "databricks_v2",
      "~/goose artifacts",
      expect.objectContaining({ modelId: "legacy-v1-model" }),
    );
    expect(
      useChatSessionStore.getState().getSession("created-session"),
    ).toMatchObject({
      executionTarget: {
        harnessId: "goose",
        modelProviderId: "databricks_v2",
        modelId: "goose-gpt-5-5",
      },
    });
  });

  it("forwards a persona's provider and model when the provider resolves", async () => {
    setResolvingPersona("goose-model");
    useAgentStore.setState({
      selectedProvider: "codex-acp",
      providers: [
        { id: "goose", label: "Goose" },
        { id: "codex-acp", label: "Codex" },
        { id: "databricks_v2", label: "Databricks AI Gateway" },
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
      expect(mockAcpCreateSession).toHaveBeenCalledWith(
        "databricks_v2",
        "~/goose artifacts",
        {
          deferProviderSetup: false,
          modelId: "goose-model",
          projectId: undefined,
        },
      );
    });
    await waitFor(() => {
      expect(
        useChatSessionStore.getState().getSession("created-session"),
      ).toMatchObject({
        executionTarget: {
          harnessId: "goose",
          modelProviderId: "databricks_v2",
          modelId: "goose-model",
        },
      });
    });
  });

  it("qualifies a Goose persona model from provider inventory", async () => {
    setResolvingPersona("custom-model", "goose");
    seedProviderModels("databricks_v2", [
      { id: "custom-model", name: "Custom model" },
    ]);
    mockCheckAllProviderStatus.mockResolvedValue([
      { providerId: "databricks_v2", isConfigured: true },
    ]);
    const user = userEvent.setup();
    renderAppShell();

    await user.click(
      screen.getByRole("button", { name: "Start chat with resolving agent" }),
    );

    await waitFor(() => {
      expect(mockAcpCreateSession).toHaveBeenCalledWith(
        "databricks_v2",
        "~/goose artifacts",
        expect.objectContaining({ modelId: "custom-model" }),
      );
    });
    await waitFor(() => {
      expect(
        useChatSessionStore.getState().getSession("created-session"),
      ).toMatchObject({
        executionTarget: {
          harnessId: "goose",
          modelProviderId: "databricks_v2",
          modelId: "custom-model",
        },
      });
    });
  });

  it("uses the normal new-chat target when a persona has no plausible target", async () => {
    useDefaultProviderReadinessStore.setState({
      readiness: {
        status: "ready",
        providerId: "databricks_v2",
        modelId: "goose-default",
      },
    });
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
        "databricks_v2",
        "~/goose artifacts",
        expect.objectContaining({ modelId: "goose-default" }),
      );
    });
    expect(
      useChatSessionStore.getState().getSession("created-session"),
    ).toMatchObject({ personaId: "persona-unresolved" });
  });

  it("tags a Home agent starter in the composer instead of opening a blank chat", async () => {
    setResolvingPersona("goose-model");
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
    setResolvingPersona("goose-model");
    mockCheckAllProviderStatus.mockResolvedValue([
      { providerId: "databricks_v2", isConfigured: true },
    ]);
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
        executionTarget: {
          harnessId: "goose",
          modelProviderId: "databricks_v2",
          modelId: "goose-model",
          modelName: "goose-model",
        },
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
    setResolvingPersona("goose-model");
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
      expect(
        screen.getByRole("textbox", { name: "Universal search" }),
      ).toBeInTheDocument();
    });
    expect(screen.getByTestId("active-view")).toHaveTextContent("home");
  });

  it("opens search with Ctrl+K off macOS", async () => {
    mockGetPlatform.mockReturnValue("windows");
    const user = userEvent.setup();
    renderAppShell();

    await user.keyboard("{Control>}k{/Control}");

    await waitFor(() => {
      expect(
        screen.getByRole("textbox", { name: "Universal search" }),
      ).toBeInTheDocument();
    });
    expect(screen.getByTestId("active-view")).toHaveTextContent("home");
  });

  it("toggles the dev design system inspector with Cmd+Shift+D", async () => {
    mockDesignSystemExplorerEnabled.mockReturnValue(true);
    renderAppShell();

    expect(
      screen.queryByRole("button", { name: "Inspect (⌘I)" }),
    ).not.toBeInTheDocument();

    fireEvent.keyDown(window, {
      key: "d",
      metaKey: true,
      shiftKey: true,
    });

    expect(
      screen.getByRole("button", { name: "Inspect (⌘I)" }),
    ).toBeInTheDocument();

    fireEvent.keyDown(window, {
      key: "d",
      metaKey: true,
      shiftKey: true,
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
    expect(
      screen.queryByRole("textbox", { name: "Universal search" }),
    ).not.toBeInTheDocument();

    await user.keyboard("{Meta>}{Shift>}x{/Shift}{/Meta}");
    await waitFor(() => {
      expect(
        screen.getByRole("textbox", { name: "Universal search" }),
      ).toBeInTheDocument();
    });
    expect(screen.getByTestId("active-view")).toHaveTextContent("home");
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
    expect(
      screen.queryByRole("textbox", { name: "Universal search" }),
    ).not.toBeInTheDocument();
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
    const stopVoiceConversation = vi.fn();
    const sessionBase = {
      executionTarget: { harnessId: "goose" },
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
    useVoiceConversationStore.setState({
      status: {
        available: true,
        unavailableReason: null,
        lifecycle: "running",
        sessionId: "session-1",
        ownerWindowLabel: "main",
        microphoneMuted: false,
        revision: 1,
      },
      stop: stopVoiceConversation,
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
    expect(stopVoiceConversation).not.toHaveBeenCalled();
  });
});

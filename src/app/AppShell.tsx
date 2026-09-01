import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { FeedbackDialog } from "@/features/feedback/FeedbackDialog";
import { useFeedbackDialogStore } from "@/features/feedback/feedbackDialogStore";
import { KeyboardShortcutsDialog } from "@/features/shortcuts/ui/KeyboardShortcutsDialog";
import { eventMatchesShortcutCommand } from "@/features/shortcuts/lib/shortcutRegistry";
import { useShortcutsDialogStore } from "@/features/shortcuts/stores/shortcutsDialogStore";
import { prefetchProjectArtifactRenderer } from "@/features/projects/artifact/prefetchProjectArtifactRenderer";
import { getPlatform, type Platform } from "@/shared/lib/platform";
import {
  archiveProject,
  isWorktreeStartupMode,
  requiresWorkspaceStartup,
  type ProjectInfo,
} from "@/features/projects/api/projects";
import { useAutoArchiveSessions } from "@/features/sessions/hooks/useAutoArchiveSessions";
import {
  DEFAULT_SETTINGS_SECTION,
  resolveEnabledSettingsSection,
  resolveSettingsSection,
  SETTINGS_SECTIONS,
  type SectionId,
} from "@/features/settings/ui/settingsSections";
import {
  OPEN_SETTINGS_EVENT,
  requestOpenSettings,
  type AgentBuilderProviderSetupReturnTarget,
  type OpenSettingsEventDetail,
  type VoiceSetupReturnTarget,
} from "@/features/settings/lib/settingsEvents";
import type { ExtensionEntry } from "@/features/extensions/types";
import { acceptFirstSend } from "@/features/chat/lib/firstWorkspaceSend";
import { CHAT_SOURCE_SURFACE } from "@/features/chat/lib/chatTelemetry";
import {
  admitSystemInheritedQueuedMessage,
  personaIntentFromComposer,
} from "@/features/chat/lib/admittedSend";
import { planProjectChatWorkspacesAsIs } from "@/features/projects/lib/projectChatWorkspaces";
import { ProjectWorkspaceStartupNameDialog } from "@/features/projects/ui/ProjectWorkspaceStartupNameDialog";
import { useWorkspaceRepository } from "@/features/workspaces/workspaceRepository";
import type { TopBarChromeInsets } from "./ui/TopBar";
import {
  isSessionActivelyViewed,
  useChatStore,
} from "@/features/chat/stores/chatStore";
import { useActiveProjectTint } from "@/features/chat/hooks/useActiveProjectTint";
import { useWorkspaceNameRequestQueue } from "@/features/chat/hooks/useWorkspaceNameRequestQueue";
import {
  cleanupSessionWorkspaces,
  countSessionWorkspaceCleanupResources,
  hasSessionWorkspaceCleanupTargets,
  inspectSessionWorkspaceCleanup,
  type InspectedSessionWorkspaceCleanupPlan,
  loadAllSessionsForWorkspaceCleanup,
  planSessionWorkspaceCleanup,
  SessionWorkspaceCleanupInterruptedError,
  type SessionWorkspaceCleanupInterruptionReason,
  wouldSessionWorkspaceCleanupDiscardFiles,
} from "@/features/chat/lib/sessionWorkspaceCleanup";
import { getCachedHomeDir, getHomeDir } from "@/shared/api/system";
import { isSessionRunning } from "@/features/chat/lib/sessionActivity";
import {
  isAgentBuilderVisible,
  isContextPanelVisible,
} from "@/features/chat/lib/chatCapabilityVisibility";
import { SessionWorkspaceCleanupDialog } from "@/features/chat/ui/SessionWorkspaceCleanupDialog";
import {
  type ChatSession,
  type ChatSessionReasoningEffortConfig,
  getVisibleSessions,
  SessionNotFoundError,
  useChatSessionStore,
} from "@/features/chat/stores/chatSessionStore";
import { selectLocalMessageCountsBySession } from "@/features/chat/stores/chatSelectors";
import { resolveSessionCycleTarget } from "@/features/sessions/lib/sessionCycle";
import { useSessionWindowStore } from "@/features/chat/stores/sessionWindowStore";
import { loadPersistedChatWorkspaceMetadata } from "@/features/chat/stores/workspaceAttachmentPersistence";
import {
  selectActiveSessionId,
  selectHasHydratedSessions,
  selectSessions,
  selectSessionsLoading,
} from "@/features/chat/stores/chatSessionSelectors";
import { useAgentStore } from "@/features/agents/stores/agentStore";
import { useProviderSelection } from "@/features/agents/hooks/useProviderSelection";
import { personaExecutionTarget } from "@/features/agents/lib/personaExecutionTarget";
import { useProjectStore } from "@/features/projects/stores/projectStore";
import { selectProjects } from "@/features/projects/stores/projectSelectors";
import { findExistingDraft } from "@/features/chat/lib/newChat";
import { DEFAULT_CHAT_TITLE } from "@/features/chat/lib/sessionTitle";
import { useAppStartup } from "./hooks/useAppStartup";
import { useCompletionNotifications } from "@/shared/hooks/useCompletionNotifications";
import { useHomeSessionStateSync } from "./hooks/useHomeSessionStateSync";
import { useHomeWidgetStore } from "@/features/home/stores/homeWidgetStore";
import { runPinnedPrompt } from "@/features/home/lib/runPinnedPrompt";
import { useProjectDialog } from "./hooks/useProjectDialog";
import { useResizableSidebar } from "./hooks/useResizableSidebar";
import {
  areAppNavigationLocationsEqual,
  getAppNavigationLocation,
} from "./lib/appNavigationLocation";
import { useStagedAppContentLocation } from "./lib/useStagedAppContentLocation";
import { loadStoredHomeSessionId } from "./lib/homeSessionStorage";
import { resolveSupportedSessionModelPreference } from "@/features/providers/lib/resolveSessionModelPreference";
import { listenSessionDeepLinkErrors } from "./lib/sessionDeepLinkErrors";
import {
  clearSettingsSectionUrl,
  getInitialSettingsSection,
  setDesignSystemUrl,
  setSettingsSectionUrl,
} from "./lib/settingsSectionUrl";
import { useAgentBuilderCoordinator } from "@/features/agents/hooks/useAgentBuilderCoordinator";
import {
  type ArchiveCleanupPolicy,
  MUTATION_DEADLINE_MARGIN_MS,
  useRegisterAppNavigationController,
} from "@/features/berdctl/navigation";
import { AgentBuilderLeaveDraftDialog } from "@/features/agents/ui/AgentBuilderLeaveDraftDialog";
import { AutomationBuilderLeaveDialog } from "@/features/automations/ui/AutomationBuilderLeaveDialog";
import type { AutomationBuilderLeaveAction } from "@/features/automations/ui/AutomationBuilderView";
import { AppShellLayout } from "./ui/AppShellLayout";
import type { AuthStatus } from "@/features/auth/api/auth";
import { AppShellContent } from "./ui/AppShellContent";
import {
  replaceSessionTargetAfterDispatch,
  transferSessionTargetOwnership,
  transitionSessionTarget,
} from "@/features/chat/lib/sessionTargetCoordinator";
import {
  beginModelSelectionIntent,
  getModelSelectionIntent,
  clearCurrentModelSelectionIntent,
  createModelSelectionRequestId,
  isCurrentModelSelectionIntent,
  showModelSwitchErrorToast,
} from "@/features/chat/model-selection/modelSelectionIntent";
import { setStoredModelPreference } from "@/features/chat/lib/modelPreferences";
import { archiveSession as archiveSessionApi } from "@/shared/api/acpApi";
import {
  moveSessionToProject,
  updateSessionTitle,
} from "@/features/chat/stores/chatSessionOperations";
import {
  activateSession as activateChatSession,
  loadSessionMessagesAndPrepare,
} from "@/features/chat/lib/sessionActivation";
import { hasConversationMessages } from "@/features/chat/lib/sessionReplayReplacement";
import {
  focusSessionWindow,
  releaseSession,
} from "@/features/chat/lib/sessionWindowCommands";
import { sendSessionWindowSearchTarget } from "@/features/chat/lib/sessionWindowSearchEvents";
import { useSessionHandoffSource } from "@/features/chat/hooks/useSessionHandoffSource";
import { useSessionWindowSupport } from "@/features/chat/hooks/useSessionWindowSupport";
import { useSessionWindowTracking } from "@/features/chat/hooks/useSessionWindowTracking";
import { resolveSessionCwd } from "@/features/projects/lib/sessionCwdSelection";
import { perfLog } from "@/shared/lib/perfLog";
import { cn } from "@/shared/lib/cn";
import { isEditableTarget } from "@/shared/keyboard/isEditableTarget";
import {
  getChatSessionIdsWithTerminals,
  setTerminalRenderingSuspended,
} from "@/features/terminal/lib/terminalSessionManager";
import type { SetupChatRequest } from "@/features/chat/lib/setupChatRequest";
import type { AgentSetupTroubleshootingRequest } from "@/features/providers/lib/agentSetupTroubleshooting";
import type { SkillInfo } from "@/features/skills/api/skills";
import { toChatSkillDraft } from "@/features/skills/lib/skillChatPrompt";
import { useMigrationGate } from "@/features/migration/hooks/useMigrationGate";
import { useNewSessionTarget } from "@/features/providers/hooks/useNewSessionTarget";
import { useAgentProviderStatus } from "@/features/providers/hooks/useAgentProviderStatus";
import { useDefaultProviderReadinessStore } from "@/features/providers/stores/defaultProviderReadinessStore";
import {
  getProviderCatalog,
  resolveAgentProviderCatalogIdStrict,
} from "@/features/providers/providerCatalog";
import { useProviderModelCacheStore } from "@/features/providers/stores/providerModelCacheStore";
import { getBuildFeatureState } from "@/shared/profile/buildProfile";
import { gooseServeSelectionFromExecutionTarget } from "@/features/chat/lib/gooseServeExecutionTarget";
import {
  isModelExecutionTarget,
  materializeSessionExecutionModel,
  normalizeSessionExecutionTarget,
  sameSessionExecutionTarget,
  type SessionExecutionTarget,
} from "@/features/chat/lib/sessionExecutionTarget";
import { useDefaultModelGate } from "@/features/migration/hooks/useDefaultModelGate";
import { findBerdyPersonaId } from "@/features/onboarding/berdyAgent";
import { StartupDiagnosticView } from "./ui/StartupDiagnosticView";
import { buildStartupDiagnosticIssue } from "./lib/startupDiagnostics";
import { usePersistedState } from "@/shared/hooks/usePersistedState";
import {
  FocusRegionProvider,
  hasOpenKeyboardOwningLayer,
} from "./focus/FocusRegionProvider";
import { SessionQuickSwitcher } from "@/features/sessions/ui/SessionQuickSwitcher";
import { SearchView } from "@/features/search/ui/SearchView";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/shared/ui/dialog";
import { useForkSession } from "@/features/sessions/hooks/useForkSession";
import {
  GlobalComposerPill,
  type GlobalComposerExpandPayload,
  type GlobalComposerHandoffRect,
  type GlobalComposerStarterRequest,
  type GlobalComposeOptions,
} from "@/shared/ui/GlobalComposerPill";
import { acpCreateSession, acpSetSessionConfigOption } from "@/shared/api/acp";
import { formatAcpErrorMessage } from "@/shared/api/acpErrors";
import { findMissingProjectDirs } from "@/features/projects/lib/missingProjectDirs";
import {
  createSystemNotificationMessage,
  isSystemNotification,
} from "@/shared/types/messages";
import { isDesignSystemExplorerEnabled } from "@/features/design-system/lib/designSystemEnabled";
import { useExperiment } from "@/features/experiments/experimentPreferences";
import { OnboardingFlow } from "@/features/onboarding/ui/OnboardingFlow";
import { useOnboardingState } from "@/features/onboarding/model";
import {
  blockVoiceConversationStarts,
  useVoiceConversationStore,
} from "@/features/voice-conversation/stores/voiceConversationStore";
import {
  listenToVoiceConversationOpenSession,
  setVoiceConversationForegroundSession,
} from "@/features/voice-conversation/api/voiceConversation";
import { usePocketVoiceSetup } from "@/features/voice-conversation/hooks/usePocketVoiceSetup";
import { useMacSpeechSetup } from "@/features/voice-conversation/hooks/useMacSpeechSetup";
import { useOpenAiVoiceSetup } from "@/features/voice-conversation/hooks/useOpenAiVoiceSetup";
import { useSiriVoiceSetup } from "@/features/voice-conversation/hooks/useSiriVoiceSetup";
import {
  isMacSpeechAvailable,
  useVoiceInputPreference,
} from "@/features/voice-conversation/lib/voiceInputPreference";
import { useVoiceOutputPreference } from "@/features/voice-conversation/lib/voiceOutputPreference";
import { isVoiceSetupReady } from "@/features/voice-conversation/lib/voiceSetupReadiness";
import { useProfileCapabilities } from "@/shared/profile/capabilities";
import { getOptimisticArtifactCwd } from "@/shared/artifacts/sessionArtifactLocation";
import {
  DEFAULT_DESIGN_SYSTEM_SECTION,
  DESIGN_SYSTEM_SECTIONS,
  type DesignSystemSection,
} from "@/features/design-system/ui/designSystemSections";
import type {
  AppNavigationLocation,
  AppNavigationUpdateOptions,
  AppView,
  AutomationNavigationRoute,
  BuilderbotNavigationRoute,
} from "./types/appNavigation";
import type { TopBarBreadcrumb } from "./ui/TopBar";
import { STARTUP_LOADING_MIN_DISPLAY_MS } from "./lib/startupLoading";
import { StartupLoadingView } from "./ui/StartupLoadingView";
import { deriveStarterTaskCompletion } from "@/features/home/onboarding/starterTaskCompletion";
import {
  omittedStarterTasksAfterFirstRun,
  type StarterTaskCompletionState,
  type StarterTaskId,
} from "@/features/home/onboarding/starterTasks";
import { StarterTaskList } from "@/features/home/onboarding/StarterTaskList";
import {
  clearStarterTaskProgress,
  EMPTY_STARTER_TASK_COMPLETION,
  loadStarterTaskProgress,
  saveStarterTaskProgress,
  STARTER_TASK_PROGRESS_STORAGE_KEY,
} from "@/features/home/onboarding/starterTaskProgress";
import { StarterTasksProvider } from "@/features/home/onboarding/StarterTasksContext";
import {
  requestStarterWidgetPicker,
  STARTER_WIDGET_ADDED_EVENT,
} from "@/features/home/onboarding/starterWidgetTask";
import { STARTER_TASKS_EXPERIMENT_ID } from "@/features/experiments/experimentDefinitions";
import {
  recordAssistiveMomentRetired,
  recordAssistiveMomentShown,
  shouldShowAssistiveMoment,
} from "@/shared/assistive-ux/runtime";
import { resetAssistiveUxMoment } from "@/shared/assistive-ux/state";
export type { AppView } from "./types/appNavigation";

type AppNavigationHistory = {
  entries: AppNavigationLocation[];
  index: number;
  isApplying: boolean;
};

type ResolvedSessionModelPreference = Awaited<
  ReturnType<typeof resolveSupportedSessionModelPreference>
>;
type MaybePromise<T> = T | Promise<T>;
type DraftSessionCreationReady = {
  backendSessionId: string;
  configOptionsSnapshot: Awaited<
    ReturnType<typeof acpCreateSession>
  >["configOptionsSnapshot"];
};
type ProjectChatDraftOptions = {
  executionTarget?: SessionExecutionTarget;
  reuseExistingDraft?: boolean;
  reasoningEffort?: GlobalComposeOptions["reasoningEffort"];
};

function executionTargetFromModelPreference(
  harnessId: string,
  preference: ResolvedSessionModelPreference,
): SessionExecutionTarget {
  const canApplyModel =
    !preference.modelId ||
    harnessId !== "goose" ||
    (preference.providerId !== "goose" &&
      !resolveAgentProviderCatalogIdStrict(preference.providerId));
  return normalizeSessionExecutionTarget({
    harnessId,
    modelProviderId:
      canApplyModel &&
      (preference.modelId || preference.providerId !== harnessId)
        ? preference.providerId
        : undefined,
    modelId: canApplyModel ? preference.modelId : undefined,
    modelName: canApplyModel ? preference.modelName : undefined,
  });
}

interface PendingSessionWorkspaceCleanupConfirmation {
  worktreeCount: number;
  branchCount: number;
  resolve: (confirmed: boolean) => void;
}

const APP_NAVIGATION_HISTORY_LIMIT = 50;
const PINNED_CHAT_HYDRATION_CONCURRENCY = 5;
const DESIGN_SYSTEM_INSPECTOR_VISIBLE_STORAGE_KEY =
  "goose:design-system-inspector-visible:v2";
const REDUCED_MOTION_QUERY = "(prefers-reduced-motion: reduce)";
const GLOBAL_COMPOSER_HANDOFF_MS = 620;
const GLOBAL_COMPOSER_ROUTE_SWAP_DELAY_MS = 220;

function getSessionArchiveInterruptionReason(
  sessionId: string,
  cleanupPolicy: ArchiveCleanupPolicy,
  deadlineMs?: number,
): SessionWorkspaceCleanupInterruptionReason | null {
  if (
    deadlineMs != null &&
    Date.now() >= deadlineMs - MUTATION_DEADLINE_MARGIN_MS
  ) {
    return "timed_out";
  }
  if (cleanupPolicy === "confirm") {
    return null;
  }
  if (useSessionWindowStore.getState().isOpenInWindow(sessionId)) {
    return "target_session_running";
  }
  const runtime = useChatStore.getState().getSessionRuntime(sessionId);
  return isSessionRunning(runtime.chatState) || runtime.isRunCancellationPending
    ? "target_session_running"
    : null;
}

async function acquireVoiceStartBlockBeforeDeadline(
  sessionId: string,
  deadlineMs?: number,
): Promise<(() => Promise<void>) | null> {
  const acquisition = blockVoiceConversationStarts(sessionId);
  if (deadlineMs == null) return acquisition;

  const remainingMs = deadlineMs - MUTATION_DEADLINE_MARGIN_MS - Date.now();
  if (remainingMs <= 0) {
    void acquisition.then((release) => release()).catch(() => undefined);
    return null;
  }

  let timeoutId: number | undefined;
  const timeout = new Promise<null>((resolve) => {
    timeoutId = window.setTimeout(() => resolve(null), remainingMs);
  });
  const release = await Promise.race([acquisition, timeout]);
  if (timeoutId !== undefined) window.clearTimeout(timeoutId);
  if (!release) {
    void acquisition
      .then((lateRelease) => lateRelease())
      .catch(() => undefined);
  }
  return release;
}

type GlobalComposerPlacement = "docked" | "centered" | "handoff";

const current = (id: string, label: string): TopBarBreadcrumb => ({
  id,
  label,
});

const parent = (
  id: string,
  label: string,
  onClick: () => void,
): TopBarBreadcrumb => ({ id, label, onClick });

function validateBooleanPreference(value: unknown, defaults: boolean) {
  return typeof value === "boolean" ? value : defaults;
}

function isArchiveShortcutBlockedTarget(target: EventTarget | null) {
  if (!(target instanceof Element)) {
    return false;
  }
  // The chat composer opts back in (data-chat-composer): it holds focus for
  // most of a session's life, so treating it like other editable fields would
  // make the archive shortcut effectively dead in chat view.
  if (target.closest("[data-chat-composer]")) {
    return false;
  }
  if (isEditableTarget(target)) {
    return true;
  }
  return Boolean(target.closest(".xterm"));
}

function isTerminalOwnedHistoryShortcut(event: KeyboardEvent) {
  if (!(event.target instanceof Element) || !event.target.closest(".xterm")) {
    return false;
  }

  return (
    event.altKey &&
    !event.ctrlKey &&
    !event.metaKey &&
    !event.shiftKey &&
    (event.key === "ArrowLeft" || event.key === "ArrowRight")
  );
}

function getInitialAppView(initialSettingsSection: SectionId | null): AppView {
  if (initialSettingsSection) return "settings";
  if (
    isDesignSystemExplorerEnabled() &&
    window.location.pathname === "/design-system"
  ) {
    return "design-system";
  }
  return "home";
}

function getOptimisticSessionCwd(project?: ProjectInfo | null): string {
  const projectWorkingDir = (project?.workingDirs ?? [])
    .map((directory) => directory.trim())
    .find((directory) => directory.length > 0);
  return projectWorkingDir ?? getOptimisticArtifactCwd();
}

function resolveLiveSessionId(sessionId: string): string | null {
  const session = useChatSessionStore
    .getState()
    .sessions.find(
      (candidate) =>
        candidate.id === sessionId || candidate.clientSessionId === sessionId,
    );
  return session && !session.archivedAt ? session.id : null;
}

function readSessionReasoningEffort(
  sessionId: string,
): ChatSessionReasoningEffortConfig | undefined {
  return useChatSessionStore.getState().getSession(sessionId)?.reasoningEffort;
}

function patchSessionReasoningEffort(
  sessionId: string,
  reasoningEffort: ChatSessionReasoningEffortConfig,
) {
  useChatSessionStore.getState().patchSession(sessionId, { reasoningEffort });
}

async function applyReasoningEffortToSession(
  sessionId: string,
  reasoningEffort: NonNullable<GlobalComposeOptions["reasoningEffort"]>,
  options: {
    currentReasoningEffort?: ChatSessionReasoningEffortConfig;
    patchSessionId?: string;
  } = {},
) {
  const currentReasoningEffort =
    options.currentReasoningEffort ?? readSessionReasoningEffort(sessionId);
  if (!currentReasoningEffort) {
    return;
  }

  const patchSessionId = options.patchSessionId ?? sessionId;
  const targetAtRequest =
    useChatSessionStore.getState().getSession(patchSessionId)
      ?.executionTarget ??
    useChatSessionStore.getState().getSession(sessionId)?.executionTarget;
  const optimisticReasoningEffort =
    currentReasoningEffort.configId === reasoningEffort.configId
      ? {
          ...currentReasoningEffort,
          currentValue: reasoningEffort.value,
        }
      : currentReasoningEffort;
  patchSessionReasoningEffort(patchSessionId, optimisticReasoningEffort);
  const requestIsCurrent = () => {
    const liveSession = useChatSessionStore
      .getState()
      .getSession(patchSessionId);
    return (
      sameSessionExecutionTarget(
        liveSession?.executionTarget,
        targetAtRequest,
      ) &&
      liveSession?.reasoningEffort?.configId ===
        optimisticReasoningEffort.configId &&
      liveSession.reasoningEffort.currentValue ===
        optimisticReasoningEffort.currentValue
    );
  };
  const { providerId, modelId } =
    gooseServeSelectionFromExecutionTarget(targetAtRequest);

  try {
    const configOptionsSnapshot = await acpSetSessionConfigOption(
      sessionId,
      reasoningEffort.configId,
      reasoningEffort.value,
      { providerId, modelId, reasoningEffortValue: reasoningEffort.value },
    );
    if (configOptionsSnapshot.reasoningEffort && requestIsCurrent()) {
      patchSessionReasoningEffort(
        patchSessionId,
        configOptionsSnapshot.reasoningEffort,
      );
    }
  } catch (error) {
    if (requestIsCurrent()) {
      patchSessionReasoningEffort(patchSessionId, currentReasoningEffort);
    }
    throw error;
  }
}

function applyReasoningEffortAfterDraftCreation(
  draftSessionId: string,
  reasoningEffort: GlobalComposeOptions["reasoningEffort"] | undefined,
): ((result: DraftSessionCreationReady) => Promise<void>) | undefined {
  if (!reasoningEffort) {
    return undefined;
  }

  return async ({ backendSessionId, configOptionsSnapshot }) => {
    if (!configOptionsSnapshot?.reasoningEffort) {
      return;
    }

    try {
      await applyReasoningEffortToSession(backendSessionId, reasoningEffort, {
        currentReasoningEffort: configOptionsSnapshot.reasoningEffort,
        patchSessionId: draftSessionId,
      });
    } catch (error) {
      console.error(
        "Failed to apply reasoning effort during draft session creation:",
        error,
      );
    }
  };
}

function prefersReducedMotion(): boolean {
  return window.matchMedia?.(REDUCED_MOTION_QUERY).matches ?? false;
}

function logProjectChatStartError(message: string, error: unknown): void {
  console.error(message, error);
  toast.error(formatAcpErrorMessage(error, "Couldn't start chat. Try again."));
}

function useWindowFullscreenState() {
  const [isWindowFullscreen, setIsWindowFullscreen] = useState(false);

  useEffect(() => {
    if (!window.__TAURI_INTERNALS__) {
      return;
    }

    let didCancel = false;
    let unlisten: (() => void) | undefined;

    async function setupFullscreenState() {
      const { getCurrentWindow } = await import("@tauri-apps/api/window");
      const appWindow = getCurrentWindow();

      async function syncFullscreenState() {
        const nextIsFullscreen = await appWindow.isFullscreen();
        if (!didCancel) {
          setIsWindowFullscreen(nextIsFullscreen);
        }
      }

      await syncFullscreenState();
      unlisten = await appWindow.onResized(() => {
        void syncFullscreenState();
      });

      if (didCancel) {
        unlisten();
      }
    }

    void setupFullscreenState().catch(() => undefined);

    return () => {
      didCancel = true;
      unlisten?.();
    };
  }, []);

  return isWindowFullscreen;
}

function getTopBarChromeInsets(
  platform: Platform,
  isWindowFullscreen: boolean,
): TopBarChromeInsets {
  if (platform === "mac" && !isWindowFullscreen) {
    return { leading: "trafficLights" };
  }

  return { leading: "compact" };
}

export function shouldStopVoiceConversationOnExperimentChange({
  wasEnabled,
  isEnabled,
}: {
  wasEnabled: boolean;
  isEnabled: boolean;
}): boolean {
  return wasEnabled && !isEnabled;
}

export function AppShell({
  authStatus,
  children,
  onLoggedOut,
}: {
  authStatus?: AuthStatus;
  children?: React.ReactNode;
  onLoggedOut?: (status: AuthStatus) => void;
}) {
  const { t } = useTranslation([
    "chat",
    "common",
    "agents",
    "settings",
    "search",
    "home",
    "sidebar",
  ]);
  const {
    expandSidebar,
    handleCornerResizeDoubleClick,
    handleCornerResizeStart,
    handleHeightResizeDoubleClick,
    handleHeightResizeStart,
    handleResizeDoubleClick,
    handleResizeStart,
    isCollapsed: sidebarCollapsed,
    isResizing,
    resizeHandleHeight,
    resizeHandleWidth,
    sidebarOuterHeight,
    sidebarPanelOuterWidth,
    sidebarWidth,
    toggleCollapse: toggleSidebar,
  } = useResizableSidebar();
  const isWindowFullscreen = useWindowFullscreenState();
  const platform = getPlatform();
  const topBarChromeInsets = getTopBarChromeInsets(
    platform,
    isWindowFullscreen,
  );
  const initialSettingsSection = getInitialSettingsSection();
  const [activeSettingsSection, setActiveSettingsSection] = useState<SectionId>(
    initialSettingsSection ?? DEFAULT_SETTINGS_SECTION,
  );
  const [quickSwitcherOpen, setQuickSwitcherOpen] = useState(false);
  const [searchDialogOpen, setSearchDialogOpen] = useState(false);
  const [searchEscapeRequest, setSearchEscapeRequest] = useState(0);
  const [
    pendingWorkspaceCleanupConfirmation,
    setPendingWorkspaceCleanupConfirmation,
  ] = useState<PendingSessionWorkspaceCleanupConfirmation | null>(null);
  const pendingWorkspaceCleanupConfirmationRef =
    useRef<PendingSessionWorkspaceCleanupConfirmation | null>(null);
  const sessionArchiveQueueRef = useRef<Promise<void>>(Promise.resolve());
  const [activeDesignSystemSection, setActiveDesignSystemSection] =
    useState<DesignSystemSection>(DEFAULT_DESIGN_SYSTEM_SECTION);
  const [designSystemInspectorVisible, setDesignSystemInspectorVisible] =
    usePersistedState(
      DESIGN_SYSTEM_INSPECTOR_VISIBLE_STORAGE_KEY,
      false,
      validateBooleanPreference,
    );
  const [
    designSystemInspectorModeToggleRequest,
    setDesignSystemInspectorModeToggleRequest,
  ] = useState(0);
  const initialActiveView = getInitialAppView(initialSettingsSection);
  const [activeView, setActiveView] = useState<AppView>(initialActiveView);
  const capabilities = useProfileCapabilities();
  const isAutomationsFeatureEnabled = capabilities.automations;
  const isBuilderbotSurfaceEnabled = capabilities.builderbot;
  const isFeedbackEnabled = capabilities.feedback;
  const sessionWindowSupport = useSessionWindowSupport();
  const isMultiWindowEnabled = sessionWindowSupport.supported;
  const stopVoiceConversation = useVoiceConversationStore(
    (state) => state.stop,
  );
  const requestVoiceConversationStart = useVoiceConversationStore(
    (state) => state.requestStart,
  );
  const globalPocketVoiceSetup = usePocketVoiceSetup(
    capabilities.voiceConversation,
  );
  const globalMacSpeechSetup = useMacSpeechSetup(
    capabilities.voiceConversation,
  );
  const globalVoiceInput = useVoiceInputPreference(
    isMacSpeechAvailable(
      globalMacSpeechSetup.status,
      globalMacSpeechSetup.loading,
    ),
  );
  const globalVoiceOutput = useVoiceOutputPreference();
  const globalOpenAiVoiceSetup = useOpenAiVoiceSetup(
    capabilities.voiceConversation &&
      (globalVoiceInput.backend === "openai" ||
        globalVoiceOutput.backend === "openai"),
  );
  const globalSiriVoiceSetup = useSiriVoiceSetup(
    capabilities.voiceConversation && globalVoiceOutput.backend === "siri",
  );
  const globalVoiceReady = isVoiceSetupReady(
    globalPocketVoiceSetup.status,
    globalMacSpeechSetup.status,
    globalSiriVoiceSetup.status,
    globalVoiceInput.backend,
    globalVoiceOutput.backend,
    globalOpenAiVoiceSetup.status,
  );
  const voiceConversationWasEnabledRef = useRef(capabilities.voiceConversation);
  useEffect(() => {
    const wasEnabled = voiceConversationWasEnabledRef.current;
    voiceConversationWasEnabledRef.current = capabilities.voiceConversation;
    if (
      !shouldStopVoiceConversationOnExperimentChange({
        wasEnabled,
        isEnabled: capabilities.voiceConversation,
      })
    ) {
      return;
    }
    // The native process survives renderer reloads and may be owned by another
    // window, so an explicit on-to-off transition must clean up active use.
    // Mounting with the experiment already off performs no Voice native work.
    void stopVoiceConversation().catch(() => undefined);
  }, [capabilities.voiceConversation, stopVoiceConversation]);
  const sessions = useChatSessionStore(selectSessions);
  const activeSessionId = useChatSessionStore(selectActiveSessionId);
  useLayoutEffect(() => {
    const foregroundSessionId = activeView === "chat" ? activeSessionId : null;
    void setVoiceConversationForegroundSession(foregroundSessionId).catch(
      (error) => {
        console.warn("Failed to publish the foreground voice session", error);
      },
    );
  }, [activeSessionId, activeView]);
  const messagesBySession = useChatStore((state) => state.messagesBySession);
  const previousActiveSessionIdRef = useRef(activeSessionId);
  useEffect(() => {
    const previousSessionId = previousActiveSessionIdRef.current;
    previousActiveSessionIdRef.current = activeSessionId;
    const voice = useVoiceConversationStore.getState();
    if (
      previousSessionId !== null &&
      previousSessionId !== activeSessionId &&
      voice.requestedStartSessionId === previousSessionId
    ) {
      voice.clearRequestedStart(previousSessionId);
    }
  }, [activeSessionId]);
  const sidebarIsResizing = isResizing;
  const sidebarDockedPanelOuterWidth = sidebarPanelOuterWidth;
  const sidebarDockedOuterWidth = sidebarCollapsed ? 0 : sidebarPanelOuterWidth;
  const [skillsSkillId, setSkillsSkillId] = useState<string | null>(null);
  const [agentsPersonaId, setAgentsPersonaId] = useState<string | null>(null);
  const [globalComposerFocusRequest, setGlobalComposerFocusRequest] =
    useState(0);
  const onboardingState = useOnboardingState();
  const omittedStarterTaskIds = useMemo<ReadonlySet<StarterTaskId>>(
    () =>
      omittedStarterTasksAfterFirstRun({
        onboardingCompleted: onboardingState.lifecycle === "completed",
        providerHandled: onboardingState.completedHarnessSetupIds.length > 0,
      }),
    [
      onboardingState.completedHarnessSetupIds.length,
      onboardingState.lifecycle,
    ],
  );
  const starterTasksExperimentEnabled =
    useExperiment(STARTER_TASKS_EXPERIMENT_ID)?.enabled === true;
  const [starterTasksEligible, setStarterTasksEligible] = useState(() =>
    shouldShowAssistiveMoment("home.starterTasks"),
  );
  const starterTasksVisible =
    starterTasksExperimentEnabled && starterTasksEligible;
  const [starterTasksDocked, setStarterTasksDocked] = useState(false);
  const [selectedStarterTaskId, setSelectedStarterTaskId] =
    useState<StarterTaskId | null>(null);
  const [starterProjectId, setStarterProjectId] = useState<string | null>(null);
  const [starterProjectStickyExiting, setStarterProjectStickyExiting] =
    useState(false);
  const starterProjectStickyExitTimerRef = useRef<number | null>(null);
  const starterTasksLeftHomeRef = useRef(false);
  useEffect(
    () => () => {
      if (starterProjectStickyExitTimerRef.current !== null) {
        window.clearTimeout(starterProjectStickyExitTimerRef.current);
      }
    },
    [],
  );
  const initialStarterTaskProgressRef = useRef(loadStarterTaskProgress());
  const [starterTaskOverrides, setStarterTaskOverrides] =
    useState<StarterTaskCompletionState>(
      initialStarterTaskProgressRef.current.completion,
    );
  const [starterTasksAwaitingCompletion, setStarterTasksAwaitingCompletion] =
    useState<Set<StarterTaskId>>(
      initialStarterTaskProgressRef.current.awaiting,
    );

  useEffect(() => {
    if (starterTasksVisible) {
      recordAssistiveMomentShown("home.starterTasks");
    }
  }, [starterTasksVisible]);

  useEffect(() => {
    const reset = () => {
      clearStarterTaskProgress();
      setStarterTaskOverrides({ ...EMPTY_STARTER_TASK_COMPLETION });
      setStarterTasksAwaitingCompletion(new Set());
      setStarterTasksDocked(false);
      setStarterProjectId(null);
      setStarterTasksEligible(true);
    };
    const synchronize = (event: StorageEvent) => {
      if (
        event.key !== STARTER_TASK_PROGRESS_STORAGE_KEY &&
        event.key !== null
      ) {
        return;
      }
      const progress = loadStarterTaskProgress();
      setStarterTaskOverrides(progress.completion);
      setStarterTasksAwaitingCompletion(progress.awaiting);
    };
    window.addEventListener("starter-tasks-reset", reset);
    window.addEventListener("starter-tasks-state-reset", reset);
    window.addEventListener("storage", synchronize);
    return () => {
      window.removeEventListener("starter-tasks-reset", reset);
      window.removeEventListener("starter-tasks-state-reset", reset);
      window.removeEventListener("storage", synchronize);
    };
  }, []);
  const [globalComposerPlacement, setGlobalComposerPlacement] =
    useState<GlobalComposerPlacement>("docked");
  const [globalComposerStarterRequest, setGlobalComposerStarterRequest] =
    useState<GlobalComposerStarterRequest | null>(null);
  const [retainGlobalComposerDraft, setRetainGlobalComposerDraft] =
    useState(false);
  const globalComposerStarterRequestIdRef = useRef(0);
  const [chatComposerHandoffRequest, setChatComposerHandoffRequest] =
    useState(0);
  const [chatComposerHandoffSessionId, setChatComposerHandoffSessionId] =
    useState<string | null>(null);
  const [globalComposerHandoffSourceRect, setGlobalComposerHandoffSourceRect] =
    useState<GlobalComposerHandoffRect | null>(null);
  const [globalComposerHandoffTargetRect, setGlobalComposerHandoffTargetRect] =
    useState<GlobalComposerHandoffRect | null>(null);
  const globalComposerHandoffTimeoutRef = useRef<number | null>(null);
  const globalComposerRouteSwapTimeoutRef = useRef<number | null>(null);
  const [automationsRoute, setAutomationsRoute] =
    useState<AutomationNavigationRoute>({ surface: "overview" });
  const [builderbotRoute, setBuilderbotRoute] =
    useState<BuilderbotNavigationRoute>({ surface: "overview" });
  const [skillsBreadcrumbLabel, setSkillsBreadcrumbLabel] = useState<
    string | null
  >(null);
  const [agentsBreadcrumbLabel, setAgentsBreadcrumbLabel] = useState<
    string | null
  >(null);
  const [automationsBreadcrumbLabel, setAutomationsBreadcrumbLabel] = useState<
    string | null
  >(null);
  const [builderbotBreadcrumbLabel, setBuilderbotBreadcrumbLabel] = useState<
    string | null
  >(null);
  const [
    agentBuilderSettingsReturnTarget,
    setAgentBuilderSettingsReturnTarget,
  ] = useState<AgentBuilderProviderSetupReturnTarget | null>(null);
  const [voiceSettingsReturnTarget, setVoiceSettingsReturnTarget] =
    useState<VoiceSetupReturnTarget | null>(null);
  const voiceSettingsReturnTargetRef = useRef(voiceSettingsReturnTarget);
  voiceSettingsReturnTargetRef.current = voiceSettingsReturnTarget;
  const [homeSessionId, setHomeSessionId] = useState<string | null>(() =>
    loadStoredHomeSessionId(),
  );
  const [globalComposerExecutionTarget, setGlobalComposerExecutionTarget] =
    useState<SessionExecutionTarget | null | undefined>(undefined);
  const globalComposerExecutionTargetRef = useRef(
    globalComposerExecutionTarget,
  );
  globalComposerExecutionTargetRef.current = globalComposerExecutionTarget;
  const replaceNextNavigationEntryRef = useRef(false);
  const navigationHistoryRef = useRef<AppNavigationHistory>({
    entries: [
      getAppNavigationLocation(
        initialActiveView,
        null,
        initialSettingsSection ?? DEFAULT_SETTINGS_SECTION,
        null,
        null,
        { surface: "overview" },
        { surface: "overview" },
        DEFAULT_DESIGN_SYSTEM_SECTION,
      ),
    ],
    index: 0,
    isApplying: false,
  });
  const [navigationAvailability, setNavigationAvailability] = useState({
    canGoBack: false,
    canGoForward: false,
  });
  const closeAgentBuilderSessionRef = useRef<
    (sessionId: string) => void | Promise<void>
  >(() => {});
  const navigateAgentBuilderChatRef = useRef<
    (sessionId: string) => void | Promise<void>
  >(() => {});
  const automationBuilderLeaveActionRef =
    useRef<AutomationBuilderLeaveAction | null>(null);
  const pendingAutomationNavigationRef = useRef<{
    next: () => void;
    onCancel?: () => void;
  } | null>(null);
  const [
    automationBuilderHasUnsavedChanges,
    setAutomationBuilderHasUnsavedChanges,
  ] = useState(false);
  const [automationLeavePromptOpen, setAutomationLeavePromptOpen] =
    useState(false);
  const [automationLeaveSaving, setAutomationLeaveSaving] = useState(false);
  const {
    workspaceNameRequest: pendingWorkspaceName,
    enqueueWorkspaceNameRequest,
    cancelWorkspaceNameRequest,
    submitWorkspaceNameRequest,
  } = useWorkspaceNameRequestQueue();
  const workspaceRepository = useWorkspaceRepository();

  const homeSessionMessages = useChatStore((s) =>
    homeSessionId ? s.messagesBySession[homeSessionId] : undefined,
  );
  const setChatActiveSession = useChatStore((s) => s.setActiveSession);
  const setChatActiveSessionViewing = useChatStore(
    (s) => s.setActiveSessionViewing,
  );
  const promoteChatSessionId = useChatStore((s) => s.promoteSessionId);
  const cleanupChatSession = useChatStore((s) => s.cleanupSession);
  const isRightRailOpen = useChatSessionStore((s) => s.isRightRailOpen);
  const activeProjectTint = useActiveProjectTint();
  const hasHydratedSessions = useChatSessionStore(selectHasHydratedSessions);
  const sessionsLoading = useChatSessionStore(selectSessionsLoading);
  const activeSessionWindowLabel = useSessionWindowStore((s) =>
    isMultiWindowEnabled && activeSessionId
      ? s.openSessions[activeSessionId]
      : undefined,
  );
  const activeSessionInHandoff = useSessionWindowStore((s) =>
    isMultiWindowEnabled && activeSessionId
      ? s.isInHandoff(activeSessionId)
      : false,
  );
  const createSession = useChatSessionStore((s) => s.createSession);
  const createDraftSession = useChatSessionStore((s) => s.createDraftSession);
  const promoteDraftSession = useChatSessionStore((s) => s.promoteDraftSession);
  const markSessionCreationFailed = useChatSessionStore(
    (s) => s.markSessionCreationFailed,
  );
  const resetSessionCreation = useChatSessionStore(
    (s) => s.resetSessionCreation,
  );
  const patchSession = useChatSessionStore((s) => s.patchSession);
  const setActiveSession = useChatSessionStore((s) => s.setActiveSession);
  const handleNavigateToSession = useCallback(
    (sessionId: string) => {
      setActiveSession(sessionId);
      setChatActiveSession(sessionId);
      setActiveView("chat");
      useChatStore.getState().markSessionRead(sessionId);
    },
    [setActiveSession, setChatActiveSession],
  );

  useCompletionNotifications(handleNavigateToSession);

  useEffect(() => {
    let didCancel = false;
    let unlisten: (() => void) | null = null;

    listenSessionDeepLinkErrors(({ message }) => {
      toast.error(message);
    })
      .then((cleanup) => {
        if (didCancel) {
          cleanup();
        } else {
          unlisten = cleanup;
        }
      })
      .catch((error) => {
        console.error("Failed to listen for session deep link errors:", error);
      });

    return () => {
      didCancel = true;
      unlisten?.();
    };
  }, []);
  const setRightRailOpen = useChatSessionStore((s) => s.setRightRailOpen);
  const { selectedProvider } = useProviderSelection();
  const ensureNewSessionTarget = useNewSessionTarget();
  const resolveSessionCreationTarget = useCallback(
    async (
      options: Pick<ProjectChatDraftOptions, "executionTarget">,
    ): Promise<SessionExecutionTarget | undefined> => {
      const requestedTarget = options.executionTarget;
      const requestedSelection = requestedTarget
        ? gooseServeSelectionFromExecutionTarget(requestedTarget)
        : undefined;
      const resolution = await ensureNewSessionTarget(
        requestedTarget
          ? {
              providerId:
                requestedSelection?.providerId ?? requestedTarget.harnessId,
              modelId: requestedSelection?.modelId,
            }
          : {},
      );
      if (resolution.status !== "ready") {
        return undefined;
      }
      if (requestedTarget) {
        return executionTargetFromModelPreference(
          requestedTarget.harnessId,
          resolution,
        );
      }

      const modelPreference = await resolveSupportedSessionModelPreference(
        resolution.providerId,
        resolution.modelId,
      );
      return executionTargetFromModelPreference(
        resolution.providerId,
        modelPreference,
      );
    },
    [ensureNewSessionTarget],
  );
  const { readyAgentIds } = useAgentProviderStatus();
  const defaultProviderReadinessStatus = useDefaultProviderReadinessStore(
    (state) => state.readiness?.status,
  );
  const providerSetupRequiredForHome =
    getBuildFeatureState().byoKeyProviders &&
    defaultProviderReadinessStatus === "needs_setup" &&
    ![...readyAgentIds].some((providerId) => providerId !== "goose");
  const selectedProviderRef = useRef(selectedProvider);
  selectedProviderRef.current = selectedProvider;
  const projects = useProjectStore(selectProjects);
  const hasFetchedProjects = useProjectStore(
    (state) => state.hasFetchedProjects,
  );
  const fetchProjects = useProjectStore((s) => s.fetchProjects);
  const reorderProjects = useProjectStore((s) => s.reorderProjects);
  const retryFailedSessionsForProjectRef = useRef<
    (project: ProjectInfo) => void
  >(() => {});
  const [projectCreatedRevision, setProjectCreatedRevision] = useState(0);
  const startChatForCreatedProjectRef = useRef<(project: ProjectInfo) => void>(
    () => {},
  );
  const refreshProjectsAfterDialogSave = useCallback(
    (savedProject: ProjectInfo) => {
      useProjectStore
        .getState()
        .replaceProjectsFromBackend(
          useProjectStore
            .getState()
            .projects.some((project) => project.id === savedProject.id)
            ? useProjectStore
                .getState()
                .projects.map((project) =>
                  project.id === savedProject.id ? savedProject : project,
                )
            : [...useProjectStore.getState().projects, savedProject],
        );
      retryFailedSessionsForProjectRef.current(savedProject);
    },
    [],
  );

  const {
    closeCreateProjectDialog,
    createProjectInitialWorkingDir,
    createProjectOpen,
    editingProject,
    handleProjectCreated,
    openCreateProjectDialog,
    openEditProjectDialog,
  } = useProjectDialog({
    onProjectSaved: refreshProjectsAfterDialogSave,
    onProjectCreated: (project) => {
      setProjectCreatedRevision((revision) => revision + 1);
      startChatForCreatedProjectRef.current(project);
    },
  });
  useEffect(() => {
    if (!createProjectOpen || selectedStarterTaskId !== "create-project")
      return;
    const appRoot = document.getElementById("root");
    if (!appRoot) return;
    const wasInert = appRoot.inert;
    appRoot.inert = true;
    return () => {
      appRoot.inert = wasInert;
    };
  }, [createProjectOpen, selectedStarterTaskId]);
  const startup = useAppStartup();
  const [startupLoadingMinElapsed, setStartupLoadingMinElapsed] = useState(
    () => startup.ready,
  );

  useEffect(() => {
    const timeoutId = window.setTimeout(
      () => setStartupLoadingMinElapsed(true),
      STARTUP_LOADING_MIN_DISPLAY_MS,
    );

    return () => window.clearTimeout(timeoutId);
  }, []);
  const clearGlobalComposerHandoffTimer = useCallback(() => {
    if (globalComposerHandoffTimeoutRef.current !== null) {
      window.clearTimeout(globalComposerHandoffTimeoutRef.current);
      globalComposerHandoffTimeoutRef.current = null;
    }
  }, []);

  const clearGlobalComposerRouteSwapTimer = useCallback(() => {
    if (globalComposerRouteSwapTimeoutRef.current !== null) {
      window.clearTimeout(globalComposerRouteSwapTimeoutRef.current);
      globalComposerRouteSwapTimeoutRef.current = null;
    }
  }, []);

  useEffect(() => {
    return () => {
      clearGlobalComposerHandoffTimer();
      clearGlobalComposerRouteSwapTimer();
    };
  }, [clearGlobalComposerHandoffTimer, clearGlobalComposerRouteSwapTimer]);

  const resetGlobalComposerTransition = useCallback(() => {
    clearGlobalComposerHandoffTimer();
    setGlobalComposerPlacement("docked");
    setChatComposerHandoffSessionId(null);
    setGlobalComposerHandoffSourceRect(null);
    setGlobalComposerHandoffTargetRect(null);
  }, [clearGlobalComposerHandoffTimer]);

  const finishGlobalComposerHandoff = useCallback(() => {
    resetGlobalComposerTransition();
  }, [resetGlobalComposerTransition]);

  useEffect(() => {
    if (globalComposerPlacement !== "handoff") {
      return;
    }

    if (globalComposerHandoffTimeoutRef.current !== null) {
      window.clearTimeout(globalComposerHandoffTimeoutRef.current);
      globalComposerHandoffTimeoutRef.current = null;
    }

    if (prefersReducedMotion()) {
      finishGlobalComposerHandoff();
      return;
    }

    const hasMeasuredHandoff =
      globalComposerHandoffSourceRect && globalComposerHandoffTargetRect;
    globalComposerHandoffTimeoutRef.current = window.setTimeout(
      finishGlobalComposerHandoff,
      hasMeasuredHandoff
        ? GLOBAL_COMPOSER_HANDOFF_MS
        : GLOBAL_COMPOSER_HANDOFF_MS + 500,
    );

    return () => {
      if (globalComposerHandoffTimeoutRef.current !== null) {
        window.clearTimeout(globalComposerHandoffTimeoutRef.current);
        globalComposerHandoffTimeoutRef.current = null;
      }
    };
  }, [
    finishGlobalComposerHandoff,
    globalComposerHandoffSourceRect,
    globalComposerHandoffTargetRect,
    globalComposerPlacement,
  ]);
  const startupReady = startup.ready && !startup.error;
  const migrationGate = useMigrationGate(startupReady);
  const migrationSettled =
    migrationGate.status === "ready" || migrationGate.status === "error";
  useDefaultModelGate(migrationSettled);
  useSessionWindowTracking({ enabled: isMultiWindowEnabled });
  useSessionHandoffSource({ enabled: isMultiWindowEnabled });
  const lastNonSecondaryViewRef = useRef<AppView>("home");
  const designSystemReturnViewRef = useRef<AppView>("home");
  const homeSessionRequestRef = useRef<Promise<ChatSession | null> | null>(
    null,
  );
  const hydratingPinnedSessionIdsRef = useRef<Set<string>>(new Set());
  const hydratePinnedChatSessions = useCallback(
    async (sessionIds: string[]) => {
      const uniqueSessionIds = [...new Set(sessionIds)].filter(Boolean);
      const sessionStore = useChatSessionStore.getState();
      const sessionsToLoad: string[] = [];
      for (const sessionId of uniqueSessionIds) {
        if (hydratingPinnedSessionIdsRef.current.has(sessionId)) {
          continue;
        }

        const session = sessionStore.getSession(sessionId);
        if (session?.creationState) {
          continue;
        }

        const hasMessages = hasConversationMessages(
          useChatStore.getState().messagesBySession[sessionId],
        );
        if (hasMessages) {
          continue;
        }

        sessionsToLoad.push(sessionId);
      }

      if (sessionsToLoad.length === 0) {
        return;
      }

      const pendingSessionIds: string[] = [];
      for (const sessionId of sessionsToLoad) {
        useChatSessionStore
          .getState()
          .ensurePinnedSessionPlaceholder(sessionId);
        hydratingPinnedSessionIdsRef.current.add(sessionId);
        pendingSessionIds.push(sessionId);
      }

      let nextIndex = 0;

      async function worker(): Promise<void> {
        while (nextIndex < pendingSessionIds.length) {
          const sessionId = pendingSessionIds[nextIndex];
          nextIndex += 1;
          const ok = await loadSessionMessagesAndPrepare(sessionId);
          if (!ok) {
            useChatSessionStore.getState().patchSession(sessionId, {
              pinnedLoadState: "failed",
            });
          }
          hydratingPinnedSessionIdsRef.current.delete(sessionId);
        }
      }

      await Promise.all(
        Array.from(
          {
            length: Math.min(
              PINNED_CHAT_HYDRATION_CONCURRENCY,
              pendingSessionIds.length,
            ),
          },
          () => worker(),
        ),
      );
    },
    [],
  );

  useEffect(() => {
    fetchProjects();
  }, [fetchProjects]);

  useEffect(() => {
    void prefetchProjectArtifactRenderer();
  }, []);

  useEffect(() => {
    if (
      !activeSessionId ||
      !activeSessionWindowLabel ||
      activeSessionInHandoff
    ) {
      return;
    }

    clearSettingsSectionUrl();
    setActiveView("home");
    setActiveSession(null);
  }, [
    activeSessionId,
    activeSessionInHandoff,
    activeSessionWindowLabel,
    setActiveSession,
  ]);

  useEffect(() => {
    const isViewingChat = activeView === "chat" && Boolean(activeSessionId);
    setChatActiveSessionViewing(isViewingChat);

    if (isViewingChat && activeSessionId) {
      useChatStore.getState().markSessionRead(activeSessionId);
    }
  }, [activeSessionId, activeView, setChatActiveSessionViewing]);

  useEffect(() => {
    if (activeView !== "settings" && activeView !== "design-system") {
      lastNonSecondaryViewRef.current = activeView;
    }
  }, [activeView]);

  useEffect(() => {
    if (activeView === "home") {
      return;
    }
    void prefetchProjectArtifactRenderer();
  }, [activeView]);

  useEffect(() => {
    if (activeView === "builderbot" && !isBuilderbotSurfaceEnabled) {
      setActiveView("home");
    }
    if (activeView === "automations" && !isAutomationsFeatureEnabled) {
      setActiveView("home");
    }
  }, [activeView, isAutomationsFeatureEnabled, isBuilderbotSurfaceEnabled]);

  useEffect(() => {
    const enabledSection = resolveEnabledSettingsSection(
      activeSettingsSection,
      capabilities,
    );
    if (enabledSection === activeSettingsSection) {
      return;
    }
    setActiveSettingsSection(enabledSection);
    if (activeView === "settings") {
      setSettingsSectionUrl(enabledSection);
    }
  }, [activeSettingsSection, activeView, capabilities]);

  useEffect(() => {
    if (activeView !== "settings") {
      setAgentBuilderSettingsReturnTarget(null);
    }
  }, [activeView]);

  const activeSession = activeSessionId
    ? sessions.find((session) => session.id === activeSessionId)
    : undefined;
  const homeSession = homeSessionId
    ? sessions.find((session) => session.id === homeSessionId)
    : undefined;
  const hasHomeSession = homeSession != null;
  const currentGlobalComposerExecutionTarget =
    globalComposerExecutionTarget === undefined
      ? homeSession
        ? (homeSession.executionTarget ?? null)
        : undefined
      : globalComposerExecutionTarget;
  const currentGlobalComposerExecutionTargetRef = useRef(
    currentGlobalComposerExecutionTarget,
  );
  currentGlobalComposerExecutionTargetRef.current =
    currentGlobalComposerExecutionTarget;
  const targetLocation = useMemo(
    () =>
      getAppNavigationLocation(
        activeView,
        activeSessionId,
        activeSettingsSection,
        skillsSkillId,
        agentsPersonaId,
        automationsRoute,
        builderbotRoute,
        activeDesignSystemSection,
      ),
    [
      activeDesignSystemSection,
      activeSessionId,
      activeSettingsSection,
      activeView,
      agentsPersonaId,
      automationsRoute,
      builderbotRoute,
      skillsSkillId,
    ],
  );
  const { renderedLocation, isPreparingContent } =
    useStagedAppContentLocation(targetLocation);
  const renderedSession =
    renderedLocation.view === "chat" && renderedLocation.sessionId
      ? sessions.find((session) => session.id === renderedLocation.sessionId)
      : undefined;
  const isContextVisible = isContextPanelVisible(
    activeSession,
    isRightRailOpen,
  );
  const rightRailLabel = isContextVisible
    ? t("rightRail.close")
    : t("rightRail.open");

  useEffect(() => {
    perfLog(
      `[perf:nav] target selected location=${JSON.stringify(targetLocation)}`,
    );
  }, [targetLocation]);

  useLayoutEffect(() => {
    setTerminalRenderingSuspended(isPreparingContent);
    return () => {
      setTerminalRenderingSuspended(false);
    };
  }, [isPreparingContent]);

  const updateNavigationAvailability = useCallback(() => {
    const history = navigationHistoryRef.current;
    const nextAvailability = {
      canGoBack: history.index > 0,
      canGoForward: history.index < history.entries.length - 1,
    };

    setNavigationAvailability((current) =>
      current.canGoBack === nextAvailability.canGoBack &&
      current.canGoForward === nextAvailability.canGoForward
        ? current
        : nextAvailability,
    );
  }, []);

  const replaceNavigationSessionId = useCallback(
    (fromSessionId: string, toSessionId: string) => {
      const history = navigationHistoryRef.current;
      history.entries = history.entries.map((entry) =>
        entry.view === "chat" && entry.sessionId === fromSessionId
          ? { ...entry, sessionId: toSessionId }
          : entry,
      );
      updateNavigationAvailability();
    },
    [updateNavigationAvailability],
  );

  useEffect(() => {
    const history = navigationHistoryRef.current;
    const location = targetLocation;
    const currentLocation = history.entries[history.index];

    if (history.isApplying) {
      history.isApplying = false;
      if (!areAppNavigationLocationsEqual(currentLocation, location)) {
        history.entries[history.index] = location;
      }
      updateNavigationAvailability();
      return;
    }

    if (replaceNextNavigationEntryRef.current) {
      replaceNextNavigationEntryRef.current = false;
      history.entries[history.index] = location;
      updateNavigationAvailability();
      return;
    }

    if (areAppNavigationLocationsEqual(currentLocation, location)) {
      updateNavigationAvailability();
      return;
    }

    let nextEntries = history.entries.slice(0, history.index + 1);
    nextEntries.push(location);
    if (nextEntries.length > APP_NAVIGATION_HISTORY_LIMIT) {
      nextEntries = nextEntries.slice(
        nextEntries.length - APP_NAVIGATION_HISTORY_LIMIT,
      );
    }

    history.entries = nextEntries;
    history.index = nextEntries.length - 1;
    updateNavigationAvailability();
  }, [targetLocation, updateNavigationAvailability]);

  useHomeSessionStateSync({
    homeSessionId,
    homeSession,
    homeSessionMessages,
    hasHydratedSessions,
    isLoading: sessionsLoading,
    setHomeSessionId,
  });

  const ensureHomeSession = useCallback(async () => {
    if (!hasHydratedSessions || sessionsLoading) {
      return undefined;
    }

    if (homeSessionRequestRef.current) {
      return homeSessionRequestRef.current;
    }

    const request = (async () => {
      const currentProvider = () => selectedProviderRef.current ?? "goose";

      if (
        homeSession &&
        !homeSession.archivedAt &&
        homeSession.messageCount === 0
      ) {
        const project = homeSession.projectId
          ? (projects.find(
              (candidate) => candidate.id === homeSession.projectId,
            ) ?? null)
          : null;
        const workingDir = await resolveSessionCwd(project);
        const readLiveHomeSession = () =>
          useChatSessionStore.getState().getSession(homeSession.id) ??
          homeSession;
        const liveHomeSession = readLiveHomeSession();
        const bootstrapTarget = liveHomeSession.executionTarget;
        const uiOwnsBootstrapTarget =
          liveHomeSession.executionTargetSource === "ui";
        if (uiOwnsBootstrapTarget && !bootstrapTarget) {
          return liveHomeSession;
        }
        // UI ownership preserves provider-only targets and explicit clears as
        // well as full model selections. ACP model snapshots are also stable
        // bootstrap targets; neither path may be re-seeded from preferences.
        if (
          bootstrapTarget &&
          (uiOwnsBootstrapTarget || isModelExecutionTarget(bootstrapTarget))
        ) {
          const bootstrapSelection =
            gooseServeSelectionFromExecutionTarget(bootstrapTarget);
          const target = await ensureNewSessionTarget(
            {
              providerId:
                bootstrapSelection.providerId ?? bootstrapTarget.harnessId,
              modelId: bootstrapSelection.modelId,
            },
            { onUnavailable: "silent" },
          );
          if (target.status !== "ready") return liveHomeSession;
          if (
            !sameSessionExecutionTarget(
              readLiveHomeSession().executionTarget,
              bootstrapTarget,
            )
          ) {
            return readLiveHomeSession();
          }
          const validatedBootstrapTarget = executionTargetFromModelPreference(
            bootstrapTarget.harnessId,
            target,
          );
          const result = await transitionSessionTarget({
            sessionId: homeSession.id,
            target: validatedBootstrapTarget,
            workingDir,
            requireReasoningEffort: !liveHomeSession.reasoningEffort,
          });
          if (!result.applied) {
            return liveHomeSession;
          }
          if (
            !sameSessionExecutionTarget(
              readLiveHomeSession().executionTarget,
              bootstrapTarget,
            )
          ) {
            return readLiveHomeSession();
          }
          return readLiveHomeSession();
        }

        const harnessAtStart = currentProvider();
        const sessionModelPreference =
          await resolveSupportedSessionModelPreference(harnessAtStart);
        const resolvedHarnessId = currentProvider();
        const targetToApply =
          resolvedHarnessId === harnessAtStart
            ? executionTargetFromModelPreference(
                resolvedHarnessId,
                sessionModelPreference,
              )
            : normalizeSessionExecutionTarget({
                harnessId: resolvedHarnessId,
              });
        if (
          sameSessionExecutionTarget(
            liveHomeSession.executionTarget,
            targetToApply,
          ) &&
          liveHomeSession.workingDir === workingDir &&
          !targetToApply.modelProviderId
        ) {
          return liveHomeSession;
        }
        const targetSelection =
          gooseServeSelectionFromExecutionTarget(targetToApply);
        const target = await ensureNewSessionTarget(
          {
            providerId: targetSelection.providerId ?? targetToApply.harnessId,
            modelId: targetSelection.modelId,
          },
          { onUnavailable: "silent" },
        );
        if (target.status !== "ready") return liveHomeSession;
        if (
          !sameSessionExecutionTarget(
            readLiveHomeSession().executionTarget,
            bootstrapTarget,
          )
        ) {
          return readLiveHomeSession();
        }
        const validatedTargetToApply = executionTargetFromModelPreference(
          targetToApply.harnessId,
          target,
        );
        const requestId = createModelSelectionRequestId();
        beginModelSelectionIntent(homeSession.id, {
          requestId,
          target: validatedTargetToApply,
          previousTarget: bootstrapTarget,
        });

        try {
          const result = await transitionSessionTarget({
            sessionId: homeSession.id,
            target: validatedTargetToApply,
            workingDir,
            requireReasoningEffort: !liveHomeSession.reasoningEffort,
            requestId,
          });
          const intentStillMatches = clearCurrentModelSelectionIntent(
            homeSession.id,
            requestId,
          );
          if (!result.applied || !intentStillMatches) {
            return readLiveHomeSession();
          }
          return readLiveHomeSession();
        } catch (error) {
          if (clearCurrentModelSelectionIntent(homeSession.id, requestId)) {
            replaceSessionTargetAfterDispatch(homeSession.id, bootstrapTarget);
          }
          throw error;
        }
      }

      const composerTargetAtStart = globalComposerExecutionTargetRef.current;
      const workingDir = await resolveSessionCwd(null);
      const harnessId = currentProvider();
      const sessionModelPreference =
        await resolveSupportedSessionModelPreference(harnessId);
      const executionTarget = executionTargetFromModelPreference(
        harnessId,
        sessionModelPreference,
      );
      const executionSelection =
        gooseServeSelectionFromExecutionTarget(executionTarget);
      const target = await ensureNewSessionTarget(
        {
          providerId:
            executionSelection.providerId ?? executionTarget.harnessId,
          modelId: executionSelection.modelId,
        },
        { onUnavailable: "silent" },
      );
      if (target.status !== "ready") return null;
      const finalComposerTarget = globalComposerExecutionTargetRef.current;
      const resolvedExecutionTarget =
        finalComposerTarget !== composerTargetAtStart
          ? (finalComposerTarget ??
            normalizeSessionExecutionTarget({ harnessId: currentProvider() }))
          : executionTargetFromModelPreference(
              executionTarget.harnessId,
              target,
            );
      const session = await createSession({
        title: DEFAULT_CHAT_TITLE,
        executionTarget: resolvedExecutionTarget,
        workingDir,
      });
      setHomeSessionId(session.id);
      return session;
    })();

    homeSessionRequestRef.current = request;
    try {
      return await request;
    } finally {
      if (homeSessionRequestRef.current === request) {
        homeSessionRequestRef.current = null;
      }
    }
  }, [
    createSession,
    hasHydratedSessions,
    homeSession,
    projects,
    sessionsLoading,
    ensureNewSessionTarget,
  ]);

  useEffect(() => {
    if (
      activeView !== "home" ||
      !migrationSettled ||
      providerSetupRequiredForHome
    ) {
      return;
    }
    void ensureHomeSession().catch((error) => {
      console.error("Failed to ensure Home session:", error);
    });
  }, [
    activeView,
    ensureHomeSession,
    migrationSettled,
    providerSetupRequiredForHome,
  ]);

  const startDraftSessionCreation = useCallback(
    ({
      session,
      sessionExecutionTarget,
      workingDir,
      projectId,
      onReady,
      onCreationFailed,
    }: {
      session: ChatSession;
      sessionExecutionTarget: SessionExecutionTarget;
      workingDir: MaybePromise<string>;
      projectId?: string;
      onReady?: (result: DraftSessionCreationReady) => Promise<void> | void;
      onCreationFailed?: (error: unknown) => Promise<void> | void;
    }) => {
      let hasHandledCreationFailure = false;
      let createdBackendSessionId: string | null = null;
      const resolveDraftTarget = (
        draft: ChatSession | undefined,
        fallback: SessionExecutionTarget,
      ): SessionExecutionTarget => {
        if (draft?.executionTarget) return draft.executionTarget;
        if (draft?.executionTargetSource === "ui") {
          throw new Error(
            "Select a model before creating this unresolved session.",
          );
        }
        return fallback;
      };
      const handleCreationFailure = async (
        error: unknown,
      ): Promise<unknown | null> => {
        if (!onCreationFailed || hasHandledCreationFailure) {
          return null;
        }
        hasHandledCreationFailure = true;
        try {
          await onCreationFailed(error);
          return null;
        } catch (cleanupError) {
          console.error(
            "Failed to clean up project workspace startup after session creation failure:",
            cleanupError,
          );
          return cleanupError;
        }
      };
      const appendCleanupFailure = (
        message: string,
        cleanupError: unknown | null,
      ): string => {
        if (!cleanupError) {
          return message;
        }
        const cleanupMessage =
          cleanupError instanceof Error
            ? cleanupError.message
            : String(cleanupError);
        return `${message} Workspace cleanup also failed: ${cleanupMessage}`;
      };
      void Promise.resolve(workingDir)
        .then(async (resolvedWorkingDir) => {
          const liveDraft = useChatSessionStore
            .getState()
            .getSession(session.id);
          const requestedTarget = resolveDraftTarget(
            liveDraft,
            sessionExecutionTarget,
          );
          const creationSelection =
            gooseServeSelectionFromExecutionTarget(requestedTarget);
          return acpCreateSession(
            creationSelection.providerId ?? requestedTarget.harnessId,
            resolvedWorkingDir,
            {
              projectId,
              modelId: requestedTarget.modelId,
              // The draft is already interactive. Construct its provider now so
              // a selection made while creation is in flight can be applied to
              // the backend session as soon as it exists.
              deferProviderSetup: false,
            },
          ).then(({ sessionId, configOptionsSnapshot }) => {
            createdBackendSessionId = sessionId;
            return {
              sessionId,
              configOptionsSnapshot,
              sessionExecutionTarget: requestedTarget,
              workingDir: resolvedWorkingDir,
            };
          });
        })
        .then(
          async ({
            sessionId,
            configOptionsSnapshot,
            sessionExecutionTarget,
            workingDir,
          }) => {
            const sessionStore = useChatSessionStore.getState();
            const latestSession = sessionStore.getSession(session.id);
            if (!latestSession || latestSession.archivedAt) {
              await handleCreationFailure(
                new Error(
                  "Draft session disappeared before session creation completed.",
                ),
              );
              return;
            }
            let appliedTarget = sessionExecutionTarget;
            let resolvedConfigOptionsSnapshot = configOptionsSnapshot;
            const reconcileLatestDraftSelection = async () => {
              while (true) {
                const liveDraft = useChatSessionStore
                  .getState()
                  .getSession(session.id);
                const latestTarget = resolveDraftTarget(
                  liveDraft,
                  appliedTarget,
                );
                if (sameSessionExecutionTarget(latestTarget, appliedTarget)) {
                  return latestTarget;
                }
                const result = await transitionSessionTarget({
                  sessionId,
                  target: latestTarget,
                  workingDir,
                });
                if (!result.applied) {
                  throw new Error(
                    "Draft session selection was superseded during creation.",
                  );
                }
                const effectiveTarget = result.resolvedTarget ?? latestTarget;
                resolvedConfigOptionsSnapshot =
                  result.configOptionsSnapshot ?? resolvedConfigOptionsSnapshot;
                if (
                  result.resolvedTarget &&
                  !sameSessionExecutionTarget(
                    result.resolvedTarget,
                    latestTarget,
                  )
                ) {
                  const liveDraftAfterRepair = useChatSessionStore
                    .getState()
                    .getSession(session.id);
                  if (
                    sameSessionExecutionTarget(
                      liveDraftAfterRepair?.executionTarget,
                      latestTarget,
                    )
                  ) {
                    replaceSessionTargetAfterDispatch(
                      session.id,
                      result.resolvedTarget,
                    );
                  }
                }
                appliedTarget = effectiveTarget;
              }
            };

            await reconcileLatestDraftSelection();
            if (onReady) {
              await onReady({
                backendSessionId: sessionId,
                configOptionsSnapshot: resolvedConfigOptionsSnapshot,
              });
              const pendingReasoningEffort = useChatSessionStore
                .getState()
                .getSession(session.id)?.reasoningEffort;
              if (pendingReasoningEffort) {
                resolvedConfigOptionsSnapshot = {
                  ...resolvedConfigOptionsSnapshot,
                  reasoningEffort: pendingReasoningEffort,
                };
              }
            }
            const latestTarget = await reconcileLatestDraftSelection();
            const promotedTarget =
              !latestTarget.modelId && resolvedConfigOptionsSnapshot?.model
                ? (materializeSessionExecutionModel(
                    latestTarget,
                    resolvedConfigOptionsSnapshot.model,
                  ) ?? latestTarget)
                : latestTarget;

            const sessionStoreAfterReady = useChatSessionStore.getState();
            const latestSessionAfterReady = sessionStoreAfterReady.getSession(
              session.id,
            );
            if (
              !latestSessionAfterReady ||
              latestSessionAfterReady.archivedAt
            ) {
              await handleCreationFailure(
                new Error(
                  "Draft session disappeared before session creation completed.",
                ),
              );
              return;
            }
            const latestSessionPatch = {
              intent: latestSessionAfterReady.intent,
              agentBuilderOpen: latestSessionAfterReady.agentBuilderOpen,
              agentBuilderContextState:
                latestSessionAfterReady.agentBuilderContextState,
              targetAgentPath: latestSessionAfterReady.targetAgentPath,
              targetAgentSlug: latestSessionAfterReady.targetAgentSlug,
              targetAgentDraftState:
                latestSessionAfterReady.targetAgentDraftState,
              targetAgentDraftSaved:
                latestSessionAfterReady.targetAgentDraftSaved,
              updatedAt: latestSessionAfterReady.updatedAt,
            };
            const shouldRemainActive =
              sessionStoreAfterReady.activeSessionId === session.id;
            const pendingSelectionIntent = getModelSelectionIntent(session.id);
            if (
              pendingSelectionIntent &&
              isModelExecutionTarget(pendingSelectionIntent.target) &&
              pendingSelectionIntent.preferenceAgentId
            ) {
              setStoredModelPreference(
                pendingSelectionIntent.preferenceAgentId,
                {
                  modelId: pendingSelectionIntent.target.modelId,
                  modelName: pendingSelectionIntent.target.modelName,
                  providerId: pendingSelectionIntent.target.modelProviderId,
                },
              );
              clearCurrentModelSelectionIntent(
                session.id,
                pendingSelectionIntent.requestId,
              );
            }
            promoteChatSessionId(session.id, sessionId);
            transferSessionTargetOwnership(session.id, sessionId);
            promoteDraftSession(session.id, sessionId, {
              executionTarget: promotedTarget,
              workingDir: latestSessionAfterReady.workingDir ?? workingDir,
              workspaceAttachments:
                latestSessionAfterReady.workspaceAttachments,
              activeWorkspaceId: latestSessionAfterReady.activeWorkspaceId,
              ...latestSessionPatch,
              ...(resolvedConfigOptionsSnapshot?.reasoningEffort
                ? {
                    reasoningEffort:
                      resolvedConfigOptionsSnapshot.reasoningEffort,
                  }
                : {}),
            });
            useHomeWidgetStore
              .getState()
              .replaceChatPinSessionId(session.id, sessionId);
            replaceNavigationSessionId(session.id, sessionId);
            if (shouldRemainActive) {
              setActiveSession(sessionId);
              setChatActiveSession(sessionId);
            }
          },
        )
        .catch(async (error) => {
          const chatStore = useChatStore.getState();
          // A chat can fail to create while the user is somewhere else — the
          // global composer hands off in the background, and any queued head
          // stays held until creation settles. The in-transcript error would
          // then be invisible until they open the chat, so report it where
          // they are instead.
          // Being the active session is not enough to make the transcript
          // visible: opening Settings or the design system leaves
          // `activeSessionId` pointing here, so the store's viewing flag is
          // what decides whether the in-transcript error is on screen.
          const reportCreationFailureIfHidden = (message: string) => {
            if (isSessionActivelyViewed(useChatStore.getState(), session.id)) {
              return;
            }
            toast.error(t("chat:toolbar.sessionStartFailed"), {
              description: message,
            });
          };
          if (createdBackendSessionId) {
            try {
              await archiveSessionApi(createdBackendSessionId);
            } catch (archiveError) {
              console.error(
                "Failed to archive backend session after draft startup failed:",
                archiveError,
              );
            }
          }
          const cleanupError = await handleCreationFailure(error);

          // Before falling back to the opaque backend error, check whether the
          // failure is actually a missing project folder. We confirm against
          // the real filesystem rather than string-matching the error text, so
          // unrelated failures keep their generic message.
          const project = projectId
            ? useProjectStore
                .getState()
                .projects.find((candidate) => candidate.id === projectId)
            : undefined;
          if (project) {
            try {
              const missing = await findMissingProjectDirs(project);
              if (missing.length > 0) {
                const message = t(
                  missing.length === 1
                    ? "toolbar.sessionMissingProjectDir"
                    : "toolbar.sessionMissingProjectDirs",
                  { paths: missing.join(", ") },
                );
                const messageWithCleanupStatus = appendCleanupFailure(
                  message,
                  cleanupError,
                );
                markSessionCreationFailed(session.id, messageWithCleanupStatus);
                chatStore.addMessage(
                  session.id,
                  createSystemNotificationMessage(
                    messageWithCleanupStatus,
                    "error",
                    {
                      type: "editProject",
                      projectId: project.id,
                    },
                  ),
                );
                chatStore.setError(session.id, messageWithCleanupStatus);
                reportCreationFailureIfHidden(messageWithCleanupStatus);
                return;
              }
            } catch (checkError) {
              console.error(
                "Failed to check project directories after session creation failure:",
                checkError,
              );
            }
          }

          const message = formatAcpErrorMessage(
            error,
            "Failed to create session.",
          );
          const messageWithCleanupStatus = appendCleanupFailure(
            message,
            cleanupError,
          );
          markSessionCreationFailed(session.id, messageWithCleanupStatus);
          chatStore.addMessage(
            session.id,
            createSystemNotificationMessage(messageWithCleanupStatus, "error"),
          );
          chatStore.setError(session.id, messageWithCleanupStatus);
          reportCreationFailureIfHidden(messageWithCleanupStatus);
        });
    },
    [
      t,
      markSessionCreationFailed,
      promoteChatSessionId,
      promoteDraftSession,
      replaceNavigationSessionId,
      setActiveSession,
      setChatActiveSession,
    ],
  );

  // When a project is edited and saved, any of its sessions that previously
  // failed to create because their working folder was missing can be retried:
  // the draft id is still valid, and editing the project may have fixed the
  // path. We re-resolve the working dir from the *updated* project (the folder
  // is what changed), clear the stale error notification + runtime error, and
  // hand the draft back to startDraftSessionCreation. If the edit didn't
  // actually fix the folders, we skip the retry so the existing error stands.
  const retryFailedSessionsForProject = useCallback(
    (savedProject: ProjectInfo) => {
      void (async () => {
        // Reload projects so the rest of the UI reflects the saved edit.
        await fetchProjects();

        // Prefer the freshest copy from the store; fall back to the saved arg.
        const updatedProject =
          useProjectStore
            .getState()
            .projects.find((candidate) => candidate.id === savedProject.id) ??
          savedProject;

        const sessionStore = useChatSessionStore.getState();
        const failedSessions = sessionStore.sessions.filter(
          (candidate) =>
            candidate.creationState === "failed" &&
            candidate.projectId === updatedProject.id &&
            !candidate.archivedAt,
        );
        if (failedSessions.length === 0) {
          return;
        }

        // Only retry if the edit actually fixed the missing folders; otherwise
        // the same error would immediately reappear.
        try {
          const missing = await findMissingProjectDirs(updatedProject);
          if (missing.length > 0) {
            return;
          }
        } catch (error) {
          console.error(
            "Failed to re-check project directories before retrying session creation:",
            error,
          );
          return;
        }

        const chatStore = useChatStore.getState();
        for (const session of failedSessions) {
          const sessionExecutionTarget = session.executionTarget;
          if (!sessionExecutionTarget) {
            continue;
          }
          // Drop the stale missing-folder error notification so the retry
          // doesn't stack a duplicate, then clear the runtime + creation error.
          const messages = chatStore.messagesBySession[session.id] ?? [];
          for (const message of messages) {
            const isMissingFolderNotice = message.content.some(
              (content) =>
                isSystemNotification(content) &&
                content.action?.type === "editProject" &&
                content.action.projectId === updatedProject.id,
            );
            if (isMissingFolderNotice) {
              chatStore.removeMessage(session.id, message.id);
            }
          }
          chatStore.setError(session.id, null);
          resetSessionCreation(session.id);

          startDraftSessionCreation({
            session,
            sessionExecutionTarget,
            workingDir: resolveSessionCwd(updatedProject),
            projectId: updatedProject.id,
          });
        }
      })();
    },
    [fetchProjects, resetSessionCreation, startDraftSessionCreation],
  );
  retryFailedSessionsForProjectRef.current = retryFailedSessionsForProject;

  const createNewTab = useCallback(
    async (
      title = DEFAULT_CHAT_TITLE,
      project?: ProjectInfo,
      options: {
        activate?: boolean;
        reuseExistingDraft?: boolean;
        executionTarget?: SessionExecutionTarget;
        reasoningEffort?: GlobalComposeOptions["reasoningEffort"];
      } = {},
    ) => {
      const shouldActivate = options.activate !== false;
      const tStart = performance.now();
      perfLog(
        `[perf:newtab] createNewTab start (project=${project?.id ?? "none"})`,
      );
      const sessionExecutionTarget =
        await resolveSessionCreationTarget(options);
      if (!sessionExecutionTarget) return undefined;
      const sessionState = useChatSessionStore.getState();
      const chatState = useChatStore.getState();
      // New chats always start at the project default folder; worktree
      // selections in other chats are per-chat state and do not carry over.
      const existingDraft = findExistingDraft({
        sessions: sessionState.sessions,
        activeSessionId: sessionState.activeSessionId,
        draftsBySession: chatState.draftsBySession,
        messagesBySession: chatState.messagesBySession,
        sessionIdsWithTerminals: getChatSessionIdsWithTerminals(),
        request: {
          title,
          projectId: project?.id,
          executionTarget: sessionExecutionTarget,
          reasoningEffortValue: options.reasoningEffort?.value,
        },
        allowDraftReuse: options.reuseExistingDraft !== false,
      });

      if (
        existingDraft &&
        (chatState.queuedMessageBySession[existingDraft.id]?.length ?? 0) === 0
      ) {
        if (shouldActivate) {
          clearSettingsSectionUrl();
          setActiveSession(existingDraft.id);
          setActiveView("chat");
          setChatActiveSession(existingDraft.id);
        }
        perfLog(
          `[perf:newtab] ${existingDraft.id.slice(0, 8)} reused draft in ${(performance.now() - tStart).toFixed(1)}ms`,
        );
        return existingDraft;
      }

      if (!shouldActivate) {
        const workingDir = await resolveSessionCwd(project);
        const session = await createSession({
          title,
          projectId: project?.id,
          executionTarget: sessionExecutionTarget,
          workingDir,
        });
        perfLog(
          `[perf:newtab] ${session.id.slice(0, 8)} created session in ${(performance.now() - tStart).toFixed(1)}ms`,
        );
        return session;
      }

      const optimisticWorkingDir = getOptimisticSessionCwd(project);
      const session = createDraftSession({
        title,
        projectId: project?.id,
        executionTarget: sessionExecutionTarget,
        workingDir: optimisticWorkingDir,
      });
      clearSettingsSectionUrl();
      setActiveSession(session.id);
      setActiveView("chat");
      setChatActiveSession(session.id);
      perfLog(
        `[perf:newtab] ${session.id.slice(0, 8)} created draft in ${(performance.now() - tStart).toFixed(1)}ms`,
      );
      startDraftSessionCreation({
        session,
        sessionExecutionTarget,
        workingDir: resolveSessionCwd(project),
        projectId: project?.id,
        onReady: applyReasoningEffortAfterDraftCreation(
          session.id,
          options.reasoningEffort,
        ),
      });
      return session;
    },
    [
      createSession,
      createDraftSession,
      resolveSessionCreationTarget,
      setActiveSession,
      setChatActiveSession,
      startDraftSessionCreation,
    ],
  );

  const agentBuilder = useAgentBuilderCoordinator({
    startupReady: startup.ready,
    createNewTab: async (title, options) => {
      const session = await createNewTab(title, undefined, options);
      if (!session) {
        throw new Error(t("settings:providers.setupRequired.toast"));
      }
      return session;
    },
    closeSession: (sessionId) => closeAgentBuilderSessionRef.current(sessionId),
    navigateChat: (sessionId) => navigateAgentBuilderChatRef.current(sessionId),
  });

  const handleAutomationBuilderLeaveActionChange = useCallback(
    (action: AutomationBuilderLeaveAction | null) => {
      automationBuilderLeaveActionRef.current = action;
      setAutomationBuilderHasUnsavedChanges(Boolean(action?.hasUnsavedChanges));
    },
    [],
  );

  const guardAutomationBuilderNavigation = useCallback(
    (next: () => void, onCancel?: () => void) => {
      const action = automationBuilderLeaveActionRef.current;
      if (
        activeView === "automations" &&
        automationsRoute.surface === "builder" &&
        automationBuilderHasUnsavedChanges &&
        action?.hasUnsavedChanges
      ) {
        // A newer guarded navigation supersedes any pending one; settle the
        // old entry as cancelled so its caller is not left waiting forever.
        pendingAutomationNavigationRef.current?.onCancel?.();
        pendingAutomationNavigationRef.current = { next, onCancel };
        setAutomationLeavePromptOpen(true);
        return;
      }

      next();
    },
    [activeView, automationBuilderHasUnsavedChanges, automationsRoute.surface],
  );

  const guardAppNavigation = useCallback(
    (next: () => void, onCancel?: () => void) => {
      agentBuilder.guardNavigation(() => {
        guardAutomationBuilderNavigation(next, onCancel);
      }, onCancel);
    },
    [agentBuilder.guardNavigation, guardAutomationBuilderNavigation],
  );

  const continuePendingAutomationNavigation = useCallback(() => {
    const pending = pendingAutomationNavigationRef.current;
    pendingAutomationNavigationRef.current = null;
    pending?.next();
  }, []);

  const cancelAutomationLeave = useCallback(() => {
    const pending = pendingAutomationNavigationRef.current;
    pendingAutomationNavigationRef.current = null;
    setAutomationLeavePromptOpen(false);
    pending?.onCancel?.();
  }, []);

  const discardAutomationLeave = useCallback(() => {
    automationBuilderLeaveActionRef.current?.discard();
    automationBuilderLeaveActionRef.current = null;
    setAutomationBuilderHasUnsavedChanges(false);
    setAutomationLeavePromptOpen(false);
    continuePendingAutomationNavigation();
  }, [continuePendingAutomationNavigation]);

  const saveAutomationLeave = useCallback(async () => {
    const action = automationBuilderLeaveActionRef.current;
    if (!action) {
      discardAutomationLeave();
      return;
    }

    setAutomationLeaveSaving(true);
    try {
      const saved = await action.save();
      if (saved === false) {
        return;
      }
      automationBuilderLeaveActionRef.current = null;
      setAutomationBuilderHasUnsavedChanges(false);
      setAutomationLeavePromptOpen(false);
      continuePendingAutomationNavigation();
    } finally {
      setAutomationLeaveSaving(false);
    }
  }, [continuePendingAutomationNavigation, discardAutomationLeave]);

  const createNewProjectDraft = useCallback(
    async (
      title = DEFAULT_CHAT_TITLE,
      project: ProjectInfo,
      options: ProjectChatDraftOptions = {},
    ) => {
      perfLog(
        `[perf:newtab] createNewProjectDraft start (project=${project.id})`,
      );
      const sessionExecutionTarget =
        await resolveSessionCreationTarget(options);
      if (!sessionExecutionTarget) return undefined;
      const sessionState = useChatSessionStore.getState();
      const chatState = useChatStore.getState();
      const needsStartup =
        workspaceRepository.mode === "multi" &&
        project.projectWorkspaces.some((workspace) =>
          requiresWorkspaceStartup(workspace.startupMode),
        );
      const existingDraft = findExistingDraft({
        sessions: sessionState.sessions,
        activeSessionId: sessionState.activeSessionId,
        draftsBySession: chatState.draftsBySession,
        messagesBySession: chatState.messagesBySession,
        sessionIdsWithTerminals: getChatSessionIdsWithTerminals(),
        request: {
          title,
          projectId: project.id,
          executionTarget: sessionExecutionTarget,
          reasoningEffortValue: options.reasoningEffort?.value,
        },
        allowDraftReuse: options.reuseExistingDraft !== false && !needsStartup,
      });
      if (
        existingDraft &&
        (chatState.queuedMessageBySession[existingDraft.id]?.length ?? 0) === 0
      ) {
        clearSettingsSectionUrl();
        setActiveSession(existingDraft.id);
        setActiveView("chat");
        setChatActiveSession(existingDraft.id);
        return existingDraft;
      }
      const asIs =
        workspaceRepository.mode === "multi"
          ? planProjectChatWorkspacesAsIs(project)
          : null;
      const session = createDraftSession({
        title,
        projectId: project.id,
        executionTarget: sessionExecutionTarget,
        workingDir: getOptimisticSessionCwd(project),
        workspaceAttachments: needsStartup
          ? asIs?.workspaceAttachments.filter(
              (_, index) =>
                !requiresWorkspaceStartup(
                  project.projectWorkspaces[index]?.startupMode ?? "none",
                ),
            )
          : asIs?.workspaceAttachments,
      });
      clearSettingsSectionUrl();
      setActiveSession(session.id);
      setActiveView("chat");
      setChatActiveSession(session.id);
      startDraftSessionCreation({
        session,
        sessionExecutionTarget,
        workingDir: resolveSessionCwd(project),
        projectId: project.id,
        onReady: applyReasoningEffortAfterDraftCreation(
          session.id,
          options.reasoningEffort,
        ),
      });
      return session;
    },
    [
      createDraftSession,
      resolveSessionCreationTarget,
      setActiveSession,
      setChatActiveSession,
      startDraftSessionCreation,
      workspaceRepository.mode,
    ],
  );

  const createBackgroundDraftChat = useCallback(
    async (
      title = DEFAULT_CHAT_TITLE,
      project?: ProjectInfo,
      options: {
        executionTarget?: SessionExecutionTarget;
        reasoningEffort?: GlobalComposeOptions["reasoningEffort"];
      } = {},
    ) => {
      const tStart = performance.now();
      perfLog(
        `[perf:newtab] createBackgroundDraftChat start (project=${project?.id ?? "none"})`,
      );
      const sessionExecutionTarget =
        await resolveSessionCreationTarget(options);
      if (!sessionExecutionTarget) return undefined;
      const sessionState = useChatSessionStore.getState();
      const chatState = useChatStore.getState();
      const existingDraft = findExistingDraft({
        sessions: sessionState.sessions,
        activeSessionId: sessionState.activeSessionId,
        draftsBySession: chatState.draftsBySession,
        messagesBySession: chatState.messagesBySession,
        sessionIdsWithTerminals: getChatSessionIdsWithTerminals(),
        request: {
          title,
          projectId: project?.id,
          executionTarget: sessionExecutionTarget,
          reasoningEffortValue: options.reasoningEffort?.value,
        },
      });

      if (
        existingDraft &&
        (chatState.queuedMessageBySession[existingDraft.id]?.length ?? 0) === 0
      ) {
        perfLog(
          `[perf:newtab] ${existingDraft.id.slice(0, 8)} reused background draft in ${(performance.now() - tStart).toFixed(1)}ms`,
        );
        return existingDraft;
      }

      const optimisticWorkingDir = getOptimisticSessionCwd(project);
      const session = createDraftSession({
        title,
        projectId: project?.id,
        executionTarget: sessionExecutionTarget,
        workingDir: optimisticWorkingDir,
      });
      perfLog(
        `[perf:newtab] ${session.id.slice(0, 8)} created background draft in ${(performance.now() - tStart).toFixed(1)}ms`,
      );
      startDraftSessionCreation({
        session,
        sessionExecutionTarget,
        workingDir: resolveSessionCwd(project),
        projectId: project?.id,
        onReady: applyReasoningEffortAfterDraftCreation(
          session.id,
          options.reasoningEffort,
        ),
      });
      return session;
    },
    [
      createDraftSession,
      resolveSessionCreationTarget,
      startDraftSessionCreation,
    ],
  );

  startChatForCreatedProjectRef.current = (project) => {
    void createNewProjectDraft(DEFAULT_CHAT_TITLE, project).catch((error) => {
      logProjectChatStartError("Failed to start chat for new project:", error);
    });
  };

  const activateDeferredChatSession = useCallback(
    (sessionId: string) => {
      const liveSessionId = resolveLiveSessionId(sessionId);
      if (!liveSessionId) {
        return;
      }
      clearSettingsSectionUrl();
      setChatComposerHandoffSessionId(liveSessionId);
      setActiveSession(liveSessionId);
      setActiveView("chat");
      setChatActiveSession(liveSessionId);
    },
    [setActiveSession, setChatActiveSession],
  );

  const closeWorkspaceName = cancelWorkspaceNameRequest;
  const submitWorkspaceName = submitWorkspaceNameRequest;

  const handleStartChatFromProject = useCallback(
    (project: ProjectInfo) => {
      guardAppNavigation(() => {
        void createNewProjectDraft(DEFAULT_CHAT_TITLE, project).catch(
          (error) => {
            logProjectChatStartError(
              "Failed to start chat from project:",
              error,
            );
          },
        );
      });
    },
    [createNewProjectDraft, guardAppNavigation],
  );

  const handleStartProjectChat = useCallback(
    (projectId: string) => {
      const project = projects.find((candidate) => candidate.id === projectId);
      if (project) {
        guardAppNavigation(() => {
          void createNewProjectDraft(DEFAULT_CHAT_TITLE, project).catch(
            (error) => {
              logProjectChatStartError("Failed to start project chat:", error);
            },
          );
        });
      }
    },
    [createNewProjectDraft, projects, guardAppNavigation],
  );

  const handleStartChatWithSkill = useCallback(
    (
      skill: SkillInfo,
      projectId?: string | null,
      onNavigationAccepted?: () => void,
    ) => {
      guardAppNavigation(() => {
        onNavigationAccepted?.();
        const project = projectId
          ? projects.find((candidate) => candidate.id === projectId)
          : undefined;
        const createChat = project
          ? createNewProjectDraft(DEFAULT_CHAT_TITLE, project)
          : createNewTab(DEFAULT_CHAT_TITLE);

        void createChat
          .then((session) => {
            if (session) {
              useChatStore
                .getState()
                .setSkillDrafts(session.id, [toChatSkillDraft(skill)]);
            }
          })
          .catch((error) => {
            logProjectChatStartError("Failed to start chat with skill:", error);
          });
      });
    },
    [createNewProjectDraft, createNewTab, projects, guardAppNavigation],
  );

  const primeGlobalComposerFromHomeStarter = useCallback(
    (request: Omit<GlobalComposerStarterRequest, "id">) => {
      guardAppNavigation(() => {
        clearGlobalComposerHandoffTimer();
        setChatComposerHandoffSessionId(null);
        setGlobalComposerHandoffSourceRect(null);
        setGlobalComposerHandoffTargetRect(null);
        setGlobalComposerPlacement("docked");
        globalComposerStarterRequestIdRef.current += 1;
        setGlobalComposerStarterRequest({
          ...request,
          id: globalComposerStarterRequestIdRef.current,
        });
        setGlobalComposerFocusRequest((focusRequest) => focusRequest + 1);
      });
    },
    [clearGlobalComposerHandoffTimer, guardAppNavigation],
  );

  const handleTagHomeComposerSkill = useCallback(
    (skill: SkillInfo) => {
      primeGlobalComposerFromHomeStarter({
        skill: toChatSkillDraft(skill),
      });
    },
    [primeGlobalComposerFromHomeStarter],
  );

  const handleTagHomeComposerAgent = useCallback(
    (agentId: string) => {
      primeGlobalComposerFromHomeStarter({
        personaId: agentId,
      });
    },
    [primeGlobalComposerFromHomeStarter],
  );

  const handleTagHomeComposerProject = useCallback(
    (projectId: string) => {
      primeGlobalComposerFromHomeStarter({
        projectId,
      });
    },
    [primeGlobalComposerFromHomeStarter],
  );

  const handleGlobalComposerStarterRequestConsumed = useCallback(
    (requestId: number) => {
      setGlobalComposerStarterRequest((current) =>
        current?.id === requestId ? null : current,
      );
    },
    [],
  );

  const handleStartChatWithAgent = useCallback(
    (agentId: string, onNavigationAccepted?: () => void) => {
      guardAppNavigation(() => {
        onNavigationAccepted?.();
        if (activeView === "agents" && agentsPersonaId === agentId) {
          setGlobalComposerFocusRequest((request) => request + 1);
          return;
        }

        const agentState = useAgentStore.getState();
        const persona = agentState.personas.find(
          (candidate) => candidate.id === agentId,
        );
        const cachedModels = [
          ...useProviderModelCacheStore.getState().providers,
        ].flatMap(([providerId, entry]) =>
          entry.models.map((model) => ({
            ...model,
            providerId: model.providerId ?? providerId,
          })),
        );
        const executionTarget = personaExecutionTarget(persona, {
          providers: agentState.providers,
          models: cachedModels,
          catalogEntries: getProviderCatalog(),
        });

        void createNewTab(DEFAULT_CHAT_TITLE, undefined, {
          executionTarget,
        })
          .then((session) => {
            if (!session) return;
            patchSession(session.id, { personaId: agentId });
          })
          .catch((error) => {
            console.error("Failed to start chat with agent:", error);
          });
      });
    },
    [
      activeView,
      agentsPersonaId,
      createNewTab,
      patchSession,
      guardAppNavigation,
    ],
  );

  const handleGlobalComposerReasoningEffortChange = useCallback(
    (value: string) => {
      if (!homeSessionId || !homeSession?.reasoningEffort) {
        return;
      }
      const current = homeSession.reasoningEffort;
      if (current.currentValue === value) {
        return;
      }

      patchSession(homeSessionId, {
        reasoningEffort: {
          ...current,
          currentValue: value,
        },
      });

      const targetAtRequest = homeSession.executionTarget;
      const { providerId, modelId } =
        gooseServeSelectionFromExecutionTarget(targetAtRequest);
      void acpSetSessionConfigOption(homeSessionId, current.configId, value, {
        providerId,
        modelId,
        reasoningEffortValue: value,
      }).catch((error) => {
        const liveSession = useChatSessionStore
          .getState()
          .getSession(homeSessionId);
        if (
          !sameSessionExecutionTarget(
            liveSession?.executionTarget,
            targetAtRequest,
          ) ||
          liveSession?.reasoningEffort?.currentValue !== value
        ) {
          return;
        }
        console.error("Failed to set Home reasoning effort:", error);
        patchSession(homeSessionId, {
          reasoningEffort: current,
        });
      });
    },
    [
      homeSession?.executionTarget,
      homeSession?.reasoningEffort,
      homeSessionId,
      patchSession,
    ],
  );

  const syncGlobalComposerExecutionTargetToHome = useCallback(
    (sessionId: string, requestedTarget: SessionExecutionTarget) => {
      const sessionStore = useChatSessionStore.getState();
      const liveHomeSession = sessionStore.getSession(sessionId);
      if (!liveHomeSession) {
        return undefined;
      }
      const project = liveHomeSession.projectId
        ? (useProjectStore
            .getState()
            .projects.find(
              (candidate) => candidate.id === liveHomeSession.projectId,
            ) ?? null)
        : null;

      const requestId = createModelSelectionRequestId();
      const target = normalizeSessionExecutionTarget(requestedTarget);
      beginModelSelectionIntent(sessionId, {
        requestId,
        target,
        previousTarget: liveHomeSession.executionTarget,
      });

      void (async () => {
        try {
          const workingDir = await resolveSessionCwd(
            project,
            liveHomeSession.workingDir,
          );
          if (!isCurrentModelSelectionIntent(sessionId, requestId)) {
            return;
          }
          const result = await transitionSessionTarget({
            sessionId,
            target,
            workingDir,
            requireReasoningEffort: true,
            requestId,
          });
          const intentStillMatches = clearCurrentModelSelectionIntent(
            sessionId,
            requestId,
          );
          if (!result.applied || !intentStillMatches) {
            return;
          }

          if (!sameSessionExecutionTarget(result.target, target)) {
            setGlobalComposerExecutionTarget(result.target);
          }
        } catch (error) {
          if (clearCurrentModelSelectionIntent(sessionId, requestId)) {
            const previousTarget = liveHomeSession.executionTarget;
            replaceSessionTargetAfterDispatch(sessionId, previousTarget);
            setGlobalComposerExecutionTarget(previousTarget ?? null);
            showModelSwitchErrorToast({
              modelName: target.modelName ?? target.modelId ?? target.harnessId,
              fallbackModelName:
                liveHomeSession.executionTarget?.modelName ??
                liveHomeSession.executionTarget?.modelId ??
                null,
            });
          }
          console.error(
            "Failed to apply the selected Home execution target:",
            error,
          );
        }
      })();

      return () => {
        clearCurrentModelSelectionIntent(sessionId, requestId);
      };
    },
    [],
  );

  useEffect(() => {
    if (!globalComposerExecutionTarget || !homeSessionId || !hasHomeSession) {
      return;
    }

    return syncGlobalComposerExecutionTargetToHome(
      homeSessionId,
      globalComposerExecutionTarget,
    );
  }, [
    globalComposerExecutionTarget,
    hasHomeSession,
    homeSessionId,
    syncGlobalComposerExecutionTargetToHome,
  ]);

  const handleGlobalComposerExecutionTargetChange = useCallback(
    (target: SessionExecutionTarget | null) => {
      globalComposerExecutionTargetRef.current = target;
      setGlobalComposerExecutionTarget(target);
      if (!target && homeSessionId) {
        clearCurrentModelSelectionIntent(homeSessionId);
      }
    },
    [homeSessionId],
  );

  const handleGlobalCompose = useCallback(
    (
      text: string,
      options?: GlobalComposeOptions,
      internalOptions?: {
        showQueuedHandoff?: boolean;
        onSettled?: (didStart: boolean) => void;
      },
    ) => {
      const project = options?.projectId
        ? projects.find((candidate) => candidate.id === options.projectId)
        : undefined;
      const requiresProjectWorkspaceDraftPlan =
        workspaceRepository.mode === "multi" &&
        Boolean(project?.projectWorkspaces.length);
      const shouldRunComposerHandoff =
        globalComposerPlacement === "centered" &&
        !requiresProjectWorkspaceDraftPlan;
      if (shouldRunComposerHandoff) {
        clearGlobalComposerHandoffTimer();
        setGlobalComposerPlacement("handoff");
        setChatComposerHandoffRequest((request) => request + 1);
        setChatComposerHandoffSessionId(null);
        setGlobalComposerHandoffTargetRect(null);
      } else if (
        globalComposerPlacement === "centered" &&
        requiresProjectWorkspaceDraftPlan
      ) {
        resetGlobalComposerTransition();
      }

      const chatOptions = {
        executionTarget: options?.executionTarget,
        reasoningEffort: options?.reasoningEffort,
      };
      const acceptGlobalFirstSend = async (session: ChatSession) => {
        const sessionId = resolveLiveSessionId(session.id) ?? session.id;

        if (options?.personaId !== undefined) {
          patchSession(sessionId, {
            personaId: options.personaId ?? undefined,
          });
        }
        if (options?.reasoningEffort) {
          try {
            await applyReasoningEffortToSession(
              sessionId,
              options.reasoningEffort,
            );
          } catch (error) {
            console.error(
              "Failed to apply reasoning effort from global composer:",
              error,
            );
          }
        }
        acceptFirstSend(
          sessionId,
          {
            text,
            ...(internalOptions?.showQueuedHandoff === false
              ? { showInComposer: false }
              : {}),
            persona: personaIntentFromComposer(options?.personaId),
            attachments: options?.attachments,
            sendOptions: {
              ...options?.sendOptions,
              // A deferred first send is dispatched by the background
              // queued-send pipeline, which reads this surface for `berd_chat`
              // send telemetry. MAIN_CHAT for parity with this composer's
              // non-deferred sends, which drain through the ChatView
              // controller and report the same surface.
              telemetrySourceSurface: CHAT_SOURCE_SURFACE.MAIN_CHAT,
            },
          },
          { queueReady: true, onNeedsName: enqueueWorkspaceNameRequest },
        );
      };

      const startChat = async () => {
        const createChat = project
          ? createNewProjectDraft(DEFAULT_CHAT_TITLE, project, chatOptions)
          : createNewTab(DEFAULT_CHAT_TITLE, undefined, chatOptions);

        try {
          const session = await createChat;
          if (!session) {
            resetGlobalComposerTransition();
            internalOptions?.onSettled?.(false);
            return;
          }
          await acceptGlobalFirstSend(session);
          internalOptions?.onSettled?.(true);
        } catch (error) {
          logProjectChatStartError(
            "Failed to start chat from global composer:",
            error,
          );
          resetGlobalComposerTransition();
          internalOptions?.onSettled?.(false);
        }
      };

      const startBackgroundChat = async () => {
        try {
          const session = await createBackgroundDraftChat(
            DEFAULT_CHAT_TITLE,
            project,
            chatOptions,
          );
          if (!session) {
            resetGlobalComposerTransition();
            internalOptions?.onSettled?.(false);
            return;
          }
          setChatComposerHandoffSessionId(session.id);
          const firstSendPromise = acceptGlobalFirstSend(session);
          clearGlobalComposerRouteSwapTimer();
          if (prefersReducedMotion()) {
            activateDeferredChatSession(session.id);
            resetGlobalComposerTransition();
          } else {
            globalComposerRouteSwapTimeoutRef.current = window.setTimeout(
              () => {
                globalComposerRouteSwapTimeoutRef.current = null;
                activateDeferredChatSession(session.id);
              },
              GLOBAL_COMPOSER_ROUTE_SWAP_DELAY_MS,
            );
          }
          await firstSendPromise;
          internalOptions?.onSettled?.(true);
        } catch (error) {
          logProjectChatStartError(
            "Failed to start chat from global composer:",
            error,
          );
          resetGlobalComposerTransition();
          internalOptions?.onSettled?.(false);
        }
      };

      if (shouldRunComposerHandoff) {
        guardAppNavigation(startBackgroundChat, () => {
          resetGlobalComposerTransition();
          internalOptions?.onSettled?.(false);
        });
        return;
      }

      guardAppNavigation(startChat, () => internalOptions?.onSettled?.(false));
    },
    [
      activateDeferredChatSession,
      createBackgroundDraftChat,
      createNewProjectDraft,
      createNewTab,
      clearGlobalComposerHandoffTimer,
      clearGlobalComposerRouteSwapTimer,
      globalComposerPlacement,
      patchSession,
      projects,
      guardAppNavigation,
      resetGlobalComposerTransition,
      workspaceRepository,
      enqueueWorkspaceNameRequest,
    ],
  );

  const handleRunPinnedPrompt = useCallback(
    async (args: { text: string; agentId?: string }) => {
      const agentState = useAgentStore.getState();
      await runPinnedPrompt(args, {
        personas: agentState.personas,
        resolveExecutionTarget: (persona) => {
          const cachedModels = [
            ...useProviderModelCacheStore.getState().providers,
          ].flatMap(([providerId, entry]) =>
            entry.models.map((model) => ({
              ...model,
              providerId: model.providerId ?? providerId,
            })),
          );
          return personaExecutionTarget(persona, {
            providers: agentState.providers,
            models: cachedModels,
            catalogEntries: getProviderCatalog(),
          });
        },
        resolveFallbackExecutionTarget: () =>
          currentGlobalComposerExecutionTargetRef.current ?? undefined,
        // Resolves on onSettled so the widget's launch guard holds until the
        // session is created (or fails), not just until dispatch.
        compose: (text, options) =>
          new Promise<void>((resolve) => {
            handleGlobalCompose(text, options, {
              onSettled: () => resolve(),
            });
          }),
        onAgentUnavailable: () =>
          toast.error(t("home:widgets.promptPin.agentUnavailable")),
      });
    },
    [handleGlobalCompose, t],
  );

  const handleResolveBerdyAgent = useCallback(async (): Promise<
    string | null
  > => {
    try {
      const store = useAgentStore.getState();
      let personaId = findBerdyPersonaId(store.personas);

      if (!personaId) {
        const { listPersonas, repairBundledAgent } = await import(
          "@/shared/api/agents"
        );
        try {
          await repairBundledAgent("berdy.md");
        } catch (error) {
          console.error("Failed to restore the bundled Berdy agent:", error);
        }

        try {
          const personas = await listPersonas();
          personaId = findBerdyPersonaId(personas);
          const repairedBerdy = personaId
            ? personas.find((persona) => persona.id === personaId)
            : undefined;
          if (repairedBerdy) {
            useAgentStore.setState((current) => ({
              personas: [
                ...current.personas.filter(
                  (persona) => persona.id !== repairedBerdy.id,
                ),
                repairedBerdy,
              ],
            }));
          }
        } catch (error) {
          console.error(
            "Failed to refresh personas after Berdy repair:",
            error,
          );
        }
      }

      if (!personaId) {
        toast.error(t("home:onboarding.callout.agentUnavailable"));
        return null;
      }

      return personaId;
    } catch (error) {
      console.error("Failed to resolve the bundled Berdy agent:", error);
      toast.error(t("home:onboarding.callout.agentUnavailable"));
      return null;
    }
  }, [t]);

  const handleGlobalComposerExpand = useCallback(
    (payload: GlobalComposerExpandPayload): Promise<boolean> => {
      const options = payload.options;
      const project = options?.projectId
        ? projects.find((candidate) => candidate.id === options.projectId)
        : undefined;
      const chatOptions = {
        executionTarget: options?.executionTarget,
        reasoningEffort: options?.reasoningEffort,
      };

      const shouldDismissCenteredComposer =
        globalComposerPlacement === "centered";

      const openExpandedDraft = async () => {
        const session = project
          ? await createNewProjectDraft(
              DEFAULT_CHAT_TITLE,
              project,
              chatOptions,
            )
          : await createNewTab(DEFAULT_CHAT_TITLE, undefined, chatOptions);
        if (!session) {
          return false;
        }
        const sessionId = resolveLiveSessionId(session.id) ?? session.id;

        if (options?.personaId !== undefined) {
          patchSession(sessionId, {
            personaId: options.personaId ?? undefined,
          });
        }

        if (options?.reasoningEffort) {
          try {
            await applyReasoningEffortToSession(
              sessionId,
              options.reasoningEffort,
            );
          } catch (error) {
            console.error(
              "Failed to apply reasoning effort from expanded global composer:",
              error,
            );
          }
        }

        const chatState = useChatStore.getState();
        chatState.setDraft(sessionId, payload.text);
        chatState.setSkillDrafts(sessionId, payload.selectedSkills);
        chatState.setDraftAttachments(sessionId, options?.attachments ?? []);

        if (shouldDismissCenteredComposer) {
          resetGlobalComposerTransition();
        }
        return true;
      };

      return new Promise<boolean>((resolve) => {
        guardAppNavigation(
          () => {
            void openExpandedDraft()
              .then((expanded) => {
                resolve(expanded);
              })
              .catch((error) => {
                console.error("Failed to expand global composer:", error);
                resolve(false);
              });
          },
          () => {
            resolve(false);
          },
        );
      });
    },
    [
      createNewProjectDraft,
      createNewTab,
      guardAppNavigation,
      globalComposerPlacement,
      patchSession,
      projects,
      resetGlobalComposerTransition,
    ],
  );

  const handleGlobalVoiceConversationStart = useCallback(
    (payload: GlobalComposerExpandPayload): Promise<boolean> => {
      if (!capabilities.voiceConversation) return Promise.resolve(false);
      if (!globalVoiceReady) {
        return new Promise<boolean>((resolve) => {
          guardAppNavigation(
            () => {
              setRetainGlobalComposerDraft(true);
              requestOpenSettings("voice");
              resetGlobalComposerTransition();
              resolve(false);
            },
            () => resolve(false),
          );
        });
      }
      const options = payload.options;
      const project = options?.projectId
        ? projects.find((candidate) => candidate.id === options.projectId)
        : undefined;
      const chatOptions = {
        activate: false,
        reuseExistingDraft: false,
        executionTarget: options?.executionTarget,
        reasoningEffort: options?.reasoningEffort,
      };

      const createAndStart = async () => {
        const voice = useVoiceConversationStore.getState();
        if (
          voice.status.lifecycle === "starting" ||
          voice.status.lifecycle === "running" ||
          voice.status.lifecycle === "stopping"
        ) {
          await stopVoiceConversation();
        }
        const session = await createNewTab(
          DEFAULT_CHAT_TITLE,
          project,
          chatOptions,
        );
        if (!session) {
          toast.error(t("chat:globalPill.voiceConversationStartFailed"));
          return false;
        }

        const sessionId = resolveLiveSessionId(session.id) ?? session.id;
        if (options?.personaId !== undefined) {
          patchSession(sessionId, {
            personaId: options.personaId ?? undefined,
          });
        }
        if (options?.reasoningEffort) {
          try {
            await applyReasoningEffortToSession(
              sessionId,
              options.reasoningEffort,
            );
          } catch (error) {
            console.error(
              "Failed to apply reasoning effort for voice conversation:",
              error,
            );
          }
        }

        const chatState = useChatStore.getState();
        chatState.setDraft(sessionId, payload.text);
        chatState.setSkillDrafts(sessionId, payload.selectedSkills);
        chatState.setDraftAttachments(sessionId, options?.attachments ?? []);
        requestVoiceConversationStart(sessionId);
        handleNavigateToSession(sessionId);
        resetGlobalComposerTransition();
        return true;
      };

      return new Promise<boolean>((resolve) => {
        guardAppNavigation(
          () => {
            void createAndStart()
              .then(resolve)
              .catch((error) => {
                console.error(
                  "Failed to create chat for voice conversation:",
                  error,
                );
                toast.error(t("chat:globalPill.voiceConversationStartFailed"));
                resolve(false);
              });
          },
          () => resolve(false),
        );
      });
    },
    [
      capabilities.voiceConversation,
      createNewTab,
      globalVoiceReady,
      guardAppNavigation,
      handleNavigateToSession,
      patchSession,
      projects,
      requestVoiceConversationStart,
      resetGlobalComposerTransition,
      stopVoiceConversation,
      t,
    ],
  );
  const handleStartConnectionSetupChat = useCallback(
    (request: SetupChatRequest) => {
      guardAppNavigation(() => {
        const harnessId = selectedProviderRef.current ?? "goose";
        void createNewTab(request.title, undefined, {
          executionTarget: { harnessId },
        })
          .then((session) => {
            if (!session) return;
            const sessionId = resolveLiveSessionId(session.id) ?? session.id;
            useChatStore.getState().setDraft(sessionId, request.prompt);
          })
          .catch((error) => {
            console.error("Failed to start connection setup chat:", error);
          });
      });
    },
    [guardAppNavigation, createNewTab],
  );

  const handleStartProviderTroubleshootingChat = useCallback(
    (request: AgentSetupTroubleshootingRequest) => {
      guardAppNavigation(() => {
        void createNewTab(request.title, undefined, {
          executionTarget: { harnessId: "goose" },
        })
          .then((session) => {
            if (!session) return;
            useChatStore.getState().enqueueTransportReadyMessage(
              session.id,
              admitSystemInheritedQueuedMessage({
                text: request.prompt,
              }),
            );
          })
          .catch((error) => {
            console.error(
              "Failed to start provider troubleshooting chat:",
              error,
            );
          });
      });
    },
    [guardAppNavigation, createNewTab],
  );

  const handleNewChatInProject = useCallback(
    (
      projectId: string,
      options: {
        reuseExistingDraft?: boolean;
      } = {},
    ) => {
      const project = projects.find((p) => p.id === projectId);
      if (!project) {
        return Promise.resolve(undefined);
      }

      return new Promise<ChatSession | undefined>((resolve) => {
        guardAppNavigation(
          () => {
            const draftOptions =
              options.reuseExistingDraft === undefined
                ? {}
                : { reuseExistingDraft: options.reuseExistingDraft };
            void createNewProjectDraft(
              DEFAULT_CHAT_TITLE,
              project,
              draftOptions,
            )
              .then(resolve)
              .catch((error) => {
                logProjectChatStartError(
                  "Failed to start project chat:",
                  error,
                );
                resolve(undefined);
              });
          },
          () => {
            resolve(undefined);
          },
        );
      });
    },
    [createNewProjectDraft, projects, guardAppNavigation],
  );
  const handleArchiveProject = useCallback(
    async (projectId: string) => {
      try {
        await archiveProject(projectId);
        fetchProjects();
      } catch {
        // best-effort
      }
    },
    [fetchProjects],
  );

  const clearActiveSession = useCallback(
    (sessionId: string) => {
      cleanupChatSession(sessionId);
      setActiveSession(null);
      clearSettingsSectionUrl();
      if (activeView === "chat") {
        setActiveView("home");
      }
    },
    [activeView, cleanupChatSession, setActiveSession],
  );

  const returnToAgentBuilderSettingsTarget = useCallback(() => {
    const target = agentBuilderSettingsReturnTarget;
    if (!target) {
      return false;
    }

    const session = useChatSessionStore.getState().getSession(target.sessionId);
    setAgentBuilderSettingsReturnTarget(null);
    if (!session || session.archivedAt) {
      return false;
    }

    clearSettingsSectionUrl();
    setActiveSession(target.sessionId);
    setActiveView("chat");
    setChatActiveSession(target.sessionId);
    useChatStore.getState().markSessionRead(target.sessionId);
    void loadSessionMessagesAndPrepare(target.sessionId);
    return true;
  }, [
    agentBuilderSettingsReturnTarget,
    setActiveSession,
    setChatActiveSession,
  ]);

  const returnToVoiceSettingsTarget = useCallback(() => {
    const target = voiceSettingsReturnTarget;
    if (!target) {
      return false;
    }

    const session = useChatSessionStore.getState().getSession(target.sessionId);
    if (!session || session.archivedAt) {
      voiceSettingsReturnTargetRef.current = null;
      setVoiceSettingsReturnTarget(null);
      useVoiceConversationStore
        .getState()
        .clearRequestedStart(target.sessionId);
      return false;
    }

    useVoiceConversationStore.getState().clearRequestedStart(target.sessionId);
    voiceSettingsReturnTargetRef.current = null;
    setVoiceSettingsReturnTarget(null);

    const history = navigationHistoryRef.current;
    const previousLocation =
      history.index > 0 ? history.entries[history.index - 1] : null;
    if (
      previousLocation?.view === "chat" &&
      previousLocation.sessionId === target.sessionId
    ) {
      history.index -= 1;
    } else {
      history.entries.splice(history.index, 0, {
        view: "chat",
        sessionId: target.sessionId,
      });
    }

    clearSettingsSectionUrl();
    setActiveSession(target.sessionId);
    setActiveView("chat");
    setChatActiveSession(target.sessionId);
    useChatStore.getState().markSessionRead(target.sessionId);
    void loadSessionMessagesAndPrepare(target.sessionId);
    updateNavigationAvailability();
    return true;
  }, [
    setActiveSession,
    setChatActiveSession,
    updateNavigationAvailability,
    voiceSettingsReturnTarget,
  ]);

  useEffect(() => {
    if (
      !voiceSettingsReturnTarget ||
      (activeView === "settings" && activeSettingsSection === "voice")
    ) {
      return;
    }
    useVoiceConversationStore
      .getState()
      .clearRequestedStart(voiceSettingsReturnTarget.sessionId);
    voiceSettingsReturnTargetRef.current = null;
    setVoiceSettingsReturnTarget(null);
  }, [activeSettingsSection, activeView, voiceSettingsReturnTarget]);

  const openSettings = useCallback(
    (section: SectionId = DEFAULT_SETTINGS_SECTION) => {
      const enabledSection = resolveEnabledSettingsSection(
        section,
        capabilities,
      );
      if (activeView !== "settings" && activeView !== "design-system") {
        lastNonSecondaryViewRef.current = activeView;
      }
      setActiveSettingsSection(enabledSection);
      setSettingsSectionUrl(enabledSection);
      setActiveView("settings");
      if (sidebarCollapsed) {
        void expandSidebar();
      }
    },
    [activeView, capabilities, expandSidebar, sidebarCollapsed],
  );

  const leaveSecondarySurface = useCallback(() => {
    if (returnToVoiceSettingsTarget()) {
      return;
    }
    if (returnToAgentBuilderSettingsTarget()) {
      return;
    }
    clearSettingsSectionUrl();
    setActiveView(lastNonSecondaryViewRef.current);
  }, [returnToAgentBuilderSettingsTarget, returnToVoiceSettingsTarget]);

  const selectSettingsSection = useCallback(
    (section: SectionId) => {
      const enabledSection = resolveEnabledSettingsSection(
        section,
        capabilities,
      );
      setActiveSettingsSection(enabledSection);
      setSettingsSectionUrl(enabledSection);
    },
    [capabilities],
  );

  const openDesignSystem = useCallback(() => {
    if (!isDesignSystemExplorerEnabled()) return;
    if (activeView !== "design-system") {
      designSystemReturnViewRef.current = activeView;
    }
    setDesignSystemUrl();
    setActiveView("design-system");
  }, [activeView]);

  const closeDesignSystem = useCallback(() => {
    const returnView = designSystemReturnViewRef.current;
    if (returnView === "settings") {
      setSettingsSectionUrl(activeSettingsSection);
    } else {
      clearSettingsSectionUrl();
    }
    setActiveView(returnView);
  }, [activeSettingsSection]);

  const selectDesignSystemSection = useCallback(
    (section: DesignSystemSection) => {
      setActiveDesignSystemSection(section);
    },
    [],
  );

  useEffect(() => {
    const handleOpenSettingsEvent = (event: Event) => {
      const detail = (event as CustomEvent<OpenSettingsEventDetail>).detail;
      const section = detail?.section;
      const nextVoiceTarget =
        detail?.returnTarget?.type === "voice-setup"
          ? detail.returnTarget
          : null;
      const commitNavigation = () => {
        setAgentBuilderSettingsReturnTarget(
          detail?.returnTarget?.type === "agent-builder-provider-setup"
            ? detail.returnTarget
            : null,
        );
        const currentVoiceTarget = voiceSettingsReturnTargetRef.current;
        if (
          currentVoiceTarget &&
          currentVoiceTarget.sessionId !== nextVoiceTarget?.sessionId
        ) {
          useVoiceConversationStore
            .getState()
            .clearRequestedStart(currentVoiceTarget.sessionId);
        }
        if (nextVoiceTarget) {
          useVoiceConversationStore
            .getState()
            .clearRequestedStart(nextVoiceTarget.sessionId);
        }
        voiceSettingsReturnTargetRef.current = nextVoiceTarget;
        setVoiceSettingsReturnTarget(nextVoiceTarget);
        openSettings(resolveSettingsSection(section ?? null));
      };

      if (nextVoiceTarget) {
        guardAppNavigation(commitNavigation, () => {
          useVoiceConversationStore
            .getState()
            .clearRequestedStart(nextVoiceTarget.sessionId);
        });
        return;
      }
      commitNavigation();
    };

    window.addEventListener(
      OPEN_SETTINGS_EVENT,
      handleOpenSettingsEvent as EventListener,
    );
    return () => {
      window.removeEventListener(
        OPEN_SETTINGS_EVENT,
        handleOpenSettingsEvent as EventListener,
      );
    };
  }, [guardAppNavigation, openSettings]);

  const settleWorkspaceCleanupConfirmation = useCallback(
    (confirmed: boolean) => {
      const pending = pendingWorkspaceCleanupConfirmationRef.current;
      if (!pending) return;
      pendingWorkspaceCleanupConfirmationRef.current = null;
      setPendingWorkspaceCleanupConfirmation(null);
      pending.resolve(confirmed);
    },
    [],
  );

  useEffect(
    () => () => {
      const pending = pendingWorkspaceCleanupConfirmationRef.current;
      pendingWorkspaceCleanupConfirmationRef.current = null;
      pending?.resolve(false);
    },
    [],
  );

  const confirmGitCleanup = useCallback(
    (plans: InspectedSessionWorkspaceCleanupPlan[]): Promise<boolean> => {
      const { worktreeCount, branchCount } =
        countSessionWorkspaceCleanupResources(plans);
      return new Promise((resolve) => {
        const pending: PendingSessionWorkspaceCleanupConfirmation = {
          worktreeCount,
          branchCount,
          resolve,
        };
        pendingWorkspaceCleanupConfirmationRef.current = pending;
        setPendingWorkspaceCleanupConfirmation(pending);
      });
    },
    [],
  );

  const archiveChat = useCallback(
    async (
      sessionId: string,
      cleanupPolicy: ArchiveCleanupPolicy,
      deadlineMs?: number,
      fallbackSession?: ChatSession,
      revalidateBeforeMutation?: () => Promise<boolean>,
    ) => {
      let releaseArchiveQueue!: () => void;
      const previousArchive = sessionArchiveQueueRef.current;
      sessionArchiveQueueRef.current = new Promise<void>((resolve) => {
        releaseArchiveQueue = resolve;
      });
      await previousArchive;

      try {
        const sessionStore = useChatSessionStore.getState();
        const session = sessionStore.getSession(sessionId) ?? fallbackSession;
        if (!session || session.id !== sessionId) {
          return { ok: false as const, reason: "session_not_found" as const };
        }
        await useVoiceConversationStore.getState().init();
        const voiceBeforeArchive = useVoiceConversationStore.getState().status;
        if (
          cleanupPolicy !== "confirm" &&
          voiceBeforeArchive.sessionId === sessionId &&
          voiceBeforeArchive.lifecycle !== "stopped" &&
          voiceBeforeArchive.lifecycle !== "unavailable"
        ) {
          return {
            ok: false as const,
            reason: "target_session_running" as const,
          };
        }

        let plans: InspectedSessionWorkspaceCleanupPlan[] = [];
        if (hasSessionWorkspaceCleanupTargets(session)) {
          try {
            const allSessions = await loadAllSessionsForWorkspaceCleanup();
            // Resolve the home dir so the used-elsewhere check can match a
            // `~`-spelled attachment in another chat against an absolute
            // cleanup target; on failure fall back to the cached value (raw
            // comparison, as before).
            const homeDir = await getHomeDir().catch(() => getCachedHomeDir());
            plans = await inspectSessionWorkspaceCleanup(
              planSessionWorkspaceCleanup(
                session,
                [...allSessions, ...sessionStore.sessions],
                homeDir,
              ),
            );
          } catch (error) {
            console.error("Failed to inspect session Git resources:", error);
            if (cleanupPolicy === "confirm") {
              toast.error(t("chat:notifications.gitInspectionError"), {
                description: formatAcpErrorMessage(error),
              });
            }
            return {
              ok: false as const,
              reason: "git_inspection_failed" as const,
            };
          }
        }

        // Automatic archiving must never remove a worktree or branch. A
        // renderer-side status check cannot make a subsequent force-delete
        // atomic with respect to editor or process writes, so preserve all Git
        // resources and let the user clean them up explicitly later.
        if (revalidateBeforeMutation) {
          plans = [];
        }

        const wouldDiscardFiles = plans.some(
          wouldSessionWorkspaceCleanupDiscardFiles,
        );
        if (wouldDiscardFiles) {
          if (cleanupPolicy === "reject") {
            return {
              ok: false as const,
              reason: "cleanup_requires_discard" as const,
            };
          }
          if (
            cleanupPolicy === "confirm" &&
            !(await confirmGitCleanup(plans))
          ) {
            return {
              ok: false as const,
              reason: "blocked_unsaved_changes" as const,
            };
          }
        }

        const preArchiveInterruption = getSessionArchiveInterruptionReason(
          sessionId,
          cleanupPolicy,
          deadlineMs,
        );
        if (preArchiveInterruption) {
          return { ok: false as const, reason: preArchiveInterruption };
        }
        if (revalidateBeforeMutation && !(await revalidateBeforeMutation())) {
          return {
            ok: false as const,
            reason: "blocked_unsaved_changes" as const,
          };
        }
        const releaseVoiceStartBlock =
          await acquireVoiceStartBlockBeforeDeadline(sessionId, deadlineMs);
        if (!releaseVoiceStartBlock) {
          return { ok: false as const, reason: "timed_out" as const };
        }
        try {
          const postLeaseInterruption = getSessionArchiveInterruptionReason(
            sessionId,
            cleanupPolicy,
            deadlineMs,
          );
          if (postLeaseInterruption) {
            return { ok: false as const, reason: postLeaseInterruption };
          }
          await useVoiceConversationStore.getState().init();
          const voiceBeforeMutation =
            useVoiceConversationStore.getState().status;
          const targetOwnsVoice =
            voiceBeforeMutation.sessionId === sessionId &&
            voiceBeforeMutation.lifecycle !== "stopped" &&
            voiceBeforeMutation.lifecycle !== "unavailable";
          if (cleanupPolicy !== "confirm" && targetOwnsVoice) {
            return {
              ok: false as const,
              reason: "target_session_running" as const,
            };
          }
          if (targetOwnsVoice) {
            try {
              const stoppedStatus = await useVoiceConversationStore
                .getState()
                .stop();
              const currentStatus = useVoiceConversationStore.getState().status;
              const targetStillOwnsVoice = [stoppedStatus, currentStatus].some(
                (status) =>
                  status.sessionId === sessionId &&
                  status.lifecycle !== "stopped" &&
                  status.lifecycle !== "unavailable",
              );
              if (targetStillOwnsVoice) {
                throw new Error("Voice is still active for this chat.");
              }
            } catch (error) {
              console.error("Failed to stop voice before archiving:", error);
              toast.error(t("chat:notifications.voiceStopBeforeArchiveError"), {
                description: formatAcpErrorMessage(error),
              });
              return {
                ok: false as const,
                reason: "voice_stop_failed" as const,
              };
            }
          }

          const preMutationInterruption = getSessionArchiveInterruptionReason(
            sessionId,
            cleanupPolicy,
            deadlineMs,
          );
          if (preMutationInterruption) {
            return { ok: false as const, reason: preMutationInterruption };
          }
          try {
            await useChatSessionStore
              .getState()
              .archiveSession(sessionId, fallbackSession);
            const homeWidgetState = useHomeWidgetStore.getState();
            const pinnedWidget = homeWidgetState.instances.find(
              (instance) =>
                instance.type === "chatPin" &&
                instance.state?.sessionId === sessionId,
            );
            if (pinnedWidget) {
              homeWidgetState.removeWidget(pinnedWidget.id);
            }
          } catch (error) {
            if (cleanupPolicy === "confirm") {
              toast.error(
                formatAcpErrorMessage(
                  error,
                  t("chat:notifications.archiveError"),
                ),
              );
            }
            return {
              ok: false as const,
              reason:
                error instanceof SessionNotFoundError
                  ? ("session_not_found" as const)
                  : ("backend_archive_failed" as const),
              detail:
                error instanceof SessionNotFoundError
                  ? undefined
                  : formatAcpErrorMessage(error),
            };
          }
          let cleanupFailureReason:
            | "target_session_running"
            | "workspace_cleanup_failed"
            | "timed_out"
            | null = null;
          try {
            await cleanupSessionWorkspaces(plans, {
              getInterruptionReason: () =>
                getSessionArchiveInterruptionReason(
                  sessionId,
                  cleanupPolicy,
                  deadlineMs,
                ),
            });
          } catch (error) {
            cleanupFailureReason =
              error instanceof SessionWorkspaceCleanupInterruptedError
                ? error.reason
                : "workspace_cleanup_failed";
            console.error(
              "Failed to clean up archived session Git resources:",
              error,
            );
            if (cleanupPolicy === "confirm") {
              toast.error(
                formatAcpErrorMessage(
                  error,
                  t("chat:notifications.gitCleanupError"),
                ),
              );
            }
          }

          const wasActiveSession =
            useChatSessionStore.getState().activeSessionId === sessionId;
          cleanupChatSession(sessionId);
          if (useSessionWindowStore.getState().isOpenInWindow(sessionId)) {
            releaseSession(sessionId).catch((error: unknown) =>
              console.error("Failed to release session window:", error),
            );
          }
          if (wasActiveSession) {
            setActiveSession(null);
            setActiveView("home");
          }

          return cleanupFailureReason
            ? { ok: true as const, cleanupIncomplete: cleanupFailureReason }
            : { ok: true as const };
        } finally {
          await releaseVoiceStartBlock();
        }
      } finally {
        releaseArchiveQueue();
      }
    },
    [cleanupChatSession, confirmGitCleanup, setActiveSession, t],
  );

  const handleAutoArchiveChat = useCallback(
    (session: ChatSession, revalidate: () => Promise<boolean>) =>
      archiveChat(session.id, "reject", undefined, session, revalidate),
    [archiveChat],
  );
  useAutoArchiveSessions(handleAutoArchiveChat);

  const handleArchiveChat = useCallback(
    (sessionId: string) => archiveChat(sessionId, "confirm"),
    [archiveChat],
  );
  closeAgentBuilderSessionRef.current = async (sessionId) => {
    await handleArchiveChat(sessionId);
  };

  const handleEditProject = useCallback(
    (projectId: string) => {
      const project = projects.find((p) => p.id === projectId);
      if (project) {
        openEditProjectDialog(project);
      }
    },
    [openEditProjectDialog, projects],
  );

  const handleMoveToProject = useCallback(
    (sessionId: string, projectId: string | null) => {
      const session = useChatSessionStore.getState().getSession(sessionId);
      if (!session) {
        return;
      }

      // Ignore drops that would not change the chat's group (e.g. dropping a
      // chat back onto a sibling in the same list) so we never fire a no-op
      // move that looks like a failed drag.
      if ((session.projectId ?? null) === projectId) {
        return;
      }

      void moveSessionToProject(sessionId, projectId).catch((error) => {
        console.error("Failed to move session to project:", error);
        toast.error(
          formatAcpErrorMessage(error, t("chat:notifications.moveError")),
        );
      });
    },
    [t],
  );

  const handleRenameChat = useCallback(
    (sessionId: string, nextTitle: string) => {
      void updateSessionTitle(sessionId, nextTitle).catch((error) => {
        console.error("Failed to rename session:", error);
        toast.error(
          formatAcpErrorMessage(error, t("notifications.renameError")),
        );
      });
    },
    [t],
  );

  const handleMarkChatRead = useCallback((sessionId: string) => {
    useChatStore.getState().markSessionRead(sessionId);
  }, []);

  const handleMarkChatUnread = useCallback((sessionId: string) => {
    useChatStore.getState().markSessionUnread(sessionId);
  }, []);

  const activateHomeSession = useCallback(
    (sessionId: string) => {
      guardAppNavigation(() => {
        if (homeSessionId === sessionId) {
          setHomeSessionId(null);
        }
        setActiveSession(sessionId);
        clearSettingsSectionUrl();
        setActiveView("chat");
        setChatActiveSession(sessionId);
        useChatStore.getState().markSessionRead(sessionId);
      });
    },
    [homeSessionId, guardAppNavigation, setActiveSession, setChatActiveSession],
  );

  const selectSessionDirect = useCallback((id: string) => {
    activateChatSession(id);
    clearSettingsSectionUrl();
    setActiveView("chat");
    void loadSessionMessagesAndPrepare(id);
  }, []);
  navigateAgentBuilderChatRef.current = selectSessionDirect;

  const handleSelectSession = useCallback(
    (id: string) => {
      if (
        isMultiWindowEnabled &&
        useSessionWindowStore.getState().isOpenInWindow(id)
      ) {
        void focusSessionWindow(id);
        return;
      }
      if (
        activeView === "chat" &&
        id === useChatSessionStore.getState().activeSessionId
      ) {
        return;
      }
      guardAppNavigation(() => {
        selectSessionDirect(id);
      });
    },
    [activeView, guardAppNavigation, isMultiWindowEnabled, selectSessionDirect],
  );

  useEffect(() => {
    let cancelled = false;
    let unlisten: (() => void) | null = null;
    void listenToVoiceConversationOpenSession((sessionId) => {
      const voice = useVoiceConversationStore.getState().status;
      if (voice.lifecycle === "running" && voice.sessionId === sessionId) {
        handleSelectSession(sessionId);
      }
    })
      .then((cleanup) => {
        if (cancelled) cleanup();
        else unlisten = cleanup;
      })
      .catch((error) => {
        console.error(
          "Failed to listen for voice session open requests:",
          error,
        );
      });
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [handleSelectSession]);

  const handleSelectSearchResult = useCallback(
    (
      sessionId: string,
      messageId?: string,
      query?: string,
      session?: ChatSession,
    ) => {
      guardAppNavigation(() => {
        setSearchDialogOpen(false);
        if (messageId) {
          useChatStore
            .getState()
            .setScrollTargetMessage(sessionId, messageId, query);
        }
        const sessionWindowStore = useSessionWindowStore.getState();
        if (
          isMultiWindowEnabled &&
          sessionWindowStore.isOpenInWindow(sessionId)
        ) {
          const windowLabel = sessionWindowStore.getWindowLabel(sessionId);
          if (messageId && windowLabel) {
            void sendSessionWindowSearchTarget(windowLabel, {
              sessionId,
              messageId,
              query,
            }).then(() => focusSessionWindow(sessionId));
          } else {
            void focusSessionWindow(sessionId);
          }
          return;
        }
        // Server-discovered sessions are not in the store yet; hydrate from
        // the row's own metadata synchronously so activation renders the chat
        // instead of falling through to home. The row mapping skipped
        // workspace persistence, so restore it here — opening the session
        // must land in the workspace the user last worked in.
        if (session && !useChatSessionStore.getState().getSession(sessionId)) {
          const persisted = loadPersistedChatWorkspaceMetadata(sessionId);
          useChatSessionStore.getState().addSession({
            ...session,
            workspaceAttachments:
              persisted?.workspaceAttachments ?? session.workspaceAttachments,
            activeWorkspaceId:
              persisted?.activeWorkspaceId ?? session.activeWorkspaceId,
          });
        }
        selectSessionDirect(sessionId);
      });
    },
    [guardAppNavigation, isMultiWindowEnabled, selectSessionDirect],
  );

  const handleForkChat = useForkSession({ onForked: handleSelectSession });

  const handleOpenSettingsFromSearch = useCallback(
    (section: SectionId) => {
      guardAppNavigation(() => {
        setSearchDialogOpen(false);
        openSettings(section);
      });
    },
    [guardAppNavigation, openSettings],
  );

  const handleOpenExtensionFromSearch = useCallback(
    (_entry: ExtensionEntry) => {
      handleOpenSettingsFromSearch("connections");
    },
    [handleOpenSettingsFromSearch],
  );

  const handleOpenAutomationFromSearch = useCallback(
    (automationId: string, onNavigationAccepted?: () => void) => {
      if (!isAutomationsFeatureEnabled) {
        return;
      }
      guardAppNavigation(() => {
        onNavigationAccepted?.();
        replaceNextNavigationEntryRef.current = false;
        setAutomationsRoute({
          surface: "detail",
          automationId,
          tab: "details",
          selectedRunKey: null,
        });
        setActiveSession(null);
        clearSettingsSectionUrl();
        setActiveView("automations");
      });
    },
    [guardAppNavigation, isAutomationsFeatureEnabled, setActiveSession],
  );

  const handleNavigate = useCallback(
    (view: AppView) => {
      guardAppNavigation(() => {
        resetGlobalComposerTransition();
        if (view === "automations" && !isAutomationsFeatureEnabled) {
          setActiveView("home");
          return;
        }
        if (view === "builderbot" && !isBuilderbotSurfaceEnabled) {
          setActiveView("home");
          return;
        }
        if (view === "settings") {
          openSettings();
          return;
        }
        if (view === "design-system") {
          openDesignSystem();
          return;
        }
        if (view !== "chat" && view !== "search") {
          setActiveSession(null);
        }
        if (view === "skills") {
          setSkillsSkillId(null);
        }
        if (view === "agents") {
          setAgentsPersonaId(null);
        }
        if (view === "automations") {
          setAutomationsRoute({ surface: "overview" });
        }
        if (view === "builderbot") {
          setBuilderbotRoute({ surface: "overview" });
        }
        clearSettingsSectionUrl();
        setActiveView(view);
      });
    },
    [
      openDesignSystem,
      openSettings,
      guardAppNavigation,
      resetGlobalComposerTransition,
      setActiveSession,
      isAutomationsFeatureEnabled,
      isBuilderbotSurfaceEnabled,
    ],
  );

  const handleOpenProject = useCallback(
    (projectId: string) => {
      useProjectStore.getState().setActiveProject(projectId);
      handleNavigate("projects");
    },
    [handleNavigate],
  );

  useRegisterAppNavigationController({
    guardAppNavigation,
    selectSessionDirect,
    archiveChat,
    getActiveSessionId: () => useChatSessionStore.getState().activeSessionId,
    hasSession: (sessionId) =>
      Boolean(useChatSessionStore.getState().getSession(sessionId)),
    isSessionOpenInWindow: (sessionId) =>
      useSessionWindowStore.getState().isOpenInWindow(sessionId),
    focusSessionWindow,
    getAppContext: () => {
      const sessionStore = useChatSessionStore.getState();
      const activeSession = sessionStore.activeSessionId
        ? sessionStore.getSession(sessionStore.activeSessionId)
        : undefined;
      return {
        view: activeView,
        activeSessionId: sessionStore.activeSessionId,
        activeProjectId: activeSession?.projectId ?? null,
      };
    },
    activeView,
    isMultiWindowEnabled,
  });

  const navigateSkills = useCallback(
    (skillId: string | null, options?: AppNavigationUpdateOptions) => {
      guardAppNavigation(() => {
        replaceNextNavigationEntryRef.current = Boolean(options?.replace);
        setSkillsSkillId(skillId);
        setActiveSession(null);
        clearSettingsSectionUrl();
        setActiveView("skills");
      });
    },
    [guardAppNavigation, setActiveSession],
  );

  const navigateAgentsDirect = useCallback(
    (personaId: string | null, options?: AppNavigationUpdateOptions) => {
      replaceNextNavigationEntryRef.current = Boolean(options?.replace);
      setAgentsPersonaId(personaId);
      setActiveSession(null);
      clearSettingsSectionUrl();
      setActiveView("agents");
    },
    [setActiveSession],
  );
  const navigateAgents = useCallback(
    (personaId: string | null, options?: AppNavigationUpdateOptions) => {
      guardAppNavigation(() => {
        navigateAgentsDirect(personaId, options);
      });
    },
    [guardAppNavigation, navigateAgentsDirect],
  );
  const handleAgentBuilderCompleted = useCallback(
    (agentId: string) => {
      navigateAgentsDirect(agentId);
    },
    [navigateAgentsDirect],
  );

  const navigateAutomations = useCallback(
    (
      route: AutomationNavigationRoute,
      options?: AppNavigationUpdateOptions,
    ) => {
      if (!isAutomationsFeatureEnabled) {
        return;
      }
      guardAppNavigation(() => {
        replaceNextNavigationEntryRef.current = Boolean(options?.replace);
        setAutomationsRoute(route);
        setActiveSession(null);
        clearSettingsSectionUrl();
        setActiveView("automations");
      });
    },
    [guardAppNavigation, isAutomationsFeatureEnabled, setActiveSession],
  );

  const navigateBuilderbot = useCallback(
    (
      route: BuilderbotNavigationRoute,
      options?: AppNavigationUpdateOptions,
    ) => {
      if (!isBuilderbotSurfaceEnabled) {
        return;
      }
      guardAppNavigation(() => {
        replaceNextNavigationEntryRef.current = Boolean(options?.replace);
        setBuilderbotRoute(route);
        setActiveSession(null);
        clearSettingsSectionUrl();
        setActiveView("builderbot");
      });
    },
    [guardAppNavigation, isBuilderbotSurfaceEnabled, setActiveSession],
  );

  const applyNavigationLocation = useCallback(
    (location: AppNavigationLocation) => {
      navigationHistoryRef.current.isApplying = true;

      if (location.view === "settings") {
        setActiveSettingsSection(location.settingsSection);
        setSettingsSectionUrl(location.settingsSection);
        setActiveView("settings");
        if (sidebarCollapsed) {
          void expandSidebar();
        }
        return;
      }

      if (
        location.view === "design-system" &&
        isDesignSystemExplorerEnabled()
      ) {
        setActiveDesignSystemSection(location.designSystemSection);
        setDesignSystemUrl();
        setActiveView("design-system");
        if (sidebarCollapsed) {
          void expandSidebar();
        }
        return;
      }

      clearSettingsSectionUrl();

      if (location.view === "skills") {
        setActiveSession(null);
        setSkillsSkillId(location.skillId);
        setActiveView("skills");
        return;
      }

      if (location.view === "agents") {
        setActiveSession(null);
        setAgentsPersonaId(location.personaId);
        setActiveView("agents");
        return;
      }

      if (location.view === "automations") {
        if (!isAutomationsFeatureEnabled) {
          setActiveSession(null);
          setActiveView("home");
          return;
        }
        setActiveSession(null);
        setAutomationsRoute(location.route);
        setActiveView("automations");
        return;
      }

      if (location.view === "builderbot") {
        if (!isBuilderbotSurfaceEnabled) {
          setActiveSession(null);
          setActiveView("home");
          return;
        }
        setActiveSession(null);
        setBuilderbotRoute(location.route);
        setActiveView("builderbot");
        return;
      }

      if (location.view === "search") {
        setActiveView("search");
        return;
      }

      if (location.view === "chat" && location.sessionId) {
        const session = useChatSessionStore
          .getState()
          .getSession(location.sessionId);

        if (session && !session.archivedAt) {
          setActiveSession(location.sessionId);
          setActiveView("chat");
          setChatActiveSession(location.sessionId);
          useChatStore.getState().markSessionRead(location.sessionId);
          void loadSessionMessagesAndPrepare(location.sessionId);
          return;
        }
      }

      setActiveSession(null);
      setActiveView(location.view === "chat" ? "home" : location.view);
    },
    [
      expandSidebar,
      isAutomationsFeatureEnabled,
      isBuilderbotSurfaceEnabled,
      setActiveSession,
      setChatActiveSession,
      sidebarCollapsed,
    ],
  );

  const goBack = useCallback(() => {
    if (activeView === "settings" && returnToVoiceSettingsTarget()) {
      updateNavigationAvailability();
      return;
    }
    if (activeView === "settings" && agentBuilderSettingsReturnTarget) {
      const history = navigationHistoryRef.current;
      const previousLocation =
        history.index > 0 ? history.entries[history.index - 1] : null;
      if (
        previousLocation?.view === "chat" &&
        previousLocation.sessionId ===
          agentBuilderSettingsReturnTarget.sessionId
      ) {
        history.index -= 1;
        if (returnToAgentBuilderSettingsTarget()) {
          updateNavigationAvailability();
          return;
        }
        history.index += 1;
      }
    }

    guardAppNavigation(() => {
      const history = navigationHistoryRef.current;
      if (history.index <= 0) {
        return;
      }

      history.index -= 1;
      applyNavigationLocation(history.entries[history.index]);
      updateNavigationAvailability();
    });
  }, [
    activeView,
    agentBuilderSettingsReturnTarget,
    applyNavigationLocation,
    guardAppNavigation,
    returnToAgentBuilderSettingsTarget,
    returnToVoiceSettingsTarget,
    updateNavigationAvailability,
  ]);

  const goForward = useCallback(() => {
    guardAppNavigation(() => {
      const history = navigationHistoryRef.current;
      if (history.index >= history.entries.length - 1) {
        return;
      }

      history.index += 1;
      applyNavigationLocation(history.entries[history.index]);
      updateNavigationAvailability();
    });
  }, [
    applyNavigationLocation,
    guardAppNavigation,
    updateNavigationAvailability,
  ]);

  const handleExitSearch = useCallback(() => {
    const history = navigationHistoryRef.current;
    if (history.index > 0) {
      goBack();
      return;
    }

    guardAppNavigation(() => {
      clearSettingsSectionUrl();
      setActiveSession(null);
      setActiveView("home");
    });
  }, [goBack, guardAppNavigation, setActiveSession]);

  const toggleRightRail = useCallback(() => {
    if (!activeSessionId) {
      return;
    }

    const nextOpen = !isContextVisible;
    if (nextOpen && isAgentBuilderVisible(activeSession)) {
      useChatSessionStore.getState().patchSession(activeSessionId, {
        agentBuilderContextState: "userOpened",
      });
    }
    setRightRailOpen(nextOpen);
  }, [activeSession, activeSessionId, isContextVisible, setRightRailOpen]);

  const feedbackOpen = useFeedbackDialogStore((state) => state.open);
  const feedbackDraft = useFeedbackDialogStore((state) => state.draft);
  const openFeedbackDialog = useFeedbackDialogStore(
    (state) => state.openDialog,
  );
  const setFeedbackOpen = useFeedbackDialogStore((state) => state.setOpen);
  const shortcutsOpen = useShortcutsDialogStore((state) => state.open);
  const setShortcutsOpen = useShortcutsDialogStore((state) => state.setOpen);
  const handleFeedbackClick = useCallback(() => {
    if (!isFeedbackEnabled) {
      return;
    }
    openFeedbackDialog();
  }, [isFeedbackEnabled, openFeedbackDialog]);

  useEffect(() => {
    if (!isFeedbackEnabled) {
      setFeedbackOpen(false);
    }
  }, [isFeedbackEnabled, setFeedbackOpen]);

  const startupIssue = useMemo(
    () =>
      startup.error
        ? buildStartupDiagnosticIssue(startup.error, startup.probe)
        : null,
    [startup.error, startup.probe],
  );
  const forceStartupLoading =
    import.meta.env.DEV &&
    new URLSearchParams(window.location.search).has("startupLoading");
  const isGlobalComposerHandoff = globalComposerPlacement === "handoff";
  const isGlobalComposerRouteDisallowed =
    targetLocation.view === "automations" &&
    targetLocation.route.surface === "builder";
  const canShowGlobalComposer =
    startup.ready &&
    !forceStartupLoading &&
    !startupIssue &&
    children == null &&
    (!isPreparingContent || globalComposerPlacement === "handoff") &&
    !isGlobalComposerRouteDisallowed;
  const canUseGlobalComposerShortcut =
    startup.ready && !forceStartupLoading && !startupIssue && children == null;
  const showGlobalComposer =
    canShowGlobalComposer &&
    (globalComposerPlacement !== "docked" || renderedLocation.view !== "chat");
  const mountGlobalComposer = showGlobalComposer || retainGlobalComposerDraft;
  const showGlobalComposerShim =
    canShowGlobalComposer && globalComposerPlacement !== "docked";

  useEffect(() => {
    if (
      retainGlobalComposerDraft &&
      showGlobalComposer &&
      globalComposerPlacement === "centered"
    ) {
      setRetainGlobalComposerDraft(false);
    }
  }, [globalComposerPlacement, retainGlobalComposerDraft, showGlobalComposer]);

  useEffect(() => {
    if (
      globalComposerPlacement === "docked" ||
      !isGlobalComposerRouteDisallowed
    ) {
      return;
    }

    resetGlobalComposerTransition();
  }, [
    globalComposerPlacement,
    isGlobalComposerRouteDisallowed,
    resetGlobalComposerTransition,
  ]);

  const handleGlobalComposerHandoffStart = useCallback(
    (rect: GlobalComposerHandoffRect) => {
      setGlobalComposerHandoffSourceRect(rect);
      setGlobalComposerHandoffTargetRect(null);
    },
    [],
  );
  const handleChatComposerHandoffTarget = useCallback(
    (rect: GlobalComposerHandoffRect) => {
      setGlobalComposerHandoffTargetRect((current) => current ?? rect);
    },
    [],
  );
  const dismissCenteredGlobalComposer = useCallback(() => {
    if (globalComposerPlacement === "centered") {
      resetGlobalComposerTransition();
    }
  }, [globalComposerPlacement, resetGlobalComposerTransition]);

  const topBarBreadcrumbs = useMemo<TopBarBreadcrumb[]>(() => {
    switch (activeView) {
      case "chat": {
        if (!activeSession?.title) {
          return [current("root", "Home")];
        }
        const chatProject = activeSession.projectId
          ? (projects.find((p) => p.id === activeSession.projectId) ?? null)
          : null;
        // "Chat" and the project segment are intentionally non-clickable for now:
        // neither destination exists yet (no chats-list view, no per-project surface).
        // Swap `current` → `parent` with a real onClick when those routes land.
        return chatProject
          ? [
              current("chat", "Chat"),
              current("chat-project", chatProject.name),
              current("chat-session", activeSession.title),
            ]
          : [
              current("chat", "Chat"),
              current("chat-session", activeSession.title),
            ];
      }
      case "skills":
        return skillsSkillId && skillsBreadcrumbLabel
          ? [
              parent("skills", t("sidebar:navigation.skills"), () =>
                handleNavigate("skills"),
              ),
              current("skill-detail", skillsBreadcrumbLabel),
            ]
          : [current("skills", t("sidebar:navigation.skills"))];
      case "agents":
        return agentsPersonaId && agentsBreadcrumbLabel
          ? [
              parent("agents", "Agents", () => handleNavigate("agents")),
              current("agent-detail", agentsBreadcrumbLabel),
            ]
          : [current("agents", "Agents")];
      case "automations":
        return automationsBreadcrumbLabel
          ? [
              parent("automations", "Automations", () =>
                handleNavigate("automations"),
              ),
              current("automation-detail", automationsBreadcrumbLabel),
            ]
          : [current("automations", "Automations")];
      case "builderbot":
        if (!builderbotBreadcrumbLabel) {
          return [current("builderbot", "Builderbot")];
        }
        if (builderbotRoute.surface === "task") {
          return [
            parent("builderbot", "Builderbot", () =>
              navigateBuilderbot({ surface: "overview" }),
            ),
            parent("builderbot-tasks", "Tasks", () =>
              navigateBuilderbot({ surface: "overview", tab: "tasks" }),
            ),
            current("builderbot-detail", builderbotBreadcrumbLabel),
          ];
        }
        if (builderbotRoute.surface === "automation") {
          return [
            parent("builderbot", "Builderbot", () =>
              navigateBuilderbot({ surface: "overview" }),
            ),
            parent("builderbot-automations", "Automations", () =>
              navigateBuilderbot({ surface: "overview", tab: "automations" }),
            ),
            current("builderbot-detail", builderbotBreadcrumbLabel),
          ];
        }
        return [current("builderbot", "Builderbot")];
      case "design-system": {
        const designSystemSectionLabel = DESIGN_SYSTEM_SECTIONS.find(
          (section) => section.id === activeDesignSystemSection,
        )?.label;
        const showDesignSystemSection =
          activeDesignSystemSection !== DEFAULT_DESIGN_SYSTEM_SECTION &&
          Boolean(designSystemSectionLabel);

        return showDesignSystemSection && designSystemSectionLabel
          ? [
              parent("design-system", "Design System", () => {
                setActiveDesignSystemSection(DEFAULT_DESIGN_SYSTEM_SECTION);
                openDesignSystem();
              }),
              current("design-system-section", designSystemSectionLabel),
            ]
          : [current("design-system", "Design System")];
      }
      case "settings": {
        const settingsSection = SETTINGS_SECTIONS.find(
          (section) => section.id === activeSettingsSection,
        );
        const showSettingsSection =
          activeSettingsSection !== DEFAULT_SETTINGS_SECTION &&
          Boolean(settingsSection);

        if (!showSettingsSection || !settingsSection) {
          return [current("settings", "Settings")];
        }

        // rev 4: Doctor no longer needs a "back to parent section"
        // breadcrumb segment here -- it moved from a hidden sub-page (routed
        // through activeSettingsSection) to a dialog opened directly from a
        // row inside System, so it never becomes the active settings
        // section in the first place.
        return [
          parent("settings", "Settings", () =>
            openSettings(DEFAULT_SETTINGS_SECTION),
          ),
          current(
            "settings-section",
            t(`settings:${settingsSection.labelKey}`),
          ),
        ];
      }
      case "projects":
        return [current("projects", "Projects")];
      case "search":
        return [current("search", "Search")];
      case "session-history":
        return [current("session-history", "Session History")];
      case "home":
        return [current("root", "Home")];
    }
  }, [
    activeDesignSystemSection,
    activeSession?.projectId,
    activeSession?.title,
    activeSettingsSection,
    activeView,
    agentsBreadcrumbLabel,
    agentsPersonaId,
    automationsBreadcrumbLabel,
    builderbotBreadcrumbLabel,
    builderbotRoute.surface,
    handleNavigate,
    navigateBuilderbot,
    openDesignSystem,
    openSettings,
    projects,
    skillsBreadcrumbLabel,
    skillsSkillId,
    t,
  ]);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.isComposing || e.repeat) {
        return;
      }
      if (eventMatchesShortcutCommand(e, "view.toggleDesignSystemInspector")) {
        e.preventDefault();
        setDesignSystemInspectorModeToggleRequest(0);
        setDesignSystemInspectorVisible((visible) => !visible);
        return;
      }
      if (
        eventMatchesShortcutCommand(e, "view.toggleDesignSystemInspectorMode")
      ) {
        e.preventDefault();
        setDesignSystemInspectorVisible(true);
        setDesignSystemInspectorModeToggleRequest((request) => request + 1);
        return;
      }
      // Toggles the keyboard shortcuts reference. Handled before the layer
      // guard so it can close its own (modal) dialog.
      if (eventMatchesShortcutCommand(e, "help.shortcuts")) {
        e.preventDefault();
        useShortcutsDialogStore.getState().toggle();
        return;
      }
      // Any mounted modal/popper owns the keyboard (matching the transcript
      // search and pane-jump guards).
      if (hasOpenKeyboardOwningLayer()) {
        return;
      }
      // Dismiss the centered global composer on Escape from anywhere once
      // nested menus/popovers have had the chance to handle Escape first.
      if (
        e.key === "Escape" &&
        !e.defaultPrevented &&
        globalComposerPlacement === "centered"
      ) {
        e.preventDefault();
        resetGlobalComposerTransition();
        return;
      }
      // Navigation history (defaults mod+[ / mod+])
      if (
        eventMatchesShortcutCommand(e, "navigation.back") &&
        !e.defaultPrevented &&
        !isTerminalOwnedHistoryShortcut(e)
      ) {
        e.preventDefault();
        goBack();
        return;
      }
      if (
        eventMatchesShortcutCommand(e, "navigation.forward") &&
        !e.defaultPrevented &&
        !isTerminalOwnedHistoryShortcut(e)
      ) {
        e.preventDefault();
        goForward();
        return;
      }
      // Settings (default mod+,)
      if (eventMatchesShortcutCommand(e, "navigation.openSettings")) {
        e.preventDefault();
        if (activeView === "settings") {
          leaveSecondarySurface();
          return;
        }
        handleNavigate("settings");
        return;
      }
      // Sidebar toggle (default mod+b)
      if (eventMatchesShortcutCommand(e, "view.toggleSidebar")) {
        e.preventDefault();
        toggleSidebar();
        return;
      }
      // Global search dialog (default mod+k).
      if (eventMatchesShortcutCommand(e, "navigation.search")) {
        e.preventDefault();
        setSearchDialogOpen(true);
        return;
      }
      // Session quick switcher (default mod+p)
      if (eventMatchesShortcutCommand(e, "session.quickSwitch")) {
        e.preventDefault();
        setQuickSwitcherOpen((open) => !open);
        return;
      }
      // Cycle sessions by recency (defaults ctrl+tab / ctrl+shift+tab)
      const cycleDirection = eventMatchesShortcutCommand(e, "session.next")
        ? 1
        : eventMatchesShortcutCommand(e, "session.previous")
          ? -1
          : null;
      if (cycleDirection !== null) {
        e.preventDefault();
        const { sessions, activeSessionId } = useChatSessionStore.getState();
        const sessionWindowStore = useSessionWindowStore.getState();
        const candidates = getVisibleSessions(
          sessions,
          selectLocalMessageCountsBySession(useChatStore.getState()),
        ).filter(
          (session) =>
            !session.archivedAt &&
            // Sessions open in other windows aren't part of this window's
            // cycle order.
            !(
              isMultiWindowEnabled &&
              sessionWindowStore.isOpenInWindow(session.id)
            ),
        );
        const currentSessionId =
          activeView === "chat" && activeSessionId
            ? resolveLiveSessionId(activeSessionId)
            : null;
        const targetId = resolveSessionCycleTarget(
          candidates,
          currentSessionId,
          cycleDirection,
        );
        if (targetId) {
          handleSelectSession(targetId);
        }
        return;
      }
      // Archive the current chat/session (default mod+e)
      if (eventMatchesShortcutCommand(e, "chat.archiveSession")) {
        if (e.defaultPrevented || isArchiveShortcutBlockedTarget(e.target)) {
          return;
        }
        const { activeSessionId } = useChatSessionStore.getState();
        const sessionId =
          activeView === "chat" && activeSessionId
            ? resolveLiveSessionId(activeSessionId)
            : null;
        if (!sessionId) {
          return;
        }
        e.preventDefault();
        void handleArchiveChat(sessionId);
        return;
      }
      // Returns to home instead of closing the window (default mod+w)
      if (eventMatchesShortcutCommand(e, "navigation.closeSession")) {
        e.preventDefault();
        const { activeSessionId } = useChatSessionStore.getState();
        if (activeSessionId) {
          clearActiveSession(activeSessionId);
        } else if (activeView === "design-system") {
          closeDesignSystem();
        } else if (activeView === "settings") {
          clearSettingsSectionUrl();
          setActiveView("home");
        }
        return;
      }
      // Open the floating new conversation composer (default mod+n).
      if (eventMatchesShortcutCommand(e, "navigation.newConversation")) {
        e.preventDefault();
        if (!canUseGlobalComposerShortcut) {
          return;
        }
        guardAppNavigation(() => {
          clearGlobalComposerHandoffTimer();
          setChatComposerHandoffSessionId(null);
          setGlobalComposerHandoffSourceRect(null);
          setGlobalComposerHandoffTargetRect(null);
          if (!canShowGlobalComposer) {
            setActiveSession(null);
            clearSettingsSectionUrl();
            setActiveView("home");
          }
          setGlobalComposerPlacement("centered");
          setGlobalComposerFocusRequest((request) => request + 1);
        });
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [
    activeView,
    canShowGlobalComposer,
    canUseGlobalComposerShortcut,
    clearActiveSession,
    clearGlobalComposerHandoffTimer,
    closeDesignSystem,
    globalComposerPlacement,
    goBack,
    goForward,
    guardAppNavigation,
    handleArchiveChat,
    handleNavigate,
    handleSelectSession,
    isMultiWindowEnabled,
    leaveSecondarySurface,
    resetGlobalComposerTransition,
    setDesignSystemInspectorVisible,
    setActiveSession,
    toggleSidebar,
  ]);

  useEffect(() => {
    if (showGlobalComposer) {
      document.documentElement.setAttribute(
        "data-global-composer-visible",
        "true",
      );
    } else {
      document.documentElement.removeAttribute("data-global-composer-visible");
    }

    return () => {
      document.documentElement.removeAttribute("data-global-composer-visible");
    };
  }, [showGlobalComposer]);

  const derivedStarterTaskCompletion = useMemo(
    () =>
      deriveStarterTaskCompletion({
        providerReady: defaultProviderReadinessStatus === "ready",
        sessionsHydrated: hasHydratedSessions,
        sessions,
        messagesBySession,
        projectsFetched: hasFetchedProjects,
        projects,
      }),
    [
      defaultProviderReadinessStatus,
      hasHydratedSessions,
      sessions,
      messagesBySession,
      hasFetchedProjects,
      projects,
    ],
  );
  useEffect(() => {
    const completedTaskIds = [...starterTasksAwaitingCompletion].filter(
      (taskId) => derivedStarterTaskCompletion[taskId],
    );
    if (completedTaskIds.length === 0) return;

    setStarterTasksAwaitingCompletion((awaiting) => {
      const next = new Set(awaiting);
      for (const taskId of completedTaskIds) next.delete(taskId);
      return next;
    });
    setStarterTaskOverrides((overrides) => {
      const next = { ...overrides };
      for (const taskId of completedTaskIds) next[taskId] = true;
      return next;
    });
  }, [derivedStarterTaskCompletion, starterTasksAwaitingCompletion]);

  const starterTaskCompletion = starterTaskOverrides;

  useEffect(() => {
    if (omittedStarterTaskIds.size === 0) return;
    setStarterTasksAwaitingCompletion((awaiting) => {
      const next = new Set(awaiting);
      for (const taskId of omittedStarterTaskIds) next.delete(taskId);
      return next.size === awaiting.size ? awaiting : next;
    });
  }, [omittedStarterTaskIds]);

  useEffect(() => {
    saveStarterTaskProgress({
      completion: starterTaskOverrides,
      awaiting: starterTasksAwaitingCompletion,
    });
  }, [starterTaskOverrides, starterTasksAwaitingCompletion]);

  useEffect(() => {
    if (!starterTasksDocked) return;
    if (renderedLocation.view !== "home") {
      starterTasksLeftHomeRef.current = true;
      return;
    }
    if (starterTasksLeftHomeRef.current) {
      starterTasksLeftHomeRef.current = false;
      setStarterTasksDocked(false);
    }
  }, [renderedLocation.view, starterTasksDocked]);

  useEffect(() => {
    const handleStarterWidgetAdded = () => {
      setStarterTasksAwaitingCompletion((awaiting) => {
        if (!awaiting.has("add-widget")) return awaiting;
        const next = new Set(awaiting);
        next.delete("add-widget");
        return next;
      });
      setStarterTaskOverrides((overrides) => ({
        ...overrides,
        "add-widget": true,
      }));
    };
    window.addEventListener(
      STARTER_WIDGET_ADDED_EVENT,
      handleStarterWidgetAdded,
    );
    return () =>
      window.removeEventListener(
        STARTER_WIDGET_ADDED_EVENT,
        handleStarterWidgetAdded,
      );
  }, []);

  const handleStarterTaskToggle = (taskId: StarterTaskId) => {
    setStarterTasksAwaitingCompletion((awaiting) => {
      if (!awaiting.has(taskId)) return awaiting;
      const next = new Set(awaiting);
      next.delete(taskId);
      return next;
    });
    setStarterTaskOverrides((overrides) => ({
      ...overrides,
      [taskId]: !overrides[taskId],
    }));
  };

  const handleStarterProjectCreated = (projectId: string) => {
    setStarterProjectId(projectId);
    setStarterTasksAwaitingCompletion((awaiting) => {
      const next = new Set(awaiting);
      next.delete("create-project");
      return next;
    });
    setStarterTaskOverrides((overrides) => ({
      ...overrides,
      "create-project": true,
    }));
    const homeWidgetState = useHomeWidgetStore.getState();
    const starterProject = homeWidgetState.instances.find(
      (instance) =>
        instance.type === "onboardingProjectArtifact" ||
        instance.state?.onboardingStarterProject === true,
    );
    if (starterProject) {
      homeWidgetState.updateWidgetState(starterProject.id, {
        ...starterProject.state,
        projectId,
      });
    }
  };

  const handleStarterTaskSelect = (taskId: StarterTaskId) => {
    if (starterProjectStickyExitTimerRef.current !== null) {
      window.clearTimeout(starterProjectStickyExitTimerRef.current);
      starterProjectStickyExitTimerRef.current = null;
      setStarterProjectStickyExiting(false);
    }
    const selectTask = () => {
      setSelectedStarterTaskId(taskId);
      // The widget task stays on Home. Keep the existing canvas sticky mounted
      // so its content can crossfade instead of replacing it with an overlay.
      setStarterTasksDocked(taskId !== "add-widget");
      starterTasksLeftHomeRef.current = renderedLocation.view !== "home";
      if (derivedStarterTaskCompletion[taskId]) {
        setStarterTaskOverrides((overrides) => ({
          ...overrides,
          [taskId]: true,
        }));
      } else {
        setStarterTasksAwaitingCompletion((awaiting) =>
          new Set(awaiting).add(taskId),
        );
      }
    };
    if (taskId !== "add-widget") selectTask();
    switch (taskId) {
      case "connect-provider":
        openSettings("providers");
        break;
      case "start-chat":
        void createNewTab();
        break;
      case "create-project":
        openCreateProjectDialog({ onCreated: handleStarterProjectCreated });
        break;
      case "add-widget":
        guardAppNavigation(() => {
          selectTask();
          setActiveSession(null);
          clearSettingsSectionUrl();
          setActiveView("home");
          window.setTimeout(requestStarterWidgetPicker, 0);
        });
        break;
    }
  };

  const handleCloseStarterTaskSecondary = () => {
    setSelectedStarterTaskId(null);
    setStarterTasksDocked(false);
  };

  const handleStarterTasksBackHome = () => {
    setSelectedStarterTaskId(null);
    setStarterTasksDocked(false);
    handleNavigate("home");
  };

  const dismissStarterTasks = () => {
    recordAssistiveMomentRetired("home.starterTasks", "dismissed");
    setStarterTasksEligible(false);
  };

  const restoreStarterTasks = () => {
    resetAssistiveUxMoment("home.starterTasks");
    setStarterTasksDocked(false);
    setSelectedStarterTaskId(null);
    setStarterTasksEligible(true);
  };

  // The dev-only `?startupLoading` override still preempts everything, so the
  // loader stays inspectable on a fresh install.
  if (forceStartupLoading) {
    return <StartupLoadingView />;
  }

  // The first-run landing ceremony comes before startup gates because it needs
  // nothing from the chat runtime. Advancing completes the ceremony and then
  // exposes the normal loading or diagnostic surface until startup settles.
  if (onboardingState.lifecycle !== "completed") {
    return <OnboardingFlow />;
  }

  if (!startup.ready || !startupLoadingMinElapsed) {
    return <StartupLoadingView />;
  }

  if (startupIssue) {
    return (
      <StartupDiagnosticView issue={startupIssue} onRetry={startup.retry} />
    );
  }

  return (
    <FocusRegionProvider>
      <AppShellLayout
        topBar={{
          breadcrumbs: topBarBreadcrumbs,
          sidebarCollapsed,
          canGoBack: navigationAvailability.canGoBack,
          canGoForward: navigationAvailability.canGoForward,
          onToggleSidebar: toggleSidebar,
          onHomeClick: () => handleNavigate("home"),
          onGoBack: goBack,
          onGoForward: goForward,
          showRightRailToggle:
            activeView === "chat" && Boolean(activeSessionId),
          chromeInsets: topBarChromeInsets,
          rightRailOpen: isContextVisible,
          rightRailLabel,
          onToggleRightRail: toggleRightRail,
          onFeedbackClick: isFeedbackEnabled ? handleFeedbackClick : undefined,
          onSearchClick: () => setSearchDialogOpen(true),
        }}
        navigationPanes={{
          collapsed: false,
          width: sidebarWidth,
          isResizing: sidebarIsResizing,
          onSettingsClick: () => handleNavigate("settings"),
          onSettingsBack: leaveSecondarySurface,
          onSettingsSectionChange: selectSettingsSection,
          onNavigate: handleNavigate,
          onNewChatInProject: handleNewChatInProject,
          onNewChat: () => {
            guardAppNavigation(() => {
              void createNewTab(DEFAULT_CHAT_TITLE).catch((error) => {
                console.error("Failed to start new chat:", error);
              });
            });
          },
          onCreateProject: () => openCreateProjectDialog(),
          onEditProject: handleEditProject,
          onOpenProject: handleOpenProject,
          onArchiveProject: handleArchiveProject,
          onArchiveChat: handleArchiveChat,
          onRenameChat: handleRenameChat,
          onForkChat: handleForkChat,
          onMarkChatRead: handleMarkChatRead,
          onMarkChatUnread: handleMarkChatUnread,
          onMoveToProject: handleMoveToProject,
          onReorderProject: reorderProjects,
          onSelectSession: handleSelectSession,
          activeView,
          activeSettingsSection,
          activeSessionId,
          onProjectCreatedRevisionHandled: (revision) =>
            setProjectCreatedRevision((current) =>
              current === revision ? 0 : current,
            ),
          projectCreatedRevision,
          projects,
          className: "h-full rounded-md",
        }}
        sidebarCollapsed={sidebarCollapsed}
        sidebarContentAnchor="right"
        sidebarOuterWidth={sidebarDockedOuterWidth}
        sidebarPanelOuterWidth={sidebarDockedPanelOuterWidth}
        isResizing={sidebarIsResizing}
        resizeHandleHeight={resizeHandleHeight}
        resizeHandleWidth={resizeHandleWidth}
        sidebarOuterHeight={sidebarOuterHeight}
        onResizeStart={handleResizeStart}
        onResizeDoubleClick={handleResizeDoubleClick}
        onHeightResizeStart={handleHeightResizeStart}
        onHeightResizeDoubleClick={handleHeightResizeDoubleClick}
        onCornerResizeStart={handleCornerResizeStart}
        onCornerResizeDoubleClick={handleCornerResizeDoubleClick}
        contentUnderSidebar={activeView === "home"}
        contentUnderTopBar={activeView === "home"}
        projectTint={activeView === "chat" ? activeProjectTint : null}
        designSystemInspectorModeToggleRequest={
          designSystemInspectorModeToggleRequest
        }
        onOpenDesignSystemExplorer={() => handleNavigate("design-system")}
        showDesignSystemInspector={designSystemInspectorVisible}
        contentTakeover={activeView === "design-system"}
        createProjectDialog={{
          isOpen: createProjectOpen,
          onClose: () => {
            const closingStarterProjectTask =
              selectedStarterTaskId === "create-project" && starterTasksDocked;
            if (closingStarterProjectTask) {
              setStarterProjectStickyExiting(true);
            }
            closeCreateProjectDialog();
            setStarterTasksAwaitingCompletion((awaiting) => {
              if (!awaiting.has("create-project")) return awaiting;
              const next = new Set(awaiting);
              next.delete("create-project");
              return next;
            });
            if (starterTasksDocked && renderedLocation.view === "home") {
              if (closingStarterProjectTask) {
                starterProjectStickyExitTimerRef.current = window.setTimeout(
                  () => {
                    starterProjectStickyExitTimerRef.current = null;
                    setSelectedStarterTaskId(null);
                    setStarterTasksDocked(false);
                    setStarterProjectStickyExiting(false);
                  },
                  300,
                );
              } else {
                setStarterTasksDocked(false);
              }
            }
          },
          onCreated: handleProjectCreated,
          initialWorkingDir: createProjectInitialWorkingDir,
          editingProject: editingProject ?? undefined,
          // Keep the visual modal backdrop, but let keyboard focus move between
          // the starter-task sticky and the project panel.
          modal: selectedStarterTaskId !== "create-project",
        }}
      >
        {children ?? (
          <StarterTasksProvider
            value={{
              completionState: starterTaskCompletion,
              enabled: starterTasksExperimentEnabled,
              visible: starterTasksVisible,
              docked: starterTasksDocked,
              selectedTaskId: selectedStarterTaskId,
              starterProjectId,
              omittedTaskIds: omittedStarterTaskIds,
              onTaskSelect: handleStarterTaskSelect,
              onTaskToggle: handleStarterTaskToggle,
              onBackHome: handleStarterTasksBackHome,
              onCloseSecondary: handleCloseStarterTaskSecondary,
              onDismiss: dismissStarterTasks,
              onRestore: restoreStarterTasks,
            }}
          >
            <AppShellContent
              targetLocation={targetLocation}
              renderedLocation={renderedLocation}
              designSystemInspectorVisible={designSystemInspectorVisible}
              onCloseDesignSystem={closeDesignSystem}
              onDesignSystemInspectorVisibleChange={
                setDesignSystemInspectorVisible
              }
              onDesignSystemSectionChange={selectDesignSystemSection}
              authStatus={authStatus}
              isPreparingContent={isPreparingContent}
              automationsEnabled={isAutomationsFeatureEnabled}
              builderbotEnabled={isBuilderbotSurfaceEnabled}
              renderedSession={renderedSession}
              homeSessionId={homeSessionId}
              homeProviderSetupRequired={providerSetupRequiredForHome}
              chatComposerHandoffRequest={chatComposerHandoffRequest}
              chatComposerHandoffSessionId={chatComposerHandoffSessionId}
              chatComposerHandoffActive={isGlobalComposerHandoff}
              chatComposerHandoffInProgress={isGlobalComposerHandoff}
              onChatComposerHandoffTarget={handleChatComposerHandoffTarget}
              onWorkspaceNameRequest={enqueueWorkspaceNameRequest}
              homeViewportLeftOcclusionPx={
                renderedLocation.view === "home" ? sidebarDockedOuterWidth : 0
              }
              chatViewportLeftOcclusionPx={
                renderedLocation.view === "chat" ? sidebarDockedOuterWidth : 0
              }
              onNavigateSkills={navigateSkills}
              onNavigateAgents={navigateAgents}
              onNavigateAutomations={navigateAutomations}
              onNavigateBuilderbot={navigateBuilderbot}
              onSkillsBreadcrumbLabelChange={setSkillsBreadcrumbLabel}
              onAgentsBreadcrumbLabelChange={setAgentsBreadcrumbLabel}
              onAutomationsBreadcrumbLabelChange={setAutomationsBreadcrumbLabel}
              onBuilderbotBreadcrumbLabelChange={setBuilderbotBreadcrumbLabel}
              onAutomationBuilderLeaveActionChange={
                handleAutomationBuilderLeaveActionChange
              }
              onCreatePersona={agentBuilder.create}
              onAgentBuilderCompleted={handleAgentBuilderCompleted}
              onStartAgentBuilderSession={agentBuilder.start}
              onArchiveChat={handleArchiveChat}
              onCreateProject={(options) => {
                if (starterTasksVisible) {
                  setStarterTasksAwaitingCompletion((awaiting) =>
                    new Set(awaiting).add("create-project"),
                  );
                  openCreateProjectDialog({
                    onCreated: (projectId) => {
                      handleStarterProjectCreated(projectId);
                      options?.onCreated?.(projectId);
                    },
                  });
                  return;
                }
                openCreateProjectDialog(options);
              }}
              onOpenProjectSettings={handleEditProject}
              onActivateHomeSession={activateHomeSession}
              onRenameChat={handleRenameChat}
              onForkChat={handleForkChat}
              onSelectSession={handleSelectSession}
              onSelectSearchResult={handleSelectSearchResult}
              onStartChatFromProjectId={handleStartProjectChat}
              onStartChatFromProject={handleStartChatFromProject}
              onStartProjectChat={handleStartProjectChat}
              onStartChatWithSkill={handleStartChatWithSkill}
              onResolveBerdyAgent={handleResolveBerdyAgent}
              onExitSearch={handleExitSearch}
              onOpenExtension={handleOpenExtensionFromSearch}
              onOpenAgent={handleStartChatWithAgent}
              onOpenAutomation={handleOpenAutomationFromSearch}
              onOpenSkill={handleStartChatWithSkill}
              onTagHomeComposerAgent={handleTagHomeComposerAgent}
              onTagHomeComposerProject={handleTagHomeComposerProject}
              onTagHomeComposerSkill={handleTagHomeComposerSkill}
              onRunPinnedPrompt={handleRunPinnedPrompt}
              onHydratePinnedChatSessions={hydratePinnedChatSessions}
              onLoggedOut={onLoggedOut}
              onStartProviderTroubleshootingChat={
                handleStartProviderTroubleshootingChat
              }
              onStartConnectionSetupChat={handleStartConnectionSetupChat}
              onReturnToAgentDraft={
                agentBuilderSettingsReturnTarget
                  ? returnToAgentBuilderSettingsTarget
                  : undefined
              }
              onOpenProvidersSettings={() => openSettings("providers")}
            />
            {starterTasksVisible && starterTasksDocked ? (
              <StarterTaskList
                completionState={starterTaskCompletion}
                omittedTaskIds={omittedStarterTaskIds}
                mode="overlay"
                selectedTaskId={selectedStarterTaskId}
                labels={{
                  title: t("home:onboarding.starterTasks.title"),
                  backHome: t("home:onboarding.starterTasks.backHome"),
                  backToList: t("home:onboarding.starterTasks.backToList"),
                  markDone: t("home:onboarding.starterTasks.markDone"),
                  dismiss: t("home:onboarding.starterTasks.dismiss"),
                  closeTaskDetails: t(
                    "home:onboarding.starterTasks.closeTaskDetails",
                  ),
                  tasks: {
                    "connect-provider": t(
                      "home:onboarding.starterTasks.connectProvider",
                    ),
                    "start-chat": t("home:onboarding.starterTasks.startChat"),
                    "create-project": t(
                      "home:onboarding.starterTasks.createProject",
                    ),
                    "add-widget": t("home:onboarding.starterTasks.addWidget"),
                  },
                  taskDetails: {
                    "connect-provider": t(
                      "home:onboarding.starterTasks.taskDetails.connectProvider",
                    ),
                    "start-chat": t(
                      "home:onboarding.starterTasks.taskDetails.startChat",
                    ),
                    "create-project": t(
                      "home:onboarding.starterTasks.taskDetails.createProject",
                    ),
                    "add-widget": t(
                      "home:onboarding.starterTasks.taskDetails.addWidget",
                    ),
                  },
                  openTask: (label) =>
                    t("home:onboarding.starterTasks.openTask", { label }),
                  completedTask: (label) =>
                    t("home:onboarding.starterTasks.completedTask", { label }),
                  checkTask: (label) =>
                    t("home:onboarding.starterTasks.checkTask", { label }),
                  uncheckTask: (label) =>
                    t("home:onboarding.starterTasks.uncheckTask", { label }),
                }}
                onTaskSelect={handleStarterTaskSelect}
                onTaskDetailsBack={() => setSelectedStarterTaskId(null)}
                onCloseSecondary={handleCloseStarterTaskSecondary}
                onTaskToggle={handleStarterTaskToggle}
                onBackHome={handleStarterTasksBackHome}
                onDismiss={dismissStarterTasks}
                exiting={starterProjectStickyExiting}
              />
            ) : null}
            {showGlobalComposerShim ? (
              <div
                aria-hidden="true"
                className={cn(
                  "global-composer-shim fixed top-0 right-0 bottom-0 z-[35]",
                  globalComposerPlacement === "handoff"
                    ? "pointer-events-none global-composer-shim-handoff"
                    : "global-composer-shim-centered",
                )}
                style={{ left: sidebarDockedOuterWidth }}
                onClick={dismissCenteredGlobalComposer}
              />
            ) : null}
            {mountGlobalComposer ? (
              <GlobalComposerPill
                hidden={!showGlobalComposer}
                elevated={renderedLocation.view === "settings"}
                focusRequest={globalComposerFocusRequest}
                onSend={handleGlobalCompose}
                onExpand={handleGlobalComposerExpand}
                onDismiss={dismissCenteredGlobalComposer}
                onHandoffStart={handleGlobalComposerHandoffStart}
                placement={globalComposerPlacement}
                mainLeftOffsetPx={sidebarDockedOuterWidth}
                handoffSourceRect={globalComposerHandoffSourceRect}
                handoffTargetRect={globalComposerHandoffTargetRect}
                starterRequest={globalComposerStarterRequest}
                onStarterRequestConsumed={
                  handleGlobalComposerStarterRequestConsumed
                }
                reasoningEffort={{
                  config: homeSession?.reasoningEffort,
                  onChange: handleGlobalComposerReasoningEffortChange,
                }}
                currentExecutionTarget={currentGlobalComposerExecutionTarget}
                onExecutionTargetChange={
                  handleGlobalComposerExecutionTargetChange
                }
                voiceConversation={
                  capabilities.voiceConversation
                    ? {
                        enabled: true,
                        ready: globalVoiceReady,
                        onStart: handleGlobalVoiceConversationStart,
                      }
                    : undefined
                }
                suggestedPersonaId={
                  renderedLocation.view === "agents"
                    ? renderedLocation.personaId
                    : null
                }
              />
            ) : null}
          </StarterTasksProvider>
        )}
      </AppShellLayout>
      <SessionWorkspaceCleanupDialog
        open={Boolean(pendingWorkspaceCleanupConfirmation)}
        worktreeCount={pendingWorkspaceCleanupConfirmation?.worktreeCount ?? 0}
        branchCount={pendingWorkspaceCleanupConfirmation?.branchCount ?? 0}
        onCancel={() => settleWorkspaceCleanupConfirmation(false)}
        onConfirm={() => settleWorkspaceCleanupConfirmation(true)}
      />
      <ProjectWorkspaceStartupNameDialog
        open={Boolean(pendingWorkspaceName)}
        creating={false}
        requestIdentity={pendingWorkspaceName ?? undefined}
        workspaces={pendingWorkspaceName?.workspaces ?? []}
        requiresWorktreeSafeName={Boolean(
          pendingWorkspaceName?.workspaces.some((workspace) =>
            isWorktreeStartupMode(workspace.startupMode),
          ),
        )}
        onCancel={closeWorkspaceName}
        onSkip={() => submitWorkspaceName(null)}
        onSubmit={submitWorkspaceName}
      />
      <Dialog open={searchDialogOpen} onOpenChange={setSearchDialogOpen}>
        <DialogContent
          size="xl"
          surface="solid"
          showCloseButton={false}
          overlayClassName="bg-[var(--overlay-search-scrim)] backdrop-filter-none [-webkit-backdrop-filter:none]"
          className="h-[clamp(320px,calc(100dvh-4rem),536px)] overflow-hidden rounded-[var(--radius-lg)] px-6 pt-2 pb-6"
          onEscapeKeyDown={(event) => {
            event.preventDefault();
            const target = event.target;
            if (
              target instanceof Element &&
              target.closest('[data-search-view="true"]')
            ) {
              return;
            }
            setSearchEscapeRequest((request) => request + 1);
          }}
        >
          <DialogTitle className="sr-only">{t("search:title")}</DialogTitle>
          <DialogDescription className="sr-only">
            {t("search:placeholderDescription")}
          </DialogDescription>
          <SearchView
            variant="dialog"
            escapeRequest={searchEscapeRequest}
            onExit={() => setSearchDialogOpen(false)}
            onSelectSearchResult={handleSelectSearchResult}
            onOpenExtension={handleOpenExtensionFromSearch}
            onOpenAgent={(agentId) => {
              handleStartChatWithAgent(agentId, () =>
                setSearchDialogOpen(false),
              );
            }}
            onOpenAutomation={(automationId) => {
              handleOpenAutomationFromSearch(automationId, () =>
                setSearchDialogOpen(false),
              );
            }}
            onOpenSkill={(skill) => {
              handleStartChatWithSkill(skill, undefined, () =>
                setSearchDialogOpen(false),
              );
            }}
            onOpenSettings={handleOpenSettingsFromSearch}
          />
        </DialogContent>
      </Dialog>
      <SessionQuickSwitcher
        open={quickSwitcherOpen}
        onOpenChange={setQuickSwitcherOpen}
        onSelectSession={handleSelectSession}
      />
      <AgentBuilderLeaveDraftDialog {...agentBuilder.leaveDraftDialogProps} />
      <AutomationBuilderLeaveDialog
        open={automationLeavePromptOpen}
        isSaving={automationLeaveSaving}
        onOpenChange={(open) => {
          if (!open) {
            cancelAutomationLeave();
          }
        }}
        onCancel={cancelAutomationLeave}
        onDiscard={discardAutomationLeave}
        onSave={() => void saveAutomationLeave()}
      />
      {isFeedbackEnabled ? (
        <FeedbackDialog
          open={feedbackOpen}
          onOpenChange={setFeedbackOpen}
          draft={feedbackDraft}
        />
      ) : null}
      <KeyboardShortcutsDialog
        open={shortcutsOpen}
        onOpenChange={setShortcutsOpen}
      />
    </FocusRegionProvider>
  );
}

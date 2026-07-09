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
import { KeyboardShortcutsDialog } from "@/features/shortcuts/ui/KeyboardShortcutsDialog";
import { eventMatchesShortcutCommand } from "@/features/shortcuts/lib/shortcutRegistry";
import { useShortcutsDialogStore } from "@/features/shortcuts/stores/shortcutsDialogStore";
import { prefetchProjectArtifactRenderer } from "@/features/projects/artifact/prefetchProjectArtifactRenderer";
import { getPlatform, type Platform } from "@/shared/lib/platform";
import {
  archiveProject,
  updateProject,
} from "@/features/projects/api/projects";
import type {
  ProjectChatGroupsMetadata,
  ProjectInfo,
} from "@/features/projects/api/projects";
import {
  DEFAULT_SETTINGS_SECTION,
  resolveEnabledSettingsSection,
  resolveSettingsSection,
  SETTINGS_SECTIONS,
  type SectionId,
} from "@/features/settings/ui/settingsSections";
import {
  OPEN_SETTINGS_EVENT,
  type AgentBuilderProviderSetupReturnTarget,
  type OpenSettingsEventDetail,
} from "@/features/settings/lib/settingsEvents";
import type { ExtensionEntry } from "@/features/extensions/types";
import type { TopBarChromeInsets } from "./ui/TopBar";
import { useChatStore } from "@/features/chat/stores/chatStore";
import { useActiveProjectTint } from "@/features/chat/hooks/useActiveProjectTint";
import {
  type ChatSession,
  type ChatSessionReasoningEffortConfig,
  SessionNotFoundError,
  useChatSessionStore,
} from "@/features/chat/stores/chatSessionStore";
import { useSessionWindowStore } from "@/features/chat/stores/sessionWindowStore";
import {
  selectActiveSessionId,
  selectHasHydratedSessions,
  selectSessions,
  selectSessionsLoading,
} from "@/features/chat/stores/chatSessionSelectors";
import { useAgentStore } from "@/features/agents/stores/agentStore";
import { useProviderSelection } from "@/features/agents/hooks/useProviderSelection";
import { resolvePersonaProvider } from "@/features/agents/lib/resolvePersonaProvider";
import { useProjectStore } from "@/features/projects/stores/projectStore";
import { selectProjects } from "@/features/projects/stores/projectSelectors";
import { findExistingDraft } from "@/features/chat/lib/newChat";
import {
  DEFAULT_CHAT_TITLE,
  isDefaultChatTitle,
} from "@/features/chat/lib/sessionTitle";
import { useAppStartup } from "./hooks/useAppStartup";
import { useCompletionNotifications } from "@/shared/hooks/useCompletionNotifications";
import { useHomeSessionStateSync } from "./hooks/useHomeSessionStateSync";
import { useHomeWidgetStore } from "@/features/home/stores/homeWidgetStore";
import { useProjectDialog } from "./hooks/useProjectDialog";
import {
  getResponsiveSidebarWidth,
  useResizableSidebar,
} from "./hooks/useResizableSidebar";
import {
  areAppNavigationLocationsEqual,
  getAppNavigationLocation,
} from "./lib/appNavigationLocation";
import { useStagedAppContentLocation } from "./lib/useStagedAppContentLocation";
import { loadStoredHomeSessionId } from "./lib/homeSessionStorage";
import { resolveSupportedSessionModelPreference } from "./lib/resolveSupportedSessionModelPreference";
import { listenSessionDeepLinkErrors } from "./lib/sessionDeepLinkErrors";
import {
  clearSettingsSectionUrl,
  getInitialSettingsSection,
  setDesignSystemUrl,
  setSettingsSectionUrl,
} from "./lib/settingsSectionUrl";
import { useAgentBuilderCoordinator } from "@/features/agents/hooks/useAgentBuilderCoordinator";
import {
  type ArchiveChatWithCleanupOptions,
  useRegisterAppNavigationController,
} from "@/features/berdctl/navigation";
import { AgentBuilderLeaveDraftDialog } from "@/features/agents/ui/AgentBuilderLeaveDraftDialog";
import { AutomationBuilderLeaveDialog } from "@/features/automations/ui/AutomationBuilderLeaveDialog";
import type { AutomationBuilderLeaveAction } from "@/features/automations/ui/AutomationBuilderView";
import { AppShellLayout } from "./ui/AppShellLayout";
import type { AuthStatus } from "@/features/auth/api/auth";
import { AppShellContent } from "./ui/AppShellContent";
import { applyLatestSessionConfig } from "@/features/chat/lib/sessionConfigRequests";
import {
  moveSessionToProject,
  updateSessionTitle,
} from "@/features/chat/stores/chatSessionOperations";
import {
  activateSession as activateChatSession,
  hasConversationMessages,
  loadSessionMessages,
} from "@/features/chat/lib/sessionActivation";
import {
  focusSessionWindow,
  releaseSession,
} from "@/features/chat/lib/sessionWindowCommands";
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
import type { AgentSetupTroubleshootingRequest } from "@/features/providers/lib/agentSetupTroubleshooting";
import type { SkillInfo } from "@/features/skills/api/skills";
import { toChatSkillDraft } from "@/features/skills/lib/skillChatPrompt";
import { useMigrationGate } from "@/features/migration/hooks/useMigrationGate";
import { useDefaultModelGate } from "@/features/migration/hooks/useDefaultModelGate";
import { StartupDiagnosticView } from "./ui/StartupDiagnosticView";
import { buildStartupDiagnosticIssue } from "./lib/startupDiagnostics";
import { usePersistedState } from "@/shared/hooks/usePersistedState";
import {
  FocusRegionProvider,
  hasOpenKeyboardOwningLayer,
} from "./focus/FocusRegionProvider";
import { SessionQuickSwitcher } from "@/features/sessions/ui/SessionQuickSwitcher";
import { useForkSession } from "@/features/sessions/hooks/useForkSession";
import {
  GlobalComposerPill,
  type GlobalComposerExpandPayload,
  type GlobalComposerHandoffRect,
  type GlobalComposerModelSelection,
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
import {
  NAVIGATION_CHATS_UNDER_PROJECTS_EXPERIMENT_ID,
  NAVIGATION_REFRESH_EXPERIMENT_ID,
  SIDEBAR_DETACHABLE_CHATS_EXPERIMENT_ID,
} from "@/features/experiments/experimentDefinitions";
import { useExperiment } from "@/features/experiments/experimentPreferences";
import { usePaneDockingLayout } from "./layout/panes/usePaneDockingLayout";
import {
  getStackedNavigationPaneWidth,
  resolveSideBySideNavigationPaneSizesForAvailableWidth,
  resolveStackedNavigationPaneSizes,
} from "./layout/panes/paneSizeRules";
import {
  NAV_PROTOTYPE_PRIMARY_COLLAPSED_WIDTH_PX,
  NAV_PROTOTYPE_PRIMARY_EXPANDED_WIDTH_PX,
  NAV_PROTOTYPE_PRIMARY_MAX_WIDTH_PX,
  NAV_PROTOTYPE_PRIMARY_MIN_WIDTH_PX,
  NAV_PROTOTYPE_PANEL_GAP_PX,
  NAV_PROTOTYPE_PANEL_OVERLAP_PX,
  NAV_PROTOTYPE_SECONDARY_MAX_WIDTH_PX,
  NAV_PROTOTYPE_SECONDARY_MIN_WIDTH_PX,
  NAV_PROTOTYPE_SECONDARY_WIDTH_PX,
  type NavigationPrototypeMode,
  type NavigationSelectSessionOptions,
  type NavigationSecondaryTarget,
} from "./views/NavigationPanesView";
import { SIDEBAR_DETACHED_PANEL_GAP_PX } from "@/shared/ui/sidebar-tokens";
import { useProfileCapabilities } from "@/shared/profile/capabilities";
import {
  resolveEffectiveNavigationSecondaryTarget,
  resolveNavigationPrototypePrimaryCollapsed,
} from "./navigationPrototypeState";
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

const APP_NAVIGATION_HISTORY_LIMIT = 50;
const PINNED_CHAT_HYDRATION_CONCURRENCY = 5;
const DESIGN_SYSTEM_INSPECTOR_VISIBLE_STORAGE_KEY =
  "goose:design-system-inspector-visible:v2";
const REDUCED_MOTION_QUERY = "(prefers-reduced-motion: reduce)";
const GLOBAL_COMPOSER_HANDOFF_MS = 620;
const GLOBAL_COMPOSER_ROUTE_SWAP_DELAY_MS = 220;

type GlobalComposerPlacement = "docked" | "centered" | "handoff";

function clampPrototypePanelWidth(width: number, min: number, max: number) {
  return Math.min(max, Math.max(min, width));
}

export function getPrototypeSecondaryWidthForDockedLayout({
  dockedPrimaryWidth,
  requestedSecondaryWidth,
  secondaryPush,
  viewportWidth,
}: {
  dockedPrimaryWidth: number;
  requestedSecondaryWidth: number;
  secondaryPush: boolean;
  viewportWidth: number;
}) {
  if (!secondaryPush) {
    return requestedSecondaryWidth;
  }

  const preferredDockedWidth =
    dockedPrimaryWidth +
    NAV_PROTOTYPE_PANEL_GAP_PX +
    requestedSecondaryWidth -
    NAV_PROTOTYPE_PANEL_OVERLAP_PX;
  const responsiveDockedWidth = getResponsiveSidebarWidth(
    preferredDockedWidth,
    viewportWidth,
  );
  const availableSecondaryWidth =
    responsiveDockedWidth -
    dockedPrimaryWidth -
    NAV_PROTOTYPE_PANEL_GAP_PX +
    NAV_PROTOTYPE_PANEL_OVERLAP_PX;

  return Math.max(
    0,
    Math.min(requestedSecondaryWidth, availableSecondaryWidth),
  );
}

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

function getNavigationSecondaryTargetKey(target: NavigationSecondaryTarget) {
  if (!target) return "none";
  if (target.kind === "settings") return "settings";
  if (target.kind === "chats") {
    return target.variant ? `chats:${target.variant}` : "chats";
  }
  return `project:${target.projectId}`;
}

function getNavigationPrototypeMode(): NavigationPrototypeMode {
  return "hybrid-push-overlay";
}

function isArchiveShortcutBlockedTarget(target: EventTarget | null) {
  if (isEditableTarget(target)) {
    return true;
  }
  return target instanceof Element && Boolean(target.closest(".xterm"));
}

function getInitialAppView(initialSettingsSection: SectionId | null): AppView {
  // Connections graduated from Settings to a main navigation surface; keep
  // legacy settings deep links (including the older "extensions" section)
  // landing on the new top-level view.
  if (window.location.pathname === "/settings") {
    const legacySection = new URLSearchParams(window.location.search).get(
      "section",
    );
    if (legacySection === "connections" || legacySection === "extensions") {
      return "connections";
    }
  }
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
  const optimisticReasoningEffort =
    currentReasoningEffort.configId === reasoningEffort.configId
      ? {
          ...currentReasoningEffort,
          currentValue: reasoningEffort.value,
        }
      : currentReasoningEffort;
  patchSessionReasoningEffort(patchSessionId, optimisticReasoningEffort);

  try {
    const configOptionsSnapshot = await acpSetSessionConfigOption(
      sessionId,
      reasoningEffort.configId,
      reasoningEffort.value,
    );
    if (configOptionsSnapshot.reasoningEffort) {
      patchSessionReasoningEffort(
        patchSessionId,
        configOptionsSnapshot.reasoningEffort,
      );
    }
  } catch (error) {
    patchSessionReasoningEffort(patchSessionId, currentReasoningEffort);
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

export function AppShell({
  authStatus,
  children,
  onLoggedOut,
}: {
  authStatus?: AuthStatus;
  children?: React.ReactNode;
  onLoggedOut?: (status: AuthStatus) => void;
}) {
  const { t } = useTranslation(["chat", "common", "agents", "settings"]);
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
    viewportWidth,
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
  const detachableSidebarChatsExperiment = useExperiment(
    SIDEBAR_DETACHABLE_CHATS_EXPERIMENT_ID,
  );
  const isDetachableSidebarChatsEnabled = Boolean(
    detachableSidebarChatsExperiment?.enabled,
  );
  const navigationRefreshExperiment = useExperiment(
    NAVIGATION_REFRESH_EXPERIMENT_ID,
  );
  const navigationChatsUnderProjectsExperiment = useExperiment(
    NAVIGATION_CHATS_UNDER_PROJECTS_EXPERIMENT_ID,
  );
  const isNavigationPrototypeEnabled =
    Boolean(navigationRefreshExperiment?.enabled) && !import.meta.env.VITEST;
  const showNavigationPrototypeChatsUnderProjects = Boolean(
    navigationChatsUnderProjectsExperiment?.enabled,
  );
  const navigationPrototypeMode = getNavigationPrototypeMode();
  const sessions = useChatSessionStore(selectSessions);
  const activeSessionId = useChatSessionStore(selectActiveSessionId);
  const [navigationSecondaryTarget, setNavigationSecondaryTarget] =
    useState<NavigationSecondaryTarget>(null);
  const [navigationSecondaryPreview, setNavigationSecondaryPreview] =
    useState(false);
  const [
    navigationSecondarySuppressedSessionId,
    setNavigationSecondarySuppressedSessionId,
  ] = useState<string | null>(null);
  const [
    navigationSecondarySelectionCommitted,
    setNavigationSecondarySelectionCommitted,
  ] = useState(false);
  const [navigationPrimaryManualCollapsed] = usePersistedState(
    "goose:navigation-prototype-primary-collapsed",
    false,
    validateBooleanPreference,
  );
  const [navigationPrimaryHovered, setNavigationPrimaryHovered] =
    useState(false);
  const handleNavigationSecondaryTargetChange = useCallback(
    (target: NavigationSecondaryTarget) => {
      if (
        getNavigationSecondaryTargetKey(target) !==
          getNavigationSecondaryTargetKey(navigationSecondaryTarget) ||
        target === null
      ) {
        setNavigationSecondarySelectionCommitted(false);
      }

      setNavigationSecondaryTarget(target);
    },
    [navigationSecondaryTarget],
  );
  const handleNavigationSecondarySelect = useCallback(() => {
    setNavigationSecondarySelectionCommitted(true);
  }, []);
  const resetNavigationSecondary = useCallback(() => {
    setNavigationSecondaryTarget(null);
    setNavigationSecondaryPreview(false);
    setNavigationSecondarySuppressedSessionId(null);
    setNavigationSecondarySelectionCommitted(false);
  }, []);
  const isEffectiveDetachableSidebarChatsEnabled =
    isDetachableSidebarChatsEnabled && !isNavigationPrototypeEnabled;
  const paneDockingLayout = usePaneDockingLayout({
    baseNavigationWidth: sidebarWidth,
    enabled: isEffectiveDetachableSidebarChatsEnabled,
  });
  const [prototypePanelWidths, setPrototypePanelWidths] = useState(() => ({
    primary: NAV_PROTOTYPE_PRIMARY_EXPANDED_WIDTH_PX,
    secondary: NAV_PROTOTYPE_SECONDARY_WIDTH_PX,
  }));
  const resizePrototypePrimaryWidth = useCallback((width: number) => {
    setPrototypePanelWidths((currentWidths) => ({
      ...currentWidths,
      primary: clampPrototypePanelWidth(
        width,
        NAV_PROTOTYPE_PRIMARY_MIN_WIDTH_PX,
        NAV_PROTOTYPE_PRIMARY_MAX_WIDTH_PX,
      ),
    }));
  }, []);
  const resizePrototypeSecondaryWidth = useCallback((width: number) => {
    setPrototypePanelWidths((currentWidths) => ({
      ...currentWidths,
      secondary: clampPrototypePanelWidth(
        width,
        NAV_PROTOTYPE_SECONDARY_MIN_WIDTH_PX,
        NAV_PROTOTYPE_SECONDARY_MAX_WIDTH_PX,
      ),
    }));
  }, []);
  const sidebarOuterGutterWidth = Math.max(
    0,
    sidebarPanelOuterWidth - sidebarWidth,
  );
  const activeNavigationSession = activeSessionId
    ? (sessions.find((session) => session.id === activeSessionId) ?? null)
    : null;
  const activeNavigationSessionIsEmptyDefaultChat =
    activeView === "chat" &&
    (activeNavigationSession === null ||
      (isDefaultChatTitle(activeNavigationSession.title) &&
        activeNavigationSession.messageCount === 0));
  const showDetachedSessionList = isEffectiveDetachableSidebarChatsEnabled;
  const activeChatNavigationSecondaryTarget =
    useMemo<NavigationSecondaryTarget>(() => {
      if (activeView === "settings") return { kind: "settings" };
      if (activeView !== "chat") return null;
      if (activeNavigationSessionIsEmptyDefaultChat) return null;
      if (activeNavigationSession?.projectId) {
        return {
          kind: "project",
          projectId: activeNavigationSession.projectId,
        };
      }
      return { kind: "chats" };
    }, [
      activeNavigationSession?.projectId,
      activeNavigationSessionIsEmptyDefaultChat,
      activeView,
    ]);
  const resolvedNavigationSecondaryTarget =
    resolveEffectiveNavigationSecondaryTarget({
      activeChatNavigationSecondaryTarget,
      activeSessionId,
      navigationSecondarySuppressedSessionId,
      navigationSecondaryTarget,
    });
  const effectiveNavigationSecondaryTarget =
    activeNavigationSessionIsEmptyDefaultChat
      ? null
      : resolvedNavigationSecondaryTarget;
  const effectiveNavigationSecondaryMatchesActiveChat =
    getNavigationSecondaryTargetKey(effectiveNavigationSecondaryTarget) ===
    getNavigationSecondaryTargetKey(activeChatNavigationSecondaryTarget);
  const effectiveNavigationSecondaryPreview =
    navigationSecondaryPreview &&
    !effectiveNavigationSecondaryMatchesActiveChat;
  const effectiveNavigationSecondaryCommitted =
    navigationSecondarySelectionCommitted ||
    effectiveNavigationSecondaryMatchesActiveChat;
  const prototypeSecondaryOpen =
    isNavigationPrototypeEnabled && effectiveNavigationSecondaryTarget !== null;
  const prototypeChatSecondaryShouldStayDocked =
    isNavigationPrototypeEnabled &&
    activeView === "chat" &&
    activeChatNavigationSecondaryTarget !== null;
  const prototypeSecondaryFloating = navigationPrototypeMode === "manual-float";
  const prototypeSecondaryPush =
    prototypeSecondaryOpen &&
    !prototypeSecondaryFloating &&
    (!effectiveNavigationSecondaryPreview ||
      prototypeChatSecondaryShouldStayDocked);
  const prototypeSecondaryVisual =
    prototypeSecondaryOpen && !prototypeSecondaryFloating;
  const prototypePrimaryRestCollapsed =
    isNavigationPrototypeEnabled &&
    activeView === "chat" &&
    !prototypeSecondaryOpen;
  const prototypePrimaryDefaultExpanded =
    isNavigationPrototypeEnabled &&
    activeView === "home" &&
    (!prototypeSecondaryOpen || effectiveNavigationSecondaryPreview);
  const prototypePrimaryCollapsed =
    navigationPrototypeMode === "manual-push"
      ? navigationPrimaryManualCollapsed
      : resolveNavigationPrototypePrimaryCollapsed({
          mode: navigationPrototypeMode,
          navigationPrimaryHovered,
          prototypePrimaryDefaultExpanded,
          prototypePrimaryRestCollapsed,
          prototypeSecondaryOpen,
        });
  const prototypePrimaryExpandedWidth = prototypePanelWidths.primary;
  const requestedPrototypeSecondaryWidth = prototypePanelWidths.secondary;
  const prototypePrimaryWidth = prototypePrimaryCollapsed
    ? NAV_PROTOTYPE_PRIMARY_COLLAPSED_WIDTH_PX
    : prototypePrimaryExpandedWidth;
  const prototypePrimaryOverlaysContent =
    navigationPrototypeMode === "manual-float" ||
    prototypePrimaryRestCollapsed ||
    (navigationPrototypeMode === "hybrid-push-overlay" &&
      prototypeSecondaryOpen &&
      (effectiveNavigationSecondaryCommitted ||
        prototypeChatSecondaryShouldStayDocked));
  const prototypeDockedPrimaryWidth = prototypePrimaryOverlaysContent
    ? NAV_PROTOTYPE_PRIMARY_COLLAPSED_WIDTH_PX
    : prototypePrimaryWidth;
  const prototypeSecondaryWidth = getPrototypeSecondaryWidthForDockedLayout({
    dockedPrimaryWidth: prototypeDockedPrimaryWidth,
    requestedSecondaryWidth: requestedPrototypeSecondaryWidth,
    secondaryPush: prototypeSecondaryPush,
    viewportWidth,
  });
  const prototypeSidebarDockedWidth =
    prototypeDockedPrimaryWidth +
    (prototypeSecondaryPush
      ? NAV_PROTOTYPE_PANEL_GAP_PX +
        prototypeSecondaryWidth -
        NAV_PROTOTYPE_PANEL_OVERLAP_PX
      : 0);
  const prototypeSidebarVisualWidth =
    prototypePrimaryWidth +
    (prototypeSecondaryVisual
      ? NAV_PROTOTYPE_PANEL_GAP_PX +
        prototypeSecondaryWidth -
        NAV_PROTOTYPE_PANEL_OVERLAP_PX
      : 0);
  const preferredSidebarDockedWidth = isNavigationPrototypeEnabled
    ? prototypeSidebarDockedWidth
    : showDetachedSessionList && paneDockingLayout.chatListDock === "side"
      ? paneDockingLayout.navigationPaneSizes.primaryNav +
        SIDEBAR_DETACHED_PANEL_GAP_PX +
        paneDockingLayout.navigationPaneSizes.chatList
      : showDetachedSessionList
        ? getStackedNavigationPaneWidth(paneDockingLayout.navigationPaneSizes)
        : sidebarWidth;
  const responsiveSidebarDockedWidth = getResponsiveSidebarWidth(
    preferredSidebarDockedWidth,
    viewportWidth,
  );
  const visibleNavigationPaneSizes = showDetachedSessionList
    ? paneDockingLayout.chatListDock === "side"
      ? resolveSideBySideNavigationPaneSizesForAvailableWidth(
          paneDockingLayout.navigationPaneSizes,
          responsiveSidebarDockedWidth,
          SIDEBAR_DETACHED_PANEL_GAP_PX,
        )
      : resolveStackedNavigationPaneSizes(responsiveSidebarDockedWidth)
    : paneDockingLayout.navigationPaneSizes;
  const sidebarDockedWidth = isNavigationPrototypeEnabled
    ? prototypeSidebarDockedWidth
    : showDetachedSessionList && paneDockingLayout.chatListDock === "side"
      ? visibleNavigationPaneSizes.primaryNav +
        SIDEBAR_DETACHED_PANEL_GAP_PX +
        visibleNavigationPaneSizes.chatList
      : showDetachedSessionList
        ? getStackedNavigationPaneWidth(visibleNavigationPaneSizes)
        : sidebarWidth;
  const sidebarDockedPanelOuterWidth =
    (isNavigationPrototypeEnabled
      ? prototypeSidebarVisualWidth
      : sidebarDockedWidth) + sidebarOuterGutterWidth;
  const sidebarDockedOuterWidth = sidebarCollapsed
    ? 0
    : sidebarDockedWidth + sidebarOuterGutterWidth;
  const [skillsSkillId, setSkillsSkillId] = useState<string | null>(null);
  const [agentsPersonaId, setAgentsPersonaId] = useState<string | null>(null);
  const [globalComposerFocusRequest, setGlobalComposerFocusRequest] =
    useState(0);
  const [globalComposerPlacement, setGlobalComposerPlacement] =
    useState<GlobalComposerPlacement>("docked");
  const [globalComposerStarterRequest, setGlobalComposerStarterRequest] =
    useState<GlobalComposerStarterRequest | null>(null);
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
  const [homeSessionId, setHomeSessionId] = useState<string | null>(() =>
    loadStoredHomeSessionId(),
  );
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
  const navigateAgentBuilderAgentsRef = useRef<
    (
      personaId: string | null,
      options?: AppNavigationUpdateOptions,
    ) => void | Promise<void>
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

  const homeSessionMessages = useChatStore((s) =>
    homeSessionId ? s.messagesBySession[homeSessionId] : undefined,
  );
  const setChatActiveSession = useChatStore((s) => s.setActiveSession);
  const setChatActiveSessionViewing = useChatStore(
    (s) => s.setActiveSessionViewing,
  );
  const promoteChatSessionId = useChatStore((s) => s.promoteSessionId);
  const cleanupChatSession = useChatStore((s) => s.cleanupSession);
  const isContextPanelOpen = useChatSessionStore((s) => s.isContextPanelOpen);
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
      resetNavigationSecondary();
      setActiveSession(sessionId);
      setChatActiveSession(sessionId);
      setActiveView("chat");
      useChatStore.getState().markSessionRead(sessionId);
    },
    [resetNavigationSecondary, setActiveSession, setChatActiveSession],
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
  const setContextPanelOpen = useChatSessionStore((s) => s.setContextPanelOpen);
  const { selectedProvider } = useProviderSelection();
  const selectedProviderRef = useRef(selectedProvider);
  selectedProviderRef.current = selectedProvider;
  const projects = useProjectStore(selectProjects);
  const fetchProjects = useProjectStore((s) => s.fetchProjects);
  const reorderProjects = useProjectStore((s) => s.reorderProjects);
  const retryFailedSessionsForProjectRef = useRef<
    (project: ProjectInfo) => void
  >(() => {});
  const startEmptyChatForSelectedProjectRef = useRef<
    (project: ProjectInfo) => void
  >(() => {});
  const projectChatGroupMutationVersionRef = useRef<Record<string, number>>({});
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

  const handleProjectCreatedAfterDialogSave = useCallback(
    (savedProject: ProjectInfo) => {
      if (isNavigationPrototypeEnabled) {
        setNavigationSecondaryTarget({
          kind: "project",
          projectId: savedProject.id,
        });
        setNavigationSecondarySelectionCommitted(true);
        startEmptyChatForSelectedProjectRef.current(savedProject);
      }
    },
    [isNavigationPrototypeEnabled],
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
    onProjectCreated: handleProjectCreatedAfterDialogSave,
    onProjectSaved: refreshProjectsAfterDialogSave,
  });
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
  const homeComposerReasoningRefreshKeyRef = useRef<string | null>(null);
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
          const ok = await loadSessionMessages(sessionId);
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
  const contextPanelLabel = isContextPanelOpen
    ? t("context.closePanel")
    : t("context.openPanel");

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
      return null;
    }

    if (homeSessionRequestRef.current) {
      return homeSessionRequestRef.current;
    }

    const request = (async () => {
      const currentProvider = () => selectedProviderRef.current ?? "goose";

      // Resolve the provider to use after an async gap. If the user changed
      // their selection while we were awaiting (liveProvider differs from what
      // it was before the await), prefer the live value; otherwise use the
      // model-preference resolution result.
      const resolveProviderAfterAwait = (
        providerAtStart: string,
        sessionModelPreference: { providerId: string },
      ): string => {
        const liveProvider = currentProvider();
        return liveProvider !== providerAtStart
          ? liveProvider
          : sessionModelPreference.providerId;
      };

      if (
        homeSession &&
        !homeSession.archivedAt &&
        homeSession.messageCount === 0
      ) {
        const providerAtStart = currentProvider();
        const sessionModelPreference =
          await resolveSupportedSessionModelPreference(
            providerAtStart,
            undefined,
          );
        const project = homeSession.projectId
          ? (projects.find(
              (candidate) => candidate.id === homeSession.projectId,
            ) ?? null)
          : null;
        const workingDir = await resolveSessionCwd(project);
        const resolvedProviderId = resolveProviderAfterAwait(
          providerAtStart,
          sessionModelPreference,
        );
        const modelIdToApply =
          resolvedProviderId === sessionModelPreference.providerId
            ? sessionModelPreference.modelId
            : undefined;
        const readLiveHomeSession = () =>
          useChatSessionStore.getState().getSession(homeSession.id) ??
          homeSession;
        const liveHomeSession = readLiveHomeSession();
        // Once a provider+model is set, don't let stored preferences re-seed
        // on model refreshes — that would clobber explicit user picks.
        if (liveHomeSession.providerId && liveHomeSession.modelId) {
          const result = await applyLatestSessionConfig({
            sessionId: homeSession.id,
            providerId: liveHomeSession.providerId,
            workingDir,
            modelId: liveHomeSession.modelId,
            forceConfigRefresh: !liveHomeSession.reasoningEffort,
          });
          if (!result.applied) {
            return liveHomeSession;
          }
          patchSession(homeSession.id, {
            workingDir,
            ...(result.configOptionsSnapshot?.reasoningEffort
              ? {
                  reasoningEffort: result.configOptionsSnapshot.reasoningEffort,
                }
              : {}),
          });
          return readLiveHomeSession();
        }
        if (
          liveHomeSession.providerId === resolvedProviderId &&
          liveHomeSession.workingDir === workingDir &&
          modelIdToApply == null
        ) {
          return liveHomeSession;
        }
        const result = await applyLatestSessionConfig({
          sessionId: homeSession.id,
          providerId: resolvedProviderId,
          workingDir,
          modelId: modelIdToApply,
          forceConfigRefresh: !liveHomeSession.reasoningEffort,
        });
        if (!result.applied) {
          return homeSession;
        }

        const shouldClearHomeModel =
          resolvedProviderId !== homeSession.providerId || !modelIdToApply;
        patchSession(homeSession.id, {
          providerId: resolvedProviderId,
          workingDir,
          modelId:
            modelIdToApply ??
            (shouldClearHomeModel ? undefined : homeSession.modelId),
          modelName:
            modelIdToApply != null
              ? sessionModelPreference.modelName
              : shouldClearHomeModel
                ? undefined
                : homeSession.modelName,
          ...(result.configOptionsSnapshot?.reasoningEffort
            ? {
                reasoningEffort: result.configOptionsSnapshot.reasoningEffort,
              }
            : {}),
        });
        return (
          useChatSessionStore.getState().getSession(homeSession.id) ??
          homeSession
        );
      }

      const providerAtStart = currentProvider();
      const workingDir = await resolveSessionCwd(null);
      const sessionModelPreference =
        await resolveSupportedSessionModelPreference(
          providerAtStart,
          undefined,
        );
      const resolvedProviderId = resolveProviderAfterAwait(
        providerAtStart,
        sessionModelPreference,
      );
      const session = await createSession({
        title: DEFAULT_CHAT_TITLE,
        providerId: resolvedProviderId,
        workingDir,
        modelId:
          resolvedProviderId === sessionModelPreference.providerId
            ? sessionModelPreference.modelId
            : undefined,
        modelName:
          resolvedProviderId === sessionModelPreference.providerId
            ? sessionModelPreference.modelName
            : undefined,
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
    patchSession,
  ]);

  useEffect(() => {
    if (activeView !== "home" || !migrationSettled) {
      return;
    }
    void ensureHomeSession().catch((error) => {
      console.error("Failed to ensure Home session:", error);
    });
  }, [activeView, ensureHomeSession, migrationSettled]);

  const startDraftSessionCreation = useCallback(
    ({
      session,
      sessionModelPreference,
      workingDir,
      projectId,
      onReady,
    }: {
      session: ChatSession;
      sessionModelPreference: MaybePromise<ResolvedSessionModelPreference>;
      workingDir: MaybePromise<string>;
      projectId?: string;
      onReady?: (result: DraftSessionCreationReady) => Promise<void> | void;
    }) => {
      void Promise.all([
        Promise.resolve(sessionModelPreference),
        Promise.resolve(workingDir),
      ])
        .then(([resolvedSessionModelPreference, resolvedWorkingDir]) =>
          acpCreateSession(
            resolvedSessionModelPreference.providerId,
            resolvedWorkingDir,
            {
              projectId,
              modelId: resolvedSessionModelPreference.modelId,
              deferProviderSetup:
                resolvedSessionModelPreference.modelId == null,
            },
          ).then(({ sessionId, configOptionsSnapshot }) => ({
            sessionId,
            configOptionsSnapshot,
            sessionModelPreference: resolvedSessionModelPreference,
            workingDir: resolvedWorkingDir,
          })),
        )
        .then(
          async ({
            sessionId,
            configOptionsSnapshot,
            sessionModelPreference,
            workingDir,
          }) => {
            const sessionStore = useChatSessionStore.getState();
            const latestSession = sessionStore.getSession(session.id);
            if (!latestSession || latestSession.archivedAt) {
              return;
            }
            let resolvedConfigOptionsSnapshot = configOptionsSnapshot;
            if (onReady) {
              await onReady({
                backendSessionId: sessionId,
                configOptionsSnapshot,
              });
              const pendingReasoningEffort = useChatSessionStore
                .getState()
                .getSession(session.id)?.reasoningEffort;
              if (pendingReasoningEffort) {
                resolvedConfigOptionsSnapshot = {
                  ...configOptionsSnapshot,
                  reasoningEffort: pendingReasoningEffort,
                };
              }
            }

            const sessionStoreAfterReady = useChatSessionStore.getState();
            const latestSessionAfterReady = sessionStoreAfterReady.getSession(
              session.id,
            );
            if (
              !latestSessionAfterReady ||
              latestSessionAfterReady.archivedAt
            ) {
              return;
            }
            const shouldRemainActive =
              sessionStoreAfterReady.activeSessionId === session.id;
            promoteChatSessionId(session.id, sessionId);
            promoteDraftSession(session.id, sessionId, {
              providerId: sessionModelPreference.providerId,
              modelId: sessionModelPreference.modelId,
              modelName: sessionModelPreference.modelName,
              workingDir,
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
                markSessionCreationFailed(session.id, message);
                chatStore.addMessage(
                  session.id,
                  createSystemNotificationMessage(message, "error", {
                    type: "editProject",
                    projectId: project.id,
                  }),
                );
                chatStore.setError(session.id, message);
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
          markSessionCreationFailed(session.id, message);
          chatStore.addMessage(
            session.id,
            createSystemNotificationMessage(message, "error"),
          );
          chatStore.setError(session.id, message);
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

          const providerId = session.providerId ?? selectedProvider ?? "goose";
          const sessionModelPreference = resolveSupportedSessionModelPreference(
            providerId,
            undefined,
            session.modelId ?? undefined,
          ).then((preference) =>
            session.modelName && preference.modelId === session.modelId
              ? { ...preference, modelName: session.modelName }
              : preference,
          );
          startDraftSessionCreation({
            session,
            sessionModelPreference,
            workingDir: resolveSessionCwd(updatedProject),
            projectId: updatedProject.id,
          });
        }
      })();
    },
    [
      fetchProjects,
      resetSessionCreation,
      selectedProvider,
      startDraftSessionCreation,
    ],
  );
  retryFailedSessionsForProjectRef.current = retryFailedSessionsForProject;

  const createNewTab = useCallback(
    async (
      title = DEFAULT_CHAT_TITLE,
      project?: ProjectInfo,
      options: {
        activate?: boolean;
        providerId?: string;
        modelId?: string;
        modelName?: string;
        reasoningEffort?: GlobalComposeOptions["reasoningEffort"];
      } = {},
    ) => {
      const shouldActivate = options.activate !== false;
      const tStart = performance.now();
      perfLog(
        `[perf:newtab] createNewTab start (project=${project?.id ?? "none"})`,
      );
      const providerId = options.providerId ?? selectedProvider ?? "goose";
      const resolvedSessionModelPreference =
        await resolveSupportedSessionModelPreference(
          providerId,
          undefined,
          options.modelId ?? undefined,
        );
      const sessionModelPreference =
        options.modelName &&
        resolvedSessionModelPreference.modelId === options.modelId
          ? {
              ...resolvedSessionModelPreference,
              modelName: options.modelName,
            }
          : resolvedSessionModelPreference;
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
          providerId: sessionModelPreference.providerId,
          modelId: sessionModelPreference.modelId,
          reasoningEffortValue: options.reasoningEffort?.value,
        },
      });

      if (existingDraft) {
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
          providerId: sessionModelPreference.providerId,
          workingDir,
          modelId: sessionModelPreference.modelId,
          modelName: sessionModelPreference.modelName,
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
        providerId,
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
        sessionModelPreference,
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
      selectedProvider,
      createSession,
      createDraftSession,
      setActiveSession,
      setChatActiveSession,
      startDraftSessionCreation,
    ],
  );

  const agentBuilder = useAgentBuilderCoordinator({
    startupReady: startup.ready,
    createNewTab: (title, options) => createNewTab(title, undefined, options),
    closeSession: (sessionId) => closeAgentBuilderSessionRef.current(sessionId),
    navigateChat: (sessionId) => navigateAgentBuilderChatRef.current(sessionId),
    navigateAgents: (personaId, options) =>
      navigateAgentBuilderAgentsRef.current(personaId, options),
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
      options: {
        providerId?: string;
        modelId?: string;
        modelName?: string;
        reuseExistingDraft?: boolean;
        reasoningEffort?: GlobalComposeOptions["reasoningEffort"];
      } = {},
    ) => {
      const tStart = performance.now();
      perfLog(
        `[perf:newtab] createNewProjectDraft start (project=${project.id})`,
      );
      const providerId = options.providerId ?? selectedProvider ?? "goose";
      const sessionState = useChatSessionStore.getState();
      const chatState = useChatStore.getState();
      // New chats always start at the project default folder; worktree
      // selections in other chats are per-chat state and do not carry over.
      const existingDraft =
        options.reuseExistingDraft === false
          ? undefined
          : findExistingDraft({
              sessions: sessionState.sessions,
              activeSessionId: sessionState.activeSessionId,
              draftsBySession: chatState.draftsBySession,
              messagesBySession: chatState.messagesBySession,
              sessionIdsWithTerminals: getChatSessionIdsWithTerminals(),
              request: {
                title,
                projectId: project.id,
                providerId,
                modelId: options.modelId,
                reasoningEffortValue: options.reasoningEffort?.value,
              },
            });

      if (existingDraft) {
        clearSettingsSectionUrl();
        setActiveSession(existingDraft.id);
        setActiveView("chat");
        setChatActiveSession(existingDraft.id);
        perfLog(
          `[perf:newtab] ${existingDraft.id.slice(0, 8)} reused project draft in ${(performance.now() - tStart).toFixed(1)}ms`,
        );
        return existingDraft;
      }

      const sessionModelPreference = resolveSupportedSessionModelPreference(
        providerId,
        undefined,
        options.modelId ?? undefined,
      ).then((preference) =>
        options.modelName && preference.modelId === options.modelId
          ? { ...preference, modelName: options.modelName }
          : preference,
      );
      const optimisticWorkingDir = getOptimisticSessionCwd(project);
      const session = createDraftSession({
        title,
        projectId: project.id,
        providerId,
        workingDir: optimisticWorkingDir,
      });
      clearSettingsSectionUrl();
      setActiveSession(session.id);
      setActiveView("chat");
      setChatActiveSession(session.id);
      perfLog(
        `[perf:newtab] ${session.id.slice(0, 8)} created project draft in ${(performance.now() - tStart).toFixed(1)}ms`,
      );
      startDraftSessionCreation({
        session,
        sessionModelPreference,
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
      selectedProvider,
      createDraftSession,
      setActiveSession,
      setChatActiveSession,
      startDraftSessionCreation,
    ],
  );

  const createBackgroundDraftChat = useCallback(
    (
      title = DEFAULT_CHAT_TITLE,
      project?: ProjectInfo,
      options: {
        providerId?: string;
        modelId?: string;
        modelName?: string;
        reasoningEffort?: GlobalComposeOptions["reasoningEffort"];
      } = {},
    ) => {
      const tStart = performance.now();
      perfLog(
        `[perf:newtab] createBackgroundDraftChat start (project=${project?.id ?? "none"})`,
      );
      const providerId = options.providerId ?? selectedProvider ?? "goose";
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
          providerId,
          modelId: options.modelId,
          reasoningEffortValue: options.reasoningEffort?.value,
        },
      });

      if (existingDraft) {
        perfLog(
          `[perf:newtab] ${existingDraft.id.slice(0, 8)} reused background draft in ${(performance.now() - tStart).toFixed(1)}ms`,
        );
        return existingDraft;
      }

      const sessionModelPreference = resolveSupportedSessionModelPreference(
        providerId,
        undefined,
        options.modelId ?? undefined,
      ).then((preference) =>
        options.modelName && preference.modelId === options.modelId
          ? { ...preference, modelName: options.modelName }
          : preference,
      );
      const optimisticWorkingDir = getOptimisticSessionCwd(project);
      const session = createDraftSession({
        title,
        projectId: project?.id,
        providerId,
        workingDir: optimisticWorkingDir,
        modelId: options.modelId,
        modelName: options.modelName,
      });
      perfLog(
        `[perf:newtab] ${session.id.slice(0, 8)} created background draft in ${(performance.now() - tStart).toFixed(1)}ms`,
      );
      startDraftSessionCreation({
        session,
        sessionModelPreference,
        workingDir: resolveSessionCwd(project),
        projectId: project?.id,
        onReady: applyReasoningEffortAfterDraftCreation(
          session.id,
          options.reasoningEffort,
        ),
      });
      return session;
    },
    [selectedProvider, createDraftSession, startDraftSessionCreation],
  );

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

  const handleStartChatFromProject = useCallback(
    (project: ProjectInfo) => {
      guardAppNavigation(() => {
        void createNewProjectDraft(DEFAULT_CHAT_TITLE, project);
      });
    },
    [createNewProjectDraft, guardAppNavigation],
  );

  const handleStartProjectChat = useCallback(
    (projectId: string) => {
      const project = projects.find((candidate) => candidate.id === projectId);
      if (project) {
        guardAppNavigation(() => {
          void createNewProjectDraft(DEFAULT_CHAT_TITLE, project);
        });
      }
    },
    [createNewProjectDraft, projects, guardAppNavigation],
  );

  const handleStartChatWithSkill = useCallback(
    (skill: SkillInfo, projectId?: string | null) => {
      guardAppNavigation(() => {
        const project = projectId
          ? projects.find((candidate) => candidate.id === projectId)
          : undefined;
        const createChat = project
          ? createNewProjectDraft(DEFAULT_CHAT_TITLE, project)
          : createNewTab(DEFAULT_CHAT_TITLE);

        void createChat
          .then((session) => {
            useChatStore
              .getState()
              .setSkillDrafts(session.id, [toChatSkillDraft(skill)]);
          })
          .catch((error) => {
            console.error("Failed to start chat with skill:", error);
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
    (agentId: string) => {
      guardAppNavigation(() => {
        if (activeView === "agents" && agentsPersonaId === agentId) {
          setGlobalComposerFocusRequest((request) => request + 1);
          return;
        }

        const agentState = useAgentStore.getState();
        const persona = agentState.personas.find(
          (candidate) => candidate.id === agentId,
        );
        const matchingProvider = resolvePersonaProvider(
          persona,
          agentState.providers,
        );
        const providerId = matchingProvider?.id;
        const modelId = matchingProvider
          ? (persona?.model ?? undefined)
          : undefined;

        void createNewTab(DEFAULT_CHAT_TITLE, undefined, {
          providerId,
          modelId,
          modelName: modelId,
        })
          .then((session) => {
            patchSession(session.id, {
              ...(providerId ? { providerId } : {}),
              ...(modelId ? { modelId, modelName: modelId } : {}),
              personaId: agentId,
            });
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

      void acpSetSessionConfigOption(
        homeSessionId,
        current.configId,
        value,
      ).catch((error) => {
        console.error("Failed to set Home reasoning effort:", error);
        patchSession(homeSessionId, {
          reasoningEffort: current,
        });
      });
    },
    [homeSession?.reasoningEffort, homeSessionId, patchSession],
  );

  const handleGlobalComposerModelSelectionChange = useCallback(
    (selection: GlobalComposerModelSelection | null) => {
      if (!homeSessionId || !selection) {
        return;
      }

      const refreshKey = [
        homeSessionId,
        selection.providerId,
        selection.modelId,
      ].join("\u0000");
      homeComposerReasoningRefreshKeyRef.current = refreshKey;

      const liveHomeSession =
        useChatSessionStore.getState().getSession(homeSessionId) ?? homeSession;
      const project = liveHomeSession?.projectId
        ? (useProjectStore
            .getState()
            .projects.find(
              (candidate) => candidate.id === liveHomeSession.projectId,
            ) ?? null)
        : null;

      patchSession(homeSessionId, {
        providerId: selection.providerId,
        modelId: selection.modelId,
        modelName: selection.modelName,
        reasoningEffort: undefined,
      });

      void (async () => {
        try {
          const workingDir = await resolveSessionCwd(
            project,
            liveHomeSession?.workingDir,
          );
          const result = await applyLatestSessionConfig({
            sessionId: homeSessionId,
            providerId: selection.providerId,
            workingDir,
            modelId: selection.modelId,
            forceConfigRefresh: true,
          });
          if (
            !result.applied ||
            homeComposerReasoningRefreshKeyRef.current !== refreshKey
          ) {
            return;
          }

          const currentHomeSession = useChatSessionStore
            .getState()
            .getSession(homeSessionId);
          if (
            currentHomeSession?.providerId !== selection.providerId ||
            currentHomeSession.modelId !== selection.modelId
          ) {
            return;
          }

          const reasoningEffort = result.configOptionsSnapshot?.reasoningEffort;
          if (!reasoningEffort) {
            return;
          }

          patchSession(homeSessionId, {
            workingDir,
            reasoningEffort,
          });
        } catch (error) {
          console.error(
            "Failed to refresh Home reasoning effort for selected model:",
            error,
          );
        }
      })();
    },
    [homeSession, homeSessionId, patchSession],
  );

  const handleGlobalCompose = useCallback(
    (text: string, options?: GlobalComposeOptions) => {
      const shouldRunComposerHandoff = globalComposerPlacement === "centered";
      if (shouldRunComposerHandoff) {
        clearGlobalComposerHandoffTimer();
        setGlobalComposerPlacement("handoff");
        setChatComposerHandoffRequest((request) => request + 1);
        setChatComposerHandoffSessionId(null);
        setGlobalComposerHandoffTargetRect(null);
      }

      const project = options?.projectId
        ? projects.find((candidate) => candidate.id === options.projectId)
        : undefined;
      const chatOptions = {
        providerId: options?.providerId,
        modelId: options?.modelId,
        modelName: options?.modelName,
        reasoningEffort: options?.reasoningEffort,
      };
      const enqueueMessage = async (session: ChatSession) => {
        const sessionId = resolveLiveSessionId(session.id) ?? session.id;

        if (options?.providerId || options?.modelId) {
          patchSession(sessionId, {
            ...(options.providerId ? { providerId: options.providerId } : {}),
            ...(options.modelId
              ? {
                  modelId: options.modelId,
                  modelName: options.modelName ?? options.modelId,
                }
              : {}),
          });
        }
        if (options?.personaId) {
          patchSession(sessionId, { personaId: options.personaId });
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
        useChatStore.getState().enqueueMessage(sessionId, {
          text,
          ...(options?.personaId ? { personaId: options.personaId } : {}),
          attachments: options?.attachments,
          ...(options?.sendOptions ? { sendOptions: options.sendOptions } : {}),
        });
      };

      const startChat = () => {
        const createChat = project
          ? createNewProjectDraft(DEFAULT_CHAT_TITLE, project, chatOptions)
          : createNewTab(DEFAULT_CHAT_TITLE, undefined, chatOptions);

        void createChat.then(enqueueMessage).catch((error) => {
          console.error("Failed to start chat from global composer:", error);
        });
      };

      const startBackgroundChat = () => {
        try {
          const session = createBackgroundDraftChat(
            DEFAULT_CHAT_TITLE,
            project,
            chatOptions,
          );
          setChatComposerHandoffSessionId(session.id);
          void enqueueMessage(session);
          clearGlobalComposerRouteSwapTimer();
          if (prefersReducedMotion()) {
            activateDeferredChatSession(session.id);
            resetGlobalComposerTransition();
            return;
          }
          globalComposerRouteSwapTimeoutRef.current = window.setTimeout(() => {
            globalComposerRouteSwapTimeoutRef.current = null;
            activateDeferredChatSession(session.id);
          }, GLOBAL_COMPOSER_ROUTE_SWAP_DELAY_MS);
        } catch (error) {
          console.error("Failed to start chat from global composer:", error);
          resetGlobalComposerTransition();
        }
      };

      if (shouldRunComposerHandoff) {
        guardAppNavigation(startBackgroundChat, () => {
          resetGlobalComposerTransition();
        });
        return;
      }

      guardAppNavigation(startChat);
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
    ],
  );

  const handleGlobalComposerExpand = useCallback(
    (payload: GlobalComposerExpandPayload): Promise<boolean> => {
      const options = payload.options;
      const project = options?.projectId
        ? projects.find((candidate) => candidate.id === options.projectId)
        : undefined;
      const chatOptions = {
        providerId: options?.providerId,
        modelId: options?.modelId,
        modelName: options?.modelName,
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
        const sessionId = resolveLiveSessionId(session.id) ?? session.id;

        if (options?.providerId || options?.modelId || options?.personaId) {
          patchSession(sessionId, {
            ...(options.providerId ? { providerId: options.providerId } : {}),
            ...(options.modelId
              ? {
                  modelId: options.modelId,
                  modelName: options.modelName ?? options.modelId,
                }
              : {}),
            ...(options.personaId ? { personaId: options.personaId } : {}),
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
      };

      return new Promise<boolean>((resolve) => {
        guardAppNavigation(
          () => {
            void openExpandedDraft()
              .then(() => {
                resolve(true);
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

  const handleStartProviderTroubleshootingChat = useCallback(
    (request: AgentSetupTroubleshootingRequest) => {
      guardAppNavigation(() => {
        void createNewTab(request.title, undefined, { providerId: "goose" })
          .then((session) => {
            useChatStore.getState().enqueueMessage(session.id, {
              text: request.prompt,
            });
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
                console.error("Failed to start project chat:", error);
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
  startEmptyChatForSelectedProjectRef.current = (project: ProjectInfo) => {
    void createNewProjectDraft(DEFAULT_CHAT_TITLE, project);
  };

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

  const handleUpdateProjectChatGroups = useCallback(
    async (projectId: string, chatGroups: ProjectChatGroupsMetadata | null) => {
      const mutationVersion =
        (projectChatGroupMutationVersionRef.current[projectId] ?? 0) + 1;
      projectChatGroupMutationVersionRef.current[projectId] = mutationVersion;
      const project = useProjectStore
        .getState()
        .projects.find((candidate) => candidate.id === projectId);
      if (!project) return;

      const optimisticProject = { ...project, chatGroups };
      useProjectStore
        .getState()
        .replaceProjectsFromBackend(
          useProjectStore
            .getState()
            .projects.map((candidate) =>
              candidate.id === projectId ? optimisticProject : candidate,
            ),
        );

      try {
        const savedProject = await updateProject(project, { chatGroups });
        if (
          projectChatGroupMutationVersionRef.current[projectId] !==
          mutationVersion
        ) {
          return;
        }

        useProjectStore
          .getState()
          .replaceProjectsFromBackend(
            useProjectStore
              .getState()
              .projects.map((candidate) =>
                candidate.id === projectId ? savedProject : candidate,
              ),
          );
      } catch (error) {
        console.error("Failed to update project chat groups:", error);
        if (
          projectChatGroupMutationVersionRef.current[projectId] ===
          mutationVersion
        ) {
          void fetchProjects();
        }
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
    void loadSessionMessages(target.sessionId);
    return true;
  }, [
    agentBuilderSettingsReturnTarget,
    setActiveSession,
    setChatActiveSession,
  ]);

  const openSettings = useCallback(
    (section: SectionId = DEFAULT_SETTINGS_SECTION) => {
      const enabledSection = resolveEnabledSettingsSection(
        section,
        capabilities,
      );
      resetNavigationSecondary();
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
    [
      activeView,
      capabilities,
      expandSidebar,
      resetNavigationSecondary,
      sidebarCollapsed,
    ],
  );

  const openConnections = useCallback(() => {
    guardAppNavigation(() => {
      resetGlobalComposerTransition();
      resetNavigationSecondary();
      setActiveSession(null);
      clearSettingsSectionUrl();
      setActiveView("connections");
    });
  }, [
    guardAppNavigation,
    resetGlobalComposerTransition,
    resetNavigationSecondary,
    setActiveSession,
  ]);

  const leaveSecondarySurface = useCallback(() => {
    if (returnToAgentBuilderSettingsTarget()) {
      return;
    }
    resetNavigationSecondary();
    clearSettingsSectionUrl();
    setActiveView(lastNonSecondaryViewRef.current);
  }, [resetNavigationSecondary, returnToAgentBuilderSettingsTarget]);

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
    resetNavigationSecondary();
    if (activeView !== "design-system") {
      designSystemReturnViewRef.current = activeView;
    }
    setDesignSystemUrl();
    setActiveView("design-system");
  }, [activeView, resetNavigationSecondary]);

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
      // Connections is a main navigation surface now; keep legacy
      // open-settings requests (and the older "extensions" section) working.
      if (section === "connections" || section === "extensions") {
        setAgentBuilderSettingsReturnTarget(null);
        openConnections();
        return;
      }
      setAgentBuilderSettingsReturnTarget(
        detail?.returnTarget?.type === "agent-builder-provider-setup"
          ? detail.returnTarget
          : null,
      );
      openSettings(resolveSettingsSection(section ?? null));
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
  }, [openConnections, openSettings]);

  const archiveChatWithCleanup = useCallback(
    async (sessionId: string, options: ArchiveChatWithCleanupOptions = {}) => {
      const mode = options.mode ?? "optimistic";
      const reportErrors = options.reportErrors ?? false;
      const sessionStore = useChatSessionStore.getState();
      const session = sessionStore.getSession(sessionId);
      if (!session) {
        return { ok: false as const, reason: "session_not_found" as const };
      }

      const wasActiveSession = sessionStore.activeSessionId === sessionId;
      const cleanup = () => {
        cleanupChatSession(sessionId);
        if (useSessionWindowStore.getState().isOpenInWindow(sessionId)) {
          releaseSession(sessionId).catch((err: unknown) =>
            console.error("Failed to release session window:", err),
          );
        }
        if (wasActiveSession) {
          setActiveSession(null);
          setActiveView("home");
        }
      };
      const handleFailure = (error: unknown) => {
        if (reportErrors) {
          toast.error(
            formatAcpErrorMessage(error, t("chat:notifications.archiveError")),
          );
        }
        return {
          ok: false as const,
          reason:
            error instanceof SessionNotFoundError
              ? ("session_not_found" as const)
              : ("backend_archive_failed" as const),
        };
      };

      const archive = useChatSessionStore.getState().archiveSession(sessionId);
      if (mode === "optimistic") {
        cleanup();
        try {
          await archive;
          return { ok: true as const };
        } catch (error) {
          return handleFailure(error);
        }
      }

      try {
        await archive;
      } catch (error) {
        return handleFailure(error);
      }
      cleanup();
      return { ok: true as const };
    },
    [cleanupChatSession, setActiveSession, t],
  );

  const handleArchiveChat = useCallback(
    async (sessionId: string) => {
      return archiveChatWithCleanup(sessionId, {
        mode: "optimistic",
        reportErrors: true,
      });
    },
    [archiveChatWithCleanup],
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

      void moveSessionToProject(sessionId, projectId, {
        providerId: selectedProvider,
        modelId: session.modelId,
      }).catch((error) => {
        console.error("Failed to move session to project:", error);
        toast.error(
          formatAcpErrorMessage(error, t("chat:notifications.moveError")),
        );
      });
    },
    [selectedProvider, t],
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
        resetNavigationSecondary();
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
    [
      homeSessionId,
      guardAppNavigation,
      resetNavigationSecondary,
      setActiveSession,
      setChatActiveSession,
    ],
  );

  const selectSessionDirect = useCallback(
    (
      id: string,
      options: {
        preserveNavigationSecondary?: boolean;
        suppressNavigationSecondary?: boolean;
      } = {},
    ) => {
      if (options.suppressNavigationSecondary) {
        setNavigationSecondaryTarget(null);
        setNavigationSecondaryPreview(false);
        setNavigationSecondarySelectionCommitted(false);
        setNavigationSecondarySuppressedSessionId(id);
      } else {
        setNavigationSecondarySuppressedSessionId(null);
      }

      if (
        !options.preserveNavigationSecondary &&
        !options.suppressNavigationSecondary
      ) {
        resetNavigationSecondary();
      }
      activateChatSession(id);
      clearSettingsSectionUrl();
      setActiveView("chat");
      void loadSessionMessages(id);
    },
    [resetNavigationSecondary],
  );
  navigateAgentBuilderChatRef.current = selectSessionDirect;

  const handleSelectSession = useCallback(
    (id: string, options: NavigationSelectSessionOptions = {}) => {
      if (
        isMultiWindowEnabled &&
        useSessionWindowStore.getState().isOpenInWindow(id)
      ) {
        void focusSessionWindow(id);
        return;
      }
      const suppressPrototypeSecondary =
        isNavigationPrototypeEnabled &&
        showNavigationPrototypeChatsUnderProjects &&
        options.suppressPrototypeSecondary;
      if (
        id === useChatSessionStore.getState().activeSessionId &&
        !suppressPrototypeSecondary
      ) {
        return;
      }
      guardAppNavigation(() => {
        selectSessionDirect(id, {
          preserveNavigationSecondary:
            isNavigationPrototypeEnabled &&
            !suppressPrototypeSecondary &&
            effectiveNavigationSecondaryTarget?.kind === "chats",
          suppressNavigationSecondary: suppressPrototypeSecondary,
        });
      });
    },
    [
      effectiveNavigationSecondaryTarget,
      guardAppNavigation,
      isMultiWindowEnabled,
      isNavigationPrototypeEnabled,
      selectSessionDirect,
      showNavigationPrototypeChatsUnderProjects,
    ],
  );

  const handleSelectSearchResult = useCallback(
    (sessionId: string, messageId?: string, query?: string) => {
      if (messageId) {
        useChatStore
          .getState()
          .setScrollTargetMessage(sessionId, messageId, query);
      }
      handleSelectSession(sessionId);
    },
    [handleSelectSession],
  );

  const handleForkChat = useForkSession({ onForked: handleSelectSession });

  const handleOpenExtensionFromSearch = useCallback(
    (_entry: ExtensionEntry) => {
      // Connections is a single page now; company-managed and custom
      // connections both live on it, so no per-entry tab routing is needed.
      openConnections();
    },
    [openConnections],
  );

  const handleOpenAutomationFromSearch = useCallback(
    (automationId: string) => {
      if (!isAutomationsFeatureEnabled) {
        return;
      }
      guardAppNavigation(() => {
        resetNavigationSecondary();
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
    [
      guardAppNavigation,
      isAutomationsFeatureEnabled,
      resetNavigationSecondary,
      setActiveSession,
    ],
  );

  const handleNavigate = useCallback(
    (view: AppView) => {
      guardAppNavigation(() => {
        resetGlobalComposerTransition();
        resetNavigationSecondary();
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
      resetNavigationSecondary,
      resetGlobalComposerTransition,
      setActiveSession,
      isAutomationsFeatureEnabled,
      isBuilderbotSurfaceEnabled,
    ],
  );

  useRegisterAppNavigationController({
    guardAppNavigation,
    selectSessionDirect,
    archiveChatWithCleanup,
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
  navigateAgentBuilderAgentsRef.current = navigateAgentsDirect;

  const navigateAgents = useCallback(
    (personaId: string | null, options?: AppNavigationUpdateOptions) => {
      guardAppNavigation(() => {
        navigateAgentsDirect(personaId, options);
      });
    },
    [guardAppNavigation, navigateAgentsDirect],
  );

  const closeAgentBuilder = useCallback(() => {
    navigateAgents(null);
  }, [navigateAgents]);

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
      resetNavigationSecondary();

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
          void loadSessionMessages(location.sessionId);
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
      resetNavigationSecondary,
      setActiveSession,
      setChatActiveSession,
      sidebarCollapsed,
    ],
  );

  const goBack = useCallback(() => {
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

  const toggleContextPanel = useCallback(() => {
    if (!activeSessionId) {
      return;
    }

    setContextPanelOpen(activeSessionId, !isContextPanelOpen);
  }, [activeSessionId, isContextPanelOpen, setContextPanelOpen]);

  const [feedbackOpen, setFeedbackOpen] = useState(false);
  const shortcutsOpen = useShortcutsDialogStore((state) => state.open);
  const setShortcutsOpen = useShortcutsDialogStore((state) => state.setOpen);
  const handleFeedbackClick = useCallback(() => {
    if (!isFeedbackEnabled) {
      return;
    }
    setFeedbackOpen(true);
  }, [isFeedbackEnabled]);

  useEffect(() => {
    if (!isFeedbackEnabled) {
      setFeedbackOpen(false);
    }
  }, [isFeedbackEnabled]);

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
  const showGlobalComposerShim =
    canShowGlobalComposer && globalComposerPlacement !== "docked";

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
              parent("skills", "Skills", () => handleNavigate("skills")),
              current("skill-detail", skillsBreadcrumbLabel),
            ]
          : [current("skills", "Skills")];
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

        return showSettingsSection && settingsSection
          ? [
              parent("settings", "Settings", () =>
                openSettings(DEFAULT_SETTINGS_SECTION),
              ),
              current(
                "settings-section",
                t(`settings:${settingsSection.labelKey}`),
              ),
            ]
          : [current("settings", "Settings")];
      }
      case "connections":
        return [current("connections", "Connections")];
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
      // Universal search (default mod+k)
      if (eventMatchesShortcutCommand(e, "navigation.search")) {
        e.preventDefault();
        handleNavigate("search");
        return;
      }
      // Session quick switcher (default mod+p)
      if (eventMatchesShortcutCommand(e, "session.quickSwitch")) {
        e.preventDefault();
        setQuickSwitcherOpen((open) => !open);
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
      // Floating new conversation composer (default mod+n)
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
    guardAppNavigation,
    handleArchiveChat,
    handleNavigate,
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

  if (forceStartupLoading || !startup.ready || !startupLoadingMinElapsed) {
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
          onGoHome: () => handleNavigate("home"),
          onToggleSidebar: toggleSidebar,
          onGoBack: goBack,
          onGoForward: goForward,
          showContextPanelToggle:
            activeView === "chat" &&
            Boolean(activeSessionId) &&
            activeSession?.intent !== "build-agent",
          chromeInsets: topBarChromeInsets,
          contextPanelOpen: isContextPanelOpen,
          contextPanelLabel,
          onToggleContextPanel: toggleContextPanel,
          onFeedbackClick: isFeedbackEnabled ? handleFeedbackClick : undefined,
          onSearchClick: () => handleNavigate("search"),
        }}
        navigationPanes={{
          collapsed: false,
          width: sidebarWidth,
          isResizing,
          onSettingsClick: () => handleNavigate("settings"),
          onOpenSettingsSection: openSettings,
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
          onArchiveProject: handleArchiveProject,
          onUpdateProjectChatGroups: handleUpdateProjectChatGroups,
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
          detachableSessionListEnabled: showDetachedSessionList,
          onPaneResizeBegin: paneDockingLayout.beginNavigationPaneResize,
          onPaneResizeEnd: paneDockingLayout.endNavigationPaneResize,
          onPaneResize: paneDockingLayout.resizeNavigationPane,
          paneSizes: visibleNavigationPaneSizes,
          sessionListDock: paneDockingLayout.chatListDock,
          onSessionListDragRelease: paneDockingLayout.commitPaneDragRelease,
          getSessionListDragPreviewDock:
            paneDockingLayout.getPaneDragPreviewDock,
          prototypeMode: isNavigationPrototypeEnabled
            ? navigationPrototypeMode
            : null,
          prototypePrimaryCollapsed,
          onPrototypePrimaryHoverChange: setNavigationPrimaryHovered,
          prototypeSecondaryTarget: effectiveNavigationSecondaryTarget,
          onPrototypeSecondaryTargetChange:
            handleNavigationSecondaryTargetChange,
          onPrototypeSecondarySelect: handleNavigationSecondarySelect,
          prototypeSecondaryPreview: effectiveNavigationSecondaryPreview,
          onPrototypeSecondaryPreviewChange: setNavigationSecondaryPreview,
          prototypePrimaryWidth,
          prototypeSecondaryWidth,
          onPrototypePrimaryWidthResize: resizePrototypePrimaryWidth,
          onPrototypeSecondaryWidthResize: resizePrototypeSecondaryWidth,
          prototypeSecondaryFloating,
          prototypePrimaryOverlaysContent,
          prototypeSecondaryPush,
          prototypeChatsUnderProjects:
            showNavigationPrototypeChatsUnderProjects,
          projects,
          className: "h-full rounded-md",
        }}
        sidebarCollapsed={sidebarCollapsed}
        sidebarContentAnchor={isNavigationPrototypeEnabled ? "left" : "right"}
        sidebarDisableWidthTransition={
          paneDockingLayout.suppressNavigationWidthTransition
        }
        sidebarResizeDisabled={isEffectiveDetachableSidebarChatsEnabled}
        sidebarWidthResizeDisabled={isNavigationPrototypeEnabled}
        sidebarOuterWidth={sidebarDockedOuterWidth}
        sidebarPanelOuterWidth={sidebarDockedPanelOuterWidth}
        isResizing={isResizing}
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
          onClose: closeCreateProjectDialog,
          onCreated: handleProjectCreated,
          initialWorkingDir: createProjectInitialWorkingDir,
          editingProject: editingProject ?? undefined,
        }}
      >
        {children ?? (
          <>
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
              chatComposerHandoffRequest={chatComposerHandoffRequest}
              chatComposerHandoffSessionId={chatComposerHandoffSessionId}
              chatComposerHandoffActive={isGlobalComposerHandoff}
              chatComposerHandoffInProgress={isGlobalComposerHandoff}
              onChatComposerHandoffTarget={handleChatComposerHandoffTarget}
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
              onAgentBuilderSaved={agentBuilder.onSaved}
              onAgentBuilderClose={closeAgentBuilder}
              onStartAgentBuilderSession={agentBuilder.start}
              onArchiveChat={handleArchiveChat}
              onCreateProject={openCreateProjectDialog}
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
              onExitSearch={handleExitSearch}
              onOpenExtension={handleOpenExtensionFromSearch}
              onOpenAgent={handleStartChatWithAgent}
              onOpenAutomation={handleOpenAutomationFromSearch}
              onOpenSkill={handleStartChatWithSkill}
              onTagHomeComposerAgent={handleTagHomeComposerAgent}
              onTagHomeComposerProject={handleTagHomeComposerProject}
              onTagHomeComposerSkill={handleTagHomeComposerSkill}
              onHydratePinnedChatSessions={hydratePinnedChatSessions}
              onLoggedOut={onLoggedOut}
              onStartProviderTroubleshootingChat={
                handleStartProviderTroubleshootingChat
              }
              onReturnToAgentDraft={
                agentBuilderSettingsReturnTarget
                  ? returnToAgentBuilderSettingsTarget
                  : undefined
              }
            />
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
            {showGlobalComposer ? (
              <GlobalComposerPill
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
                reasoningEffortModelSelection={{
                  providerId: homeSession?.providerId,
                  modelId: homeSession?.modelId,
                }}
                onModelSelectionChange={
                  handleGlobalComposerModelSelectionChange
                }
                suggestedPersonaId={
                  renderedLocation.view === "agents"
                    ? renderedLocation.personaId
                    : null
                }
              />
            ) : null}
          </>
        )}
      </AppShellLayout>
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
        <FeedbackDialog open={feedbackOpen} onOpenChange={setFeedbackOpen} />
      ) : null}
      <KeyboardShortcutsDialog
        open={shortcutsOpen}
        onOpenChange={setShortcutsOpen}
      />
    </FocusRegionProvider>
  );
}

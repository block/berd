import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { FeedbackDialog } from "@/features/feedback/FeedbackDialog";
import { prefetchProjectArtifactRenderer } from "@/features/projects/artifact/prefetchProjectArtifactRenderer";
import { getPlatform, type Platform } from "@/shared/lib/platform";
import { archiveProject } from "@/features/projects/api/projects";
import type { ProjectInfo } from "@/features/projects/api/projects";
import {
  DEFAULT_SETTINGS_SECTION,
  resolveSettingsSection,
  SETTINGS_SECTIONS,
  type SectionId,
} from "@/features/settings/ui/settingsSections";
import type { ConnectionsTab } from "@/features/connections/ui/ConnectionsSettings";
import {
  OPEN_SETTINGS_EVENT,
  type AgentBuilderProviderSetupReturnTarget,
  type OpenSettingsEventDetail,
} from "@/features/settings/lib/settingsEvents";
import type { ExtensionEntry } from "@/features/extensions/types";
import { isCompanyManagedExtension } from "@/features/connections/lib/managedExtensions";
import { classifyExtension } from "@/features/extensions/lib/extensionCategories";
import type { TopBarChromeInsets } from "./ui/TopBar";
import { useChatStore } from "@/features/chat/stores/chatStore";
import { selectMessagesBySession } from "@/features/chat/stores/chatSelectors";
import { useActiveProjectTint } from "@/features/chat/hooks/useActiveProjectTint";
import {
  type ChatSession,
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
import { selectSelectedProvider } from "@/features/agents/stores/agentSelectors";
import { resolvePersonaProvider } from "@/features/agents/lib/resolvePersonaProvider";
import { useProjectStore } from "@/features/projects/stores/projectStore";
import { selectProjects } from "@/features/projects/stores/projectSelectors";
import { findExistingDraft } from "@/features/chat/lib/newChat";
import { DEFAULT_CHAT_TITLE } from "@/features/chat/lib/sessionTitle";
import { useAppStartup } from "./hooks/useAppStartup";
import { useHomeSessionStateSync } from "./hooks/useHomeSessionStateSync";
import { useHomeWidgetStore } from "@/features/home/stores/homeWidgetStore";
import { useProjectDialog } from "./hooks/useProjectDialog";
import { useResizableSidebar } from "./hooks/useResizableSidebar";
import {
  areAppNavigationLocationsEqual,
  getAppNavigationLocation,
} from "./lib/appNavigationLocation";
import { loadStoredHomeSessionId } from "./lib/homeSessionStorage";
import { resolveSupportedSessionModelPreference } from "./lib/resolveSupportedSessionModelPreference";
import {
  clearSettingsSectionUrl,
  getInitialSettingsSection,
  setDesignSystemUrl,
  setSettingsSectionUrl,
} from "./lib/settingsSectionUrl";
import { useAgentBuilderCoordinator } from "@/features/agents/hooks/useAgentBuilderCoordinator";
import { AgentBuilderLeaveDraftDialog } from "@/features/agents/ui/AgentBuilderLeaveDraftDialog";
import { AutomationBuilderLeaveDialog } from "@/features/automations/ui/AutomationBuilderLeaveDialog";
import type { AutomationBuilderLeaveAction } from "@/features/automations/ui/AutomationBuilderView";
import { AppShellLayout } from "./ui/AppShellLayout";
import { AppShellContent } from "./ui/AppShellContent";
import { applyLatestSessionConfig } from "@/features/chat/lib/sessionConfigRequests";
import {
  moveSessionToProject,
  updateSessionTitle,
} from "@/features/chat/stores/chatSessionOperations";
import {
  activateSession as activateChatSession,
  loadSessionMessages,
} from "@/features/chat/lib/sessionActivation";
import { focusSessionWindow } from "@/features/chat/lib/sessionWindowCommands";
import { useSessionHandoffSource } from "@/features/chat/hooks/useSessionHandoffSource";
import { useSessionWindowTracking } from "@/features/chat/hooks/useSessionWindowTracking";
import { resolveSessionCwd } from "@/features/projects/lib/sessionCwdSelection";
import { perfLog } from "@/shared/lib/perfLog";
import type { AgentSetupTroubleshootingRequest } from "@/features/providers/lib/agentSetupTroubleshooting";
import type { SkillInfo } from "@/features/skills/api/skills";
import { toChatSkillDraft } from "@/features/skills/lib/skillChatPrompt";
import { resolveInheritedProjectWorkspace } from "@/features/chat/lib/workspaceContext";
import { useMigrationGate } from "@/features/migration/hooks/useMigrationGate";
import { useDefaultModelGate } from "@/features/migration/hooks/useDefaultModelGate";
import { StartupDiagnosticView } from "./ui/StartupDiagnosticView";
import { buildStartupDiagnosticIssue } from "./lib/startupDiagnostics";
import { usePersistedState } from "@/shared/hooks/usePersistedState";
import {
  GlobalComposerPill,
  type GlobalComposeOptions,
} from "@/shared/ui/GlobalComposerPill";
import { acpCreateSession } from "@/shared/api/acp";
import { formatAcpErrorMessage } from "@/shared/api/acpErrors";
import { createSystemNotificationMessage } from "@/shared/types/messages";
import { isDesignSystemExplorerEnabled } from "@/features/design-system/lib/designSystemEnabled";
import {
  BUILDERBOT_SURFACE_EXPERIMENT_ID,
  MULTI_WINDOW_EXPERIMENT_ID,
} from "@/features/experiments/experimentDefinitions";
import { useExperiment } from "@/features/experiments/experimentPreferences";
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

const APP_NAVIGATION_HISTORY_LIMIT = 50;
const PINNED_CHAT_HYDRATION_CONCURRENCY = 5;
const DESIGN_SYSTEM_INSPECTOR_VISIBLE_STORAGE_KEY =
  "goose:design-system-inspector-visible:v2";

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

function getOptimisticSessionCwd(
  project?: ProjectInfo | null,
  inheritedWorkspacePath?: string | null,
): string {
  const workspacePath = inheritedWorkspacePath?.trim();
  if (workspacePath) {
    return workspacePath;
  }

  const projectWorkingDir = (project?.workingDirs ?? [])
    .map((directory) => directory.trim())
    .find((directory) => directory.length > 0);
  return projectWorkingDir ?? getOptimisticArtifactCwd();
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

export function AppShell({ children }: { children?: React.ReactNode }) {
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
    sidebarOuterWidth,
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
  const [activeConnectionsTab, setActiveConnectionsTab] =
    useState<ConnectionsTab>("companyManaged");
  const [activeDesignSystemSection, setActiveDesignSystemSection] =
    useState<DesignSystemSection>(DEFAULT_DESIGN_SYSTEM_SECTION);
  const [designSystemInspectorVisible, setDesignSystemInspectorVisible] =
    usePersistedState(
      DESIGN_SYSTEM_INSPECTOR_VISIBLE_STORAGE_KEY,
      false,
      validateBooleanPreference,
    );
  const initialActiveView = getInitialAppView(initialSettingsSection);
  const [activeView, setActiveView] = useState<AppView>(initialActiveView);
  const builderbotExperiment = useExperiment(BUILDERBOT_SURFACE_EXPERIMENT_ID);
  const isBuilderbotSurfaceEnabled = Boolean(builderbotExperiment?.enabled);
  const multiWindowExperiment = useExperiment(MULTI_WINDOW_EXPERIMENT_ID);
  const isMultiWindowEnabled = Boolean(multiWindowExperiment?.enabled);
  const [skillsSkillId, setSkillsSkillId] = useState<string | null>(null);
  const [agentsPersonaId, setAgentsPersonaId] = useState<string | null>(null);
  const [globalComposerFocusRequest, setGlobalComposerFocusRequest] =
    useState(0);
  const pendingGlobalComposerFocusViewRef = useRef<AppView | null>(null);
  const [automationsRoute, setAutomationsRoute] =
    useState<AutomationNavigationRoute>({ surface: "overview" });
  const [skillsBreadcrumbLabel, setSkillsBreadcrumbLabel] = useState<
    string | null
  >(null);
  const [agentsBreadcrumbLabel, setAgentsBreadcrumbLabel] = useState<
    string | null
  >(null);
  const [automationsBreadcrumbLabel, setAutomationsBreadcrumbLabel] = useState<
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
  const pendingAutomationNavigationRef = useRef<(() => void) | null>(null);
  const [
    automationBuilderHasUnsavedChanges,
    setAutomationBuilderHasUnsavedChanges,
  ] = useState(false);
  const [automationLeavePromptOpen, setAutomationLeavePromptOpen] =
    useState(false);
  const [automationLeaveSaving, setAutomationLeaveSaving] = useState(false);

  const messagesBySession = useChatStore(selectMessagesBySession);
  const setChatActiveSession = useChatStore((s) => s.setActiveSession);
  const setChatActiveSessionViewing = useChatStore(
    (s) => s.setActiveSessionViewing,
  );
  const promoteChatSessionId = useChatStore((s) => s.promoteSessionId);
  const cleanupChatSession = useChatStore((s) => s.cleanupSession);
  const isContextPanelOpen = useChatSessionStore((s) => s.isContextPanelOpen);
  const sessions = useChatSessionStore(selectSessions);
  const activeSessionId = useChatSessionStore(selectActiveSessionId);
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
  const patchSession = useChatSessionStore((s) => s.patchSession);
  const setActiveWorkspace = useChatSessionStore((s) => s.setActiveWorkspace);
  const setActiveSession = useChatSessionStore((s) => s.setActiveSession);
  const setContextPanelOpen = useChatSessionStore((s) => s.setContextPanelOpen);
  const archiveSession = useChatSessionStore((s) => s.archiveSession);
  const selectedProvider = useAgentStore(selectSelectedProvider);
  const projects = useProjectStore(selectProjects);
  const fetchProjects = useProjectStore((s) => s.fetchProjects);
  const reorderProjects = useProjectStore((s) => s.reorderProjects);
  const refreshProjectsAfterDialogSave = useCallback(() => {
    void fetchProjects();
  }, [fetchProjects]);
  const {
    closeCreateProjectDialog,
    createProjectInitialWorkingDir,
    createProjectOpen,
    editingProject,
    handleProjectCreated,
    openCreateProjectDialog,
    openEditProjectDialog,
  } = useProjectDialog({ onProjectCreated: refreshProjectsAfterDialogSave });
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
  const startupReady = startup.ready && !startup.error;
  const migrationGate = useMigrationGate(startupReady);
  const migrationSettled =
    migrationGate.status === "ready" || migrationGate.status === "error";
  useDefaultModelGate(migrationSettled);
  useSessionWindowTracking({ enabled: isMultiWindowEnabled });
  useSessionHandoffSource({ enabled: isMultiWindowEnabled });
  const lastNonSecondaryViewRef = useRef<AppView>("home");
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

        const hasMessages =
          (useChatStore.getState().messagesBySession[sessionId]?.length ?? 0) >
          0;
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
  }, [activeView, isBuilderbotSurfaceEnabled]);

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
  const contextPanelLabel = isContextPanelOpen
    ? t("context.closePanel")
    : t("context.openPanel");

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
    const location = getAppNavigationLocation(
      activeView,
      activeSessionId,
      activeSettingsSection,
      skillsSkillId,
      agentsPersonaId,
      automationsRoute,
      activeDesignSystemSection,
    );
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
  }, [
    activeSessionId,
    activeDesignSystemSection,
    activeSettingsSection,
    activeView,
    agentsPersonaId,
    automationsRoute,
    skillsSkillId,
    updateNavigationAvailability,
  ]);

  useHomeSessionStateSync({
    homeSessionId,
    homeSession,
    messagesBySession,
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
      const currentProvider = () =>
        useAgentStore.getState().selectedProvider ?? "goose";

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
          });
          if (!result.applied) {
            return liveHomeSession;
          }
          patchSession(homeSession.id, { workingDir });
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
    }: {
      session: ChatSession;
      sessionModelPreference: MaybePromise<ResolvedSessionModelPreference>;
      workingDir: MaybePromise<string>;
      projectId?: string;
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
            },
          ).then(({ sessionId }) => ({
            sessionId,
            sessionModelPreference: resolvedSessionModelPreference,
            workingDir: resolvedWorkingDir,
          })),
        )
        .then(({ sessionId, sessionModelPreference, workingDir }) => {
          const sessionStore = useChatSessionStore.getState();
          const latestSession = sessionStore.getSession(session.id);
          if (!latestSession || latestSession.archivedAt) {
            return;
          }
          const shouldRemainActive =
            sessionStore.activeSessionId === session.id;
          promoteChatSessionId(session.id, sessionId);
          promoteDraftSession(session.id, sessionId, {
            providerId: sessionModelPreference.providerId,
            modelId: sessionModelPreference.modelId,
            modelName: sessionModelPreference.modelName,
            workingDir,
          });
          useHomeWidgetStore
            .getState()
            .replaceChatPinSessionId(session.id, sessionId);
          replaceNavigationSessionId(session.id, sessionId);
          if (shouldRemainActive) {
            setActiveSession(sessionId);
            setChatActiveSession(sessionId);
          }
        })
        .catch((error) => {
          const message = formatAcpErrorMessage(
            error,
            "Failed to create session.",
          );
          const chatStore = useChatStore.getState();
          markSessionCreationFailed(session.id, message);
          chatStore.addMessage(
            session.id,
            createSystemNotificationMessage(message, "error"),
          );
          chatStore.setError(session.id, message);
        });
    },
    [
      markSessionCreationFailed,
      promoteChatSessionId,
      promoteDraftSession,
      replaceNavigationSessionId,
      setActiveSession,
      setChatActiveSession,
    ],
  );

  const createNewTab = useCallback(
    async (
      title = DEFAULT_CHAT_TITLE,
      project?: ProjectInfo,
      options: {
        activate?: boolean;
        providerId?: string;
        modelId?: string;
        modelName?: string;
      } = {},
    ) => {
      const shouldActivate = options.activate !== false;
      const tStart = performance.now();
      perfLog(
        `[perf:newtab] createNewTab start (project=${project?.id ?? "none"})`,
      );
      const providerId =
        options.providerId ??
        project?.preferredProvider ??
        selectedProvider ??
        "goose";
      const resolvedSessionModelPreference =
        await resolveSupportedSessionModelPreference(
          providerId,
          undefined,
          options.modelId ?? project?.preferredModel ?? undefined,
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
      const inheritedWorkspace = resolveInheritedProjectWorkspace({
        projectId: project?.id,
        sessions: sessionState.sessions,
        activeSessionId: sessionState.activeSessionId,
        activeWorkspaceBySession: sessionState.activeWorkspaceBySession,
      });
      const existingDraft = findExistingDraft({
        sessions: sessionState.sessions,
        activeSessionId: sessionState.activeSessionId,
        draftsBySession: chatState.draftsBySession,
        messagesBySession: chatState.messagesBySession,
        request: {
          title,
          projectId: project?.id,
        },
      });

      if (existingDraft) {
        if (inheritedWorkspace) {
          setActiveWorkspace(existingDraft.id, inheritedWorkspace);
          patchSession(existingDraft.id, {
            workingDir: inheritedWorkspace.path,
          });
        }
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
        const workingDir = await resolveSessionCwd(
          project,
          inheritedWorkspace?.path,
        );
        const session = await createSession({
          title,
          projectId: project?.id,
          providerId: sessionModelPreference.providerId,
          workingDir,
          modelId: sessionModelPreference.modelId,
          modelName: sessionModelPreference.modelName,
        });
        if (inheritedWorkspace) {
          setActiveWorkspace(session.id, inheritedWorkspace);
        }
        perfLog(
          `[perf:newtab] ${session.id.slice(0, 8)} created session in ${(performance.now() - tStart).toFixed(1)}ms`,
        );
        return session;
      }

      const optimisticWorkingDir = getOptimisticSessionCwd(
        project,
        inheritedWorkspace?.path,
      );
      const session = createDraftSession({
        title,
        projectId: project?.id,
        providerId,
        workingDir: optimisticWorkingDir,
      });
      if (inheritedWorkspace) {
        setActiveWorkspace(session.id, inheritedWorkspace);
      }
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
        workingDir: resolveSessionCwd(project, inheritedWorkspace?.path),
        projectId: project?.id,
      });
      return session;
    },
    [
      selectedProvider,
      createSession,
      createDraftSession,
      patchSession,
      setActiveWorkspace,
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
    (next: () => void) => {
      const action = automationBuilderLeaveActionRef.current;
      if (
        activeView === "automations" &&
        automationsRoute.surface === "builder" &&
        automationBuilderHasUnsavedChanges &&
        action?.hasUnsavedChanges
      ) {
        pendingAutomationNavigationRef.current = next;
        setAutomationLeavePromptOpen(true);
        return;
      }

      next();
    },
    [activeView, automationBuilderHasUnsavedChanges, automationsRoute.surface],
  );

  const guardAppNavigation = useCallback(
    (next: () => void) => {
      agentBuilder.guardNavigation(() => {
        guardAutomationBuilderNavigation(next);
      });
    },
    [agentBuilder.guardNavigation, guardAutomationBuilderNavigation],
  );

  const continuePendingAutomationNavigation = useCallback(() => {
    const next = pendingAutomationNavigationRef.current;
    pendingAutomationNavigationRef.current = null;
    if (next) {
      next();
    }
  }, []);

  const cancelAutomationLeave = useCallback(() => {
    pendingAutomationNavigationRef.current = null;
    setAutomationLeavePromptOpen(false);
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
      } = {},
    ) => {
      const tStart = performance.now();
      perfLog(
        `[perf:newtab] createNewProjectDraft start (project=${project.id})`,
      );
      const providerId =
        options.providerId ??
        project.preferredProvider ??
        selectedProvider ??
        "goose";
      const sessionState = useChatSessionStore.getState();
      const chatState = useChatStore.getState();
      const inheritedWorkspace = resolveInheritedProjectWorkspace({
        projectId: project.id,
        sessions: sessionState.sessions,
        activeSessionId: sessionState.activeSessionId,
        activeWorkspaceBySession: sessionState.activeWorkspaceBySession,
      });
      const existingDraft = findExistingDraft({
        sessions: sessionState.sessions,
        activeSessionId: sessionState.activeSessionId,
        draftsBySession: chatState.draftsBySession,
        messagesBySession: chatState.messagesBySession,
        request: {
          title,
          projectId: project.id,
        },
      });

      if (existingDraft) {
        if (inheritedWorkspace) {
          setActiveWorkspace(existingDraft.id, inheritedWorkspace);
          patchSession(existingDraft.id, {
            workingDir: inheritedWorkspace.path,
          });
        }
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
        options.modelId ?? project.preferredModel ?? undefined,
      ).then((preference) =>
        options.modelName && preference.modelId === options.modelId
          ? { ...preference, modelName: options.modelName }
          : preference,
      );
      const optimisticWorkingDir = getOptimisticSessionCwd(
        project,
        inheritedWorkspace?.path,
      );
      const session = createDraftSession({
        title,
        projectId: project.id,
        providerId,
        workingDir: optimisticWorkingDir,
      });
      if (inheritedWorkspace) {
        setActiveWorkspace(session.id, inheritedWorkspace);
      }
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
        workingDir: resolveSessionCwd(project, inheritedWorkspace?.path),
        projectId: project.id,
      });
      return session;
    },
    [
      selectedProvider,
      createDraftSession,
      patchSession,
      setActiveWorkspace,
      setActiveSession,
      setChatActiveSession,
      startDraftSessionCreation,
    ],
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

  const handleGlobalCompose = useCallback(
    (text: string, options?: GlobalComposeOptions) => {
      guardAppNavigation(() => {
        const project = options?.projectId
          ? projects.find((candidate) => candidate.id === options.projectId)
          : undefined;
        const chatOptions = {
          providerId: options?.providerId,
          modelId: options?.modelId,
          modelName: options?.modelName,
        };
        const createChat = project
          ? createNewProjectDraft(DEFAULT_CHAT_TITLE, project, chatOptions)
          : createNewTab(DEFAULT_CHAT_TITLE, undefined, chatOptions);

        void createChat
          .then((session) => {
            if (options?.providerId || options?.modelId) {
              patchSession(session.id, {
                ...(options.providerId
                  ? { providerId: options.providerId }
                  : {}),
                ...(options.modelId
                  ? {
                      modelId: options.modelId,
                      modelName: options.modelName ?? options.modelId,
                    }
                  : {}),
              });
            }
            if (options?.personaId) {
              patchSession(session.id, { personaId: options.personaId });
            }
            useChatStore.getState().enqueueMessage(session.id, {
              text,
              attachments: options?.attachments,
              ...(options?.sendOptions
                ? { sendOptions: options.sendOptions }
                : {}),
            });
          })
          .catch((error) => {
            console.error("Failed to start chat from global composer:", error);
          });
      });
    },
    [
      createNewProjectDraft,
      createNewTab,
      patchSession,
      projects,
      guardAppNavigation,
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
    (projectId: string) => {
      const project = projects.find((p) => p.id === projectId);
      if (project) {
        guardAppNavigation(() => {
          void createNewProjectDraft(DEFAULT_CHAT_TITLE, project);
        });
      }
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
    void loadSessionMessages(target.sessionId);
    return true;
  }, [
    agentBuilderSettingsReturnTarget,
    setActiveSession,
    setChatActiveSession,
  ]);

  const openSettings = useCallback(
    (section: SectionId = DEFAULT_SETTINGS_SECTION) => {
      if (activeView !== "settings" && activeView !== "design-system") {
        lastNonSecondaryViewRef.current = activeView;
      }
      setActiveSettingsSection(section);
      setSettingsSectionUrl(section);
      setActiveView("settings");
      if (sidebarCollapsed) {
        void expandSidebar();
      }
    },
    [activeView, expandSidebar, sidebarCollapsed],
  );

  const leaveSecondarySurface = useCallback(() => {
    if (returnToAgentBuilderSettingsTarget()) {
      return;
    }
    clearSettingsSectionUrl();
    setActiveView(lastNonSecondaryViewRef.current);
  }, [returnToAgentBuilderSettingsTarget]);

  const selectSettingsSection = useCallback((section: SectionId) => {
    setActiveSettingsSection(section);
    setSettingsSectionUrl(section);
  }, []);

  const openDesignSystem = useCallback(() => {
    if (!isDesignSystemExplorerEnabled()) return;
    if (activeView !== "settings" && activeView !== "design-system") {
      lastNonSecondaryViewRef.current = activeView;
    }
    setDesignSystemUrl();
    setActiveView("design-system");
    if (sidebarCollapsed) {
      void expandSidebar();
    }
  }, [activeView, expandSidebar, sidebarCollapsed]);

  const returnToSettingsFromDesignSystem = useCallback(() => {
    openSettings(activeSettingsSection);
  }, [activeSettingsSection, openSettings]);

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
  }, [openSettings]);

  const handleArchiveChat = useCallback(
    async (sessionId: string) => {
      const { activeSessionId: currentActiveSessionId } =
        useChatSessionStore.getState();
      const wasActiveSession = currentActiveSessionId === sessionId;

      try {
        await archiveSession(sessionId);
        cleanupChatSession(sessionId);

        if (!wasActiveSession) {
          return;
        }

        setActiveSession(null);
        setActiveView("home");
      } catch {
        // best-effort
      }
    },
    [archiveSession, cleanupChatSession, setActiveSession],
  );
  closeAgentBuilderSessionRef.current = handleArchiveChat;

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
    void loadSessionMessages(id);
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
      if (id === useChatSessionStore.getState().activeSessionId) {
        return;
      }
      guardAppNavigation(() => {
        selectSessionDirect(id);
      });
    },
    [guardAppNavigation, isMultiWindowEnabled, selectSessionDirect],
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

  const handleOpenExtensionFromSearch = useCallback(
    (entry: ExtensionEntry) => {
      setActiveConnectionsTab(
        isCompanyManagedExtension(entry)
          ? "companyManaged"
          : classifyExtension(entry) === "gooseCapabilities"
            ? "gooseCapabilities"
            : "custom",
      );
      openSettings("connections");
    },
    [openSettings],
  );

  const handleOpenAutomationFromSearch = useCallback(
    (automationId: string) => {
      guardAppNavigation(() => {
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
    [guardAppNavigation, setActiveSession],
  );

  const handleNavigate = useCallback(
    (view: AppView) => {
      guardAppNavigation(() => {
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
        clearSettingsSectionUrl();
        setActiveView(view);
      });
    },
    [
      openDesignSystem,
      openSettings,
      guardAppNavigation,
      setActiveSession,
      isBuilderbotSurfaceEnabled,
    ],
  );

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
      guardAppNavigation(() => {
        replaceNextNavigationEntryRef.current = Boolean(options?.replace);
        setAutomationsRoute(route);
        setActiveSession(null);
        clearSettingsSectionUrl();
        setActiveView("automations");
      });
    },
    [guardAppNavigation, setActiveSession],
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
        setActiveSession(null);
        setAutomationsRoute(location.route);
        setActiveView("automations");
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
    [expandSidebar, setActiveSession, setChatActiveSession, sidebarCollapsed],
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
  const handleFeedbackClick = useCallback(() => {
    setFeedbackOpen(true);
  }, []);

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
  const showGlobalComposer =
    startup.ready &&
    !forceStartupLoading &&
    !startupIssue &&
    children == null &&
    activeView !== "chat" &&
    !(activeView === "automations" && automationsRoute.surface === "builder");

  const requestGlobalComposerFocus = useCallback(() => {
    if (showGlobalComposer) {
      setGlobalComposerFocusRequest((request) => request + 1);
      return;
    }

    pendingGlobalComposerFocusViewRef.current = "home";
  }, [showGlobalComposer]);

  useEffect(() => {
    const pendingView = pendingGlobalComposerFocusViewRef.current;
    if (!pendingView) {
      return;
    }

    // Only bridge the Cmd+N unmount gap. If Home lands without the composer,
    // drop the request so a later unrelated composer-visible route won't steal focus.
    if (activeView !== pendingView || !showGlobalComposer) {
      pendingGlobalComposerFocusViewRef.current = null;
      return;
    }

    pendingGlobalComposerFocusViewRef.current = null;
    setGlobalComposerFocusRequest((request) => request + 1);
  }, [activeView, showGlobalComposer]);

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
              parent("settings", "Settings", returnToSettingsFromDesignSystem),
              parent("design-system", "Design System", () => {
                setActiveDesignSystemSection(DEFAULT_DESIGN_SYSTEM_SECTION);
                openDesignSystem();
              }),
              current("design-system-section", designSystemSectionLabel),
            ]
          : [
              parent("settings", "Settings", returnToSettingsFromDesignSystem),
              current("design-system", "Design System"),
            ];
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
    handleNavigate,
    openDesignSystem,
    openSettings,
    projects,
    returnToSettingsFromDesignSystem,
    skillsBreadcrumbLabel,
    skillsSkillId,
    t,
  ]);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      // Cmd+, for settings
      if (e.key === "," && e.metaKey) {
        e.preventDefault();
        if (activeView === "settings") {
          leaveSecondarySurface();
          return;
        }
        handleNavigate("settings");
      }
      // Cmd+B for sidebar toggle
      if (e.key === "b" && e.metaKey) {
        e.preventDefault();
        toggleSidebar();
      }
      // Cmd+K opens universal search.
      if (e.key === "k" && e.metaKey) {
        e.preventDefault();
        handleNavigate("search");
      }
      // Cmd+W returns to home instead of closing the window
      if (e.key === "w" && e.metaKey) {
        e.preventDefault();
        const { activeSessionId } = useChatSessionStore.getState();
        if (activeSessionId) {
          clearActiveSession(activeSessionId);
        } else if (
          activeView === "settings" ||
          activeView === "design-system"
        ) {
          clearSettingsSectionUrl();
          setActiveView("home");
        }
      }
      // Cmd+N opens new conversation screen
      if (e.key === "n" && e.metaKey) {
        e.preventDefault();
        guardAppNavigation(() => {
          setActiveSession(null);
          clearSettingsSectionUrl();
          setActiveView("home");
          requestGlobalComposerFocus();
        });
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [
    activeView,
    clearActiveSession,
    guardAppNavigation,
    handleNavigate,
    leaveSecondarySurface,
    requestGlobalComposerFocus,
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
    <>
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
          onFeedbackClick: handleFeedbackClick,
          onSearchClick: () => handleNavigate("search"),
        }}
        sidebar={{
          collapsed: false,
          width: sidebarWidth,
          isResizing,
          onSettingsClick: () => handleNavigate("settings"),
          onSettingsBack: leaveSecondarySurface,
          onSettingsSectionChange: selectSettingsSection,
          onDesignSystemBack: returnToSettingsFromDesignSystem,
          onDesignSystemSectionChange: selectDesignSystemSection,
          designSystemInspectorVisible,
          onDesignSystemInspectorVisibleChange: setDesignSystemInspectorVisible,
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
          onArchiveChat: handleArchiveChat,
          onRenameChat: handleRenameChat,
          onMarkChatRead: handleMarkChatRead,
          onMarkChatUnread: handleMarkChatUnread,
          onMoveToProject: handleMoveToProject,
          onReorderProject: reorderProjects,
          onSelectSession: handleSelectSession,
          activeView,
          activeSettingsSection,
          activeDesignSystemSection,
          activeSessionId,
          projects,
          className: "h-full rounded-md",
        }}
        sidebarCollapsed={sidebarCollapsed}
        sidebarOuterWidth={sidebarOuterWidth}
        sidebarPanelOuterWidth={sidebarPanelOuterWidth}
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
        showDesignSystemInspector={designSystemInspectorVisible}
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
              activeView={activeView}
              activeSettingsSection={activeSettingsSection}
              activeConnectionsTab={activeConnectionsTab}
              activeSkillsSkillId={skillsSkillId}
              activeAgentsPersonaId={agentsPersonaId}
              activeAutomationsRoute={automationsRoute}
              activeDesignSystemSection={activeDesignSystemSection}
              activeSession={activeSession}
              homeSessionId={homeSessionId}
              onNavigateSkills={navigateSkills}
              onNavigateAgents={navigateAgents}
              onNavigateAutomations={navigateAutomations}
              onConnectionsTabChange={setActiveConnectionsTab}
              onSkillsBreadcrumbLabelChange={setSkillsBreadcrumbLabel}
              onAgentsBreadcrumbLabelChange={setAgentsBreadcrumbLabel}
              onAutomationsBreadcrumbLabelChange={setAutomationsBreadcrumbLabel}
              onAutomationBuilderLeaveActionChange={
                handleAutomationBuilderLeaveActionChange
              }
              onCreatePersona={agentBuilder.create}
              onAgentBuilderSaved={agentBuilder.onSaved}
              onAgentBuilderClose={closeAgentBuilder}
              onStartAgentBuilderSession={agentBuilder.start}
              onArchiveChat={handleArchiveChat}
              onCreateProject={openCreateProjectDialog}
              onActivateHomeSession={activateHomeSession}
              onRenameChat={handleRenameChat}
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
              onHydratePinnedChatSessions={hydratePinnedChatSessions}
              onStartProviderTroubleshootingChat={
                handleStartProviderTroubleshootingChat
              }
              onReturnToAgentDraft={
                agentBuilderSettingsReturnTarget
                  ? returnToAgentBuilderSettingsTarget
                  : undefined
              }
            />
            {showGlobalComposer ? (
              <GlobalComposerPill
                focusRequest={globalComposerFocusRequest}
                onSend={handleGlobalCompose}
                suggestedPersonaId={
                  activeView === "agents" ? agentsPersonaId : null
                }
              />
            ) : null}
          </>
        )}
      </AppShellLayout>
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
      <FeedbackDialog open={feedbackOpen} onOpenChange={setFeedbackOpen} />
    </>
  );
}

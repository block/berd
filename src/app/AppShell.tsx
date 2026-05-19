import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { Sidebar } from "@/features/sidebar/ui/Sidebar";
import { getVersion } from "@tauri-apps/api/app";
import { openFeedbackForm } from "@/shared/api/feedback";
import { getPlatform, type Platform } from "@/shared/lib/platform";
import { CreateProjectDialog } from "@/features/projects/ui/CreateProjectDialog";
import { archiveProject } from "@/features/projects/api/projects";
import type { ProjectInfo } from "@/features/projects/api/projects";
import {
  DEFAULT_SETTINGS_SECTION,
  resolveSettingsSection,
  type SectionId,
} from "@/features/settings/ui/settingsSections";
import { OPEN_SETTINGS_EVENT } from "@/features/settings/lib/settingsEvents";
import { TopBar } from "./ui/TopBar";
import type { TopBarChromeInsets } from "./ui/TopBar";
import { useChatStore } from "@/features/chat/stores/chatStore";
import { selectMessagesBySession } from "@/features/chat/stores/chatSelectors";
import {
  type ChatSession,
  useChatSessionStore,
} from "@/features/chat/stores/chatSessionStore";
import {
  selectActiveSessionId,
  selectHasHydratedSessions,
  selectSessions,
  selectSessionsLoading,
} from "@/features/chat/stores/chatSessionSelectors";
import { useAgentStore } from "@/features/agents/stores/agentStore";
import { selectSelectedProvider } from "@/features/agents/stores/agentSelectors";
import { useProjectStore } from "@/features/projects/stores/projectStore";
import { selectProjects } from "@/features/projects/stores/projectSelectors";
import { findExistingDraft } from "@/features/chat/lib/newChat";
import { DEFAULT_CHAT_TITLE } from "@/features/chat/lib/sessionTitle";
import { useAppStartup } from "./hooks/useAppStartup";
import { useHomeSessionStateSync } from "./hooks/useHomeSessionStateSync";
import { loadStoredHomeSessionId } from "./lib/homeSessionStorage";
import { resolveSupportedSessionModelPreference } from "./lib/resolveSupportedSessionModelPreference";
import { useCreatePersonaNavigation } from "./hooks/useCreatePersonaNavigation";
import { AppShellContent } from "./ui/AppShellContent";
import { applyLatestSessionConfig } from "@/features/chat/lib/sessionConfigRequests";
import {
  moveSessionToProject,
  updateSessionTitle,
} from "@/features/chat/stores/chatSessionOperations";
import {
  clearReplayBuffer,
  getAndDeleteReplayBuffer,
} from "@/features/chat/hooks/replayBuffer";
import { resolveSessionCwd } from "@/features/projects/lib/sessionCwdSelection";
import { perfLog } from "@/shared/lib/perfLog";
import { useProviderInventoryStore } from "@/features/providers/stores/providerInventoryStore";
import { sanitizeReplayMessages } from "@/features/chat/lib/replaySanitizer";
import type { SkillInfo } from "@/features/skills/api/skills";
import { toChatSkillDraft } from "@/features/skills/lib/skillChatPrompt";
import { resolveInheritedProjectWorkspace } from "@/features/chat/lib/workspaceContext";
import { OnboardingFlow } from "@/features/onboarding/ui/OnboardingFlow";
import { useOnboardingGate } from "@/features/onboarding/hooks/useOnboardingGate";
import { Spinner } from "@/shared/ui/spinner";
import { SIDE_PANEL_DEFAULT_WIDTH } from "@/shared/constants/panels";
import { acpCreateSession } from "@/shared/api/acp";
import { createSystemNotificationMessage } from "@/shared/types/messages";
import { isDesignSystemExplorerEnabled } from "@/features/design-system/lib/designSystemEnabled";
import {
  DEFAULT_DESIGN_SYSTEM_SECTION,
  type DesignSystemSection,
} from "@/features/design-system/ui/designSystemSections";
import { DesignSystemInspector } from "@/features/design-system/inspector/DesignSystemInspector";
import type {
  AppNavigationLocation,
  AppNavigationUpdateOptions,
  AppView,
  AutomationNavigationRoute,
} from "./types/appNavigation";
export type { AppView } from "./types/appNavigation";

type AppNavigationHistory = {
  entries: AppNavigationLocation[];
  index: number;
  isApplying: boolean;
};

const SIDEBAR_OUTER_GUTTER_WIDTH = 12;
const SIDEBAR_RESIZE_HANDLE_WIDTH = 12;
const SIDEBAR_DEFAULT_WIDTH = SIDE_PANEL_DEFAULT_WIDTH;
const SIDEBAR_MIN_WIDTH = 220;
const SIDEBAR_MAX_WIDTH = 380;
const SIDEBAR_SNAP_COLLAPSE_THRESHOLD = 100;
const SIDEBAR_COLLAPSED_WIDTH = 48;
const APP_NAVIGATION_HISTORY_LIMIT = 50;
const APP_SHELL_HORIZONTAL_CHROME_WIDTH = 28;
const MIN_MAIN_CONTENT_WIDTH = 532;
const MIN_WINDOW_HEIGHT = 600;
const COLLAPSED_WINDOW_MIN_WIDTH =
  SIDEBAR_COLLAPSED_WIDTH +
  APP_SHELL_HORIZONTAL_CHROME_WIDTH +
  MIN_MAIN_CONTENT_WIDTH;
function getExpandedSidebarFitWidth(sidebarWidth: number) {
  return (
    sidebarWidth + APP_SHELL_HORIZONTAL_CHROME_WIDTH + MIN_MAIN_CONTENT_WIDTH
  );
}

function getInitialSettingsSection(): SectionId | null {
  if (typeof window === "undefined") return null;
  if (window.location.pathname !== "/settings") return null;
  const section = new URLSearchParams(window.location.search).get("section");
  return resolveSettingsSection(section);
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

function setSettingsSectionUrl(section: SectionId) {
  if (typeof window === "undefined") return;
  const url = new URL(window.location.href);
  url.pathname = "/settings";
  url.searchParams.set("section", section);
  window.history.replaceState(window.history.state, "", url);
}

function setDesignSystemUrl() {
  if (typeof window === "undefined") return;
  const url = new URL(window.location.href);
  url.pathname = "/design-system";
  url.search = "";
  window.history.replaceState(window.history.state, "", url);
}

function clearSettingsSectionUrl() {
  if (typeof window === "undefined") return;
  const url = new URL(window.location.href);
  if (url.pathname === "/settings" || url.pathname === "/design-system") {
    url.pathname = "/";
  }
  url.searchParams.delete("section");
  window.history.replaceState(window.history.state, "", url);
}

function getAppNavigationLocation(
  view: AppView,
  sessionId: string | null,
  settingsSection: SectionId,
  skillsSkillId: string | null,
  agentsPersonaId: string | null,
  automationsRoute: AutomationNavigationRoute,
  designSystemSection: DesignSystemSection,
): AppNavigationLocation {
  switch (view) {
    case "chat":
      return { view, sessionId };
    case "automations":
      return { view, route: automationsRoute };
    case "design-system":
      return { view, designSystemSection };
    case "skills":
      return { view, skillId: skillsSkillId };
    case "agents":
      return { view, personaId: agentsPersonaId };
    case "settings":
      return { view, settingsSection };
    case "home":
    case "projects":
    case "session-history":
      return { view };
  }
}

function areAppNavigationLocationsEqual(
  a: AppNavigationLocation | undefined,
  b: AppNavigationLocation,
) {
  return JSON.stringify(a) === JSON.stringify(b);
}

function getOptimisticSessionCwd(
  project: ProjectInfo,
  inheritedWorkspacePath?: string | null,
): string {
  const workspacePath = inheritedWorkspacePath?.trim();
  if (workspacePath) {
    return workspacePath;
  }

  const projectWorkingDir = project.workingDirs
    .map((directory) => directory.trim())
    .find((directory) => directory.length > 0);
  return projectWorkingDir ?? "~";
}

async function ensureWindowWidth(minWidth: number) {
  if (!window.__TAURI_INTERNALS__ || window.innerWidth >= minWidth) {
    return;
  }

  const { getCurrentWindow, LogicalSize } = await import(
    "@tauri-apps/api/window"
  );
  await getCurrentWindow().setSize(
    new LogicalSize(minWidth, window.innerHeight),
  );
}

async function syncWindowMinimumSize() {
  if (!window.__TAURI_INTERNALS__) {
    return;
  }

  const { getCurrentWindow, LogicalSize } = await import(
    "@tauri-apps/api/window"
  );
  await getCurrentWindow().setMinSize(
    new LogicalSize(COLLAPSED_WINDOW_MIN_WIDTH, MIN_WINDOW_HEIGHT),
  );
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
  const { t } = useTranslation("chat");
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [sidebarWidth, setSidebarWidth] = useState(SIDEBAR_DEFAULT_WIDTH);
  const [isResizing, setIsResizing] = useState(false);
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
  const [activeDesignSystemSection, setActiveDesignSystemSection] =
    useState<DesignSystemSection>(DEFAULT_DESIGN_SYSTEM_SECTION);
  const initialActiveView = getInitialAppView(initialSettingsSection);
  const [createProjectOpen, setCreateProjectOpen] = useState(false);
  const [createProjectInitialWorkingDir, setCreateProjectInitialWorkingDir] =
    useState<string | null>(null);
  const [editingProject, setEditingProject] = useState<ProjectInfo | null>(
    null,
  );
  const [activeView, setActiveView] = useState<AppView>(initialActiveView);
  const [skillsSkillId, setSkillsSkillId] = useState<string | null>(null);
  const [agentsPersonaId, setAgentsPersonaId] = useState<string | null>(null);
  const [automationsRoute, setAutomationsRoute] =
    useState<AutomationNavigationRoute>({ surface: "overview" });
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
  const hasHydratedSessions = useChatSessionStore(selectHasHydratedSessions);
  const sessionsLoading = useChatSessionStore(selectSessionsLoading);
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
  const providerInventoryEntries = useProviderInventoryStore((s) => s.entries);
  const startup = useAppStartup();
  const onboardingGate = useOnboardingGate(startup.ready);
  const pendingProjectCreatedRef = useRef<((projectId: string) => void) | null>(
    null,
  );
  const lastNonSecondaryViewRef = useRef<AppView>("home");
  const homeSessionRequestRef = useRef<Promise<ChatSession | null> | null>(
    null,
  );
  const loadSessionMessages = useCallback(async (sessionId: string) => {
    const sid = sessionId.slice(0, 8);
    const existingMsgs = useChatStore.getState().messagesBySession[sessionId];
    if ((existingMsgs?.length ?? 0) > 0) {
      perfLog(`[perf:load] ${sid} skip — has messages`);
      return;
    }
    const t0 = performance.now();
    perfLog(`[perf:load] ${sid} start`);
    useChatStore.getState().setSessionLoading(sessionId, true);
    try {
      const [{ acpLoadSession }, { getReplayPerf, clearReplayPerf }] =
        await Promise.all([
          import("@/shared/api/acp"),
          import("@/shared/api/acpNotificationHandler"),
        ]);
      const t1 = performance.now();
      perfLog(`[perf:load] ${sid} import in ${(t1 - t0).toFixed(1)}ms`);
      const session = useChatSessionStore.getState().getSession(sessionId);
      const project = session?.projectId
        ? (useProjectStore
            .getState()
            .projects.find((p) => p.id === session.projectId) ?? null)
        : null;
      const activeWorkspace =
        session?.id != null
          ? useChatSessionStore.getState().activeWorkspaceBySession[session.id]
          : undefined;
      const workingDir = await resolveSessionCwd(
        project,
        activeWorkspace?.path ?? session?.workingDir,
      );
      await acpLoadSession(sessionId, workingDir);
      const tFlush = performance.now();
      useChatStore.getState().setSessionLoading(sessionId, false);
      const buffer = getAndDeleteReplayBuffer(sessionId);
      const replayMessages = buffer
        ? sanitizeReplayMessages(buffer)
        : undefined;
      const replayStats = getReplayPerf(sessionId);
      clearReplayPerf(sessionId);
      if (replayMessages) {
        useChatStore.getState().setMessages(sessionId, replayMessages);
      }
      const t2 = performance.now();
      perfLog(
        `[perf:load] ${sid} replay: notifs=${replayStats?.count ?? 0} span=${replayStats?.spanMs.toFixed(1) ?? "0"}ms msgs=${replayMessages?.length ?? 0} flush=${(t2 - tFlush).toFixed(1)}ms total=${(t2 - t0).toFixed(1)}ms`,
      );
    } catch (err) {
      console.error("Failed to load session messages:", err);
      clearReplayBuffer(sessionId);
      useChatStore.getState().setSessionLoading(sessionId, false);
    }
  }, []);

  useEffect(() => {
    fetchProjects();
  }, [fetchProjects]);

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
            providerInventoryEntries,
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
        // on inventory refreshes — that would clobber explicit user picks.
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
          providerInventoryEntries,
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
    providerInventoryEntries,
    projects,
    sessionsLoading,
    patchSession,
  ]);

  useEffect(() => {
    if (activeView !== "home" || onboardingGate.shouldShowOnboarding) {
      return;
    }
    void ensureHomeSession().catch((error) => {
      console.error("Failed to ensure Home session:", error);
    });
  }, [activeView, ensureHomeSession, onboardingGate.shouldShowOnboarding]);

  const createNewTab = useCallback(
    async (title = DEFAULT_CHAT_TITLE, project?: ProjectInfo) => {
      const tStart = performance.now();
      perfLog(
        `[perf:newtab] createNewTab start (project=${project?.id ?? "none"})`,
      );
      const providerId =
        project?.preferredProvider ?? selectedProvider ?? "goose";
      const sessionModelPreference =
        await resolveSupportedSessionModelPreference(
          providerId,
          providerInventoryEntries,
          project?.preferredModel ?? undefined,
        );
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
        clearSettingsSectionUrl();
        setActiveSession(existingDraft.id);
        setActiveView("chat");
        setChatActiveSession(existingDraft.id);
        perfLog(
          `[perf:newtab] ${existingDraft.id.slice(0, 8)} reused draft in ${(performance.now() - tStart).toFixed(1)}ms`,
        );
        return existingDraft;
      }

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
      clearSettingsSectionUrl();
      setActiveSession(session.id);
      setActiveView("chat");
      setChatActiveSession(session.id);
      perfLog(
        `[perf:newtab] ${session.id.slice(0, 8)} created session in ${(performance.now() - tStart).toFixed(1)}ms`,
      );
      return session;
    },
    [
      selectedProvider,
      createSession,
      patchSession,
      providerInventoryEntries,
      setActiveWorkspace,
      setActiveSession,
      setChatActiveSession,
    ],
  );

  const createNewProjectDraft = useCallback(
    async (title = DEFAULT_CHAT_TITLE, project: ProjectInfo) => {
      const tStart = performance.now();
      perfLog(
        `[perf:newtab] createNewProjectDraft start (project=${project.id})`,
      );
      const providerId =
        project.preferredProvider ?? selectedProvider ?? "goose";
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
      void Promise.all([
        resolveSupportedSessionModelPreference(
          providerId,
          providerInventoryEntries,
          project.preferredModel ?? undefined,
        ),
        resolveSessionCwd(project, inheritedWorkspace?.path),
      ])
        .then(([sessionModelPreference, workingDir]) =>
          acpCreateSession(sessionModelPreference.providerId, workingDir, {
            projectId: project.id,
            modelId: sessionModelPreference.modelId,
          }).then(({ sessionId }) => ({
            sessionId,
            sessionModelPreference,
            workingDir,
          })),
        )
        .then(({ sessionId, sessionModelPreference, workingDir }) => {
          const sessionStore = useChatSessionStore.getState();
          const latestSession = sessionStore.getSession(session.id);
          if (!latestSession || latestSession.archivedAt) {
            return;
          }
          const shouldActivate = sessionStore.activeSessionId === session.id;
          promoteChatSessionId(session.id, sessionId);
          promoteDraftSession(session.id, sessionId, {
            providerId: sessionModelPreference.providerId,
            modelId: sessionModelPreference.modelId,
            modelName: sessionModelPreference.modelName,
            workingDir,
          });
          replaceNavigationSessionId(session.id, sessionId);
          if (shouldActivate) {
            setActiveSession(sessionId);
            setChatActiveSession(sessionId);
          }
        })
        .catch((error) => {
          const message =
            error instanceof Error
              ? error.message
              : "Failed to create session.";
          const chatStore = useChatStore.getState();
          markSessionCreationFailed(session.id, message);
          chatStore.addMessage(
            session.id,
            createSystemNotificationMessage(message, "error"),
          );
          chatStore.setError(session.id, message);
        });
      return session;
    },
    [
      selectedProvider,
      createDraftSession,
      markSessionCreationFailed,
      patchSession,
      promoteChatSessionId,
      promoteDraftSession,
      providerInventoryEntries,
      replaceNavigationSessionId,
      setActiveWorkspace,
      setActiveSession,
      setChatActiveSession,
    ],
  );

  const handleStartChatFromProject = useCallback(
    (project: ProjectInfo) => {
      void createNewProjectDraft(DEFAULT_CHAT_TITLE, project);
    },
    [createNewProjectDraft],
  );

  const handleStartChatWithSkill = useCallback(
    (skill: SkillInfo, projectId?: string | null) => {
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
    },
    [createNewProjectDraft, createNewTab, projects],
  );

  const handleNewChatInProject = useCallback(
    (projectId: string) => {
      const project = projects.find((p) => p.id === projectId);
      if (project) {
        void createNewProjectDraft(DEFAULT_CHAT_TITLE, project);
      }
    },
    [createNewProjectDraft, projects],
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
      setActiveView("home");
    },
    [cleanupChatSession, setActiveSession],
  );

  const expandSidebar = useCallback(async () => {
    const expandedFitWidth = getExpandedSidebarFitWidth(sidebarWidth);

    try {
      await ensureWindowWidth(expandedFitWidth);
    } catch (error) {
      console.warn("Failed to resize window before expanding sidebar:", error);
    }

    setSidebarCollapsed(false);
  }, [sidebarWidth]);

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
    clearSettingsSectionUrl();
    setActiveView(lastNonSecondaryViewRef.current);
  }, []);

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

  const selectDesignSystemSection = useCallback(
    (section: DesignSystemSection) => {
      setActiveDesignSystemSection(section);
    },
    [],
  );

  useEffect(() => {
    const handleOpenSettingsEvent = (event: Event) => {
      const section = (event as CustomEvent<{ section?: string }>).detail
        ?.section;
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

  const handleEditProject = useCallback(
    (projectId: string) => {
      const project = projects.find((p) => p.id === projectId);
      if (project) {
        setEditingProject(project);
        setCreateProjectOpen(true);
      }
    },
    [projects],
  );

  const handleMoveToProject = useCallback(
    (sessionId: string, projectId: string | null) => {
      const session = useChatSessionStore.getState().getSession(sessionId);
      if (!session) {
        return;
      }

      void moveSessionToProject(sessionId, projectId, {
        providerId: selectedProvider,
        modelId: session.modelId,
      }).catch((error) => {
        console.error("Failed to move session to project:", error);
        toast.error(t("chat:notifications.moveError"));
      });
    },
    [selectedProvider, t],
  );

  const handleRenameChat = useCallback(
    (sessionId: string, nextTitle: string) => {
      void updateSessionTitle(sessionId, nextTitle).catch((error) => {
        console.error("Failed to rename session:", error);
        toast.error(t("notifications.renameError"));
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

  const openCreateProjectDialog = useCallback(
    (options?: {
      initialWorkingDir?: string | null;
      onCreated?: (projectId: string) => void;
    }) => {
      setEditingProject(null);
      setCreateProjectInitialWorkingDir(options?.initialWorkingDir ?? null);
      pendingProjectCreatedRef.current = options?.onCreated ?? null;
      setCreateProjectOpen(true);
    },
    [],
  );

  const activateHomeSession = useCallback(
    (sessionId: string) => {
      if (homeSessionId === sessionId) {
        setHomeSessionId(null);
      }
      setActiveSession(sessionId);
      clearSettingsSectionUrl();
      setActiveView("chat");
      setChatActiveSession(sessionId);
      useChatStore.getState().markSessionRead(sessionId);
    },
    [homeSessionId, setActiveSession, setChatActiveSession],
  );

  const handleSelectSession = useCallback(
    (id: string) => {
      setActiveSession(id);
      clearSettingsSectionUrl();
      setActiveView("chat");
      setChatActiveSession(id);
      useChatStore.getState().markSessionRead(id);
      loadSessionMessages(id);
    },
    [setActiveSession, setChatActiveSession, loadSessionMessages],
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

  const handleNavigate = useCallback(
    (view: AppView) => {
      if (view === "settings") {
        openSettings();
        return;
      }
      if (view === "design-system") {
        openDesignSystem();
        return;
      }
      if (view !== "chat") {
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
    },
    [openDesignSystem, openSettings, setActiveSession],
  );

  const navigateSkills = useCallback(
    (skillId: string | null, options?: AppNavigationUpdateOptions) => {
      replaceNextNavigationEntryRef.current = Boolean(options?.replace);
      setSkillsSkillId(skillId);
      setActiveSession(null);
      clearSettingsSectionUrl();
      setActiveView("skills");
    },
    [setActiveSession],
  );

  const navigateAgents = useCallback(
    (personaId: string | null, options?: AppNavigationUpdateOptions) => {
      replaceNextNavigationEntryRef.current = Boolean(options?.replace);
      setAgentsPersonaId(personaId);
      setActiveSession(null);
      clearSettingsSectionUrl();
      setActiveView("agents");
    },
    [setActiveSession],
  );

  const navigateAutomations = useCallback(
    (
      route: AutomationNavigationRoute,
      options?: AppNavigationUpdateOptions,
    ) => {
      replaceNextNavigationEntryRef.current = Boolean(options?.replace);
      setAutomationsRoute(route);
      setActiveSession(null);
      clearSettingsSectionUrl();
      setActiveView("automations");
    },
    [setActiveSession],
  );

  const handleCreatePersona = useCreatePersonaNavigation(() =>
    handleNavigate("agents"),
  );

  const collapseSidebar = useCallback(() => {
    setSidebarCollapsed(true);
  }, []);

  const toggleSidebar = useCallback(() => {
    if (sidebarCollapsed) {
      void expandSidebar();
      return;
    }

    collapseSidebar();
  }, [collapseSidebar, expandSidebar, sidebarCollapsed]);

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
      loadSessionMessages,
      setActiveSession,
      setChatActiveSession,
      sidebarCollapsed,
    ],
  );

  const goBack = useCallback(() => {
    const history = navigationHistoryRef.current;
    if (history.index <= 0) {
      return;
    }

    history.index -= 1;
    applyNavigationLocation(history.entries[history.index]);
    updateNavigationAvailability();
  }, [applyNavigationLocation, updateNavigationAvailability]);

  const goForward = useCallback(() => {
    const history = navigationHistoryRef.current;
    if (history.index >= history.entries.length - 1) {
      return;
    }

    history.index += 1;
    applyNavigationLocation(history.entries[history.index]);
    updateNavigationAvailability();
  }, [applyNavigationLocation, updateNavigationAvailability]);

  const toggleContextPanel = useCallback(() => {
    if (!activeSessionId) {
      return;
    }

    setContextPanelOpen(activeSessionId, !isContextPanelOpen);
  }, [activeSessionId, isContextPanelOpen, setContextPanelOpen]);

  const handleFeedbackClick = useCallback(async () => {
    let version: string;
    try {
      version = await getVersion();
    } catch {
      version = "unknown";
    }
    await openFeedbackForm({
      version,
      platform: getPlatform(),
    });
  }, []);

  const handleResizeStart = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      setIsResizing(true);
      const startX = e.clientX;
      const startWidth = sidebarCollapsed
        ? SIDEBAR_COLLAPSED_WIDTH
        : sidebarWidth;
      let shouldCollapse = false;

      const onMouseMove = (moveEvent: MouseEvent) => {
        const delta = moveEvent.clientX - startX;
        const newWidth = startWidth + delta;

        if (newWidth < SIDEBAR_SNAP_COLLAPSE_THRESHOLD) {
          shouldCollapse = true;
          setSidebarWidth(SIDEBAR_MIN_WIDTH);
        } else {
          shouldCollapse = false;
          setSidebarCollapsed(false);
          setSidebarWidth(
            Math.min(SIDEBAR_MAX_WIDTH, Math.max(SIDEBAR_MIN_WIDTH, newWidth)),
          );
        }
      };

      const cleanup = () => {
        setIsResizing(false);
        if (shouldCollapse) setSidebarCollapsed(true);
        document.removeEventListener("mousemove", onMouseMove);
        document.removeEventListener("mouseup", cleanup);
        window.removeEventListener("blur", cleanup);
        document.body.style.cursor = "";
        document.body.style.userSelect = "";
      };
      document.body.style.cursor = "col-resize";
      document.body.style.userSelect = "none";
      document.addEventListener("mousemove", onMouseMove);
      document.addEventListener("mouseup", cleanup);
      window.addEventListener("blur", cleanup);
    },
    [sidebarCollapsed, sidebarWidth],
  );

  const handleResizeDoubleClick = useCallback(() => {
    setSidebarWidth(SIDEBAR_DEFAULT_WIDTH);
    void ensureWindowWidth(getExpandedSidebarFitWidth(SIDEBAR_DEFAULT_WIDTH))
      .catch((error) => {
        console.warn(
          "Failed to resize window before resetting sidebar:",
          error,
        );
      })
      .finally(() => setSidebarCollapsed(false));
  }, []);

  useEffect(() => {
    void syncWindowMinimumSize().catch((error) => {
      console.warn("Failed to update window minimum size:", error);
    });
  }, []);

  useEffect(() => {
    if (sidebarCollapsed) {
      return;
    }

    const handleWindowResize = () => {
      if (window.innerWidth < getExpandedSidebarFitWidth(sidebarWidth)) {
        setSidebarCollapsed(true);
      }
    };

    handleWindowResize();
    window.addEventListener("resize", handleWindowResize);
    return () => window.removeEventListener("resize", handleWindowResize);
  }, [sidebarCollapsed, sidebarWidth]);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      // Cmd+, for settings
      if (e.key === "," && e.metaKey) {
        e.preventDefault();
        if (activeView === "settings") {
          leaveSecondarySurface();
          return;
        }
        openSettings();
      }
      // Cmd+B for sidebar toggle
      if (e.key === "b" && e.metaKey) {
        e.preventDefault();
        toggleSidebar();
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
        setActiveSession(null);
        clearSettingsSectionUrl();
        setActiveView("home");
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [
    activeView,
    clearActiveSession,
    leaveSecondarySurface,
    openSettings,
    setActiveSession,
    toggleSidebar,
  ]);

  if (!startup.ready) {
    return (
      <div className="flex h-screen w-screen items-center justify-center bg-background text-foreground">
        <Spinner className="size-5 text-text-primary" />
      </div>
    );
  }

  if (
    onboardingGate.shouldShowOnboarding &&
    !(isDesignSystemExplorerEnabled() && activeView === "design-system")
  ) {
    return (
      <OnboardingFlow
        readiness={onboardingGate.readiness}
        onComplete={(setup) => {
          onboardingGate.completeOnboarding(setup);
          setActiveView("home");
        }}
      />
    );
  }

  return (
    <div className="flex h-screen w-screen flex-col overflow-hidden bg-background text-foreground">
      <TopBar
        sidebarCollapsed={sidebarCollapsed}
        canGoBack={navigationAvailability.canGoBack}
        canGoForward={navigationAvailability.canGoForward}
        onToggleSidebar={toggleSidebar}
        onGoBack={goBack}
        onGoForward={goForward}
        showContextPanelToggle={
          activeView === "chat" && Boolean(activeSessionId)
        }
        chromeInsets={topBarChromeInsets}
        contextPanelOpen={isContextPanelOpen}
        contextPanelLabel={contextPanelLabel}
        onToggleContextPanel={toggleContextPanel}
        onFeedbackClick={handleFeedbackClick}
      />

      <div className="goose-zoom-scope flex flex-1 min-h-0 overflow-hidden">
        <div
          className="flex-shrink-0 h-full pt-[var(--spacing-app-panel-gutter-top)] pb-3 pl-3"
          style={{
            width: sidebarCollapsed
              ? SIDEBAR_COLLAPSED_WIDTH + SIDEBAR_OUTER_GUTTER_WIDTH
              : sidebarWidth + SIDEBAR_OUTER_GUTTER_WIDTH,
            transition: isResizing ? "none" : "width 200ms ease-out",
          }}
        >
          <Sidebar
            collapsed={sidebarCollapsed}
            width={sidebarWidth}
            isResizing={isResizing}
            onSettingsClick={() => openSettings()}
            onSettingsBack={leaveSecondarySurface}
            onSettingsSectionChange={selectSettingsSection}
            onDesignSystemBack={leaveSecondarySurface}
            onDesignSystemSectionChange={selectDesignSystemSection}
            onNavigate={handleNavigate}
            onNewChatInProject={handleNewChatInProject}
            onNewChat={() => {
              setActiveSession(null);
              clearSettingsSectionUrl();
              setActiveView("home");
            }}
            onCreateProject={() => openCreateProjectDialog()}
            onEditProject={handleEditProject}
            onArchiveProject={handleArchiveProject}
            onArchiveChat={handleArchiveChat}
            onRenameChat={handleRenameChat}
            onMarkChatRead={handleMarkChatRead}
            onMarkChatUnread={handleMarkChatUnread}
            onMoveToProject={handleMoveToProject}
            onReorderProject={reorderProjects}
            onSelectSession={handleSelectSession}
            onSelectSearchResult={handleSelectSearchResult}
            activeView={activeView}
            activeSettingsSection={activeSettingsSection}
            activeDesignSystemSection={activeDesignSystemSection}
            activeSessionId={activeSessionId}
            projects={projects}
            className="h-full rounded-xl"
          />
        </div>

        {/* biome-ignore lint/a11y/noStaticElementInteractions: drag handle for sidebar resize */}
        <div
          onMouseDown={handleResizeStart}
          onDoubleClick={handleResizeDoubleClick}
          className="flex-shrink-0 h-full cursor-col-resize group flex items-center justify-center"
          style={{ width: SIDEBAR_RESIZE_HANDLE_WIDTH }}
        >
          <div className="w-px h-8 rounded-full bg-transparent group-hover:bg-border transition-colors" />
        </div>

        <main className="min-h-0 min-w-0 flex-1">
          {children ?? (
            <AppShellContent
              activeView={activeView}
              activeSettingsSection={activeSettingsSection}
              activeSkillsSkillId={skillsSkillId}
              activeAgentsPersonaId={agentsPersonaId}
              activeAutomationsRoute={automationsRoute}
              activeDesignSystemSection={activeDesignSystemSection}
              activeSession={activeSession}
              homeSessionId={homeSessionId}
              onNavigateSkills={navigateSkills}
              onNavigateAgents={navigateAgents}
              onNavigateAutomations={navigateAutomations}
              onCreatePersona={handleCreatePersona}
              onArchiveChat={handleArchiveChat}
              onCreateProject={openCreateProjectDialog}
              onActivateHomeSession={activateHomeSession}
              onRenameChat={handleRenameChat}
              onSelectSession={handleSelectSession}
              onSelectSearchResult={handleSelectSearchResult}
              onStartChatFromProject={handleStartChatFromProject}
              onStartChatWithSkill={handleStartChatWithSkill}
            />
          )}
        </main>
      </div>

      <CreateProjectDialog
        isOpen={createProjectOpen}
        onClose={() => {
          setCreateProjectOpen(false);
          setEditingProject(null);
          setCreateProjectInitialWorkingDir(null);
          pendingProjectCreatedRef.current = null;
        }}
        onCreated={(project) => {
          fetchProjects();
          pendingProjectCreatedRef.current?.(project.id);
          pendingProjectCreatedRef.current = null;
          setCreateProjectInitialWorkingDir(null);
        }}
        initialWorkingDir={createProjectInitialWorkingDir}
        editingProject={editingProject ?? undefined}
      />
      {isDesignSystemExplorerEnabled() ? <DesignSystemInspector /> : null}
    </div>
  );
}

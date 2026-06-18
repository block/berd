import { useEffect, type ReactNode } from "react";
import { HomeScreen } from "@/features/home/ui/HomeScreen";
import { HomeView } from "@/features/home/ui/HomeView";
import { ChatView } from "@/features/chat/ui/ChatView";
import { AutomationsWorkbench } from "@/features/automations/ui/AutomationsView";
import type { AutomationBuilderLeaveAction } from "@/features/automations/ui/AutomationBuilderView";
import { BuilderbotView } from "@/features/builderbot/ui/BuilderbotView";
import { SkillsView } from "@/features/skills/ui/SkillsView";
import { AgentsView } from "@/features/agents/ui/AgentsView";
import { ProjectsView } from "@/features/projects/ui/ProjectsView";
import { SearchView } from "@/features/search/ui/SearchView";
import { SessionHistoryView } from "@/features/sessions/ui/SessionHistoryView";
import { SettingsView } from "@/features/settings/ui/SettingsView";
import { DesignSystemView } from "@/features/design-system/ui/DesignSystemView";
import { isDesignSystemExplorerEnabled } from "@/features/design-system/lib/designSystemEnabled";
import { BUILDERBOT_SURFACE_EXPERIMENT_ID } from "@/features/experiments/experimentDefinitions";
import { useExperiment } from "@/features/experiments/experimentPreferences";
import type { ChatSession } from "@/features/chat/stores/chatSessionStore";
import type { SkillInfo } from "@/features/skills/api/skills";
import type { ProjectInfo } from "@/features/projects/api/projects";
import type { ExtensionEntry } from "@/features/extensions/types";
import type { ConnectionsTab } from "@/features/connections/ui/ConnectionsSettings";
import type { AgentSourceEntry } from "@/shared/api/agents";
import type { AgentSetupTroubleshootingRequest } from "@/features/providers/lib/agentSetupTroubleshooting";
import type {
  AppNavigationLocation,
  AppNavigationUpdateOptions,
  AutomationNavigationRoute,
  BuilderbotNavigationRoute,
} from "../types/appNavigation";
import { perfLog } from "@/shared/lib/perfLog";
import { cn } from "@/shared/lib/cn";
import { AppContentPlaceholder } from "./AppContentPlaceholder";
import { scheduleAfterNextPaint } from "../lib/scheduleAfterNextPaint";

interface AppShellContentProps {
  targetLocation: AppNavigationLocation;
  renderedLocation: AppNavigationLocation;
  isPreparingContent: boolean;
  activeConnectionsTab: ConnectionsTab;
  renderedSession?: ChatSession;
  homeSessionId: string | null;
  homeViewportLeftOcclusionPx?: number;
  onNavigateSkills: (
    skillId: string | null,
    options?: AppNavigationUpdateOptions,
  ) => void;
  onNavigateAgents: (
    personaId: string | null,
    options?: AppNavigationUpdateOptions,
  ) => void;
  onNavigateAutomations: (
    route: AutomationNavigationRoute,
    options?: AppNavigationUpdateOptions,
  ) => void;
  onNavigateBuilderbot: (
    route: BuilderbotNavigationRoute,
    options?: AppNavigationUpdateOptions,
  ) => void;
  onConnectionsTabChange: (tab: ConnectionsTab) => void;
  onSkillsBreadcrumbLabelChange?: (label: string | null) => void;
  onAgentsBreadcrumbLabelChange?: (label: string | null) => void;
  onAutomationsBreadcrumbLabelChange?: (label: string | null) => void;
  onBuilderbotBreadcrumbLabelChange?: (label: string | null) => void;
  onAutomationBuilderLeaveActionChange?: (
    action: AutomationBuilderLeaveAction | null,
  ) => void;
  onCreatePersona: () => void;
  onAgentBuilderSaved?: (source: AgentSourceEntry) => void;
  onAgentBuilderClose?: () => void;
  onStartAgentBuilderSession: (args?: { path?: string; slug?: string }) => void;
  onArchiveChat: (sessionId: string) => Promise<void>;
  onCreateProject: (options?: {
    initialWorkingDir?: string | null;
    onCreated?: (projectId: string) => void;
  }) => void;
  onOpenProjectSettings: (projectId: string) => void;
  onActivateHomeSession: (sessionId: string) => void;
  onRenameChat: (sessionId: string, nextTitle: string) => void;
  onSelectSession: (sessionId: string) => void;
  onSelectSearchResult: (
    sessionId: string,
    messageId?: string,
    query?: string,
  ) => void;
  onStartChatFromProjectId: (projectId: string) => void;
  onStartChatFromProject: (project: ProjectInfo) => void;
  onStartProjectChat: (projectId: string) => void;
  onStartChatWithSkill: (skill: SkillInfo, projectId?: string | null) => void;
  onExitSearch: () => void;
  onOpenExtension: (entry: ExtensionEntry) => void;
  onOpenAgent: (agentId: string) => void;
  onOpenAutomation: (automationId: string) => void;
  onOpenSkill: (skill: SkillInfo) => void;
  onHydratePinnedChatSessions?: (sessionIds: string[]) => void;
  onStartProviderTroubleshootingChat: (
    request: AgentSetupTroubleshootingRequest,
  ) => void;
  onReturnToAgentDraft?: () => void;
}

export function AppShellContent({
  targetLocation,
  renderedLocation,
  isPreparingContent,
  activeConnectionsTab,
  renderedSession,
  homeSessionId,
  homeViewportLeftOcclusionPx = 0,
  onNavigateSkills,
  onNavigateAgents,
  onNavigateAutomations,
  onNavigateBuilderbot,
  onConnectionsTabChange,
  onSkillsBreadcrumbLabelChange,
  onAgentsBreadcrumbLabelChange,
  onAutomationsBreadcrumbLabelChange,
  onBuilderbotBreadcrumbLabelChange,
  onAutomationBuilderLeaveActionChange,
  onCreatePersona,
  onAgentBuilderSaved,
  onAgentBuilderClose,
  onStartAgentBuilderSession,
  onArchiveChat,
  onCreateProject,
  onOpenProjectSettings,
  onActivateHomeSession,
  onRenameChat,
  onSelectSession,
  onSelectSearchResult,
  onStartChatFromProjectId,
  onStartChatFromProject,
  onStartProjectChat,
  onStartChatWithSkill,
  onExitSearch,
  onOpenExtension,
  onOpenAgent,
  onOpenAutomation,
  onOpenSkill,
  onHydratePinnedChatSessions,
  onStartProviderTroubleshootingChat,
  onReturnToAgentDraft,
}: AppShellContentProps) {
  const builderbotExperiment = useExperiment(BUILDERBOT_SURFACE_EXPERIMENT_ID);
  useNavigationPerfLogging({
    isPreparingContent,
    renderedLocation,
    targetLocation,
  });

  const homeContent = (
    <HomeView
      onOpenProject={onStartChatFromProjectId}
      onOpenAgent={onOpenAgent}
      onOpenSkill={onOpenSkill}
      onSelectSession={onSelectSession}
      onStartProjectChat={onStartProjectChat}
      onCreatePersona={onCreatePersona}
      onCreateProject={onCreateProject}
      onOpenAutomation={(automationId) =>
        onNavigateAutomations({
          surface: "detail",
          automationId,
          tab: "details",
          selectedRunKey: null,
        })
      }
      onOpenSkills={() => onNavigateSkills(null)}
      onOpenAutomations={() => onNavigateAutomations({ surface: "overview" })}
      onHydratePinnedChatSessions={onHydratePinnedChatSessions}
      viewportLeftOcclusionPx={homeViewportLeftOcclusionPx}
    />
  );

  const routeContent = renderRouteContent({
    activeConnectionsTab,
    builderbotEnabled: Boolean(builderbotExperiment?.enabled),
    homeContent,
    homeSessionId,
    location: renderedLocation,
    onActivateHomeSession,
    onAgentBuilderClose,
    onAgentBuilderSaved,
    onAgentsBreadcrumbLabelChange,
    onArchiveChat,
    onAutomationBuilderLeaveActionChange,
    onAutomationsBreadcrumbLabelChange,
    onBuilderbotBreadcrumbLabelChange,
    onConnectionsTabChange,
    onCreatePersona,
    onCreateProject,
    onExitSearch,
    onNavigateAgents,
    onNavigateAutomations,
    onNavigateBuilderbot,
    onNavigateSkills,
    onOpenAgent,
    onOpenAutomation,
    onOpenExtension,
    onOpenProjectSettings,
    onOpenSkill,
    onRenameChat,
    onReturnToAgentDraft,
    onSelectSearchResult,
    onSelectSession,
    onSkillsBreadcrumbLabelChange,
    onStartAgentBuilderSession,
    onStartChatFromProject,
    onStartChatWithSkill,
    onStartProviderTroubleshootingChat,
    renderedSession,
  });

  return (
    <AppStagedContentFrame isPreparing={isPreparingContent}>
      <AppRouteLayer inert={isPreparingContent} hidden={isPreparingContent}>
        {routeContent}
      </AppRouteLayer>
      {isPreparingContent ? (
        <div className="absolute inset-0 z-10 min-h-0">
          <AppContentPlaceholder location={targetLocation} />
        </div>
      ) : null}
    </AppStagedContentFrame>
  );
}

interface RenderRouteContentOptions {
  activeConnectionsTab: ConnectionsTab;
  builderbotEnabled: boolean;
  homeContent: ReactNode;
  homeSessionId: string | null;
  location: AppNavigationLocation;
  onNavigateSkills: (
    skillId: string | null,
    options?: AppNavigationUpdateOptions,
  ) => void;
  onNavigateAgents: (
    personaId: string | null,
    options?: AppNavigationUpdateOptions,
  ) => void;
  onNavigateAutomations: (
    route: AutomationNavigationRoute,
    options?: AppNavigationUpdateOptions,
  ) => void;
  onNavigateBuilderbot: (
    route: BuilderbotNavigationRoute,
    options?: AppNavigationUpdateOptions,
  ) => void;
  onConnectionsTabChange: (tab: ConnectionsTab) => void;
  onSkillsBreadcrumbLabelChange?: (label: string | null) => void;
  onAgentsBreadcrumbLabelChange?: (label: string | null) => void;
  onAutomationsBreadcrumbLabelChange?: (label: string | null) => void;
  onBuilderbotBreadcrumbLabelChange?: (label: string | null) => void;
  onAutomationBuilderLeaveActionChange?: (
    action: AutomationBuilderLeaveAction | null,
  ) => void;
  onCreatePersona: () => void;
  onAgentBuilderSaved?: (source: AgentSourceEntry) => void;
  onAgentBuilderClose?: () => void;
  onStartAgentBuilderSession: (args?: { path?: string; slug?: string }) => void;
  onArchiveChat: (sessionId: string) => Promise<void>;
  onCreateProject: (options?: {
    initialWorkingDir?: string | null;
    onCreated?: (projectId: string) => void;
  }) => void;
  onOpenProjectSettings: (projectId: string) => void;
  onActivateHomeSession: (sessionId: string) => void;
  onRenameChat: (sessionId: string, nextTitle: string) => void;
  onSelectSession: (sessionId: string) => void;
  onSelectSearchResult: (
    sessionId: string,
    messageId?: string,
    query?: string,
  ) => void;
  onStartChatFromProject: (project: ProjectInfo) => void;
  onStartChatWithSkill: (skill: SkillInfo, projectId?: string | null) => void;
  onExitSearch: () => void;
  onOpenExtension: (entry: ExtensionEntry) => void;
  onOpenAgent: (agentId: string) => void;
  onOpenAutomation: (automationId: string) => void;
  onOpenSkill: (skill: SkillInfo) => void;
  onStartProviderTroubleshootingChat: (
    request: AgentSetupTroubleshootingRequest,
  ) => void;
  onReturnToAgentDraft?: () => void;
  renderedSession?: ChatSession;
}

function renderRouteContent({
  activeConnectionsTab,
  builderbotEnabled,
  homeContent,
  homeSessionId,
  location,
  onActivateHomeSession,
  onAgentBuilderClose,
  onAgentBuilderSaved,
  onAgentsBreadcrumbLabelChange,
  onArchiveChat,
  onAutomationBuilderLeaveActionChange,
  onAutomationsBreadcrumbLabelChange,
  onBuilderbotBreadcrumbLabelChange,
  onConnectionsTabChange,
  onCreatePersona,
  onCreateProject,
  onExitSearch,
  onNavigateAgents,
  onNavigateAutomations,
  onNavigateBuilderbot,
  onNavigateSkills,
  onOpenAgent,
  onOpenAutomation,
  onOpenExtension,
  onOpenProjectSettings,
  onOpenSkill,
  onRenameChat,
  onReturnToAgentDraft,
  onSelectSearchResult,
  onSelectSession,
  onSkillsBreadcrumbLabelChange,
  onStartAgentBuilderSession,
  onStartChatFromProject,
  onStartChatWithSkill,
  onStartProviderTroubleshootingChat,
  renderedSession,
}: RenderRouteContentOptions) {
  switch (location.view) {
    case "design-system":
      return isDesignSystemExplorerEnabled() ? (
        <DesignSystemView activeSection={location.designSystemSection} />
      ) : null;
    case "settings":
      return (
        <SettingsView
          activeSection={location.settingsSection}
          activeConnectionsTab={activeConnectionsTab}
          onConnectionsTabChange={onConnectionsTabChange}
          onStartTroubleshootingChat={onStartProviderTroubleshootingChat}
          onReturnToAgentDraft={onReturnToAgentDraft}
        />
      );
    case "automations":
      return (
        <AutomationsWorkbench
          route={location.route}
          onRouteChange={onNavigateAutomations}
          onBreadcrumbLabelChange={onAutomationsBreadcrumbLabelChange}
          onBuilderLeaveActionChange={onAutomationBuilderLeaveActionChange}
        />
      );
    case "builderbot":
      return builderbotEnabled ? (
        <BuilderbotView
          route={location.route}
          onRouteChange={onNavigateBuilderbot}
          onBreadcrumbLabelChange={onBuilderbotBreadcrumbLabelChange}
        />
      ) : (
        homeContent
      );
    case "skills":
      return (
        <SkillsView
          activeSkillId={location.skillId}
          onActiveSkillIdChange={onNavigateSkills}
          onBreadcrumbLabelChange={onSkillsBreadcrumbLabelChange}
          onStartChatWithSkill={onStartChatWithSkill}
        />
      );
    case "agents":
      return (
        <AgentsView
          activePersonaId={location.personaId}
          onActivePersonaIdChange={onNavigateAgents}
          onBreadcrumbLabelChange={onAgentsBreadcrumbLabelChange}
          onStartAgentBuilderSession={onStartAgentBuilderSession}
          onStartChatWithAgent={onOpenAgent}
        />
      );
    case "projects":
      return <ProjectsView onStartChat={onStartChatFromProject} />;
    case "search":
      return (
        <SearchView
          onExit={onExitSearch}
          onSelectSearchResult={onSelectSearchResult}
          onOpenExtension={onOpenExtension}
          onOpenAgent={onOpenAgent}
          onOpenAutomation={onOpenAutomation}
          onOpenSkill={onOpenSkill}
        />
      );
    case "session-history":
      return (
        <SessionHistoryView
          onSelectSession={onSelectSession}
          onSelectSearchResult={onSelectSearchResult}
          onRenameChat={onRenameChat}
          onArchiveChat={onArchiveChat}
        />
      );
    case "chat":
      return renderedSession ? (
        <ChatView
          key={renderedSession.clientSessionId ?? renderedSession.id}
          sessionId={renderedSession.id}
          activeSession={renderedSession}
          onCreatePersona={onCreatePersona}
          onAgentBuilderSaved={onAgentBuilderSaved}
          onAgentBuilderClose={onAgentBuilderClose}
          onCreateProject={onCreateProject}
          onOpenProjectSettings={onOpenProjectSettings}
        />
      ) : (
        <HomeScreen
          sessionId={homeSessionId}
          onActivateSession={onActivateHomeSession}
          onCreatePersona={onCreatePersona}
          onCreateProject={onCreateProject}
        />
      );
    case "home":
      return homeContent;
  }
}

function AppStagedContentFrame({
  children,
  isPreparing,
}: {
  children: ReactNode;
  isPreparing: boolean;
}) {
  return (
    <div
      className="relative h-full min-h-0 w-full overflow-hidden"
      data-app-content-preparing={isPreparing || undefined}
    >
      {children}
    </div>
  );
}

function AppRouteLayer({
  children,
  hidden,
  inert,
}: {
  children: ReactNode;
  hidden: boolean;
  inert: boolean;
}) {
  return (
    <div
      className={cn(
        "h-full min-h-0 w-full",
        inert && "pointer-events-none",
        hidden && "absolute inset-0 opacity-0",
      )}
      aria-hidden={hidden || undefined}
      inert={inert || undefined}
    >
      {children}
    </div>
  );
}

function appNavigationLocationKey(location: AppNavigationLocation): string {
  return JSON.stringify(location);
}

function useNavigationPerfLogging({
  isPreparingContent,
  renderedLocation,
  targetLocation,
}: {
  isPreparingContent: boolean;
  renderedLocation: AppNavigationLocation;
  targetLocation: AppNavigationLocation;
}) {
  const targetKey = appNavigationLocationKey(targetLocation);
  const renderedKey = appNavigationLocationKey(renderedLocation);

  useEffect(() => {
    if (!isPreparingContent) {
      perfLog(`[perf:nav] real content commit location=${renderedKey}`);
      return;
    }

    perfLog(
      `[perf:nav] placeholder commit target=${targetKey} rendered=${renderedKey}`,
    );
    return scheduleAfterNextPaint(() => {
      perfLog(`[perf:nav] first frame target=${targetKey}`);
    });
  }, [isPreparingContent, renderedKey, targetKey]);
}

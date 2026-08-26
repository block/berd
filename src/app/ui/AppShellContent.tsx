import { useEffect, type ReactNode } from "react";
import { HomeScreen } from "@/features/home/ui/HomeScreen";
import { HomeView } from "@/features/home/ui/HomeView";
import { ChatView } from "@/features/chat/ui/ChatView";
import { ProviderSetupRequired } from "@/features/providers/ui/ProviderSetupRequired";
import { AutomationsWorkbench } from "@/features/automations/ui/AutomationsView";
import type { AutomationBuilderLeaveAction } from "@/features/automations/ui/AutomationBuilderView";
import { BuilderbotView } from "@/features/builderbot/ui/BuilderbotView";
import { SkillsView } from "@/features/skills/ui/SkillsView";
import { AgentsView } from "@/features/agents/ui/AgentsView";
import { ProjectsView } from "@/features/projects/ui/ProjectsView";
import { SearchView } from "@/features/search/ui/SearchView";
import { SessionHistoryView } from "@/features/sessions/ui/SessionHistoryView";
import { SettingsView } from "@/features/settings/ui/SettingsView";
import type { AuthStatus } from "@/features/auth/api/auth";
import { DesignSystemView } from "@/features/design-system/ui/DesignSystemView";
import { isDesignSystemExplorerEnabled } from "@/features/design-system/lib/designSystemEnabled";
import type { DesignSystemSection } from "@/features/design-system/ui/designSystemSections";
import type { ChatSession } from "@/features/chat/stores/chatSessionStore";
import type { GlobalComposerHandoffRect } from "@/shared/ui/GlobalComposerPill";
import type { SkillInfo } from "@/features/skills/api/skills";
import type { ProjectInfo } from "@/features/projects/api/projects";
import type { WorkspaceNameRequest } from "@/features/chat/hooks/useChatSessionController";
import type { ExtensionEntry } from "@/features/extensions/types";
import type { SetupChatRequest } from "@/features/chat/lib/setupChatRequest";
import type { AgentSetupTroubleshootingRequest } from "@/features/providers/lib/agentSetupTroubleshooting";
import type { ForkSessionHandler } from "@/features/sessions/hooks/useForkSession";
import type { CommandOutcome } from "@/features/berdctl/navigation";
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
  designSystemInspectorVisible?: boolean;
  onCloseDesignSystem?: () => void;
  onDesignSystemInspectorVisibleChange?: (visible: boolean) => void;
  onDesignSystemSectionChange?: (section: DesignSystemSection) => void;
  authStatus?: AuthStatus;
  onLoggedOut?: (status: AuthStatus) => void;
  isPreparingContent: boolean;
  automationsEnabled: boolean;
  builderbotEnabled: boolean;
  renderedSession?: ChatSession;
  homeSessionId: string | null;
  chatComposerHandoffRequest?: number;
  chatComposerHandoffSessionId?: string | null;
  chatComposerHandoffActive?: boolean;
  chatComposerHandoffInProgress?: boolean;
  onChatComposerHandoffTarget?: (rect: GlobalComposerHandoffRect) => void;
  onWorkspaceNameRequest?: (request: WorkspaceNameRequest) => void;
  homeViewportLeftOcclusionPx?: number;
  chatViewportLeftOcclusionPx?: number;
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
  onSkillsBreadcrumbLabelChange?: (label: string | null) => void;
  onAgentsBreadcrumbLabelChange?: (label: string | null) => void;
  onAutomationsBreadcrumbLabelChange?: (label: string | null) => void;
  onBuilderbotBreadcrumbLabelChange?: (label: string | null) => void;
  onAutomationBuilderLeaveActionChange?: (
    action: AutomationBuilderLeaveAction | null,
  ) => void;
  onCreatePersona: () => void;
  onAgentBuilderCompleted: (agentId: string) => void;
  onStartAgentBuilderSession: (args?: { path?: string; slug?: string }) => void;
  onArchiveChat: (sessionId: string) => Promise<CommandOutcome>;
  onCreateProject: (options?: {
    initialWorkingDir?: string | null;
    onCreated?: (projectId: string) => void;
  }) => void;
  onOpenProjectSettings: (projectId: string) => void;
  onActivateHomeSession: (sessionId: string) => void;
  onRenameChat: (sessionId: string, nextTitle: string) => void;
  onForkChat?: ForkSessionHandler;
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
  onResolveBerdyAgent: () => Promise<string | null>;
  onExitSearch: () => void;
  onOpenExtension: (entry: ExtensionEntry) => void;
  onOpenAgent: (agentId: string) => void;
  onOpenAutomation: (automationId: string) => void;
  onOpenSkill: (skill: SkillInfo) => void;
  onTagHomeComposerAgent: (agentId: string) => void;
  onTagHomeComposerProject: (projectId: string) => void;
  onTagHomeComposerSkill: (skill: SkillInfo) => void;
  onRunPinnedPrompt: (args: {
    text: string;
    agentId?: string;
  }) => Promise<void> | void;
  onHydratePinnedChatSessions?: (sessionIds: string[]) => void;
  onStartProviderTroubleshootingChat: (
    request: AgentSetupTroubleshootingRequest,
  ) => void;
  onStartConnectionSetupChat: (request: SetupChatRequest) => void;
  onReturnToAgentDraft?: () => void;
  onOpenProvidersSettings: () => void;
  homeProviderSetupRequired?: boolean;
}

export function AppShellContent({
  targetLocation,
  renderedLocation,
  authStatus,
  isPreparingContent,
  automationsEnabled,
  builderbotEnabled,
  designSystemInspectorVisible,
  onCloseDesignSystem,
  onDesignSystemInspectorVisibleChange,
  onDesignSystemSectionChange,
  renderedSession,
  homeSessionId,
  chatComposerHandoffRequest = 0,
  chatComposerHandoffSessionId = null,
  chatComposerHandoffActive = false,
  chatComposerHandoffInProgress = false,
  onChatComposerHandoffTarget,
  onWorkspaceNameRequest,
  homeViewportLeftOcclusionPx = 0,
  chatViewportLeftOcclusionPx = 0,
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
  onStartAgentBuilderSession,
  onArchiveChat,
  onCreateProject,
  onOpenProjectSettings,
  onActivateHomeSession,
  onRenameChat,
  onForkChat,
  onSelectSession,
  onSelectSearchResult,
  onStartChatFromProjectId,
  onStartChatFromProject,
  onStartProjectChat,
  onStartChatWithSkill,
  onResolveBerdyAgent,
  onExitSearch,
  onOpenExtension,
  onOpenAgent,
  onOpenAutomation,
  onOpenSkill,
  onTagHomeComposerAgent,
  onTagHomeComposerProject,
  onTagHomeComposerSkill,
  onRunPinnedPrompt,
  onHydratePinnedChatSessions,
  onLoggedOut,
  onStartProviderTroubleshootingChat,
  onStartConnectionSetupChat,
  onReturnToAgentDraft,
  onOpenProvidersSettings,
  homeProviderSetupRequired = false,
}: AppShellContentProps) {
  useNavigationPerfLogging({
    isPreparingContent,
    renderedLocation,
    targetLocation,
  });

  const openHomeAutomation = automationsEnabled
    ? (automationId: string) =>
        onNavigateAutomations({
          surface: "detail",
          automationId,
          tab: "details",
          selectedRunKey: null,
        })
    : undefined;
  const openHomeAutomations = automationsEnabled
    ? () => onNavigateAutomations({ surface: "overview" })
    : undefined;
  const setupRequiredContent = homeProviderSetupRequired ? (
    <div className="flex h-full w-full items-center justify-center p-6">
      <ProviderSetupRequired onOpenProviders={onOpenProvidersSettings} />
    </div>
  ) : null;
  const homeContent = setupRequiredContent ?? (
    <HomeView
      onOpenProject={onStartChatFromProjectId}
      onOpenAgent={onOpenAgent}
      onOpenSkill={onOpenSkill}
      onTagAgentInComposer={onTagHomeComposerAgent}
      onTagProjectInComposer={onTagHomeComposerProject}
      onTagSkillInComposer={onTagHomeComposerSkill}
      onRunPrompt={onRunPinnedPrompt}
      onSelectSession={onSelectSession}
      onStartProjectChat={onStartProjectChat}
      onCreatePersona={onCreatePersona}
      onCreateProject={onCreateProject}
      onWorkspaceNameRequest={onWorkspaceNameRequest}
      onOpenAutomation={openHomeAutomation}
      onOpenSkills={() => onNavigateSkills(null)}
      onOpenAutomations={openHomeAutomations}
      onHydratePinnedChatSessions={onHydratePinnedChatSessions}
      onResolveBerdyAgent={onResolveBerdyAgent}
      viewportLeftOcclusionPx={homeViewportLeftOcclusionPx}
    />
  );

  const routeContent = renderRouteContent({
    authStatus,
    automationsEnabled,
    builderbotEnabled,
    chatComposerHandoffActive,
    chatComposerHandoffInProgress,
    chatComposerHandoffRequest,
    chatComposerHandoffSessionId,
    chatViewportLeftOcclusionPx,
    designSystemInspectorVisible,
    homeContent,
    homeSessionId,
    location: renderedLocation,
    onCloseDesignSystem,
    onDesignSystemInspectorVisibleChange,
    onDesignSystemSectionChange,
    onActivateHomeSession,
    onAgentsBreadcrumbLabelChange,
    onArchiveChat,
    onAutomationBuilderLeaveActionChange,
    onAutomationsBreadcrumbLabelChange,
    onBuilderbotBreadcrumbLabelChange,
    onChatComposerHandoffTarget,
    onWorkspaceNameRequest,
    onCreatePersona,
    onAgentBuilderCompleted,
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
    onLoggedOut,
    onOpenSkill,
    onRenameChat,
    onForkChat,
    onReturnToAgentDraft,
    onSelectSearchResult,
    onSelectSession,
    onSkillsBreadcrumbLabelChange,
    onStartAgentBuilderSession,
    onStartChatFromProject,
    onStartChatWithSkill,
    onStartProviderTroubleshootingChat,
    onStartConnectionSetupChat,
    renderedSession,
    setupRequiredContent,
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
  authStatus?: AuthStatus;
  automationsEnabled: boolean;
  builderbotEnabled: boolean;
  chatComposerHandoffActive: boolean;
  chatComposerHandoffInProgress: boolean;
  chatComposerHandoffRequest: number;
  chatComposerHandoffSessionId: string | null;
  chatViewportLeftOcclusionPx: number;
  designSystemInspectorVisible?: boolean;
  homeContent: ReactNode;
  homeSessionId: string | null;
  location: AppNavigationLocation;
  onCloseDesignSystem?: () => void;
  onDesignSystemInspectorVisibleChange?: (visible: boolean) => void;
  onDesignSystemSectionChange?: (section: DesignSystemSection) => void;
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
  onSkillsBreadcrumbLabelChange?: (label: string | null) => void;
  onAgentsBreadcrumbLabelChange?: (label: string | null) => void;
  onAutomationsBreadcrumbLabelChange?: (label: string | null) => void;
  onBuilderbotBreadcrumbLabelChange?: (label: string | null) => void;
  onChatComposerHandoffTarget?: (rect: GlobalComposerHandoffRect) => void;
  onWorkspaceNameRequest?: (request: WorkspaceNameRequest) => void;
  onAutomationBuilderLeaveActionChange?: (
    action: AutomationBuilderLeaveAction | null,
  ) => void;
  onCreatePersona: () => void;
  onAgentBuilderCompleted: (agentId: string) => void;
  onStartAgentBuilderSession: (args?: { path?: string; slug?: string }) => void;
  onArchiveChat: (sessionId: string) => Promise<CommandOutcome>;
  onCreateProject: (options?: {
    initialWorkingDir?: string | null;
    onCreated?: (projectId: string) => void;
  }) => void;
  onOpenProjectSettings: (projectId: string) => void;
  onActivateHomeSession: (sessionId: string) => void;
  onRenameChat: (sessionId: string, nextTitle: string) => void;
  onForkChat?: ForkSessionHandler;
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
  onLoggedOut?: (status: AuthStatus) => void;
  onStartProviderTroubleshootingChat: (
    request: AgentSetupTroubleshootingRequest,
  ) => void;
  onStartConnectionSetupChat: (request: SetupChatRequest) => void;
  onReturnToAgentDraft?: () => void;
  renderedSession?: ChatSession;
  setupRequiredContent: ReactNode | null;
}

function renderRouteContent({
  automationsEnabled,
  builderbotEnabled,
  chatComposerHandoffActive,
  chatComposerHandoffInProgress,
  chatComposerHandoffRequest,
  authStatus,
  chatComposerHandoffSessionId,
  chatViewportLeftOcclusionPx,
  designSystemInspectorVisible,
  homeContent,
  homeSessionId,
  location,
  onActivateHomeSession,
  onAgentsBreadcrumbLabelChange,
  onArchiveChat,
  onAutomationBuilderLeaveActionChange,
  onAutomationsBreadcrumbLabelChange,
  onBuilderbotBreadcrumbLabelChange,
  onChatComposerHandoffTarget,
  onWorkspaceNameRequest,
  onCloseDesignSystem,
  onCreatePersona,
  onAgentBuilderCompleted,
  onCreateProject,
  onDesignSystemInspectorVisibleChange,
  onDesignSystemSectionChange,
  onExitSearch,
  onNavigateAgents,
  onNavigateAutomations,
  onNavigateBuilderbot,
  onNavigateSkills,
  onOpenAgent,
  onOpenAutomation,
  onOpenExtension,
  onOpenProjectSettings,
  onLoggedOut,
  onOpenSkill,
  onRenameChat,
  onForkChat,
  onReturnToAgentDraft,
  onSelectSearchResult,
  onSelectSession,
  onSkillsBreadcrumbLabelChange,
  onStartAgentBuilderSession,
  onStartChatFromProject,
  onStartChatWithSkill,
  onStartProviderTroubleshootingChat,
  onStartConnectionSetupChat,
  setupRequiredContent,
  renderedSession,
}: RenderRouteContentOptions) {
  switch (location.view) {
    case "design-system":
      return isDesignSystemExplorerEnabled() ? (
        <DesignSystemView
          activeSection={location.designSystemSection}
          inspectorVisible={designSystemInspectorVisible}
          onClose={onCloseDesignSystem}
          onInspectorVisibleChange={onDesignSystemInspectorVisibleChange}
          onSectionChange={onDesignSystemSectionChange}
        />
      ) : null;
    case "settings":
      return (
        <SettingsView
          activeSection={location.settingsSection}
          authStatus={authStatus}
          onLoggedOut={onLoggedOut}
          onStartTroubleshootingChat={onStartProviderTroubleshootingChat}
          onStartConnectionSetupChat={onStartConnectionSetupChat}
          onReturnToAgentDraft={onReturnToAgentDraft}
        />
      );
    case "automations":
      return automationsEnabled ? (
        <AutomationsWorkbench
          route={location.route}
          onRouteChange={onNavigateAutomations}
          onBreadcrumbLabelChange={onAutomationsBreadcrumbLabelChange}
          onBuilderLeaveActionChange={onAutomationBuilderLeaveActionChange}
        />
      ) : (
        homeContent
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
          onDeleteDraftSession={(sessionId) =>
            onArchiveChat(sessionId).then(() => undefined)
          }
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
          onCreateProject={onCreateProject}
          onOpenProjectSettings={onOpenProjectSettings}
          onForkChat={onForkChat}
          leftViewportOcclusionPx={chatViewportLeftOcclusionPx}
          composerHandoffRequest={chatComposerHandoffRequest}
          composerHandoffSessionId={chatComposerHandoffSessionId}
          composerHandoffActive={chatComposerHandoffActive}
          composerHandoffInProgress={chatComposerHandoffInProgress}
          onComposerHandoffTarget={onChatComposerHandoffTarget}
          onWorkspaceNameRequest={onWorkspaceNameRequest}
          onAgentBuilderCompleted={onAgentBuilderCompleted}
        />
      ) : (
        (setupRequiredContent ?? (
          <HomeScreen
            sessionId={homeSessionId}
            onActivateSession={onActivateHomeSession}
            onCreatePersona={onCreatePersona}
            onCreateProject={onCreateProject}
            onWorkspaceNameRequest={onWorkspaceNameRequest}
          />
        ))
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

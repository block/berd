import { HomeScreen } from "@/features/home/ui/HomeScreen";
import { ChatView } from "@/features/chat/ui/ChatView";
import { AutomationsWorkbench } from "@/features/automations/ui/AutomationsView";
import { SkillsView } from "@/features/skills/ui/SkillsView";
import { AgentsView } from "@/features/agents/ui/AgentsView";
import { ProjectsView } from "@/features/projects/ui/ProjectsView";
import { SessionHistoryView } from "@/features/sessions/ui/SessionHistoryView";
import { SettingsView } from "@/features/settings/ui/SettingsView";
import { DesignSystemView } from "@/features/design-system/ui/DesignSystemView";
import { isDesignSystemExplorerEnabled } from "@/features/design-system/lib/designSystemEnabled";
import type { ChatSession } from "@/features/chat/stores/chatSessionStore";
import type { SkillInfo } from "@/features/skills/api/skills";
import type { ProjectInfo } from "@/features/projects/api/projects";
import type {
  AppNavigationUpdateOptions,
  AppView,
  AutomationNavigationRoute,
} from "../types/appNavigation";
import type { SectionId } from "@/features/settings/ui/settingsSections";
import type { DesignSystemSection } from "@/features/design-system/ui/designSystemSections";

interface AppShellContentProps {
  activeView: AppView;
  activeSettingsSection: SectionId;
  activeSkillsSkillId: string | null;
  activeAgentsPersonaId: string | null;
  activeAutomationsRoute: AutomationNavigationRoute;
  activeDesignSystemSection: DesignSystemSection;
  activeSession?: ChatSession;
  homeSessionId: string | null;
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
  onCreatePersona: () => void;
  onArchiveChat: (sessionId: string) => Promise<void>;
  onCreateProject: (options?: {
    initialWorkingDir?: string | null;
    onCreated?: (projectId: string) => void;
  }) => void;
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
}

export function AppShellContent({
  activeView,
  activeSettingsSection,
  activeSkillsSkillId,
  activeAgentsPersonaId,
  activeAutomationsRoute,
  activeDesignSystemSection,
  activeSession,
  homeSessionId,
  onNavigateSkills,
  onNavigateAgents,
  onNavigateAutomations,
  onCreatePersona,
  onArchiveChat,
  onCreateProject,
  onActivateHomeSession,
  onRenameChat,
  onSelectSession,
  onSelectSearchResult,
  onStartChatFromProject,
  onStartChatWithSkill,
}: AppShellContentProps) {
  switch (activeView) {
    case "design-system":
      return isDesignSystemExplorerEnabled() ? (
        <DesignSystemView activeSection={activeDesignSystemSection} />
      ) : null;
    case "settings":
      return <SettingsView activeSection={activeSettingsSection} />;
    case "automations":
      return (
        <AutomationsWorkbench
          route={activeAutomationsRoute}
          onRouteChange={onNavigateAutomations}
        />
      );
    case "skills":
      return (
        <SkillsView
          activeSkillId={activeSkillsSkillId}
          onActiveSkillIdChange={onNavigateSkills}
          onStartChatWithSkill={onStartChatWithSkill}
        />
      );
    case "agents":
      return (
        <AgentsView
          activePersonaId={activeAgentsPersonaId}
          onActivePersonaIdChange={onNavigateAgents}
        />
      );
    case "projects":
      return <ProjectsView onStartChat={onStartChatFromProject} />;
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
      return activeSession ? (
        <ChatView
          key={activeSession.id}
          sessionId={activeSession.id}
          onCreatePersona={onCreatePersona}
          onCreateProject={onCreateProject}
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
      return (
        <HomeScreen
          sessionId={homeSessionId}
          onActivateSession={onActivateHomeSession}
          onCreatePersona={onCreatePersona}
          onCreateProject={onCreateProject}
        />
      );
  }
}

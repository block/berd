import type { SectionId } from "@/features/settings/ui/settingsSections";
import type { DesignSystemSection } from "@/features/design-system/ui/designSystemSections";

export type AppView =
  | "home"
  | "chat"
  | "automations"
  | "builderbot"
  | "design-system"
  | "skills"
  | "agents"
  | "projects"
  | "search"
  | "session-history"
  | "settings";

export type AutomationRunLocation = {
  automationId: string;
  runKey: string;
};

export type AutomationNavigationRoute =
  | { surface: "overview" }
  | { surface: "builder"; automationId?: string }
  | {
      surface: "history";
      selectedRun: AutomationRunLocation | null;
    }
  | {
      surface: "detail";
      automationId: string;
      tab: "details" | "history";
      selectedRunKey: string | null;
    };

export type BuilderbotNavigationRoute =
  | { surface: "overview"; tab?: "tasks" | "automations" }
  | { surface: "task"; taskKey: string }
  | { surface: "automation"; automationId: string };

export type AppNavigationLocation =
  | { view: "home" }
  | { view: "chat"; sessionId: string | null }
  | { view: "automations"; route: AutomationNavigationRoute }
  | { view: "builderbot"; route: BuilderbotNavigationRoute }
  | { view: "design-system"; designSystemSection: DesignSystemSection }
  | { view: "skills"; skillId: string | null }
  | { view: "agents"; personaId: string | null }
  | { view: "projects" }
  | { view: "search" }
  | { view: "session-history" }
  | { view: "settings"; settingsSection: SectionId };

export type AppNavigationUpdateOptions = {
  replace?: boolean;
};

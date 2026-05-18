import type { SectionId } from "@/features/settings/ui/settingsSections";

export type AppView =
  | "home"
  | "chat"
  | "automations"
  | "skills"
  | "agents"
  | "projects"
  | "session-history"
  | "settings";

export type AutomationRunLocation = {
  automationId: string;
  runKey: string;
};

export type AutomationNavigationRoute =
  | { surface: "overview" }
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

export type AppNavigationLocation =
  | { view: "home" }
  | { view: "chat"; sessionId: string | null }
  | { view: "automations"; route: AutomationNavigationRoute }
  | { view: "skills"; skillId: string | null }
  | { view: "agents"; personaId: string | null }
  | { view: "projects" }
  | { view: "session-history" }
  | { view: "settings"; settingsSection: SectionId };

export type AppNavigationUpdateOptions = {
  replace?: boolean;
};

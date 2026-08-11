export const ASSISTIVE_UX_STORAGE_KEY = "goose:assistive-ux";
export const ASSISTIVE_UX_STORAGE_VERSION = 1;

export type AssistiveUxMomentType = "discover" | "suggest" | "autoApply";

export type AssistiveUxMomentId =
  | "notifications.changeSound"
  | "chat.jumpToResponseStart"
  | "chat.agentToolsConnectionTips"
  | "home.starterTasks"
  | "sidebar.projectsInfo";

export type AssistiveUxRetiredReason =
  | "accepted"
  | "dismissed"
  | "expired"
  | "settingsChanged"
  | "manualSettingChange"
  | "autoApplied";

export interface AssistiveUxRuleDefinition {
  id: AssistiveUxMomentId;
  type: AssistiveUxMomentType;
  maxShows?: number;
}

export const ASSISTIVE_UX_RULES = {
  notificationsChangeSound: {
    id: "notifications.changeSound",
    type: "discover",
    maxShows: 3,
  },
  chatJumpToResponseStart: {
    id: "chat.jumpToResponseStart",
    type: "discover",
    maxShows: 1,
  },
  chatAgentToolsConnectionTips: {
    id: "chat.agentToolsConnectionTips",
    type: "autoApply",
  },
  homeStarterTasks: {
    id: "home.starterTasks",
    type: "discover",
  },
  sidebarProjectsInfo: {
    id: "sidebar.projectsInfo",
    type: "discover",
    maxShows: 5,
  },
} as const satisfies Record<string, AssistiveUxRuleDefinition>;

export function getAssistiveUxRule(
  id: AssistiveUxMomentId,
): AssistiveUxRuleDefinition {
  const rule = Object.values(ASSISTIVE_UX_RULES).find(
    (definition) => definition.id === id,
  );

  if (!rule) {
    throw new Error(`Unknown Assistive UX rule: ${id}`);
  }

  return rule;
}

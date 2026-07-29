import type { SectionId } from "./settingsSections";

export interface SettingsSearchItem {
  id: string;
  sectionId: SectionId;
  labelKey: string;
}

/** Searchable controls and destinations that are visible within Settings. */
export const SETTINGS_SEARCH_ITEMS: readonly SettingsSearchItem[] = [
  {
    id: "theme",
    sectionId: "general",
    labelKey: "appearance.theme.label",
  },
  {
    id: "primary-color",
    sectionId: "general",
    labelKey: "appearance.primary.label",
  },
  {
    id: "animated-avatars",
    sectionId: "general",
    labelKey: "appearance.animatedAvatars.label",
  },
  {
    id: "working-indicator",
    sectionId: "general",
    labelKey: "appearance.workingIndicatorAnimation.label",
  },
  {
    id: "pin-labels",
    sectionId: "general",
    labelKey: "appearance.homePinLabels.label",
  },
  {
    id: "language",
    sectionId: "general",
    labelKey: "general.language.label",
  },
  {
    id: "chat-tips",
    sectionId: "general",
    labelKey: "general.agentToolsTips.label",
  },
  {
    id: "mention-default",
    sectionId: "general",
    labelKey: "general.atMentionDefault.label",
  },
  {
    id: "follow-up",
    sectionId: "general",
    labelKey: "general.followUpBehavior.label",
  },
  {
    id: "group-chats",
    sectionId: "general",
    labelKey: "general.groupChatsByProject.label",
  },
  {
    id: "session-cost",
    sectionId: "general",
    labelKey: "general.sessionCost.label",
  },
  {
    id: "response-gutter",
    sectionId: "general",
    labelKey: "general.responseStartGutter.label",
  },
  {
    id: "artifact-auto-open",
    sectionId: "general",
    labelKey: "general.artifactAutoOpen.label",
  },
  {
    id: "artifact-location",
    sectionId: "general",
    labelKey: "general.artifacts.label",
  },
  {
    id: "terminal-folder",
    sectionId: "general",
    labelKey: "general.terminalFallback.label",
  },
  {
    id: "style-guidelines",
    sectionId: "general",
    labelKey: "general.styleGuidelines.title",
  },
  {
    id: "connections",
    sectionId: "connections",
    labelKey: "nav.connections",
  },
  {
    id: "providers",
    sectionId: "providers",
    labelKey: "nav.providers",
  },
  {
    id: "notifications-enabled",
    sectionId: "notifications",
    labelKey: "notifications.enabled.label",
  },
  {
    id: "notifications-in-app",
    sectionId: "notifications",
    labelKey: "notifications.inApp.label",
  },
  {
    id: "notifications-desktop",
    sectionId: "notifications",
    labelKey: "notifications.desktop.label",
  },
  {
    id: "shortcuts",
    sectionId: "shortcuts",
    labelKey: "nav.shortcuts",
  },
  {
    id: "archive",
    sectionId: "archive",
    labelKey: "nav.archive",
  },
  {
    id: "updates",
    sectionId: "updates",
    labelKey: "nav.updates",
  },
  {
    id: "doctor",
    sectionId: "doctor",
    labelKey: "nav.doctor",
  },
  {
    id: "experiments",
    sectionId: "experiments",
    labelKey: "nav.experiments",
  },
] as const;

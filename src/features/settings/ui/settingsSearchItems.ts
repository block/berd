import type { SectionId } from "./settingsSections";

export interface SettingsSearchItem {
  id: string;
  sectionId: SectionId;
  labelKey: string;
}

// Rev 3 (Aug 10): rewritten against the appearance/behavior/system/about
// split (see settingsSections.ts). "group-chats"
// (general.groupChatsByProject) was dropped -- that control now lives in
// the sidebar's own display-options menu (SidebarDisplayOptionsMenu.tsx),
// not in Settings, so there's no page for a search hit to land on.
// "language" moved from "behavior" to "system" alongside the row itself.
//
// Rev 5 (Aug 19): "about" and "updates" now point at "system" -- About
// merged into System (see settingsSections.ts).
/** Searchable controls and destinations that are visible within Settings. */
export const SETTINGS_SEARCH_ITEMS: readonly SettingsSearchItem[] = [
  {
    id: "theme",
    sectionId: "appearance",
    labelKey: "appearance.theme.label",
  },
  {
    id: "primary-color",
    sectionId: "appearance",
    labelKey: "appearance.primary.label",
  },
  {
    id: "animated-avatars",
    sectionId: "appearance",
    labelKey: "appearance.animatedAvatars.label",
  },
  {
    id: "working-indicator",
    sectionId: "appearance",
    labelKey: "appearance.workingIndicatorAnimation.label",
  },
  {
    id: "pin-labels",
    sectionId: "appearance",
    labelKey: "appearance.homePinLabels.label",
  },
  {
    id: "chat-tips",
    sectionId: "behavior",
    labelKey: "general.agentToolsTips.label",
  },
  {
    id: "mention-default",
    sectionId: "behavior",
    labelKey: "general.atMentionDefault.label",
  },
  {
    id: "follow-up",
    sectionId: "behavior",
    labelKey: "general.followUpBehavior.label",
  },
  {
    id: "session-cost",
    sectionId: "behavior",
    labelKey: "general.sessionCost.label",
  },
  {
    id: "response-gutter",
    sectionId: "behavior",
    labelKey: "general.responseStartGutter.label",
  },
  {
    id: "artifact-auto-open",
    sectionId: "behavior",
    labelKey: "general.artifactAutoOpen.label",
  },
  {
    id: "style-guidelines",
    sectionId: "behavior",
    labelKey: "general.styleGuidelines.title",
  },
  {
    id: "language",
    sectionId: "system",
    labelKey: "general.language.label",
  },
  {
    id: "artifact-location",
    sectionId: "system",
    labelKey: "general.artifacts.label",
  },
  {
    id: "terminal-folder",
    sectionId: "system",
    labelKey: "general.terminalFallback.label",
  },
  {
    id: "cached-media",
    sectionId: "system",
    labelKey: "storage.cachedMedia.label",
  },
  // Hidden via hiddenItemIds wherever the row itself does not render: enforced
  // builds, and builds/sessions without the `telemetry` capability.
  {
    id: "telemetry",
    sectionId: "system",
    labelKey: "privacy.telemetry.label",
  },
  {
    id: "bb-cli",
    sectionId: "system",
    labelKey: "general.bbCli.title",
  },
  {
    id: "connections",
    sectionId: "connections",
    labelKey: "nav.connections",
  },
  // Hidden via hiddenItemIds when the remote-ssh-sessions experiment is off,
  // mirroring the card itself (RemoteHostsSettings renders null there).
  {
    id: "remote-ssh-hosts",
    sectionId: "connections",
    labelKey: "remoteHosts.title",
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
    id: "trusted-domains",
    sectionId: "security",
    labelKey: "storage.trustedDomains.label",
  },
  {
    id: "security",
    sectionId: "security",
    labelKey: "nav.security",
  },
  {
    id: "about",
    sectionId: "system",
    labelKey: "about.title",
  },
  {
    id: "updates",
    sectionId: "system",
    labelKey: "updates.title",
  },
  {
    id: "experiments",
    sectionId: "experiments",
    labelKey: "nav.experiments",
  },
] as const;

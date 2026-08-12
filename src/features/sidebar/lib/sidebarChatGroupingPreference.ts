import { createBooleanLocalStoragePreference } from "@/shared/preferences/createBooleanLocalStoragePreference";

export const SIDEBAR_GROUP_CHATS_BY_PROJECT_STORAGE_KEY =
  "goose:sidebar:group-chats-by-project";

const SIDEBAR_GROUP_CHATS_BY_PROJECT_CHANGED_EVENT =
  "goose:sidebar:group-chats-by-project-changed";

/**
 * One-time migration from the retired sidebar-flat-chat-list experiment.
 * Users who had the experiment enabled with grouping turned off keep their
 * flat chat list instead of silently reverting to grouped mode. Runs only
 * when the new preference key has never been written.
 */
function migrateFromRetiredFlatChatListExperiment() {
  try {
    if (localStorage.getItem(SIDEBAR_GROUP_CHATS_BY_PROJECT_STORAGE_KEY)) {
      return;
    }
    const stored = localStorage.getItem("goose:experimental-features");
    if (!stored) {
      return;
    }
    const parsed: unknown = JSON.parse(stored);
    if (typeof parsed !== "object" || parsed === null) {
      return;
    }
    const experiments = (parsed as { experiments?: unknown }).experiments;
    if (typeof experiments !== "object" || experiments === null) {
      return;
    }
    const experiment = (
      experiments as Record<string, { enabled?: unknown; config?: unknown }>
    )["sidebar-flat-chat-list"];
    if (experiment?.enabled !== true) {
      return;
    }
    const config = experiment.config;
    if (typeof config !== "object" || config === null) {
      return;
    }
    const groupChatsByProject = (config as { groupChatsByProject?: unknown })
      .groupChatsByProject;
    if (groupChatsByProject === false) {
      localStorage.setItem(SIDEBAR_GROUP_CHATS_BY_PROJECT_STORAGE_KEY, "false");
    }
  } catch {
    // Migration is best-effort; the grouped default is a safe fallback.
  }
}

migrateFromRetiredFlatChatListExperiment();

const sidebarChatGroupingPreference = createBooleanLocalStoragePreference({
  storageKey: SIDEBAR_GROUP_CHATS_BY_PROJECT_STORAGE_KEY,
  changedEvent: SIDEBAR_GROUP_CHATS_BY_PROJECT_CHANGED_EVENT,
  defaultValue: true,
});

export const getSidebarGroupChatsByProjectEnabled =
  sidebarChatGroupingPreference.get;
export const setSidebarGroupChatsByProjectEnabled =
  sidebarChatGroupingPreference.set;
export const useSidebarChatGroupingPreference =
  sidebarChatGroupingPreference.useValue;

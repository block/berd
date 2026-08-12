import { createBooleanLocalStoragePreference } from "@/shared/preferences/createBooleanLocalStoragePreference";

export const SIDEBAR_GIT_BRANCH_SUBTITLE_STORAGE_KEY =
  "goose:sidebar:git-branch-subtitles-enabled";

const SIDEBAR_GIT_BRANCH_SUBTITLE_CHANGED_EVENT =
  "goose:sidebar:git-branch-subtitles-changed";

const sidebarGitBranchSubtitlePreference = createBooleanLocalStoragePreference({
  storageKey: SIDEBAR_GIT_BRANCH_SUBTITLE_STORAGE_KEY,
  changedEvent: SIDEBAR_GIT_BRANCH_SUBTITLE_CHANGED_EVENT,
  defaultValue: false,
});

export const getSidebarGitBranchSubtitlesEnabled =
  sidebarGitBranchSubtitlePreference.get;
export const setSidebarGitBranchSubtitlesEnabled =
  sidebarGitBranchSubtitlePreference.set;
export const useSidebarGitBranchSubtitlePreference =
  sidebarGitBranchSubtitlePreference.useValue;

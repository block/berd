// Desktop Agent setting (General settings, macOS only): one switch; the
// agent shows the animated Berdy character whenever Berdy is the agent. The
// right-click agent selector stays behind its own experiment
// (DESKTOP_AGENT_AGENT_SELECTOR_EXPERIMENT_ID).
//
// localStorage is shared by the main and panel webviews, so every write
// reaches the other webview as a storage event: the panel writes `visible`
// (Hide menu item, toggle-chord resurrect) and the main-webview bridge
// shows/hides the panel in response.

import { createBooleanLocalStoragePreference } from "@/shared/preferences/createBooleanLocalStoragePreference";

export const DESKTOP_AGENT_ENABLED_STORAGE_KEY = "goose:desktop-agent-enabled";
export const DESKTOP_AGENT_VISIBLE_STORAGE_KEY = "goose:desktop-agent-visible";

// An always-on-top panel appearing uninvited is rude: off by default.
const enabledPreference = createBooleanLocalStoragePreference({
  storageKey: DESKTOP_AGENT_ENABLED_STORAGE_KEY,
  changedEvent: "goose:desktop-agent-enabled-changed",
  defaultValue: false,
});

// Hide/show WITHOUT ending the chat session. Not a settings row: the
// right-click "Hide Desktop Agent" item turns it off; the toggle chord or
// turning the Desktop Agent setting back on turns it on.
const visiblePreference = createBooleanLocalStoragePreference({
  storageKey: DESKTOP_AGENT_VISIBLE_STORAGE_KEY,
  changedEvent: "goose:desktop-agent-visible-changed",
  defaultValue: true,
});

export const getDesktopAgentEnabled = enabledPreference.get;
export const setDesktopAgentEnabled = enabledPreference.set;
export const useDesktopAgentEnabledPreference = enabledPreference.useValue;

export const getDesktopAgentVisible = visiblePreference.get;
export const setDesktopAgentVisible = visiblePreference.set;
export const useDesktopAgentVisiblePreference = visiblePreference.useValue;

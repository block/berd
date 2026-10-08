// Desktop Agent setting (General settings, macOS only): ONE on/off
// switch; the agent shows the animated Berdy character whenever Berdy is
// the agent. The right-click agent selector stays behind its own
// experiment (DESKTOP_AGENT_AGENT_SELECTOR_EXPERIMENT_ID).
//
// localStorage is shared by the main and panel webviews, so every write
// reaches the other webview as a storage event: the panel's "Hide agent"
// menu item writes `enabled` false and the main-webview bridge closes the
// panel in response.
//
// There used to be a second `goose:desktop-agent-visible` preference
// (hide WITHOUT disabling). It collapsed into this single switch: hiding
// IS disabling now. Migration: the stale `visible` key is simply ignored —
// a user who had visible=false and enabled=true comes back enabled (and
// can hide again with one click).

import { createBooleanLocalStoragePreference } from "@/shared/preferences/createBooleanLocalStoragePreference";

export const DESKTOP_AGENT_ENABLED_STORAGE_KEY = "goose:desktop-agent-enabled";

// An always-on-top panel appearing uninvited is rude: off by default.
const enabledPreference = createBooleanLocalStoragePreference({
  storageKey: DESKTOP_AGENT_ENABLED_STORAGE_KEY,
  changedEvent: "goose:desktop-agent-enabled-changed",
  defaultValue: false,
});

export const getDesktopAgentEnabled = enabledPreference.get;
export const setDesktopAgentEnabled = enabledPreference.set;
export const useDesktopAgentEnabledPreference = enabledPreference.useValue;

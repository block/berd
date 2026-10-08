// Settings bridge for the Berd Desktop Agent panel (macOS only).
//
// Runs in the MAIN webview and owns the mapping from the Desktop Agent
// settings (desktopAgentPreferences.ts) to panel lifecycle:
//
//   setting off -> on             desktop_agent_open (registers the
//                                 toggle chord from the shortcuts
//                                 registry)
//   toggle chord rebound          desktop_agent_open again (idempotent
//                                 for the window; re-registers the chord)
//   setting on -> off             desktop_agent_close (destroy; chat
//                                 state is server-side and re-adopts on
//                                 re-enable)
//
// Cross-webview coherence: the setting lives in localStorage,
// which is shared across same-origin webviews — the panel webview writes
// `enabled` false on "Hide agent", the storage event lands here, and
// this bridge closes the panel. The preference hooks/useShortcutBindings
// are storage-event-driven, so no extra wiring is needed.
//
// Deliberately NO unmount cleanup: a main-webview reload must not destroy
// the panel (open is idempotent and re-runs on mount); disable-close is
// driven by state, and app quit takes the panel window with the process.

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useCallback, useEffect, useRef } from "react";

import { useDesktopAgentEnabledPreference } from "@/features/desktop-agent/lib/desktopAgentPreferences";
import { requestOpenSettings } from "@/features/settings/lib/settingsEvents";
import { useShortcutBindings } from "@/features/shortcuts/lib/shortcutRegistry";
import { getPlatform } from "@/shared/lib/platform";

interface BridgeState {
  enabled: boolean;
  chord: string;
}

export function DesktopAgentBridge() {
  const isMac = getPlatform() === "mac";
  const enabled = useDesktopAgentEnabledPreference().enabled;
  const bindings = useShortcutBindings("desktopAgent.togglePanel");

  // A cleared keybinding must not read as "disabled": open with an empty
  // chord (Rust logs the unparseable chord and continues without one).
  const chord = bindings[0]?.shortcut ?? "";

  // Ops are serialized so a rapid toggle can't interleave open/close
  // (pattern: GlobalShortcutBridge).
  const operationQueueRef = useRef<Promise<void>>(Promise.resolve());
  const enqueue = useCallback((operation: () => Promise<void>) => {
    operationQueueRef.current = operationQueueRef.current
      .catch(() => undefined)
      .then(operation)
      .catch((error) => {
        console.error("Desktop-agent bridge operation failed:", error);
      });
  }, []);

  // Previous applied state; transitions below are diffs against it. Refs
  // survive StrictMode's simulated remount, and every native op is
  // idempotent anyway.
  const appliedRef = useRef<BridgeState>({
    enabled: false,
    chord: "",
  });

  // Settings deep-link from the panel's avatar menu: Rust has already
  // revealed + focused the main window (the panel is always-on-top, this
  // window may be hidden); the remaining hop is in-webview navigation to
  // the Behavior section, which owns the Desktop Agent settings. The
  // bridge hosts the listener because it IS the desktop-agent presence
  // in the main webview. Not gated on `enabled`: the event can only
  // originate from a live panel, and an unconditional listener avoids
  // re-registration churn on toggle.
  useEffect(() => {
    if (!window.__TAURI_INTERNALS__ || !isMac) {
      return;
    }
    const unlisten = listen("desktop-agent:open-settings", () => {
      requestOpenSettings("behavior");
    });
    return () => {
      void unlisten.then((fn) => fn());
    };
  }, [isMac]);

  useEffect(() => {
    if (!window.__TAURI_INTERNALS__ || !isMac) {
      return;
    }
    const before = appliedRef.current;
    const next: BridgeState = { enabled, chord };
    appliedRef.current = next;

    if (enabled) {
      if (!before.enabled || before.chord !== chord) {
        enqueue(() => invoke("desktop_agent_open", { shortcut: chord }));
      }
      return;
    }
    if (before.enabled) {
      enqueue(() => invoke("desktop_agent_close"));
    }
  }, [enabled, chord, isMac, enqueue]);

  return null;
}

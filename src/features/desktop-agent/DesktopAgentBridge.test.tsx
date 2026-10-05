// Bridge tests: Desktop Agent settings -> panel lifecycle commands. Pins the
// mapping (enable→open, showAgent→set_visible without teardown,
// disable→close, chord rebind→re-open) plus the platform/StrictMode
// guards. Pattern: GlobalShortcutBridge.test.tsx (hoisted invoke mock,
// real settings/shortcut stores backed by localStorage).

import { act, cleanup, render } from "@testing-library/react";
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DesktopAgentBridge } from "./DesktopAgentBridge";
import {
  DESKTOP_AGENT_ENABLED_STORAGE_KEY,
  DESKTOP_AGENT_VISIBLE_STORAGE_KEY,
  setDesktopAgentEnabled,
  setDesktopAgentVisible,
} from "./lib/desktopAgentPreferences";
import { OPEN_SETTINGS_EVENT } from "@/features/settings/lib/settingsEvents";
import {
  setShortcutOverride,
  SHORTCUT_PREFERENCES_STORAGE_KEY,
} from "@/features/shortcuts/lib/shortcutRegistry";

const mocks = vi.hoisted(() => ({
  getPlatform: vi.fn(() => "mac"),
  invoke: vi.fn(),
  // Tauri event listeners by name — tests fire them to simulate Rust
  // emitting at the main webview (the settings deep-link path).
  listeners: new Map<string, Array<(event: unknown) => void>>(),
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => mocks.invoke(...args),
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: (name: string, handler: (event: unknown) => void) => {
    const list = mocks.listeners.get(name) ?? [];
    list.push(handler);
    mocks.listeners.set(name, list);
    return Promise.resolve(() => {
      const current = mocks.listeners.get(name) ?? [];
      mocks.listeners.set(
        name,
        current.filter((h) => h !== handler),
      );
    });
  },
}));

vi.mock("@/shared/lib/platform", () => ({
  getPlatform: () => mocks.getPlatform(),
}));

function callsTo(command: string) {
  return mocks.invoke.mock.calls.filter(([name]) => name === command);
}

async function flushAsync() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.listeners.clear();
  mocks.getPlatform.mockReturnValue("mac");
  mocks.invoke.mockImplementation(() => Promise.resolve());
  window.__TAURI_INTERNALS__ = {};
  localStorage.removeItem(DESKTOP_AGENT_ENABLED_STORAGE_KEY);
  localStorage.removeItem(DESKTOP_AGENT_VISIBLE_STORAGE_KEY);
  localStorage.removeItem(SHORTCUT_PREFERENCES_STORAGE_KEY);
});

/** Fires a mocked Tauri event at every registered listener (simulates
 *  Rust emit_to targeting this webview). */
function fireTauriEvent(name: string, payload?: unknown) {
  for (const handler of mocks.listeners.get(name) ?? []) {
    handler({ event: name, payload });
  }
}

afterEach(() => {
  cleanup();
  delete window.__TAURI_INTERNALS__;
});

describe("DesktopAgentBridge", () => {
  it("does nothing while the setting is disabled", async () => {
    render(<DesktopAgentBridge />);
    await flushAsync();
    expect(mocks.invoke).not.toHaveBeenCalled();
  });

  it("opens the panel with the registry chord when the setting turns on", async () => {
    render(<DesktopAgentBridge />);
    await flushAsync();
    act(() => {
      setDesktopAgentEnabled(true);
    });
    await flushAsync();
    expect(callsTo("desktop_agent_open")).toEqual([
      ["desktop_agent_open", { shortcut: "meta+alt+b", visible: true }],
    ]);
  });

  it("opens hidden when showAgent was already off at enable time", async () => {
    act(() => {
      setDesktopAgentVisible(false);
    });
    render(<DesktopAgentBridge />);
    await flushAsync();
    act(() => {
      setDesktopAgentEnabled(true);
    });
    await flushAsync();
    expect(callsTo("desktop_agent_open")).toEqual([
      ["desktop_agent_open", { shortcut: "meta+alt+b", visible: false }],
    ]);
  });

  it("maps showAgent to set_visible without reopening or closing", async () => {
    render(<DesktopAgentBridge />);
    act(() => {
      setDesktopAgentEnabled(true);
    });
    await flushAsync();
    act(() => {
      setDesktopAgentVisible(false);
    });
    await flushAsync();
    act(() => {
      setDesktopAgentVisible(true);
    });
    await flushAsync();
    expect(callsTo("desktop_agent_set_visible")).toEqual([
      ["desktop_agent_set_visible", { visible: false }],
      ["desktop_agent_set_visible", { visible: true }],
    ]);
    expect(callsTo("desktop_agent_open")).toHaveLength(1);
    expect(callsTo("desktop_agent_close")).toHaveLength(0);
  });

  it("closes the panel when the setting turns off", async () => {
    render(<DesktopAgentBridge />);
    act(() => {
      setDesktopAgentEnabled(true);
    });
    await flushAsync();
    act(() => {
      setDesktopAgentEnabled(false);
    });
    await flushAsync();
    expect(callsTo("desktop_agent_close")).toHaveLength(1);
  });

  it("re-opens (re-registering the chord) when the binding changes while enabled", async () => {
    render(<DesktopAgentBridge />);
    act(() => {
      setDesktopAgentEnabled(true);
    });
    await flushAsync();
    act(() => {
      setShortcutOverride("desktopAgent.togglePanel", "ctrl+alt+d");
    });
    await flushAsync();
    expect(callsTo("desktop_agent_open")).toEqual([
      ["desktop_agent_open", { shortcut: "meta+alt+b", visible: true }],
      ["desktop_agent_open", { shortcut: "ctrl+alt+d", visible: true }],
    ]);
  });

  it("no-ops off macOS", async () => {
    mocks.getPlatform.mockReturnValue("windows");
    act(() => {
      setDesktopAgentEnabled(true);
    });
    render(<DesktopAgentBridge />);
    await flushAsync();
    expect(mocks.invoke).not.toHaveBeenCalled();
  });

  it("no-ops without the Tauri bridge (plain browser context)", async () => {
    delete window.__TAURI_INTERNALS__;
    act(() => {
      setDesktopAgentEnabled(true);
    });
    render(<DesktopAgentBridge />);
    await flushAsync();
    expect(mocks.invoke).not.toHaveBeenCalled();
  });

  it("reload with showAgent off: one open(visible:false), ZERO set_visible", async () => {
    // The main-webview-reload shape (review Check 6): Desktop Agent enabled
    // AND showAgent=false already persisted, bridge remounts with a
    // fresh appliedRef ({enabled:false, showAgent:true}). Must re-open
    // passing the LIVE showAgent (window exists, Rust ignores visible —
    // but a wrong value here would flash the panel on first-ever open
    // after a settings import), and branch 2 must stay dead: a spurious
    // set_visible(true) would resurrect a deliberately hidden panel.
    act(() => {
      setDesktopAgentEnabled(true);
      setDesktopAgentVisible(false);
    });
    render(<DesktopAgentBridge />);
    await flushAsync();
    expect(callsTo("desktop_agent_open")).toEqual([
      ["desktop_agent_open", { shortcut: "meta+alt+b", visible: false }],
    ]);
    expect(callsTo("desktop_agent_set_visible")).toHaveLength(0);
    expect(callsTo("desktop_agent_close")).toHaveLength(0);
  });

  it("opens exactly once under StrictMode double-mount with the setting pre-enabled", async () => {
    act(() => {
      setDesktopAgentEnabled(true);
    });
    render(
      <React.StrictMode>
        <DesktopAgentBridge />
      </React.StrictMode>,
    );
    await flushAsync();
    expect(callsTo("desktop_agent_open")).toHaveLength(1);
  });

  it("routes the panel's settings deep-link to the General settings section", async () => {
    const details: unknown[] = [];
    const onOpenSettings = (event: Event) => {
      details.push((event as CustomEvent).detail);
    };
    window.addEventListener(OPEN_SETTINGS_EVENT, onOpenSettings);
    try {
      // Deliberately NOT enabling the setting: the listener is
      // unconditional (the event can only originate from a live panel,
      // and gating would add re-registration churn on toggle).
      render(<DesktopAgentBridge />);
      await flushAsync();
      act(() => {
        fireTauriEvent("desktop-agent:open-settings");
      });
      expect(details).toEqual([{ section: "general" }]);
    } finally {
      window.removeEventListener(OPEN_SETTINGS_EVENT, onOpenSettings);
    }
  });

  it("registers no settings listener off macOS", async () => {
    mocks.getPlatform.mockReturnValue("windows");
    render(<DesktopAgentBridge />);
    await flushAsync();
    expect(
      mocks.listeners.get("desktop-agent:open-settings") ?? [],
    ).toHaveLength(0);
  });
});

import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const getPlatformMock = vi.hoisted(() => vi.fn(() => "mac"));
vi.mock("@/shared/lib/platform", () => ({
  getPlatform: getPlatformMock,
}));

const isDesignSystemExplorerEnabledMock = vi.hoisted(() => vi.fn());
vi.mock("@/features/design-system/lib/designSystemEnabled", () => ({
  isDesignSystemExplorerEnabled: isDesignSystemExplorerEnabledMock,
}));

import en from "@/shared/i18n/locales/en/shortcuts.json";
import es from "@/shared/i18n/locales/es/shortcuts.json";
import {
  eventMatchesShortcutCommand,
  getShortcutBindings,
  getShortcutCommand,
  resetAllShortcutOverrides,
  resetShortcutOverride,
  resolveShortcutCommands,
  resolveShortcutGroups,
  setShortcutOverride,
  SHORTCUT_CATEGORIES,
  SHORTCUT_COMMANDS,
  SHORTCUT_PREFERENCES_CHANGED_EVENT,
  SHORTCUT_PREFERENCES_STORAGE_KEY,
  shortcutScopesOverlap,
  useShortcutBindings,
  useShortcutPreferences,
} from "./shortcutRegistry";

function hasKey(resource: object, key: string): boolean {
  let node: unknown = resource;
  for (const part of key.split(".")) {
    if (typeof node !== "object" || node === null) return false;
    node = (node as Record<string, unknown>)[part];
  }
  return typeof node === "string";
}

function keyEvent(init: KeyboardEventInit): KeyboardEvent {
  return new KeyboardEvent("keydown", init);
}

function flattenGroups() {
  return resolveShortcutGroups().flatMap((group) => group.shortcuts);
}

function storeRaw(raw: string) {
  localStorage.setItem(SHORTCUT_PREFERENCES_STORAGE_KEY, raw);
}

function storePreferences(overrides: Record<string, unknown>, version = 1) {
  storeRaw(JSON.stringify({ version, overrides }));
}

function readStored(): unknown {
  const raw = localStorage.getItem(SHORTCUT_PREFERENCES_STORAGE_KEY);
  return raw === null ? null : JSON.parse(raw);
}

function overridesById(): Record<string, string> {
  const overrides: Record<string, string> = {};
  for (const command of resolveShortcutCommands()) {
    if (command.override) overrides[command.id] = command.override;
  }
  return overrides;
}

function listenForChanges(): () => number {
  const listener = vi.fn();
  window.addEventListener(SHORTCUT_PREFERENCES_CHANGED_EVENT, listener);
  return () => listener.mock.calls.length;
}

beforeEach(() => {
  localStorage.clear();
  getPlatformMock.mockReturnValue("mac");
  isDesignSystemExplorerEnabledMock.mockReturnValue(false);
});

describe("shortcut command definitions", () => {
  it("has unique command ids", () => {
    const ids = SHORTCUT_COMMANDS.map((command) => command.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("has en and es translations for descriptions, categories, and static keys", () => {
    const keys = [
      ...SHORTCUT_COMMANDS.map((command) => command.descriptionKey),
      ...SHORTCUT_CATEGORIES.map((category) => `categories.${category}`),
      "dialog.title",
      "dialog.dismissHint",
      "settings.label",
      "settings.description",
      "settings.customize",
    ];
    for (const key of keys) {
      expect(hasKey(en, key), `en ${key}`).toBe(true);
      expect(hasKey(es, key), `es ${key}`).toBe(true);
    }
  });

  it("normalizes every configurable command's defaults to non-empty combos", () => {
    for (const command of SHORTCUT_COMMANDS) {
      if (!command.configurable) continue;
      const bindings = getShortcutBindings(command.id);
      expect(bindings.length, command.id).toBeGreaterThan(0);
      for (const binding of bindings) {
        expect(binding.shortcut.length, command.id).toBeGreaterThan(0);
        expect(binding.shortcut, command.id).not.toContain("mod");
      }
    }
  });

  it("registers native navigation history shortcuts as configurable and discoverable", () => {
    const back = getShortcutCommand("navigation.back");
    expect(back).toBeDefined();
    expect(back?.configurable).toBe(true);
    expect(back?.discoverable).toBe(true);
    expect(getShortcutBindings("navigation.back")).toEqual([
      { shortcut: "meta+[" },
    ]);

    const forward = getShortcutCommand("navigation.forward");
    expect(forward).toBeDefined();
    expect(forward?.configurable).toBe(true);
    expect(forward?.discoverable).toBe(true);
    expect(getShortcutBindings("navigation.forward")).toEqual([
      { shortcut: "meta+]" },
    ]);

    getPlatformMock.mockReturnValue("windows");
    expect(getShortcutBindings("navigation.back")).toEqual([
      { shortcut: "alt+arrowleft" },
    ]);
    expect(getShortcutBindings("navigation.forward")).toEqual([
      { shortcut: "alt+arrowright" },
    ]);

    getPlatformMock.mockReturnValue("linux");
    expect(getShortcutBindings("navigation.back")).toEqual([
      { shortcut: "alt+arrowleft" },
    ]);
    expect(getShortcutBindings("navigation.forward")).toEqual([
      { shortcut: "alt+arrowright" },
    ]);
  });

  it("registers session.quickSwitch as configurable, discoverable, mod+p", () => {
    const command = getShortcutCommand("session.quickSwitch");
    expect(command).toBeDefined();
    expect(command?.configurable).toBe(true);
    expect(command?.discoverable).toBe(true);
    expect(getShortcutBindings("session.quickSwitch")).toEqual([
      { shortcut: "meta+p" },
    ]);
  });

  it("registers session.next and session.previous as ctrl+tab and ctrl+shift+tab", () => {
    const next = getShortcutCommand("session.next");
    expect(next).toBeDefined();
    expect(next?.configurable).toBe(true);
    expect(next?.discoverable).toBe(true);
    expect(getShortcutBindings("session.next")).toEqual([
      { shortcut: "ctrl+tab" },
    ]);

    const previous = getShortcutCommand("session.previous");
    expect(previous).toBeDefined();
    expect(previous?.configurable).toBe(true);
    expect(previous?.discoverable).toBe(true);
    expect(getShortcutBindings("session.previous")).toEqual([
      { shortcut: "ctrl+shift+tab" },
    ]);
  });

  it("registers chat.archiveSession as configurable, discoverable, mod+e", () => {
    const command = getShortcutCommand("chat.archiveSession");
    expect(command).toBeDefined();
    expect(command?.configurable).toBe(true);
    expect(command?.discoverable).toBe(true);
    expect(getShortcutBindings("chat.archiveSession")).toEqual([
      { shortcut: "meta+e" },
    ]);
  });

  it("registers chat.toggleVoiceDictation as a configurable, discoverable composer shortcut", () => {
    const command = getShortcutCommand("chat.toggleVoiceDictation");
    expect(command).toBeDefined();
    expect(command?.scope).toBe("composer");
    expect(command?.configurable).toBe(true);
    expect(command?.discoverable).toBe(true);

    expect(getShortcutBindings("chat.toggleVoiceDictation")).toEqual([
      { shortcut: "meta+d" },
    ]);

    for (const platform of ["windows", "linux"] as const) {
      getPlatformMock.mockReturnValue(platform);
      expect(getShortcutBindings("chat.toggleVoiceDictation")).toEqual([
        { shortcut: "ctrl+d" },
      ]);
    }
  });

  it("accepts an override for chat.toggleVoiceDictation", () => {
    expect(
      setShortcutOverride("chat.toggleVoiceDictation", "meta+shift+d"),
    ).toEqual({ ok: true });
    expect(getShortcutBindings("chat.toggleVoiceDictation")).toEqual([
      { shortcut: "meta+shift+d" },
    ]);
  });

  it("registers the design system inspector shortcuts on macOS", () => {
    const visibilityCommand = getShortcutCommand(
      "view.toggleDesignSystemInspector",
    );
    expect(visibilityCommand).toBeDefined();
    expect(visibilityCommand?.configurable).toBe(true);
    expect(visibilityCommand?.discoverable).toBe(true);
    expect(getShortcutBindings("view.toggleDesignSystemInspector")).toEqual([
      { shortcut: "meta+shift+d" },
    ]);

    const inspectModeCommand = getShortcutCommand(
      "view.toggleDesignSystemInspectorMode",
    );
    expect(inspectModeCommand).toBeDefined();
    expect(inspectModeCommand?.configurable).toBe(true);
    expect(inspectModeCommand?.discoverable).toBe(true);
    expect(getShortcutBindings("view.toggleDesignSystemInspectorMode")).toEqual(
      [{ shortcut: "meta+i" }],
    );
  });

  it("ships no colliding default combos across overlapping scopes", () => {
    isDesignSystemExplorerEnabledMock.mockReturnValue(true);

    // Deliberate exceptions, both reconciled by ChatSearchBar stopping
    // propagation of consumed keys (Ctrl+N/Ctrl+P off macOS).
    const allowed = new Set([
      "chat.search.next|navigation.newConversation",
      "chat.search.previous|session.quickSwitch",
    ]);
    for (const platform of ["mac", "windows"] as const) {
      getPlatformMock.mockReturnValue(platform);
      const enabled = SHORTCUT_COMMANDS.filter(
        (command) => command.when?.() ?? true,
      );
      for (const a of enabled) {
        for (const b of enabled) {
          if (a.id >= b.id) continue;
          if (!shortcutScopesOverlap(a.scope, b.scope)) continue;
          if (allowed.has(`${a.id}|${b.id}`)) continue;
          const bCombos = new Set(
            getShortcutBindings(b.id).map((binding) => binding.shortcut),
          );
          for (const binding of getShortcutBindings(a.id)) {
            expect(
              bCombos.has(binding.shortcut),
              `${platform}: ${a.id} and ${b.id} share ${binding.shortcut}`,
            ).toBe(false);
          }
        }
      }
    }
  });
});

describe("scope overlap", () => {
  it("overlaps global and ancestors but keeps siblings independent", () => {
    // Global overlaps everything.
    expect(shortcutScopesOverlap("global", "global"), "global/global").toBe(
      true,
    );
    expect(shortcutScopesOverlap("global", "composer"), "global/composer").toBe(
      true,
    );
    expect(
      shortcutScopesOverlap("global", "chat-search"),
      "global/chat-search",
    ).toBe(true);
    expect(
      shortcutScopesOverlap("component", "global"),
      "component/global",
    ).toBe(true);
    // Composer overlaps its chat ancestor in both directions.
    expect(shortcutScopesOverlap("composer", "chat"), "composer/chat").toBe(
      true,
    );
    expect(shortcutScopesOverlap("chat", "composer"), "chat/composer").toBe(
      true,
    );
    // Sibling scopes stay independent.
    expect(
      shortcutScopesOverlap("composer", "chat-search"),
      "composer/chat-search",
    ).toBe(false);
    expect(
      shortcutScopesOverlap("composer", "component"),
      "composer/component",
    ).toBe(false);
    expect(
      shortcutScopesOverlap("composer", "terminal"),
      "composer/terminal",
    ).toBe(false);
  });
});

describe("mod resolution", () => {
  it("resolves mod in defaults to meta on macOS and ctrl elsewhere", () => {
    getPlatformMock.mockReturnValue("mac");
    expect(getShortcutBindings("navigation.search")).toEqual([
      { shortcut: "meta+k" },
    ]);

    getPlatformMock.mockReturnValue("windows");
    expect(getShortcutBindings("navigation.search")).toEqual([
      { shortcut: "ctrl+k" },
    ]);
  });

  it("resolves mod in stored overrides", () => {
    storePreferences({ "navigation.search": "mod+y" });
    expect(getShortcutBindings("navigation.search")).toEqual([
      { shortcut: "meta+y" },
    ]);

    getPlatformMock.mockReturnValue("windows");
    storePreferences({ "navigation.search": "mod+u" });
    expect(getShortcutBindings("navigation.search")).toEqual([
      { shortcut: "ctrl+u" },
    ]);
  });
});

describe("reading stored preferences", () => {
  it("falls back to defaults for invalid JSON, wrong versions, and hostile overrides", () => {
    // Invalid JSON.
    storeRaw("{not json");
    expect(overridesById(), "invalid JSON").toEqual({});
    expect(getShortcutBindings("navigation.search"), "invalid JSON").toEqual([
      { shortcut: "meta+k" },
    ]);

    // Wrong version.
    storePreferences({ "navigation.search": "meta+y" }, 2);
    expect(overridesById(), "wrong version").toEqual({});
    expect(getShortcutBindings("navigation.search"), "wrong version").toEqual([
      { shortcut: "meta+k" },
    ]);

    // Unknown ids, non-configurable ids, and invalid combos.
    storePreferences({
      "nope.unknown": "meta+y",
      "chat.mention.confirm": "meta+y",
      "navigation.search": "shift+k",
      "navigation.newConversation": 42,
      "navigation.closeSession": "garbage+x",
    });
    expect(overridesById(), "hostile overrides").toEqual({});
    expect(getShortcutBindings("chat.mention.confirm")).toEqual([
      { shortcut: "enter" },
    ]);
    expect(
      getShortcutBindings("navigation.search"),
      "hostile overrides",
    ).toEqual([{ shortcut: "meta+k" }]);
  });

  it("keeps exactly one of two colliding stored overrides", () => {
    storePreferences({
      "navigation.newConversation": "meta+g",
      "navigation.search": "meta+g",
    });
    // Conflicts are resolved deterministically in definition order: the
    // first-walked candidate sees the other's pending combo and is dropped,
    // so the later-defined command keeps its override regardless of
    // object-key order.
    expect(overridesById()).toEqual({
      "navigation.newConversation": "meta+g",
    });
    expect(getShortcutBindings("navigation.search")).toEqual([
      { shortcut: "meta+k" },
    ]);
  });

  it("drops stored overrides colliding with another command's defaults", () => {
    storePreferences({ "navigation.search": "meta+n" });
    expect(overridesById()).toEqual({});
    expect(getShortcutBindings("navigation.search")).toEqual([
      { shortcut: "meta+k" },
    ]);
  });

  it("accepts an override claiming another command's freed default", () => {
    // newConversation moved off meta+n, so search may claim it — read-time
    // validation must agree with the save-time check that allowed it.
    storePreferences({
      "navigation.newConversation": "meta+g",
      "navigation.search": "meta+n",
    });
    expect(overridesById()).toEqual({
      "navigation.newConversation": "meta+g",
      "navigation.search": "meta+n",
    });
    expect(getShortcutBindings("navigation.search")).toEqual([
      { shortcut: "meta+n" },
    ]);
  });

  it("resolves cascading collisions to a fixpoint with no live duplicates", () => {
    // newConversation's candidate loses to closeSession's and revives its
    // meta+n default — which must then invalidate search's already-walked
    // claim on meta+n. A single pass would leave both live.
    storePreferences({
      "navigation.search": "meta+n",
      "navigation.newConversation": "meta+q",
      "navigation.closeSession": "meta+q",
    });
    expect(overridesById()).toEqual({
      "navigation.closeSession": "meta+q",
    });
    expect(getShortcutBindings("navigation.search")).toEqual([
      { shortcut: "meta+k" },
    ]);
    expect(
      eventMatchesShortcutCommand(
        keyEvent({ key: "n", metaKey: true }),
        "navigation.search",
      ),
      "meta+n must match exactly one command",
    ).toBe(false);
    expect(
      eventMatchesShortcutCommand(
        keyEvent({ key: "n", metaKey: true }),
        "navigation.newConversation",
      ),
    ).toBe(true);
  });
});

describe("setShortcutOverride", () => {
  it("persists the override and dispatches the changed event", () => {
    const changeCount = listenForChanges();
    expect(setShortcutOverride("navigation.search", "meta+shift+x")).toEqual({
      ok: true,
    });
    expect(readStored()).toEqual({
      version: 1,
      overrides: { "navigation.search": "meta+shift+x" },
    });
    expect(changeCount()).toBe(1);
  });

  it("treats saving a default combo as clearing the override", () => {
    const changeCount = listenForChanges();
    // No override set: saving the default is a no-op and does not notify.
    expect(setShortcutOverride("navigation.search", "meta+k")).toEqual({
      ok: true,
    });
    expect(readStored(), "no-op default save").toBeNull();
    expect(changeCount(), "no-op default save").toBe(0);

    // With an override set, saving the default clears the stored override.
    expect(setShortcutOverride("navigation.search", "meta+shift+x")).toEqual({
      ok: true,
    });
    expect(readStored()).not.toBeNull();
    expect(setShortcutOverride("navigation.search", "meta+k")).toEqual({
      ok: true,
    });
    expect(readStored(), "default save clears override").toBeNull();
    expect(getShortcutBindings("navigation.search")).toEqual([
      { shortcut: "meta+k" },
    ]);
  });

  it("rejects shift-only combos for global commands", () => {
    expect(setShortcutOverride("navigation.search", "shift+k")).toEqual({
      ok: false,
      reason: "invalid",
    });
    expect(readStored()).toBeNull();
  });

  it("allows claiming a default freed by another command's override", () => {
    expect(setShortcutOverride("navigation.newConversation", "meta+g")).toEqual(
      { ok: true },
    );
    expect(setShortcutOverride("navigation.search", "meta+n")).toEqual({
      ok: true,
    });
    // The accepted override must survive the read-time re-validation.
    expect(overridesById()).toEqual({
      "navigation.newConversation": "meta+g",
      "navigation.search": "meta+n",
    });
  });

  it("rejects unmodified printable and text-editing keys for composer commands", () => {
    for (const combo of ["a", "shift+a", "backspace", "space", "tab"]) {
      expect(setShortcutOverride("chat.sendMessage", combo)).toEqual({
        ok: false,
        reason: "invalid",
      });
    }
    // Navigation/action keys stay recordable.
    expect(setShortcutOverride("chat.recallLastMessage", "arrowdown")).toEqual({
      ok: true,
    });
  });

  it("rejects non-configurable and unknown commands", () => {
    expect(setShortcutOverride("chat.mention.confirm", "meta+y")).toEqual({
      ok: false,
      reason: "invalid",
    });
    expect(setShortcutOverride("nope.unknown", "meta+y")).toEqual({
      ok: false,
      reason: "invalid",
    });
  });

  it("stores an unpinned override when re-recording a code-pinned default", () => {
    // help.shortcuts' default pins code "Slash"; layouts whose "/" lives on
    // another physical key must be able to rebind a key-only mod+/.
    expect(setShortcutOverride("help.shortcuts", "meta+/")).toEqual({
      ok: true,
    });
    expect(readStored()).toEqual({
      version: 1,
      overrides: { "help.shortcuts": "meta+/" },
    });
    expect(
      eventMatchesShortcutCommand(
        keyEvent({ key: "/", code: "Digit7", metaKey: true }),
        "help.shortcuts",
      ),
      "override matches by key regardless of physical code",
    ).toBe(true);

    resetShortcutOverride("help.shortcuts");
    expect(
      eventMatchesShortcutCommand(
        keyEvent({ key: "/", code: "Digit7", metaKey: true }),
        "help.shortcuts",
      ),
      "reset restores the code pin",
    ).toBe(false);
  });

  it("reports a storage failure without dispatching the changed event", () => {
    const changeCount = listenForChanges();
    const originalLocalStorage = window.localStorage;
    Object.defineProperty(window, "localStorage", {
      configurable: true,
      value: {
        get length() {
          return originalLocalStorage.length;
        },
        clear: () => originalLocalStorage.clear(),
        getItem: (key: string) => originalLocalStorage.getItem(key),
        key: (index: number) => originalLocalStorage.key(index),
        removeItem: (key: string) => originalLocalStorage.removeItem(key),
        setItem: () => {
          throw new Error("quota exceeded");
        },
      } satisfies Storage,
    });
    try {
      expect(setShortcutOverride("navigation.search", "meta+shift+x")).toEqual({
        ok: false,
        reason: "storage",
      });
      expect(changeCount()).toBe(0);
    } finally {
      Object.defineProperty(window, "localStorage", {
        configurable: true,
        value: originalLocalStorage,
      });
    }
  });
});

describe("resetting overrides", () => {
  it("resetShortcutOverride removes a single override and skips notifying without one", () => {
    const changeCount = listenForChanges();
    // No override stored: nothing to reset, no event.
    resetShortcutOverride("navigation.search");
    expect(changeCount(), "reset without an override").toBe(0);

    expect(setShortcutOverride("navigation.search", "meta+shift+x")).toEqual({
      ok: true,
    });
    expect(
      setShortcutOverride("navigation.newConversation", "meta+shift+y"),
    ).toEqual({ ok: true });

    resetShortcutOverride("navigation.search");
    expect(readStored()).toEqual({
      version: 1,
      overrides: { "navigation.newConversation": "meta+shift+y" },
    });
    expect(getShortcutBindings("navigation.search")).toEqual([
      { shortcut: "meta+k" },
    ]);
  });

  it("makes reset-induced collisions explicit by dropping the loser at write time", () => {
    // search legitimately claimed newConversation's freed meta+n default.
    expect(setShortcutOverride("navigation.newConversation", "meta+g")).toEqual(
      { ok: true },
    );
    expect(setShortcutOverride("navigation.search", "meta+n")).toEqual({
      ok: true,
    });

    // Resetting newConversation revives its meta+n default; search's
    // override is dropped from storage in the same write rather than
    // lingering as inert data a later write would silently erase.
    resetShortcutOverride("navigation.newConversation");
    expect(readStored()).toBeNull();
    expect(getShortcutBindings("navigation.search")).toEqual([
      { shortcut: "meta+k" },
    ]);
    expect(getShortcutBindings("navigation.newConversation")).toEqual([
      { shortcut: "meta+n" },
    ]);
  });

  it("resetAllShortcutOverrides clears storage and dispatches the event", () => {
    expect(setShortcutOverride("navigation.search", "meta+shift+x")).toEqual({
      ok: true,
    });
    const changeCount = listenForChanges();

    resetAllShortcutOverrides();
    expect(readStored()).toBeNull();
    expect(changeCount()).toBe(1);
    expect(overridesById()).toEqual({});
  });
});

describe("resolveShortcutGroups", () => {
  it("shows user overrides", () => {
    expect(setShortcutOverride("navigation.search", "meta+shift+x")).toEqual({
      ok: true,
    });
    const search = flattenGroups().find(
      (shortcut) => shortcut.id === "navigation.search",
    );
    expect(search?.shortcut).toBe("meta+shift+x");
  });

  it("never lists fixed commands", () => {
    const ids = new Set(flattenGroups().map((shortcut) => shortcut.id));
    expect(ids.has("chat.mention.confirm")).toBe(false);
    for (const command of SHORTCUT_COMMANDS) {
      if (command.discoverable) continue;
      expect(ids.has(command.id), command.id).toBe(false);
    }
  });
});

describe("pane-jump", () => {
  it("is always available with the static default combo", () => {
    expect(
      flattenGroups().find((s) => s.id === "navigation.paneJump")?.shortcut,
    ).toBe("ctrl+;");
    expect(getShortcutBindings("navigation.paneJump")).toEqual([
      { shortcut: "ctrl+;" },
    ]);
  });

  it("prefers a user override over the static default combo", () => {
    expect(setShortcutOverride("navigation.paneJump", "meta+shift+j")).toEqual({
      ok: true,
    });
    expect(getShortcutBindings("navigation.paneJump")).toEqual([
      { shortcut: "meta+shift+j" },
    ]);
  });
});

describe("global shortcut", () => {
  it("is visible and configurable only on macOS", () => {
    expect(
      flattenGroups().find(
        (shortcut) => shortcut.id === "navigation.globalShortcut",
      )?.shortcut,
    ).toBe("alt+space");
    expect(getShortcutBindings("navigation.globalShortcut")).toEqual([
      { shortcut: "alt+space" },
    ]);

    getPlatformMock.mockReturnValue("windows");

    expect(flattenGroups().map((shortcut) => shortcut.id)).not.toContain(
      "navigation.globalShortcut",
    );
    expect(
      eventMatchesShortcutCommand(
        keyEvent({ key: " ", altKey: true }),
        "navigation.globalShortcut",
      ),
    ).toBe(false);
  });

  it("uses a configured global shortcut on macOS", () => {
    expect(
      setShortcutOverride("navigation.globalShortcut", "ctrl+alt+c"),
    ).toEqual({
      ok: true,
    });

    expect(getShortcutBindings("navigation.globalShortcut")).toEqual([
      { shortcut: "ctrl+alt+c" },
    ]);
    expect(
      flattenGroups().find(
        (shortcut) => shortcut.id === "navigation.globalShortcut",
      )?.shortcut,
    ).toBe("ctrl+alt+c");
  });
});

describe("eventMatchesShortcutCommand", () => {
  it("matches the default combo", () => {
    expect(
      eventMatchesShortcutCommand(
        keyEvent({ key: "k", metaKey: true }),
        "navigation.search",
      ),
    ).toBe(true);
    expect(
      eventMatchesShortcutCommand(
        keyEvent({ key: "k", ctrlKey: true }),
        "navigation.search",
      ),
    ).toBe(false);
  });

  it("matches the override instead of the default once set", () => {
    expect(setShortcutOverride("navigation.search", "meta+shift+x")).toEqual({
      ok: true,
    });
    expect(
      eventMatchesShortcutCommand(
        keyEvent({ key: "k", metaKey: true }),
        "navigation.search",
      ),
    ).toBe(false);
    expect(
      eventMatchesShortcutCommand(
        keyEvent({ key: "x", metaKey: true, shiftKey: true }),
        "navigation.search",
      ),
    ).toBe(true);
  });

  it("requires the pinned physical code for help.shortcuts", () => {
    expect(
      eventMatchesShortcutCommand(
        keyEvent({ key: "/", code: "Digit7", metaKey: true }),
        "help.shortcuts",
      ),
    ).toBe(false);
    expect(
      eventMatchesShortcutCommand(
        keyEvent({ key: "/", code: "Slash", metaKey: true }),
        "help.shortcuts",
      ),
    ).toBe(true);
  });

  it("send-now accepts both accelerators by default on every platform", () => {
    getPlatformMock.mockReturnValue("mac");
    expect(
      eventMatchesShortcutCommand(
        keyEvent({ key: "Enter", ctrlKey: true }),
        "chat.sendNow",
      ),
    ).toBe(true);
    // Aliases that collapse after mod resolution are deduped.
    expect(getShortcutBindings("chat.sendNow")).toEqual([
      { shortcut: "meta+enter" },
      { shortcut: "ctrl+enter" },
    ]);

    getPlatformMock.mockReturnValue("windows");
    expect(
      eventMatchesShortcutCommand(
        keyEvent({ key: "Enter", metaKey: true }),
        "chat.sendNow",
      ),
    ).toBe(true);
  });

  it("zoom-in accepts its =, numpad +, and shifted + aliases", () => {
    for (const init of [
      { key: "=", metaKey: true },
      { key: "+", metaKey: true },
      { key: "+", metaKey: true, shiftKey: true },
    ]) {
      expect(
        eventMatchesShortcutCommand(keyEvent(init), "view.zoomIn"),
        JSON.stringify(init),
      ).toBe(true);
    }
    expect(
      eventMatchesShortcutCommand(
        keyEvent({ key: "-", metaKey: true }),
        "view.zoomIn",
      ),
    ).toBe(false);
  });
});

describe("conflict detection", () => {
  it("blocks overrides colliding with another global command", () => {
    expect(setShortcutOverride("navigation.search", "meta+n")).toEqual({
      ok: false,
      reason: "conflict",
      conflict: {
        commandId: "navigation.newConversation",
        descriptionKey: "actions.newConversation",
      },
    });
  });

  it("blocks composer overrides colliding within the composer scope", () => {
    expect(setShortcutOverride("chat.sendMessage", "shift+enter")).toEqual({
      ok: false,
      reason: "conflict",
      conflict: {
        commandId: "chat.insertNewline",
        descriptionKey: "actions.insertNewline",
      },
    });
  });

  it("rejects shift-only combos for commands without allowUnmodified", () => {
    // chat.sendNow has no allowUnmodified, so the shift-only rule rejects
    // shift+enter before the conflict check against chat.insertNewline runs.
    expect(setShortcutOverride("chat.sendNow", "shift+enter")).toEqual({
      ok: false,
      reason: "invalid",
    });
  });

  it("allows composer overrides equal to component fixed keys", () => {
    // arrowdown is chat.mention.next's fixed combo (component scope) and
    // chat.search.next's (chat-search scope); neither overlaps composer.
    expect(setShortcutOverride("chat.recallLastMessage", "arrowdown")).toEqual({
      ok: true,
    });
    expect(getShortcutBindings("chat.recallLastMessage")).toEqual([
      { shortcut: "arrowdown" },
    ]);
  });
});

describe("useShortcutPreferences", () => {
  it("updates after setShortcutOverride and resets", () => {
    const { result } = renderHook(() => useShortcutPreferences());
    expect(result.current.overrides).toEqual({});

    act(() => {
      expect(setShortcutOverride("navigation.search", "meta+shift+x")).toEqual({
        ok: true,
      });
    });
    expect(result.current.overrides).toEqual({
      "navigation.search": "meta+shift+x",
    });

    act(() => {
      resetAllShortcutOverrides();
    });
    expect(result.current.overrides).toEqual({});
  });
});

describe("useShortcutBindings", () => {
  it("tracks override changes", () => {
    const { result } = renderHook(() =>
      useShortcutBindings("navigation.search"),
    );
    expect(result.current).toEqual([{ shortcut: "meta+k" }]);

    act(() => {
      expect(setShortcutOverride("navigation.search", "meta+shift+x")).toEqual({
        ok: true,
      });
    });
    expect(result.current).toEqual([{ shortcut: "meta+shift+x" }]);
  });
});

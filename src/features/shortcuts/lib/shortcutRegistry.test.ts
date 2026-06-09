import { describe, expect, it, vi } from "vitest";

const getExperimentMock = vi.hoisted(() => vi.fn());
vi.mock("@/features/experiments/experimentPreferences", () => ({
  getExperiment: getExperimentMock,
}));

const getPlatformMock = vi.hoisted(() => vi.fn(() => "mac"));
vi.mock("@/shared/lib/platform", () => ({
  getPlatform: getPlatformMock,
}));

import en from "@/shared/i18n/locales/en/shortcuts.json";
import es from "@/shared/i18n/locales/es/shortcuts.json";
import {
  resolveShortcutGroups,
  SHORTCUT_DEFINITIONS,
} from "./shortcutRegistry";

function hasKey(resource: object, key: string): boolean {
  let node: unknown = resource;
  for (const part of key.split(".")) {
    if (typeof node !== "object" || node === null) return false;
    node = (node as Record<string, unknown>)[part];
  }
  return typeof node === "string";
}

describe("shortcutRegistry", () => {
  it("has unique ids", () => {
    const ids = SHORTCUT_DEFINITIONS.map((definition) => definition.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("has translations for every description key in en and es", () => {
    for (const definition of SHORTCUT_DEFINITIONS) {
      expect(hasKey(en, definition.descriptionKey), definition.id).toBe(true);
      expect(hasKey(es, definition.descriptionKey), definition.id).toBe(true);
    }
  });

  it("resolves static and dynamic shortcuts into non-empty combos", () => {
    getExperimentMock.mockReturnValue({ enabled: true, config: {} });
    const groups = resolveShortcutGroups();
    expect(groups.length).toBeGreaterThan(0);
    for (const group of groups) {
      for (const shortcut of group.shortcuts) {
        expect(shortcut.shortcut.length).toBeGreaterThan(0);
      }
    }
  });

  it("omits gated shortcuts when their condition is false", () => {
    getExperimentMock.mockReturnValue({ enabled: false, config: {} });
    const all = resolveShortcutGroups().flatMap((group) => group.shortcuts);
    expect(all.some((shortcut) => shortcut.id === "pane-jump")).toBe(false);
  });

  it("resolves mod to meta on macOS and ctrl elsewhere", () => {
    getExperimentMock.mockReturnValue({ enabled: false, config: {} });

    getPlatformMock.mockReturnValue("mac");
    let all = resolveShortcutGroups().flatMap((group) => group.shortcuts);
    expect(all.find((shortcut) => shortcut.id === "search")?.shortcut).toBe(
      "meta+k",
    );

    getPlatformMock.mockReturnValue("windows");
    all = resolveShortcutGroups().flatMap((group) => group.shortcuts);
    expect(all.find((shortcut) => shortcut.id === "search")?.shortcut).toBe(
      "ctrl+k",
    );
    expect(all.find((shortcut) => shortcut.id === "newline")?.shortcut).toBe(
      "shift+enter",
    );
  });

  it("has translations for static dialog, category, and settings keys", () => {
    const staticKeys = [
      "dialog.title",
      "dialog.dismissHint",
      "categories.navigation",
      "categories.chat",
      "categories.view",
      "categories.help",
      "settings.label",
      "settings.description",
      "settings.view",
    ];
    for (const key of staticKeys) {
      expect(hasKey(en, key), key).toBe(true);
      expect(hasKey(es, key), key).toBe(true);
    }
  });

  it("uses the configured pane-jump combo when the experiment is enabled", () => {
    getExperimentMock.mockReturnValue({
      enabled: true,
      config: { shortcut: "ctrl+j" },
    });
    const all = resolveShortcutGroups().flatMap((group) => group.shortcuts);
    expect(all.find((shortcut) => shortcut.id === "pane-jump")?.shortcut).toBe(
      "ctrl+j",
    );
  });
});

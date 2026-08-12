import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const LEGACY_EXPERIMENT_STORAGE_KEY = "goose:experimental-features";
const STORAGE_KEY = "goose:global-shortcut-enabled";

async function loadPreference() {
  vi.resetModules();
  return import("./globalShortcutPreference");
}

describe("globalShortcutPreference", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("defaults to disabled and persists explicit choices", async () => {
    const preference = await loadPreference();

    expect(preference.getGlobalShortcutEnabled()).toBe(false);

    preference.setGlobalShortcutEnabled(true);

    expect(preference.getGlobalShortcutEnabled()).toBe(true);
    expect(localStorage.getItem(STORAGE_KEY)).toBe("true");
  });

  it("updates subscribers for same-window and cross-window changes", async () => {
    const preference = await loadPreference();
    const { result } = renderHook(preference.useGlobalShortcutPreference);

    expect(result.current.enabled).toBe(false);

    act(() => {
      preference.setGlobalShortcutEnabled(true);
    });
    expect(result.current.enabled).toBe(true);

    act(() => {
      localStorage.setItem(STORAGE_KEY, "false");
      window.dispatchEvent(
        new StorageEvent("storage", {
          key: STORAGE_KEY,
          newValue: "false",
        }),
      );
    });
    expect(result.current.enabled).toBe(false);
  });

  it("migrates an explicit legacy experiment choice only when unset", async () => {
    localStorage.setItem(
      LEGACY_EXPERIMENT_STORAGE_KEY,
      JSON.stringify({
        version: 2,
        experiments: { "global-shortcut": { enabled: true } },
      }),
    );

    let preference = await loadPreference();

    expect(preference.getGlobalShortcutEnabled()).toBe(true);
    expect(localStorage.getItem(STORAGE_KEY)).toBe("true");

    localStorage.setItem(STORAGE_KEY, "false");
    preference = await loadPreference();

    expect(preference.getGlobalShortcutEnabled()).toBe(false);
  });

  it("ignores unknown or implicit legacy experiment state", async () => {
    localStorage.setItem(
      LEGACY_EXPERIMENT_STORAGE_KEY,
      JSON.stringify({
        version: 2,
        autoEnable: true,
        experiments: {
          "global-shortcut": { config: { shortcut: "ctrl+alt+c" } },
          unknown: { enabled: true },
        },
      }),
    );

    const preference = await loadPreference();

    expect(preference.getGlobalShortcutEnabled()).toBe(false);
    expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
  });
});

import { createBooleanLocalStoragePreference } from "@/shared/preferences/createBooleanLocalStoragePreference";

export const GLOBAL_SHORTCUT_ENABLED_STORAGE_KEY =
  "goose:global-shortcut-enabled";
export const GLOBAL_SHORTCUT_ENABLED_CHANGED_EVENT =
  "goose:global-shortcut-enabled-changed";

const LEGACY_EXPERIMENT_STORAGE_KEY = "goose:experimental-features";
const LEGACY_GLOBAL_SHORTCUT_EXPERIMENT_ID = "global-shortcut";

function migrateLegacyExperimentPreference() {
  try {
    if (localStorage.getItem(GLOBAL_SHORTCUT_ENABLED_STORAGE_KEY) !== null) {
      return;
    }

    const raw = localStorage.getItem(LEGACY_EXPERIMENT_STORAGE_KEY);
    if (!raw) return;

    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return;

    const experiments = (parsed as { experiments?: unknown }).experiments;
    if (typeof experiments !== "object" || experiments === null) return;

    const preference = (experiments as Record<string, unknown>)[
      LEGACY_GLOBAL_SHORTCUT_EXPERIMENT_ID
    ];
    if (typeof preference !== "object" || preference === null) return;

    const enabled = (preference as { enabled?: unknown }).enabled;
    if (typeof enabled === "boolean") {
      localStorage.setItem(
        GLOBAL_SHORTCUT_ENABLED_STORAGE_KEY,
        String(enabled),
      );
    }
  } catch {
    // Migration is best-effort; disabled is the conservative fallback.
  }
}

migrateLegacyExperimentPreference();

const globalShortcutEnabledPreference = createBooleanLocalStoragePreference({
  storageKey: GLOBAL_SHORTCUT_ENABLED_STORAGE_KEY,
  changedEvent: GLOBAL_SHORTCUT_ENABLED_CHANGED_EVENT,
  defaultValue: false,
});

export const getGlobalShortcutEnabled = globalShortcutEnabledPreference.get;
export const setGlobalShortcutEnabled = globalShortcutEnabledPreference.set;
export const useGlobalShortcutPreference =
  globalShortcutEnabledPreference.useValue;

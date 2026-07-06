import { useCallback, useSyncExternalStore } from "react";

export const STYLE_GUIDELINES_STORAGE_KEY = "goose:style-guidelines";
const STYLE_GUIDELINES_CHANGE_EVENT = "goose:style-guidelines-change";
const LEGACY_EXPERIMENT_STORAGE_KEY = "goose:experimental-features";
const LEGACY_STYLE_GUIDELINES_EXPERIMENT_ID = "goose-style-guidelines";

export const DEFAULT_STYLE_GUIDELINES_PROMPT = `Response style:
- Be concise, direct, and friendly; avoid unnecessary detail unless the user asks for it.
- For simple answers or small changes, use plain sentences or a short list instead of heavy structure.
- For final responses, lead with the outcome, mention verification or blockers, and stay compact by default.
- Expand only when extra detail is needed for correctness or user understanding.

Showing images:
- Treat "show/display/see an image, photo, or picture" as a request to produce a visible image — not a description, link, or refusal.
- Use the most direct image-capable tool in one shot: image search/fetch, an image generator, or read_image on a directly-loadable image URL (.jpg/.png/.webp/.gif, not a web page).
- Render local images inline with a Markdown image link to the path, percent-encoding spaces: ![alt](/path/to/my%20folder/pic.png). Image tool results already render inline.
- Never claim you "can't browse the web" or "can't show images" when an image, search, or fetch tool is available.
- When fetching with your own script (curl/wget/etc.), set a descriptive User-Agent — some hosts (e.g. Wikimedia) 403 a blank one.
- Only if no image-capable tool is enabled, say so in one short sentence.`;

export interface StyleGuidelinesPreference {
  prompt: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function normalizeStyleGuidelinesPrompt(prompt: unknown): string {
  return typeof prompt === "string" && prompt.trim()
    ? prompt
    : DEFAULT_STYLE_GUIDELINES_PROMPT;
}

const DEFAULT_STYLE_GUIDELINES_PREFERENCE: StyleGuidelinesPreference = {
  prompt: DEFAULT_STYLE_GUIDELINES_PROMPT,
};
let preferenceSnapshotCache:
  | { key: string; value: StyleGuidelinesPreference }
  | undefined;

function defaultStyleGuidelinesPreference(): StyleGuidelinesPreference {
  return DEFAULT_STYLE_GUIDELINES_PREFERENCE;
}

function getStorage(): Storage | null {
  if (typeof window === "undefined") return null;
  return window.localStorage ?? null;
}

function readLegacyExperimentPreference(): StyleGuidelinesPreference | null {
  const storage = getStorage();
  if (!storage) return null;

  try {
    const raw = storage.getItem(LEGACY_EXPERIMENT_STORAGE_KEY);
    if (!raw) return null;

    const parsed = JSON.parse(raw);
    if (!isRecord(parsed) || !isRecord(parsed.experiments)) return null;

    const styleGuidelines =
      parsed.experiments[LEGACY_STYLE_GUIDELINES_EXPERIMENT_ID];
    if (!isRecord(styleGuidelines)) return null;

    const config = isRecord(styleGuidelines.config)
      ? styleGuidelines.config
      : {};
    return {
      prompt: normalizeStyleGuidelinesPrompt(config.prompt),
    };
  } catch {
    return null;
  }
}

function readStorageSnapshotKey(): string {
  const storage = getStorage();
  if (!storage) return "no-storage";

  try {
    return `${storage.getItem(STYLE_GUIDELINES_STORAGE_KEY) ?? ""}:${
      storage.getItem(LEGACY_EXPERIMENT_STORAGE_KEY) ?? ""
    }`;
  } catch {
    return "unavailable-storage";
  }
}

export function getStyleGuidelinesPreference(): StyleGuidelinesPreference {
  const storage = getStorage();
  if (!storage) return defaultStyleGuidelinesPreference();

  try {
    const raw = storage.getItem(STYLE_GUIDELINES_STORAGE_KEY);
    if (!raw) {
      return (
        readLegacyExperimentPreference() ?? defaultStyleGuidelinesPreference()
      );
    }

    const parsed = JSON.parse(raw);
    if (!isRecord(parsed)) return defaultStyleGuidelinesPreference();

    return {
      prompt: normalizeStyleGuidelinesPrompt(parsed.prompt),
    };
  } catch {
    return defaultStyleGuidelinesPreference();
  }
}

function writeStyleGuidelinesPreference(
  patch: Partial<StyleGuidelinesPreference>,
): boolean {
  const storage = getStorage();
  if (!storage) return false;

  const nextPreference = {
    ...getStyleGuidelinesPreference(),
    ...patch,
  };

  try {
    storage.setItem(
      STYLE_GUIDELINES_STORAGE_KEY,
      JSON.stringify(nextPreference),
    );
  } catch {
    return false;
  }

  window.dispatchEvent(new CustomEvent(STYLE_GUIDELINES_CHANGE_EVENT));
  return true;
}

export function setStyleGuidelinesPrompt(prompt: string): boolean {
  return writeStyleGuidelinesPreference({
    prompt: normalizeStyleGuidelinesPrompt(prompt),
  });
}

export function resetStyleGuidelinesPrompt(): boolean {
  return writeStyleGuidelinesPreference({
    prompt: DEFAULT_STYLE_GUIDELINES_PROMPT,
  });
}

export function getStyleGuidelinesPrompt(): string {
  return getStyleGuidelinesPreference().prompt;
}

function subscribeToStyleGuidelinesChanges(onStoreChange: () => void) {
  if (typeof window === "undefined") return () => {};

  const handleStorage = (event: StorageEvent) => {
    if (
      event.key === STYLE_GUIDELINES_STORAGE_KEY ||
      event.key === LEGACY_EXPERIMENT_STORAGE_KEY ||
      event.key === null
    ) {
      onStoreChange();
    }
  };

  window.addEventListener(STYLE_GUIDELINES_CHANGE_EVENT, onStoreChange);
  window.addEventListener("storage", handleStorage);

  return () => {
    window.removeEventListener(STYLE_GUIDELINES_CHANGE_EVENT, onStoreChange);
    window.removeEventListener("storage", handleStorage);
  };
}

function getStyleGuidelinesPreferenceSnapshot() {
  const storageKey = readStorageSnapshotKey();
  if (preferenceSnapshotCache?.key === storageKey) {
    return preferenceSnapshotCache.value;
  }

  const preference = getStyleGuidelinesPreference();
  preferenceSnapshotCache = { key: storageKey, value: preference };
  return preference;
}

export function useStyleGuidelinesPreference() {
  const preference = useSyncExternalStore(
    subscribeToStyleGuidelinesChanges,
    getStyleGuidelinesPreferenceSnapshot,
    defaultStyleGuidelinesPreference,
  );

  const setPrompt = useCallback((prompt: string) => {
    return setStyleGuidelinesPrompt(prompt);
  }, []);

  const resetPrompt = useCallback(() => {
    return resetStyleGuidelinesPrompt();
  }, []);

  return {
    ...preference,
    setPrompt,
    resetPrompt,
  };
}

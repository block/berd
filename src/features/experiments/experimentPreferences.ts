import { useSyncExternalStore } from "react";

import {
  BUILDERBOT_SURFACE_EXPERIMENT_ID,
  EXPERIMENT_DEFINITIONS,
  SKILL_DISCOVERY_EXPERIMENT_ID,
  type ExperimentConfigControl,
  type ExperimentConfigValue,
  type ExperimentDefinition,
} from "./experimentDefinitions";
import {
  getBuildFeatureState,
  type BuildFeature,
} from "@/shared/profile/buildProfile";
export const EXPERIMENT_PREFERENCES_STORAGE_KEY = "goose:experimental-features";
export const EXPERIMENT_PREFERENCES_STORAGE_VERSION = 2;
export const EXPERIMENT_PREFERENCES_CHANGE_EVENT =
  "goose:experimental-features-change";
const EMPTY_STORAGE_SNAPSHOT = "__goose_experiments_empty__";

interface StoredExperimentPreference {
  enabled?: unknown;
  config?: unknown;
}

interface StoredPreferences {
  version: number;
  autoEnable?: boolean;
  experiments: Record<string, StoredExperimentPreference>;
}

type ExperimentPreferencePatch =
  | {
      enabled: boolean;
    }
  | {
      config: Record<string, ExperimentConfigValue>;
    };

export type ExperimentEnabledSource = "auto" | "explicit";

export interface ExperimentState {
  id: string;
  enabled: boolean;
  enabledSource: ExperimentEnabledSource;
  config: Record<string, ExperimentConfigValue>;
}

export interface ExperimentAutoEnableState {
  enabled: boolean;
  source: "stored" | "default";
  defaultEnabled: boolean;
}

export type ExperimentRegistry = readonly ExperimentDefinition[];

const listSnapshotCache = new WeakMap<
  ExperimentRegistry,
  { key: string; value: ExperimentState[] }
>();
const experimentSnapshotCache = new WeakMap<
  ExperimentRegistry,
  Map<string, { key: string; value: ExperimentState | null }>
>();
let autoEnableSnapshotCache:
  | { key: string; value: ExperimentAutoEnableState }
  | undefined;

function getStorage(): Storage | null {
  if (typeof window === "undefined") return null;
  return window.localStorage ?? null;
}

function defaultStoredPreferences(): StoredPreferences {
  return {
    version: EXPERIMENT_PREFERENCES_STORAGE_VERSION,
    experiments: {},
  };
}

function getDefaultAutoEnable() {
  return import.meta.env.DEV;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function readStorageValue(): string | null {
  const storage = getStorage();
  if (!storage) return null;

  try {
    return storage.getItem(EXPERIMENT_PREFERENCES_STORAGE_KEY);
  } catch {
    return null;
  }
}

function parseStoredPreferencesValue(parsed: unknown): StoredPreferences {
  if (!isRecord(parsed) || !isRecord(parsed.experiments)) {
    return defaultStoredPreferences();
  }

  const experiments: Record<string, StoredExperimentPreference> = {};
  for (const [id, preference] of Object.entries(parsed.experiments)) {
    if (isRecord(preference)) {
      experiments[id] = preference;
    }
  }

  if (parsed.version === 1) {
    return {
      version: EXPERIMENT_PREFERENCES_STORAGE_VERSION,
      autoEnable: undefined,
      experiments,
    };
  }

  if (parsed.version !== EXPERIMENT_PREFERENCES_STORAGE_VERSION) {
    return defaultStoredPreferences();
  }

  return {
    version: EXPERIMENT_PREFERENCES_STORAGE_VERSION,
    autoEnable:
      typeof parsed.autoEnable === "boolean" ? parsed.autoEnable : undefined,
    experiments,
  };
}

function parseStoredPreferences(rawValue: string): StoredPreferences {
  return parseStoredPreferencesValue(JSON.parse(rawValue));
}

function readStoredPreferences(): StoredPreferences {
  const rawValue = readStorageValue();
  if (!rawValue) return defaultStoredPreferences();

  try {
    return parseStoredPreferences(rawValue);
  } catch {
    return defaultStoredPreferences();
  }
}

function getStorageSnapshotKey() {
  return `${getDefaultAutoEnable() ? "dev" : "prod"}:${
    readStorageValue() ?? EMPTY_STORAGE_SNAPSHOT
  }`;
}

function readLatestWritablePreferences() {
  const storage = getStorage();
  if (!storage) return null;

  let latestPreferences = defaultStoredPreferences();
  let rawValue: string | null = null;
  try {
    rawValue = storage.getItem(EXPERIMENT_PREFERENCES_STORAGE_KEY);
  } catch {
    return null;
  }

  if (rawValue) {
    try {
      const parsed = JSON.parse(rawValue);
      if (
        isRecord(parsed) &&
        typeof parsed.version === "number" &&
        parsed.version > EXPERIMENT_PREFERENCES_STORAGE_VERSION
      ) {
        return null;
      }
      latestPreferences = parseStoredPreferencesValue(parsed);
    } catch {
      latestPreferences = defaultStoredPreferences();
    }
  }

  return latestPreferences;
}

function writeStoredPreferences(nextPreferences: StoredPreferences) {
  const storage = getStorage();
  if (!storage) return false;

  try {
    storage.setItem(
      EXPERIMENT_PREFERENCES_STORAGE_KEY,
      JSON.stringify(nextPreferences),
    );
  } catch {
    return false;
  }

  window.dispatchEvent(new CustomEvent(EXPERIMENT_PREFERENCES_CHANGE_EVENT));
  return true;
}

function writeExperimentPreference(
  id: string,
  patch: ExperimentPreferencePatch,
) {
  const writablePreferences = readLatestWritablePreferences();
  if (!writablePreferences) return false;

  const latestPreferences = writablePreferences;
  const existing = latestPreferences.experiments[id] ?? {};
  const existingConfig = isRecord(existing.config) ? existing.config : {};
  const nextPreference =
    "config" in patch
      ? {
          ...existing,
          config: {
            ...existingConfig,
            ...patch.config,
          },
        }
      : {
          ...existing,
          enabled: patch.enabled,
        };

  return writeStoredPreferences({
    ...latestPreferences,
    version: EXPERIMENT_PREFERENCES_STORAGE_VERSION,
    experiments: {
      ...latestPreferences.experiments,
      [id]: nextPreference,
    },
  });
}

function getDefaultConfig(definition: ExperimentDefinition) {
  const config: Record<string, ExperimentConfigValue> = {};

  for (const [key, control] of Object.entries(definition.config ?? {})) {
    config[key] = control.defaultValue;
  }

  return config;
}

function coerceConfigValue(
  control: ExperimentConfigControl,
  value: unknown,
): ExperimentConfigValue {
  switch (control.type) {
    case "boolean":
      return typeof value === "boolean" ? value : control.defaultValue;
    case "select":
      return typeof value === "string" &&
        control.options.some((option) => option.value === value)
        ? value
        : control.defaultValue;
    case "number": {
      const numberValue =
        typeof value === "number" ? value : control.defaultValue;
      if (!Number.isFinite(numberValue)) return control.defaultValue;
      if (
        typeof control.min === "number" &&
        typeof control.max === "number" &&
        control.min > control.max
      ) {
        return control.defaultValue;
      }
      if (typeof control.min === "number" && numberValue < control.min) {
        return control.min;
      }
      if (typeof control.max === "number" && numberValue > control.max) {
        return control.max;
      }
      return numberValue;
    }
    case "text":
      return typeof value === "string" ? value : control.defaultValue;
  }
}

/**
 * Resolve the effective auto-enabled state for an experiment.
 *
 * When auto-enable is active (dev builds by default), all experiments are
 * enabled regardless of their per-definition `defaultEnabled` value. When
 * auto-enable is off (production), `defaultEnabled` determines the default
 * state (falling back to off when omitted).
 */
export function resolveAutoEnabled(
  autoEnable: boolean,
  defaultEnabled: boolean | undefined,
): boolean {
  return autoEnable || (defaultEnabled ?? false);
}

function resolveExperimentState(
  definition: ExperimentDefinition,
  storedPreference: StoredExperimentPreference | undefined,
): ExperimentState {
  const storedConfig = isRecord(storedPreference?.config)
    ? storedPreference.config
    : {};
  const config = getDefaultConfig(definition);

  for (const [key, control] of Object.entries(definition.config ?? {})) {
    config[key] = coerceConfigValue(control, storedConfig[key]);
  }

  const explicitEnabled =
    typeof storedPreference?.enabled === "boolean"
      ? storedPreference.enabled
      : undefined;
  const autoEnabled = resolveAutoEnabled(
    definition.manualEnableOnly ? false : getExperimentAutoEnable().enabled,
    definition.defaultEnabled,
  );

  return {
    id: definition.id,
    enabled: explicitEnabled ?? autoEnabled,
    enabledSource: explicitEnabled === undefined ? "auto" : "explicit",
    config,
  };
}

function findDefinition(id: string, registry: ExperimentRegistry) {
  return getVisibleExperimentRegistry(registry).find(
    (definition) => definition.id === id,
  );
}

/**
 * Experiments whose runtime depends on Block-internal services stay hidden
 * unless the matching build feature is enabled. Hiding at the registry level
 * (not just in settings) means `getExperiment`/`useExperiment` return null in
 * public builds, so stale per-user localStorage overrides can never re-enable
 * a surface that would route consumer users to Block-internal auth (issue
 * #168).
 */
const BUILD_FEATURE_GATED_EXPERIMENTS: Readonly<
  Partial<Record<string, BuildFeature>>
> = {
  [BUILDERBOT_SURFACE_EXPERIMENT_ID]: "builderbot",
  [SKILL_DISCOVERY_EXPERIMENT_ID]: "skillDiscovery",
};

export function getVisibleExperimentRegistry(
  registry: ExperimentRegistry = EXPERIMENT_DEFINITIONS,
): ExperimentRegistry {
  const buildFeatures = getBuildFeatureState();

  return registry.filter((definition) => {
    const requiredFeature = BUILD_FEATURE_GATED_EXPERIMENTS[definition.id];
    return requiredFeature === undefined || buildFeatures[requiredFeature];
  });
}

export function listExperiments(
  registry: ExperimentRegistry = EXPERIMENT_DEFINITIONS,
): ExperimentState[] {
  const storedPreferences = readStoredPreferences();
  return getVisibleExperimentRegistry(registry).map((definition) =>
    resolveExperimentState(
      definition,
      storedPreferences.experiments[definition.id],
    ),
  );
}

export function getExperiment(
  id: string,
  registry: ExperimentRegistry = EXPERIMENT_DEFINITIONS,
): ExperimentState | null {
  const definition = findDefinition(id, registry);
  if (!definition) return null;

  return resolveExperimentState(
    definition,
    readStoredPreferences().experiments[definition.id],
  );
}

export function setExperimentEnabled(
  id: string,
  enabled: boolean,
  registry: ExperimentRegistry = EXPERIMENT_DEFINITIONS,
) {
  const definition = findDefinition(id, registry);
  if (!definition) return false;

  return writeExperimentPreference(id, { enabled });
}

export function clearExperimentEnabledOverride(
  id: string,
  registry: ExperimentRegistry = EXPERIMENT_DEFINITIONS,
) {
  const definition = findDefinition(id, registry);
  if (!definition) return false;

  const writablePreferences = readLatestWritablePreferences();
  if (!writablePreferences) return false;

  const latestPreferences = writablePreferences;
  const existing = latestPreferences.experiments[id] ?? {};
  const { enabled: _enabled, ...nextPreference } = existing;

  return writeStoredPreferences({
    ...latestPreferences,
    version: EXPERIMENT_PREFERENCES_STORAGE_VERSION,
    experiments: {
      ...latestPreferences.experiments,
      [id]: nextPreference,
    },
  });
}

export function getExperimentAutoEnable(): ExperimentAutoEnableState {
  const storedPreferences = readStoredPreferences();
  const defaultEnabled = getDefaultAutoEnable();

  return {
    enabled: storedPreferences.autoEnable ?? defaultEnabled,
    source: storedPreferences.autoEnable === undefined ? "default" : "stored",
    defaultEnabled,
  };
}

export function setExperimentAutoEnable(enabled: boolean) {
  const writablePreferences = readLatestWritablePreferences();
  if (!writablePreferences) return false;

  const latestPreferences = writablePreferences;
  return writeStoredPreferences({
    ...latestPreferences,
    version: EXPERIMENT_PREFERENCES_STORAGE_VERSION,
    autoEnable: enabled,
  });
}

export function setExperimentConfigValue(
  id: string,
  key: string,
  value: ExperimentConfigValue,
  registry: ExperimentRegistry = EXPERIMENT_DEFINITIONS,
) {
  const definition = findDefinition(id, registry);
  const control = definition?.config?.[key];
  if (!definition || !control) return false;

  return writeExperimentPreference(id, {
    config: {
      [key]: coerceConfigValue(control, value),
    },
  });
}

export function useExperiment(
  id: string,
  registry: ExperimentRegistry = EXPERIMENT_DEFINITIONS,
): ExperimentState | null {
  return useSyncExternalStore(
    subscribeToExperimentChanges,
    () => getExperimentSnapshot(id, registry),
    () => getExperimentSnapshot(id, registry),
  );
}

export function useExperimentList(
  registry: ExperimentRegistry = EXPERIMENT_DEFINITIONS,
) {
  return useSyncExternalStore(
    subscribeToExperimentChanges,
    () => getExperimentListSnapshot(registry),
    () => getExperimentListSnapshot(registry),
  );
}

export function useExperimentAutoEnable() {
  return useSyncExternalStore(
    subscribeToExperimentChanges,
    getExperimentAutoEnableSnapshot,
    getExperimentAutoEnableSnapshot,
  );
}

function getExperimentAutoEnableSnapshot() {
  const storageKey = getStorageSnapshotKey();
  if (autoEnableSnapshotCache?.key === storageKey) {
    return autoEnableSnapshotCache.value;
  }

  const snapshot = getExperimentAutoEnable();
  autoEnableSnapshotCache = { key: storageKey, value: snapshot };
  return snapshot;
}

function getExperimentListSnapshot(registry: ExperimentRegistry) {
  const storageKey = getStorageSnapshotKey();
  const cachedSnapshot = listSnapshotCache.get(registry);
  if (cachedSnapshot?.key === storageKey) {
    return cachedSnapshot.value;
  }

  const snapshot = listExperiments(registry);
  listSnapshotCache.set(registry, { key: storageKey, value: snapshot });
  return snapshot;
}

function getExperimentSnapshot(id: string, registry: ExperimentRegistry) {
  const storageKey = getStorageSnapshotKey();
  let registryCache = experimentSnapshotCache.get(registry);
  if (!registryCache) {
    registryCache = new Map<
      string,
      { key: string; value: ExperimentState | null }
    >();
    experimentSnapshotCache.set(registry, registryCache);
  }

  const cachedSnapshot = registryCache.get(id);
  if (cachedSnapshot?.key === storageKey) {
    return cachedSnapshot.value;
  }

  const snapshot = getExperiment(id, registry);
  registryCache.set(id, { key: storageKey, value: snapshot });
  return snapshot;
}

export function subscribeToExperimentChanges(onStoreChange: () => void) {
  if (typeof window === "undefined") return () => {};

  const handleStorage = (event: StorageEvent) => {
    if (
      event.key === EXPERIMENT_PREFERENCES_STORAGE_KEY ||
      event.key === null
    ) {
      onStoreChange();
    }
  };

  window.addEventListener(EXPERIMENT_PREFERENCES_CHANGE_EVENT, onStoreChange);
  window.addEventListener("storage", handleStorage);

  return () => {
    window.removeEventListener(
      EXPERIMENT_PREFERENCES_CHANGE_EVENT,
      onStoreChange,
    );
    window.removeEventListener("storage", handleStorage);
  };
}

import {
  canonicalProviderCatalogId,
  resolveAgentProviderCatalogIdStrict,
} from "@/features/providers/providerCatalog";
import { normalizeConcreteModelId } from "@/shared/lib/modelIdentity";

const MODEL_PREFERENCES_STORAGE_KEY = "goose:preferredModelsByAgent";

export interface StoredModelPreference {
  modelId: string;
  modelName: string;
  providerId?: string;
}

type StoredModelPreferences = Record<string, StoredModelPreference>;

function canonicalAgentId(agentId: string): string {
  return resolveAgentProviderCatalogIdStrict(agentId) ?? agentId;
}

function canonicalModelProviderId(providerId: string): string | undefined {
  if (!providerId || providerId === "goose") {
    return undefined;
  }
  return canonicalProviderCatalogId(providerId);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseStoredModelPreferences(value: unknown): StoredModelPreferences {
  if (!isRecord(value)) {
    return {};
  }

  const preferences: StoredModelPreferences = {};
  for (const [storedAgentId, candidate] of Object.entries(value)) {
    if (!isRecord(candidate)) continue;
    const agentId = canonicalAgentId(storedAgentId);
    const modelId =
      typeof candidate.modelId === "string"
        ? normalizeConcreteModelId(candidate.modelId)
        : undefined;
    const storedProviderId =
      typeof candidate.providerId === "string"
        ? canonicalModelProviderId(candidate.providerId)
        : undefined;
    const providerId =
      storedProviderId ?? (agentId === "goose" ? undefined : agentId);
    if (!modelId) continue;

    preferences[agentId] = {
      modelId,
      modelName:
        typeof candidate.modelName === "string" ? candidate.modelName : modelId,
      ...(providerId ? { providerId } : {}),
    };
  }
  return preferences;
}

function readStoredModelPreferences(): StoredModelPreferences {
  if (typeof window === "undefined") {
    return {};
  }

  try {
    const stored = window.localStorage.getItem(MODEL_PREFERENCES_STORAGE_KEY);
    if (!stored) {
      return {};
    }

    return parseStoredModelPreferences(JSON.parse(stored));
  } catch {
    return {};
  }
}

function persistStoredModelPreferences(
  preferences: StoredModelPreferences,
): void {
  if (typeof window === "undefined") {
    return;
  }

  try {
    if (Object.keys(preferences).length === 0) {
      window.localStorage.removeItem(MODEL_PREFERENCES_STORAGE_KEY);
      return;
    }

    window.localStorage.setItem(
      MODEL_PREFERENCES_STORAGE_KEY,
      JSON.stringify(preferences),
    );
  } catch {
    // localStorage may be unavailable
  }
}

export function getStoredModelPreference(
  agentId: string,
): StoredModelPreference | null {
  return readStoredModelPreferences()[canonicalAgentId(agentId)] ?? null;
}

export function getStoredModelPreferenceForProvider(
  providerId: string,
): StoredModelPreference | null {
  const exactPreference = getStoredModelPreference(providerId);
  if (exactPreference) {
    return exactPreference;
  }

  const agentId = resolveAgentProviderCatalogIdStrict(providerId) ?? "goose";
  return getStoredModelPreference(agentId);
}

export function setStoredModelPreference(
  agentId: string,
  preference: StoredModelPreference,
): void {
  const next = readStoredModelPreferences();
  const canonicalId = canonicalAgentId(agentId);
  const modelId = normalizeConcreteModelId(preference.modelId);
  const providerId = preference.providerId
    ? canonicalModelProviderId(preference.providerId)
    : undefined;
  if (!modelId || !providerId) {
    delete next[canonicalId];
    persistStoredModelPreferences(next);
    return;
  }
  next[canonicalId] = { ...preference, modelId, providerId };
  persistStoredModelPreferences(next);
}

export function clearStoredModelPreference(agentId: string): void {
  const next = readStoredModelPreferences();
  delete next[canonicalAgentId(agentId)];
  persistStoredModelPreferences(next);
}

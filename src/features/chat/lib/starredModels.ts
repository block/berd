import type { ModelOption } from "../types";

export const STARRED_MODELS_STORAGE_KEY = "berd:starred-models-v2";
export const STARRED_MODELS_CHANGED_EVENT = "berd:starred-models-v2-changed";

export interface StarredModelRecord {
  agentId: string;
  model: ModelOption;
}

export function modelStarKey(
  agentId: string,
  modelProviderId: string | undefined,
  modelId: string,
): string {
  return JSON.stringify([agentId, modelProviderId ?? "", modelId]);
}

export function starredModelKey(record: StarredModelRecord): string {
  return modelStarKey(record.agentId, record.model.providerId, record.model.id);
}

function isModelOption(value: unknown): value is ModelOption {
  if (!value || typeof value !== "object") return false;
  const model = value as Partial<ModelOption>;
  return typeof model.id === "string" && typeof model.name === "string";
}

function isStarredModelRecord(value: unknown): value is StarredModelRecord {
  if (!value || typeof value !== "object") return false;
  const record = value as Partial<StarredModelRecord>;
  return typeof record.agentId === "string" && isModelOption(record.model);
}

export function getStarredModels(): StarredModelRecord[] {
  if (typeof window === "undefined") return [];

  try {
    const parsed: unknown = JSON.parse(
      window.localStorage.getItem(STARRED_MODELS_STORAGE_KEY) ?? "[]",
    );
    if (!Array.isArray(parsed)) return [];

    const seen = new Set<string>();
    return parsed.filter((value): value is StarredModelRecord => {
      if (!isStarredModelRecord(value)) return false;
      const key = starredModelKey(value);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  } catch {
    return [];
  }
}

function persistStarredModels(records: StarredModelRecord[]): void {
  try {
    if (records.length === 0) {
      window.localStorage.removeItem(STARRED_MODELS_STORAGE_KEY);
    } else {
      window.localStorage.setItem(
        STARRED_MODELS_STORAGE_KEY,
        JSON.stringify(records),
      );
    }
  } catch {
    // localStorage may be unavailable.
  }
  window.dispatchEvent(new CustomEvent(STARRED_MODELS_CHANGED_EVENT));
}

export function toggleModelStar(agentId: string, model: ModelOption): void {
  const records = getStarredModels();
  const key = modelStarKey(agentId, model.providerId, model.id);
  const existingIndex = records.findIndex(
    (record) => starredModelKey(record) === key,
  );

  if (existingIndex >= 0) {
    records.splice(existingIndex, 1);
  } else {
    records.push({ agentId, model });
  }
  persistStarredModels(records);
}

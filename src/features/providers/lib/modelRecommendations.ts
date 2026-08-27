import type { ModelOption } from "@/features/chat/types";
import { formatProviderLabel } from "@/shared/ui/icons/ProviderIcons";
import { humanizeRawModelId } from "./humanizeModelId";

interface ParsedGooseModelId {
  familyKey: string;
  familyTokens: string[];
  version: number[];
}

const KNOWN_CASINGS: Record<string, string> = {
  gpt: "GPT",
  chatgpt: "ChatGPT",
  aws: "AWS",
  openai: "OpenAI",
};

const FALLBACK_GOOSE_MODEL_PROVIDER_IDS = new Set(["databricks_v2"]);

function formatFamilyToken(token: string): string {
  const lower = token.toLowerCase();
  return (
    KNOWN_CASINGS[lower] ??
    token.charAt(0).toUpperCase() + token.slice(1).toLowerCase()
  );
}

export function parseGooseModelId(id: string): ParsedGooseModelId | null {
  if (!id.startsWith("goose-")) {
    return null;
  }

  const tokens = id.slice("goose-".length).split("-").filter(Boolean);
  const familyTokens: string[] = [];
  const version: number[] = [];

  for (const token of tokens) {
    if (/^\d+$/.test(token)) {
      version.push(Number(token));
    } else {
      familyTokens.push(token);
    }
  }

  if (familyTokens.length === 0 || version.length === 0) {
    return null;
  }

  return {
    familyKey: familyTokens.join("-"),
    familyTokens,
    version,
  };
}

function compareVersion(left: number[], right: number[]): number {
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const diff = (left[index] ?? 0) - (right[index] ?? 0);
    if (diff !== 0) {
      return diff;
    }
  }
  return 0;
}

export function normalizedGooseModelDisplayName(id: string): string | null {
  const parsed = parseGooseModelId(id);
  if (!parsed) {
    return null;
  }

  return [
    ...parsed.familyTokens.map(formatFamilyToken),
    parsed.version.join("."),
  ].join(" ");
}

export function gooseModelSortRank(id: string): number {
  const parsed = parseGooseModelId(id);
  const familyKey = parsed?.familyKey ?? "";

  // These are product-positioning preferences for recommended Goose models.
  // Unknown future families intentionally land in the middle.
  if (familyKey === "gpt") return 0;
  if (familyKey.includes("opus")) return 1;
  if (familyKey.includes("haiku")) return 3;
  return 2;
}

export function recommendedGooseModelIds(ids: string[]): Set<string> {
  const bestByFamily = new Map<
    string,
    { id: string; version: number[]; originalIndex: number }
  >();

  ids.forEach((id, originalIndex) => {
    const parsed = parseGooseModelId(id);
    if (!parsed) {
      return;
    }

    const current = bestByFamily.get(parsed.familyKey);
    if (
      !current ||
      compareVersion(parsed.version, current.version) > 0 ||
      (compareVersion(parsed.version, current.version) === 0 &&
        originalIndex > current.originalIndex)
    ) {
      bestByFamily.set(parsed.familyKey, {
        id,
        version: parsed.version,
        originalIndex,
      });
    }
  });

  return new Set([...bestByFamily.values()].map((entry) => entry.id));
}

function compareModelLabels(left: ModelOption, right: ModelOption): number {
  const leftLabel = left.displayName ?? left.name ?? left.id;
  const rightLabel = right.displayName ?? right.name ?? right.id;
  return leftLabel.localeCompare(rightLabel);
}

function compareGooseModels(left: ModelOption, right: ModelOption): number {
  const leftRank = gooseModelSortRank(left.id);
  const rightRank = gooseModelSortRank(right.id);
  if (leftRank !== rightRank) {
    return leftRank - rightRank;
  }

  return compareModelLabels(left, right);
}

function featuredGooseModelId(models: ModelOption[]): string | null {
  const recommended = models.filter((model) => model.recommended);
  return [...recommended].sort(compareGooseModels)[0]?.id ?? null;
}

export function isGooseModelProviderId(providerId: string): boolean {
  return FALLBACK_GOOSE_MODEL_PROVIDER_IDS.has(providerId);
}

export function modelDisplayNameFromId(providerId: string, id: string): string {
  const firstDot = id.indexOf(".");
  const lastDot = id.lastIndexOf(".");
  const displayId =
    providerId === "databricks_v2" && firstDot > 0 && lastDot > firstDot
      ? id.slice(lastDot + 1)
      : id;
  return (
    normalizedGooseModelDisplayName(displayId) ?? humanizeRawModelId(displayId)
  );
}

function rawModelIdToOption(providerId: string, id: string): ModelOption {
  const providerName = formatProviderLabel(providerId);
  const displayName = modelDisplayNameFromId(providerId, id);

  return {
    id,
    name: displayName,
    displayName,
    providerId,
    providerName,
    recommended: false,
    featured: false,
  };
}

function markRecommendedGooseModels(models: ModelOption[]): ModelOption[] {
  const recommendedIds = recommendedGooseModelIds(
    models.map((model) => model.id),
  );
  const recommendedModels = models.map((model) => ({
    ...model,
    recommended: recommendedIds.has(model.id),
  }));
  const featuredId = featuredGooseModelId(recommendedModels);

  return recommendedModels
    .map((model) => ({
      ...model,
      featured: model.id === featuredId,
    }))
    .sort(compareGooseModels)
    .map((model, sortOrder) => ({
      ...model,
      sortOrder,
    }));
}

function markGenericProviderModels(models: ModelOption[]): ModelOption[] {
  return models.map((model) => ({
    ...model,
    recommended: true,
    featured: false,
  }));
}

export function providerModelOptionsFromIds(
  providerId: string,
  ids: string[],
): ModelOption[] {
  const options = ids.map((id) => rawModelIdToOption(providerId, id));

  if (!isGooseModelProviderId(providerId)) {
    return markGenericProviderModels(options);
  }

  return markRecommendedGooseModels(options);
}

import {
  canonicalProviderCatalogIdFromEntries,
  resolveAgentProviderCatalogIdStrictFromEntries,
  resolveModelProviderCatalogIdStrictFromEntries,
} from "@/features/providers/providerCatalog";
import type { ProviderCatalogEntry } from "@/shared/types/providers";

interface ProviderQualifiedModel {
  id: string;
  providerId?: string;
}

interface ResolveModelProviderIdOptions {
  harnessId: string;
  modelId: string;
  hintedModelProviderId?: string;
  models: readonly ProviderQualifiedModel[];
  catalogEntries: ProviderCatalogEntry[];
}

export function resolveConcreteModelProviderId(
  providerId: string | undefined,
  harnessId: string,
  catalogEntries: ProviderCatalogEntry[],
): string | undefined {
  if (!providerId) return undefined;
  const canonicalId = canonicalProviderCatalogIdFromEntries(
    catalogEntries,
    providerId,
  );
  if (canonicalId === "goose") return undefined;
  if (
    harnessId === "goose" &&
    resolveAgentProviderCatalogIdStrictFromEntries(catalogEntries, canonicalId)
  ) {
    return undefined;
  }
  return canonicalId;
}

export function resolveModelProviderId({
  harnessId,
  modelId,
  hintedModelProviderId,
  models,
  catalogEntries,
}: ResolveModelProviderIdOptions): string | undefined {
  const matchingModels = models.filter((model) => model.id === modelId);
  const matchingProviderIds = new Set(
    matchingModels
      .map((model) =>
        resolveConcreteModelProviderId(
          model.providerId,
          harnessId,
          catalogEntries,
        ),
      )
      .filter((providerId): providerId is string => Boolean(providerId)),
  );
  const hasUnqualifiedModel = matchingModels.some((model) => !model.providerId);
  const hintedProviderId = resolveConcreteModelProviderId(
    hintedModelProviderId,
    harnessId,
    catalogEntries,
  );
  if (hintedProviderId) {
    if (
      matchingProviderIds.size > 0 &&
      !hasUnqualifiedModel &&
      !matchingProviderIds.has(hintedProviderId)
    ) {
      return undefined;
    }
    const isHarnessProvider =
      harnessId !== "goose" && hintedProviderId === harnessId;
    const isCatalogModelProvider = Boolean(
      resolveModelProviderCatalogIdStrictFromEntries(
        catalogEntries,
        hintedProviderId,
      ),
    );
    const isInventoryModelProvider = matchingProviderIds.has(hintedProviderId);
    if (
      isHarnessProvider ||
      isCatalogModelProvider ||
      isInventoryModelProvider
    ) {
      return hintedProviderId;
    }
  }

  if (harnessId !== "goose") {
    return resolveConcreteModelProviderId(harnessId, harnessId, catalogEntries);
  }

  if (matchingProviderIds.size !== 1) return undefined;
  return matchingProviderIds.values().next().value;
}

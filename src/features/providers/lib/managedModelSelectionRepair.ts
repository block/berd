import packageJson from "../../../../package.json";
import { useRuntimeConfigStore } from "@/shared/runtime-config/runtimeConfigStore";
import { resolveAgentProviderCatalogIdStrict } from "@/features/providers/providerCatalog";
import {
  providerModelInventoryGeneration,
  subscribeToProviderModelInventoryInvalidation,
} from "@/shared/runtime-config/providerModelInventoryInvalidation";
import {
  readBoundedProvenModelInventory,
  resolveManagedGooseProviderSelection,
  resolveValidatedManagedGooseProviderSelection,
  type GooseProviderSelection,
  type ManagedGooseProviderSelection,
} from "@/shared/runtime-config/modelProviderPolicy";

const VALIDATED_INVENTORY_TTL_MS = 5 * 60 * 1000;
const validatedInventories = new Map<
  string,
  { modelIds: ReadonlySet<string>; fetchedAt: number }
>();
const inventoryRequests = new Map<
  string,
  Promise<ReadonlySet<string> | null>
>();
subscribeToProviderModelInventoryInvalidation((providerId) => {
  validatedInventories.delete(providerId);
  inventoryRequests.delete(providerId);
});

export type ManagedModelRepairSource =
  | "berd_preference"
  | "goose_default"
  | "new_session"
  | "session"
  | "queue"
  | "deferred";

async function validatedModelIds(
  providerId: string,
): Promise<ReadonlySet<string> | null> {
  const cached = validatedInventories.get(providerId);
  if (cached && Date.now() - cached.fetchedAt < VALIDATED_INVENTORY_TTL_MS) {
    return cached.modelIds;
  }

  const existing = inventoryRequests.get(providerId);
  if (existing) return existing;

  const generationAtStart = providerModelInventoryGeneration(providerId);
  let request!: Promise<ReadonlySet<string> | null>;
  request = (async () => {
    try {
      const modelIds = await readBoundedProvenModelInventory(providerId);
      if (generationAtStart !== providerModelInventoryGeneration(providerId)) {
        return validatedModelIds(providerId);
      }
      validatedInventories.set(providerId, {
        modelIds,
        fetchedAt: Date.now(),
      });
      return modelIds;
    } catch (error) {
      if (generationAtStart !== providerModelInventoryGeneration(providerId)) {
        return validatedModelIds(providerId);
      }
      console.warn("Could not validate managed provider model inventory", {
        providerId,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    } finally {
      if (inventoryRequests.get(providerId) === request) {
        inventoryRequests.delete(providerId);
      }
    }
  })();
  inventoryRequests.set(providerId, request);
  return request;
}

export async function repairManagedGooseModelSelection(
  selection: GooseProviderSelection,
  source: ManagedModelRepairSource,
): Promise<ManagedGooseProviderSelection | null> {
  if (
    selection.providerId &&
    selection.providerId !== "goose" &&
    resolveAgentProviderCatalogIdStrict(selection.providerId)
  ) {
    return {
      providerId: selection.providerId,
      modelId: selection.modelId ?? undefined,
    };
  }

  const config = useRuntimeConfigStore.getState().config;
  const initial = resolveManagedGooseProviderSelection(config, selection);
  if (!initial) return null;
  if (initial.providerId !== selection.providerId) {
    return resolveValidatedManagedGooseProviderSelection(config, selection);
  }
  if (!selection.modelId) {
    return initial;
  }

  const targetModelIds = await validatedModelIds(initial.providerId);
  const repaired = resolveManagedGooseProviderSelection(config, selection, {
    ...(targetModelIds ? { targetModelIds } : {}),
    targetInventoryValidated: targetModelIds !== null,
  });

  const modelRepaired =
    selection.modelId != null &&
    repaired?.modelId !== (selection.modelId ?? undefined);
  if (repaired && modelRepaired) {
    console.info("Repaired managed Goose model selection", {
      source,
      previousProviderId: selection.providerId ?? null,
      previousModelId: selection.modelId ?? null,
      repairedProviderId: repaired.providerId,
      repairedModelId: repaired.modelId ?? null,
      appVersion: packageJson.version,
      migrationVersion: "databricks-v1-to-v2-v1",
    });
  }
  return repaired;
}

export function resetManagedModelSelectionRepairCacheForTests(): void {
  validatedInventories.clear();
  inventoryRequests.clear();
}

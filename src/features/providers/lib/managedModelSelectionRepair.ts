import packageJson from "../../../../package.json";
import { getClient } from "@/shared/api/acpConnection";
import { useRuntimeConfigStore } from "@/shared/runtime-config/runtimeConfigStore";
import { resolveAgentProviderCatalogIdStrict } from "@/features/providers/providerCatalog";
import { subscribeToProviderModelInventoryInvalidation } from "./providerModelInventoryEvents";
import {
  filterDiscoveredModelIds,
  resolveManagedGooseProviderSelection,
  type GooseProviderSelection,
  type ManagedGooseProviderSelection,
} from "@/shared/runtime-config/modelProviderPolicy";

const DATABRICKS_V2_PROVIDER_ID = "databricks_v2";
const VALIDATED_INVENTORY_TTL_MS = 5 * 60 * 1000;
const validatedInventories = new Map<
  string,
  { modelIds: ReadonlySet<string>; fetchedAt: number }
>();
const inventoryRequests = new Map<
  string,
  Promise<ReadonlySet<string> | null>
>();
const inventoryGenerations = new Map<string, number>();

function inventoryGeneration(providerId: string): number {
  return inventoryGenerations.get(providerId) ?? 0;
}

subscribeToProviderModelInventoryInvalidation((providerId) => {
  validatedInventories.delete(providerId);
  inventoryRequests.delete(providerId);
  inventoryGenerations.set(providerId, inventoryGeneration(providerId) + 1);
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

  const generationAtStart = inventoryGeneration(providerId);
  let request!: Promise<ReadonlySet<string> | null>;
  request = (async () => {
    try {
      const client = await getClient();
      const response =
        await client.goose.GooseUnstableProvidersSupportedModelsList({
          providerId,
        });
      const modelIds = new Set(response.models as string[]);
      if (generationAtStart !== inventoryGeneration(providerId)) {
        return validatedModelIds(providerId);
      }
      validatedInventories.set(providerId, {
        modelIds,
        fetchedAt: Date.now(),
      });
      return modelIds;
    } catch (error) {
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

  const initialConfig = useRuntimeConfigStore.getState().config;
  const initial = resolveManagedGooseProviderSelection(
    initialConfig,
    selection,
  );
  if (!initial) return null;

  const discoveredIds =
    initial.providerId === DATABRICKS_V2_PROVIDER_ID && selection.modelId
      ? await validatedModelIds(initial.providerId)
      : null;
  const config = useRuntimeConfigStore.getState().config;
  const current = resolveManagedGooseProviderSelection(config, selection);
  if (!current) return null;

  const targetModelIds =
    discoveredIds && current.providerId === initial.providerId
      ? new Set(
          filterDiscoveredModelIds(config, current.providerId, [
            ...discoveredIds,
          ]),
        )
      : null;
  const provider = config.goose.modelProviders.find(
    (candidate) => candidate.id === current.providerId,
  );
  for (const model of provider?.models ?? []) {
    targetModelIds?.add(model.id);
  }
  if (
    targetModelIds &&
    selection.modelId &&
    provider?.allowedModelIdPrefixes?.some((prefix) =>
      selection.modelId?.startsWith(prefix),
    )
  ) {
    targetModelIds.add(selection.modelId);
  }
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
  inventoryGenerations.clear();
}

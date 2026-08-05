import { useEffect } from "react";
import {
  getStoredModelPreference,
  setStoredModelPreference,
} from "@/features/chat/lib/modelPreferences";
import { getClient } from "@/shared/api/acpConnection";
import { readDefaultModelStatus } from "../api/defaultModel";
import {
  getDefaultGooseModelId,
  getDefaultGooseModelName,
  getDefaultGooseModelProviderId,
} from "@/features/runtime-config/defaults";
import { useDefaultProviderReadinessStore } from "@/features/providers/stores/defaultProviderReadinessStore";

/**
 * Post-migration repair for installs left in the legacy broken state where
 * the active provider is set but its model id is empty. Startup must not block
 * on provider auth or default-model persistence, so failures are logged and
 * left to the model-selection/use path.
 */
export function useDefaultModelGate(migrationReady: boolean): void {
  useEffect(() => {
    if (!migrationReady) {
      return;
    }

    let cancelled = false;

    async function execute() {
      try {
        const initial = await readDefaultModelStatus();
        if (cancelled) return;

        const defaultModelId = getDefaultGooseModelId();
        const defaultProviderId = getDefaultGooseModelProviderId();
        const defaultModelName = defaultModelId
          ? getDefaultGooseModelName(defaultModelId)
          : undefined;
        if (
          !defaultProviderId ||
          !defaultModelId ||
          !initial.modelMissing ||
          initial.providerId !== defaultProviderId
        ) {
          return;
        }

        const client = await getClient();
        await client.goose.GooseUnstableDefaultsSave({
          providerId: defaultProviderId,
          modelId: defaultModelId,
        });
        if (cancelled) return;
        await useDefaultProviderReadinessStore.getState().refresh();
        if (cancelled) return;

        if (!getStoredModelPreference("goose")) {
          setStoredModelPreference("goose", {
            providerId: defaultProviderId,
            modelId: defaultModelId,
            modelName: defaultModelName ?? defaultModelId,
          });
        }
      } catch (error) {
        if (cancelled) return;
        console.error("Failed to repair default model:", error);
      }
    }

    void execute();

    return () => {
      cancelled = true;
    };
  }, [migrationReady]);
}

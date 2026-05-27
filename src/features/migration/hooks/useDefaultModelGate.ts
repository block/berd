import { useEffect } from "react";
import {
  getStoredModelPreference,
  setStoredModelPreference,
} from "@/features/chat/lib/modelPreferences";
import { getClient } from "@/shared/api/acpConnection";
import { readDefaultModelStatus } from "../api/defaultModel";
import {
  DEFAULT_MODEL_ID,
  DEFAULT_MODEL_NAME,
  DEFAULT_PROVIDER_ID,
} from "../lib/constants";

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

        if (
          !DEFAULT_MODEL_ID ||
          !initial.modelMissing ||
          initial.providerId !== DEFAULT_PROVIDER_ID
        ) {
          return;
        }

        const client = await getClient();
        await client.goose.GooseUnstableDefaultsSave({
          providerId: DEFAULT_PROVIDER_ID,
          modelId: DEFAULT_MODEL_ID,
        });
        if (cancelled) return;

        if (!getStoredModelPreference("goose")) {
          setStoredModelPreference("goose", {
            providerId: DEFAULT_PROVIDER_ID,
            modelId: DEFAULT_MODEL_ID,
            modelName: DEFAULT_MODEL_NAME,
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

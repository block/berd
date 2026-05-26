import { useCallback, useEffect, useRef, useState } from "react";
import { setStoredModelPreference } from "@/features/chat/lib/modelPreferences";
import { getClient } from "@/shared/api/acpConnection";
import { readDefaultModelStatus } from "../api/defaultModel";
import {
  DEFAULT_MODEL_ID,
  DEFAULT_MODEL_NAME,
  DEFAULT_PROVIDER_ID,
} from "../lib/constants";

export type DefaultModelGateStatus = "loading" | "ok" | "error";

interface DefaultModelGate {
  status: DefaultModelGateStatus;
  error?: Error;
  retry: () => void;
}

/**
 * Post-migration heal for installs left in the legacy broken state where
 * the active provider is set but its model id is empty (the old
 * `runMigration` invalid_params fallback). When detected, silently
 * re-saves `DEFAULT_MODEL_ID` against the same provider so the next
 * `setProvider` doesn't 32603. Only fires when the persisted provider
 * matches `DEFAULT_PROVIDER_ID` and `DEFAULT_MODEL_ID` is defined; any
 * other shape is left alone and the gate resolves to `"ok"`.
 *
 * Runs only after the migration gate is ready. Failures surface through
 * the gate's retryable error state.
 */
export function useDefaultModelGate(migrationReady: boolean): DefaultModelGate {
  const [status, setStatus] = useState<DefaultModelGateStatus>("loading");
  const [error, setError] = useState<Error | undefined>(undefined);
  const [attempt, setAttempt] = useState(0);
  const inFlight = useRef(false);

  // biome-ignore lint/correctness/useExhaustiveDependencies: `attempt` is bumped by `retry()` to force a re-run
  useEffect(() => {
    if (!migrationReady) {
      return;
    }
    if (inFlight.current) {
      return;
    }

    inFlight.current = true;
    let cancelled = false;

    async function execute() {
      try {
        setStatus("loading");
        setError(undefined);

        const initial = await readDefaultModelStatus();
        if (cancelled) return;

        const modelToHeal: string | undefined =
          initial.modelMissing &&
          initial.providerId === DEFAULT_PROVIDER_ID &&
          DEFAULT_MODEL_ID !== undefined
            ? DEFAULT_MODEL_ID
            : undefined;

        if (modelToHeal === undefined) {
          setStatus("ok");
          return;
        }

        const client = await getClient();
        await client.goose.GooseUnstableDefaultsSave({
          providerId: DEFAULT_PROVIDER_ID,
          modelId: modelToHeal,
        });
        if (cancelled) return;

        setStoredModelPreference("goose", {
          providerId: DEFAULT_PROVIDER_ID,
          modelId: modelToHeal,
          modelName: DEFAULT_MODEL_NAME,
        });

        setStatus("ok");
      } catch (err) {
        if (cancelled) return;
        setError(err instanceof Error ? err : new Error(String(err)));
        setStatus("error");
      } finally {
        inFlight.current = false;
      }
    }

    void execute();

    return () => {
      cancelled = true;
    };
  }, [migrationReady, attempt]);

  const retry = useCallback(() => {
    setAttempt((value) => value + 1);
  }, []);

  return { status, error, retry };
}

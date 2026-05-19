import { useCallback, useEffect, useRef, useState } from "react";
import { getMigrationStatus, markMigrationComplete } from "../api/migration";
import { runMigration } from "../runMigration";
import { useMigrationStore } from "../stores/migrationStore";
import type { MigrationGateStatus } from "../types";

interface MigrationGate {
  status: MigrationGateStatus;
  error?: Error;
  retry: () => void;
}

/**
 * Drives the silent first-boot migration. Reads the Tauri-side marker on
 * mount; if it's not done and the backend is `startupReady`, runs the full
 * orchestrator and persists the marker. Persists nothing to `localStorage` —
 * the marker is the single source of truth.
 *
 * If anything in the sequence throws, the marker is never written, so the next
 * boot starts fresh. The caller renders an inline retry UI for the
 * `"error"` state.
 */
export function useMigrationGate(startupReady: boolean): MigrationGate {
  const setStoreStatus = useMigrationStore((state) => state.setStatus);
  const [status, setStatus] = useState<MigrationGateStatus>("loading");
  const [error, setError] = useState<Error | undefined>(undefined);
  // Bumping this value forces the effect to re-run on `retry()`.
  const [attempt, setAttempt] = useState(0);
  // Guards against double-invocation under React 18 strict mode.
  const inFlight = useRef(false);

  // biome-ignore lint/correctness/useExhaustiveDependencies: `attempt` is bumped by `retry()` to force a re-run
  useEffect(() => {
    if (!startupReady) {
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

        const initial = await getMigrationStatus();
        if (cancelled) return;
        setStoreStatus(initial);

        if (initial.done) {
          setStatus("ready");
          return;
        }

        setStatus("running");
        const result = await runMigration();
        if (cancelled) return;

        const persisted = await markMigrationComplete({
          disabledExtensions: result.disabledExtensions,
          backupPath: result.backupPath,
        });
        if (cancelled) return;

        setStoreStatus(persisted);
        setStatus("ready");
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
  }, [startupReady, attempt, setStoreStatus]);

  const retry = useCallback(() => {
    setAttempt((value) => value + 1);
  }, []);

  return { status, error, retry };
}

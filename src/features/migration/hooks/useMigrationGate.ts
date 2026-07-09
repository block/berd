import { useCallback, useEffect, useRef, useState } from "react";
import { reconcileAlwaysOnExtensions } from "@/features/extensions/lib/reconcileAlwaysOn";
import { cleanupLegacyBundledExtensions } from "../cleanupLegacyBundledExtensions";
import {
  getMigrationStatus,
  markLegacyExtensionCleanupComplete,
  markMigrationComplete,
} from "../api/migration";
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
 * boot starts fresh. Startup callers may continue in offline-first mode after
 * the `"error"` state.
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
          let latestStatus = initial;
          if (!initial.legacyExtensionCleanupDone) {
            try {
              const cleanup = await cleanupLegacyBundledExtensions({
                excludeConfigKeys: initial.disabledExtensions.map(
                  (extension) => extension.configKey,
                ),
              });
              latestStatus = await markLegacyExtensionCleanupComplete({
                removedExtensions: cleanup.removedExtensions,
                backupPath: cleanup.backupPath,
              });
              if (cancelled) return;
              setStoreStatus(latestStatus);
            } catch (cleanupError) {
              // Best-effort: leave the marker unset so the next boot can retry,
              // but don't block startup on legacy config hygiene.
              console.warn(
                "Failed to clean up legacy bundled extensions:",
                cleanupError,
              );
            }
          }

          // Heal extensions whose desired state has changed since the user's
          // migration ran (e.g. a newly-added always-on entry). Best-effort —
          // failures don't block startup.
          try {
            await reconcileAlwaysOnExtensions();
          } catch (reconcileError) {
            console.warn(
              "Failed to reconcile always-on extensions:",
              reconcileError,
            );
          }
          if (cancelled) return;
          setStoreStatus(latestStatus);
          setStatus("ready");
          return;
        }

        setStatus("running");
        const result = await runMigration();
        if (cancelled) return;

        let persisted = await markMigrationComplete({
          disabledExtensions: result.disabledExtensions,
          backupPath: result.backupPath,
        });
        if (cancelled) return;

        try {
          const cleanup = await cleanupLegacyBundledExtensions({
            excludeConfigKeys: result.disabledExtensions.map(
              (extension) => extension.configKey,
            ),
          });
          persisted = await markLegacyExtensionCleanupComplete({
            removedExtensions: cleanup.removedExtensions,
            backupPath: cleanup.backupPath,
          });
        } catch (cleanupError) {
          // Best-effort: leave the marker unset so the next boot can retry,
          // but don't block the rest of startup on legacy config hygiene.
          console.warn(
            "Failed to clean up legacy bundled extensions after migration:",
            cleanupError,
          );
        }
        if (cancelled) return;

        try {
          await reconcileAlwaysOnExtensions();
        } catch (reconcileError) {
          console.warn(
            "Failed to reconcile always-on extensions after migration:",
            reconcileError,
          );
        }
        if (cancelled) return;

        setStoreStatus(persisted);
        setStatus("ready");
      } catch (err) {
        if (cancelled) return;
        console.error("Failed to run startup migration:", err);
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

import { useEffect } from "react";

import { WORK_STATUS_EXPERIMENT_ID } from "@/features/experiments/experimentDefinitions";
import { useExperiment } from "@/features/experiments/experimentPreferences";
import { buildWorkStatusSnapshot } from "./workStatusData";
import { WORK_STATUS_REFRESH_EVENT } from "./workStatusNative";
import { useWorkStatusStore } from "./workStatusStore";

const REFRESH_INTERVAL_MS = 30_000;
const RATE_LIMIT_BACKOFF_MS = 5 * 60_000;

export function WorkStatusBridge() {
  const enabled = useExperiment(WORK_STATUS_EXPERIMENT_ID)?.enabled === true;
  const publishSnapshot = useWorkStatusStore((state) => state.publishSnapshot);
  const resetSnapshot = useWorkStatusStore((state) => state.resetSnapshot);
  const setManualRefreshOutcome = useWorkStatusStore(
    (state) => state.setManualRefreshOutcome,
  );
  const setManualRefreshPending = useWorkStatusStore(
    (state) => state.setManualRefreshPending,
  );

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    let refreshInFlight = false;
    let manualRefreshQueued = false;
    let automaticRefreshBlockedUntil = 0;

    async function refresh({ manual = false } = {}) {
      if (!manual && Date.now() < automaticRefreshBlockedUntil) return;
      if (refreshInFlight) {
        if (manual) manualRefreshQueued = true;
        return;
      }

      refreshInFlight = true;
      let servicedManualRefresh = manual;
      let manualRefreshSucceeded = false;
      try {
        do {
          manualRefreshQueued = false;
          try {
            const snapshot = await buildWorkStatusSnapshot(
              useWorkStatusStore.getState().snapshot,
            );
            if (!cancelled) publishSnapshot(snapshot);
            automaticRefreshBlockedUntil = snapshot.errors.some(
              (error) => error.code === "rateLimited",
            )
              ? Date.now() + RATE_LIMIT_BACKOFF_MS
              : 0;
            if (servicedManualRefresh) {
              manualRefreshSucceeded = snapshot.isFresh;
            }
          } catch (error) {
            manualRefreshSucceeded = false;
            console.error("Failed to refresh PR tracker:", error);
          }
          if (manualRefreshQueued) servicedManualRefresh = true;
        } while (!cancelled && manualRefreshQueued);
      } finally {
        refreshInFlight = false;
        manualRefreshQueued = false;
        if (!cancelled && servicedManualRefresh) {
          setManualRefreshOutcome(manualRefreshSucceeded);
          setManualRefreshPending(false);
        }
      }
    }

    const handleRefreshRequest = () => {
      setManualRefreshOutcome(null);
      void refresh({ manual: true });
    };
    void refresh();
    window.addEventListener(WORK_STATUS_REFRESH_EVENT, handleRefreshRequest);
    const id = window.setInterval(refresh, REFRESH_INTERVAL_MS);
    return () => {
      cancelled = true;
      manualRefreshQueued = false;
      resetSnapshot();
      window.removeEventListener(
        WORK_STATUS_REFRESH_EVENT,
        handleRefreshRequest,
      );
      window.clearInterval(id);
    };
  }, [
    enabled,
    publishSnapshot,
    resetSnapshot,
    setManualRefreshOutcome,
    setManualRefreshPending,
  ]);

  return null;
}

import { useEffect, useRef, useState } from "react";

import { buildWorkStatusSnapshot } from "./workStatusData";
import { WORK_STATUS_REFRESH_EVENT } from "./workStatusNative";
import { useWorkStatusStore } from "./workStatusStore";

const REFRESH_INTERVAL_MS = 30_000;
const RATE_LIMIT_BACKOFF_MS = 5 * 60_000;

interface WorkStatusBridgeProps {
  active: boolean;
}

export function WorkStatusBridge({ active }: WorkStatusBridgeProps) {
  const [documentVisible, setDocumentVisible] = useState(
    () => document.visibilityState !== "hidden",
  );
  const publishSnapshot = useWorkStatusStore((state) => state.publishSnapshot);
  const setManualRefreshOutcome = useWorkStatusStore(
    (state) => state.setManualRefreshOutcome,
  );
  const setManualRefreshPending = useWorkStatusStore(
    (state) => state.setManualRefreshPending,
  );
  const eligibleRef = useRef(false);
  const generationRef = useRef(0);
  const refreshInFlightRef = useRef(false);
  const refreshQueuedRef = useRef(false);
  const manualRefreshQueuedRef = useRef(false);
  const refreshRef = useRef<(options?: { manual?: boolean }) => void>(() => {});
  const automaticRefreshBlockedUntilRef = useRef(0);

  useEffect(() => {
    const handleVisibilityChange = () => {
      setDocumentVisible(document.visibilityState !== "hidden");
    };
    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => {
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, []);

  const eligible = active && documentVisible;
  eligibleRef.current = eligible;

  useEffect(() => {
    generationRef.current += 1;
    const generation = generationRef.current;
    let refreshTimer: number | null = null;
    let cancelled = false;

    const clearRefreshTimer = () => {
      if (refreshTimer !== null) {
        window.clearTimeout(refreshTimer);
        refreshTimer = null;
      }
    };

    if (!eligible) {
      refreshQueuedRef.current = false;
      manualRefreshQueuedRef.current = false;
      setManualRefreshPending(false);
      return clearRefreshTimer;
    }

    const scheduleRefresh = () => {
      clearRefreshTimer();
      if (cancelled || !eligibleRef.current) return;
      refreshTimer = window.setTimeout(() => {
        refreshTimer = null;
        refreshRef.current();
      }, REFRESH_INTERVAL_MS);
    };

    const refresh = async ({ manual = false } = {}) => {
      if (
        cancelled ||
        generationRef.current !== generation ||
        !eligibleRef.current
      ) {
        return;
      }
      if (!manual && Date.now() < automaticRefreshBlockedUntilRef.current) {
        scheduleRefresh();
        return;
      }
      if (refreshInFlightRef.current) {
        refreshQueuedRef.current = true;
        if (manual) manualRefreshQueuedRef.current = true;
        return;
      }

      refreshInFlightRef.current = true;
      let manualRefreshSucceeded = false;
      try {
        const snapshot = await buildWorkStatusSnapshot(
          useWorkStatusStore.getState().snapshot,
        );
        automaticRefreshBlockedUntilRef.current = snapshot.errors.some(
          (error) => error.code === "rateLimited",
        )
          ? Date.now() + RATE_LIMIT_BACKOFF_MS
          : 0;
        if (
          !cancelled &&
          generationRef.current === generation &&
          eligibleRef.current
        ) {
          publishSnapshot(snapshot);
          manualRefreshSucceeded = snapshot.isFresh;
        }
      } catch (error) {
        console.error("Failed to refresh PR Inbox:", error);
      } finally {
        refreshInFlightRef.current = false;
        if (manual && generationRef.current === generation) {
          setManualRefreshOutcome(manualRefreshSucceeded);
          setManualRefreshPending(false);
        }
        if (refreshQueuedRef.current && eligibleRef.current) {
          const queuedManualRefresh = manualRefreshQueuedRef.current;
          refreshQueuedRef.current = false;
          manualRefreshQueuedRef.current = false;
          refreshRef.current({ manual: queuedManualRefresh });
        } else if (generationRef.current === generation) {
          scheduleRefresh();
        }
      }
    };

    refreshRef.current = (options) => {
      void refresh(options);
    };
    const handleRefreshRequest = () => {
      if (!eligibleRef.current) return;
      setManualRefreshOutcome(null);
      refreshRef.current({ manual: true });
    };

    refreshRef.current();
    window.addEventListener(WORK_STATUS_REFRESH_EVENT, handleRefreshRequest);
    return () => {
      cancelled = true;
      clearRefreshTimer();
      window.removeEventListener(
        WORK_STATUS_REFRESH_EVENT,
        handleRefreshRequest,
      );
    };
  }, [
    eligible,
    publishSnapshot,
    setManualRefreshOutcome,
    setManualRefreshPending,
  ]);

  return null;
}

import { isMemorySupported } from "@/features/me/lib/memoryAvailability";
import { useCallback, useEffect, useState } from "react";

import { listProposals } from "../lib/meProposals";

/**
 * Count of pending proposals for the Memory nav badge. The badge is a real
 * review queue: pending suggestions are stored locally but are not recallable.
 *
 * Polling is deliberately lazy (a tiny local file); a focus listener
 * catches the common "came back to the app" moment.
 */
const POLL_INTERVAL_MS = 30_000;

export function useMemoryProposalsPending(): number {
  const [count, setCount] = useState(0);

  const refresh = useCallback(async () => {
    if (!isMemorySupported()) return;
    try {
      setCount((await listProposals()).length);
    } catch {
      // Badge is best-effort; a read failure just means no badge.
      setCount(0);
    }
  }, []);

  useEffect(() => {
    if (!isMemorySupported()) return;
    void refresh();
    const interval = setInterval(() => void refresh(), POLL_INTERVAL_MS);
    const onFocus = () => void refresh();
    window.addEventListener("focus", onFocus);
    return () => {
      clearInterval(interval);
      window.removeEventListener("focus", onFocus);
    };
  }, [refresh]);

  return count;
}

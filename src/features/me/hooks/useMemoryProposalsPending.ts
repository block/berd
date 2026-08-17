import { useCallback, useEffect, useState } from "react";

import { listAddedEntries } from "../lib/meMemoryWrites";

/**
 * Count of recently added memories, for the Memory nav badge.
 *
 * Memory is written automatically, so the badge isn't a to-do list — it's
 * how the user finds out something landed while they were elsewhere. The
 * count clears as they acknowledge or delete entries, and unreviewed ones
 * age out on their own so this can't become a permanent chore.
 *
 * Polling is deliberately lazy (a tiny local file); a focus listener
 * catches the common "came back to the app" moment.
 */
const POLL_INTERVAL_MS = 30_000;

export function useMemoryProposalsPending(): number {
  const [count, setCount] = useState(0);

  const refresh = useCallback(async () => {
    try {
      setCount((await listAddedEntries()).length);
    } catch {
      // Badge is best-effort; a read failure just means no badge.
      setCount(0);
    }
  }, []);

  useEffect(() => {
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

import { useCallback, useEffect, useState } from "react";
import { listProposals } from "../lib/meProposals";

/**
 * Pending memory-proposal count for the settings nav badge.
 *
 * Proposals arrive when the user isn't looking — the noticer queues them
 * after a conversation goes idle — so the Memory row needs a quiet
 * indicator or the consent queue is functionally invisible. Polling is
 * deliberately lazy (the queue is a tiny local file); a focus listener
 * catches the common "came back to the app" moment.
 */
const POLL_INTERVAL_MS = 30_000;

export function useMemoryProposalsPending(): number {
  const [count, setCount] = useState(0);

  const refresh = useCallback(async () => {
    try {
      const proposals = await listProposals();
      setCount(proposals.length);
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

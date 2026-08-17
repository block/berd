import { useCallback, useEffect, useState } from "react";
import {
  listProposals,
  type MemoryProposal,
} from "@/features/me/lib/meProposals";

/**
 * Pending noticer proposals for one chat session.
 *
 * The noticer runs seconds after a conversation goes quiet, which is
 * usually while the person is still sitting in that chat — so proposals
 * it produced there belong in that transcript, not only in Settings. The
 * queue on disk is the source of truth; this polls it lightly and filters
 * to the session that produced the facts.
 *
 * Server (`propose_memory`) proposals are excluded: those already render
 * their own card at the tool call, and showing them twice in one
 * transcript would read as duplicate asks.
 */
const POLL_INTERVAL_MS = 5_000;

export function useSessionMemoryProposals(
  sessionId: string | undefined,
): MemoryProposal[] {
  const [proposals, setProposals] = useState<MemoryProposal[]>([]);

  const refresh = useCallback(async () => {
    if (!sessionId) {
      setProposals([]);
      return;
    }
    try {
      const pending = await listProposals();
      setProposals(
        pending.filter(
          (proposal) =>
            proposal.sessionId === sessionId && proposal.agent === "noticer",
        ),
      );
    } catch {
      setProposals([]);
    }
  }, [sessionId]);

  useEffect(() => {
    void refresh();
    const interval = setInterval(() => void refresh(), POLL_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [refresh]);

  return proposals;
}

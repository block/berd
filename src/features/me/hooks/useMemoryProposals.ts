import { useCallback, useEffect, useState } from "react";
import { listProposals, type MemoryProposal } from "../lib/meProposals";
import {
  approveMemoryProposal,
  declineMemoryProposal,
} from "../lib/memoryProposalReview";

const POLL_INTERVAL_MS = 5_000;

export function useMemoryProposals(
  sessionId?: string,
  options?: { sessionlessOnly?: boolean },
) {
  const [proposals, setProposals] = useState<MemoryProposal[]>([]);

  const refresh = useCallback(async () => {
    const all = await listProposals();
    setProposals(
      sessionId
        ? all.filter((proposal) => proposal.sessionId === sessionId)
        : options?.sessionlessOnly
          ? all.filter((proposal) => proposal.sessionId === null)
          : all,
    );
  }, [sessionId, options?.sessionlessOnly]);

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

  const approve = useCallback(
    async (
      proposal: MemoryProposal,
      content?: string,
      topic?: string | null,
    ) => {
      await approveMemoryProposal(proposal, content, topic);
      await refresh();
    },
    [refresh],
  );
  const decline = useCallback(
    async (proposal: MemoryProposal) => {
      await declineMemoryProposal(proposal);
      await refresh();
    },
    [refresh],
  );

  return { proposals, approve, decline, refresh };
}

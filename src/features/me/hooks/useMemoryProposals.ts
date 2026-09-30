import { isMemorySupported } from "@/features/me/lib/memoryAvailability";
import { useCallback, useEffect, useState } from "react";
import {
  memoryStoreErrorKind,
  type MemoryStoreErrorKind,
} from "../lib/memoryStoreError";
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
  const [error, setError] = useState<MemoryStoreErrorKind | null>(null);
  const [proposals, setProposals] = useState<MemoryProposal[]>([]);

  const refresh = useCallback(async () => {
    if (!isMemorySupported()) return;
    try {
      const all = await listProposals();
      setError(null);
      setProposals(
        sessionId
          ? all.filter((proposal) => proposal.sessionId === sessionId)
          : options?.sessionlessOnly
            ? all.filter((proposal) => proposal.sessionId === null)
            : all,
      );
    } catch (error) {
      setError(memoryStoreErrorKind(error));
    }
  }, [sessionId, options?.sessionlessOnly]);

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

  const approve = useCallback(
    async (
      proposal: MemoryProposal,
      content?: string,
      topic?: string | null,
    ) => {
      if (!isMemorySupported()) return;
      await approveMemoryProposal(proposal, content, topic);
      await refresh();
    },
    [refresh],
  );
  const decline = useCallback(
    async (proposal: MemoryProposal) => {
      if (!isMemorySupported()) return;
      await declineMemoryProposal(proposal);
      await refresh();
    },
    [refresh],
  );

  return { proposals, approve, decline, refresh, error };
}

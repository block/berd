import { useSessionMemoryProposals } from "@/features/me/hooks/useSessionMemoryProposals";
import { MemoryProposalCard } from "./MemoryProposalCard";

/**
 * Noticer proposals for the current chat, surfaced above the composer.
 *
 * The noticer runs a few seconds after a conversation goes quiet — the
 * person is usually still sitting right there — so a fact it caught
 * belongs in that conversation, not only in Settings. This is the
 * deterministic half of proposing: no model has to decide to offer
 * anything, the extraction pass notices and Berd asks.
 *
 * Resolving a card here clears it from Settings → Memory too; both
 * surfaces read the same queue.
 */
export function MemoryProposalPanel({
  sessionId,
}: {
  sessionId: string | undefined;
}) {
  const proposals = useSessionMemoryProposals(sessionId);
  if (proposals.length === 0) return null;

  return (
    <div
      data-role="memory-proposal-panel"
      className="mb-2 flex flex-col gap-1.5"
    >
      {proposals.map((proposal) => (
        <MemoryProposalCard
          key={proposal.id}
          arguments={{
            content: proposal.content,
            ...(proposal.topic ? { topic: proposal.topic } : {}),
          }}
        />
      ))}
    </div>
  );
}

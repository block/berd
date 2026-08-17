import { useAddedMemories } from "@/features/me/hooks/useAddedMemories";

import { AddedMemoryCard } from "./AddedMemoryCard";

/**
 * Memories added from this chat, surfaced above the composer.
 *
 * The noticer runs a few seconds after a conversation goes quiet — the
 * person is usually still sitting right there — so a fact caught from
 * this conversation gets disclosed in it. Nothing here is an ask: the
 * entry is already in the file, and the card is how the user finds out
 * and can undo it.
 *
 * Resolving a card here (OK or Delete) clears it from Settings → Memory
 * too; both surfaces read the same `recent.jsonl`.
 */
export function MemoryProposalPanel({
  sessionId,
}: {
  sessionId: string | undefined;
}) {
  const { entries, acknowledge, remove } = useAddedMemories(sessionId);
  if (!sessionId || entries.length === 0) return null;

  return (
    <div data-role="added-memory-panel" className="mb-2 flex flex-col gap-1.5">
      {entries.map((entry) => (
        <AddedMemoryCard
          key={entry.id}
          entry={entry}
          onAcknowledge={(item) => void acknowledge(item)}
          onDelete={(item) => void remove(item)}
        />
      ))}
    </div>
  );
}

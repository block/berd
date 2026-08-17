import { useCallback, useEffect, useState } from "react";

import { useAddedMemories } from "@/features/me/hooks/useAddedMemories";
import { drainMemoryQueue } from "@/features/me/lib/memoryAutoApply";
import type { AddedMemoryEntry } from "@/features/me/lib/meMemoryWrites";

import { AddedMemoryCard } from "./AddedMemoryCard";

/**
 * The card rendered at a `propose_memory` tool call.
 *
 * The server still can't write memory itself — it queues the candidate,
 * and Berd applies it. So by the time this renders, the entry is either
 * already in a memory file or it was resolved somewhere else; the card is
 * disclosure plus an undo, not an ask.
 *
 * Matching is by content+topic because tool-call arguments don't carry the
 * server-generated id. Safe: the server dedupes identical candidates, so
 * this resolves to at most one record, and OK/Delete then operate on that
 * record's id.
 */

/** Goose namespaces extension tools as `extension__tool`. */
export function isMemoryProposalTool(name: string): boolean {
  const trimmed = name.trim().toLowerCase();
  return trimmed === "propose_memory" || trimmed.endsWith("__propose_memory");
}

interface MemoryProposalCardProps {
  /** Tool-call arguments as sent by the agent. */
  arguments: Record<string, unknown>;
}

export function MemoryProposalCard({
  arguments: args,
}: MemoryProposalCardProps) {
  const content = typeof args.content === "string" ? args.content.trim() : "";
  const topic =
    typeof args.topic === "string" && args.topic.trim()
      ? args.topic.trim()
      : null;
  const { entries, acknowledge, remove } = useAddedMemories();
  const [drained, setDrained] = useState(false);

  // Apply the queue on mount so a just-proposed candidate lands in memory
  // (and gets its entry) without waiting for a poll tick.
  useEffect(() => {
    let cancelled = false;
    void drainMemoryQueue()
      .catch(() => [])
      .finally(() => {
        if (!cancelled) setDrained(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const matches = useCallback(
    (entry: AddedMemoryEntry) => {
      if (entry.content !== content) return false;
      if (!topic) return true;
      // The stored topic is the doc's display label, which can differ in
      // case from the agent's hint, and an out-of-vocabulary hint lands in
      // the spine (topic null) — so match loosely on the label only.
      return (
        entry.topic === null ||
        entry.topic.toLowerCase() === topic.toLowerCase()
      );
    },
    [content, topic],
  );

  const entry = content ? entries.find(matches) : undefined;

  // Nothing to show once it's acknowledged, deleted, or resolved from
  // another surface. Staying silent beats a stale "already reviewed" note.
  if (!entry) {
    if (!drained) return null;
    return null;
  }

  return (
    <AddedMemoryCard
      entry={entry}
      onAcknowledge={(item) => void acknowledge(item)}
      onDelete={(item) => void remove(item)}
    />
  );
}

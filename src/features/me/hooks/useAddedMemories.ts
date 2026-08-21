import { useCallback, useEffect, useState } from "react";

import {
  clearAddedEntry,
  deleteAddedEntry,
  listAddedEntries,
  type AddedMemoryEntry,
} from "../lib/meMemoryWrites";
import { drainMemoryQueue } from "../lib/memoryAutoApply";

/**
 * Recently added memories, and the two ways to resolve one.
 *
 * `recent.jsonl` on disk is the single source of truth for both surfaces
 * (the chat panel and Settings → Memory), so acknowledging or deleting an
 * entry anywhere removes it everywhere — the user shouldn't have to
 * dismiss the same fact twice.
 *
 * Mounting drains the candidate queue first, so opening either surface
 * applies anything the noticer left behind while the app was closed.
 */
const POLL_INTERVAL_MS = 5_000;

export interface AddedMemoriesState {
  entries: AddedMemoryEntry[];
  /** Acknowledge: the entry stays in memory, the card goes away. */
  acknowledge: (entry: AddedMemoryEntry) => Promise<void>;
  /** Delete: remove it from the memory file and never re-add it. */
  remove: (entry: AddedMemoryEntry) => Promise<void>;
  refresh: () => Promise<void>;
}

export function useAddedMemories(sessionId?: string): AddedMemoriesState {
  const [entries, setEntries] = useState<AddedMemoryEntry[]>([]);

  const refresh = useCallback(async () => {
    try {
      const all = await listAddedEntries();
      setEntries(
        sessionId
          ? all.filter(
              // Entries the MCP server queued have no session: it runs as a
              // separate process and the protocol carries no session identity,
              // so it can't know which chat it's serving. Claim those for the
              // open chat rather than leaving them undisclosed — an agent that
              // deliberately saved something is the case that most deserves a
              // toast. With several chats open the entry can surface in the
              // wrong one; the entry itself is still right, and Settings →
              // Memory stays the full list either way.
              (entry) =>
                entry.sessionId === sessionId || entry.sessionId === null,
            )
          : all,
      );
    } catch {
      setEntries([]);
    }
  }, [sessionId]);

  useEffect(() => {
    let cancelled = false;
    const tick = async () => {
      await drainMemoryQueue().catch(() => []);
      if (!cancelled) await refresh();
    };
    void tick();
    const interval = setInterval(() => void tick(), POLL_INTERVAL_MS);
    const onFocus = () => void tick();
    window.addEventListener("focus", onFocus);
    return () => {
      cancelled = true;
      clearInterval(interval);
      window.removeEventListener("focus", onFocus);
    };
  }, [refresh]);

  const acknowledge = useCallback(
    async (entry: AddedMemoryEntry) => {
      // Drop it locally first so the card doesn't linger for a poll cycle.
      setEntries((current) => current.filter((item) => item.id !== entry.id));
      await clearAddedEntry(entry.id).catch(() => {});
      await refresh();
    },
    [refresh],
  );

  const remove = useCallback(
    async (entry: AddedMemoryEntry) => {
      setEntries((current) => current.filter((item) => item.id !== entry.id));
      await deleteAddedEntry(entry).catch(() => {});
      await refresh();
    },
    [refresh],
  );

  return { entries, acknowledge, remove, refresh };
}

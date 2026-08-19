import { logRendererEvent } from "@/shared/api/rendererTelemetry";
import { migrateProposalsDir } from "./proposalsMigration";
import { applyMemoryEntry, type AddedMemoryEntry } from "./meMemoryWrites";
import { isMemoryEnabled } from "./memoryPrefs";
import { listProposals, removeFromQueue } from "./meProposals";

/**
 * Drain the candidate queue into memory.
 *
 * Both proposal doors — the MCP server's `propose_memory` and the
 * noticer's extraction pass — still write to `pending.jsonl`. Keeping
 * that transport means one write implementation instead of two (one in
 * Rust, one in TS) that could drift on topic routing or attribution.
 * What changed is what happens next: candidates are applied immediately
 * rather than waiting for a click, and the user sees them as *recently
 * added* entries they can delete.
 *
 * Serialized on purpose: the drain runs from a few places (chat idle,
 * Settings mount, focus) and applying the same candidate twice would
 * duplicate a bullet.
 */

let inFlight: Promise<AddedMemoryEntry[]> | null = null;

export async function drainMemoryQueue(): Promise<AddedMemoryEntry[]> {
  // Carry any queues from the old hidden dotfolder first, so a person
  // upgrading doesn't lose their tombstones and see deleted memories return.
  await migrateProposalsDir();
  if (inFlight) return inFlight;
  inFlight = run().finally(() => {
    inFlight = null;
  });
  return inFlight;
}

async function run(): Promise<AddedMemoryEntry[]> {
  // The toggle is checked here as well as at the doors: a candidate could
  // have been queued moments before memory was switched off, and off has
  // to mean nothing new lands in the files.
  if (!isMemoryEnabled()) return [];

  let candidates: Awaited<ReturnType<typeof listProposals>>;
  try {
    candidates = await listProposals();
  } catch {
    return [];
  }
  if (candidates.length === 0) return [];

  const added: AddedMemoryEntry[] = [];
  for (const candidate of candidates) {
    try {
      const entry = await applyMemoryEntry(candidate);
      // Clear the candidate either way: a null result means there was
      // nowhere to put it, and leaving it queued would retry forever.
      await removeFromQueue(candidate);
      if (entry) added.push(entry);
    } catch (error) {
      console.warn("[me] couldn't apply memory candidate", error);
    }
  }

  if (added.length > 0) {
    void logRendererEvent(
      "info",
      `[me:memory] added ${added.length} entr${added.length === 1 ? "y" : "ies"} automatically`,
    );
  }
  return added;
}

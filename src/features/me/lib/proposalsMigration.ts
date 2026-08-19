import {
  createTextFile,
  getHomeDir,
  pathExists,
  readTextFile,
  writeTextFile,
} from "@/shared/api/system";

/**
 * Moves the proposal queues out of the old hidden `~/.me/.proposals/` and into
 * the protocol's visible `~/.me/proposals/`.
 *
 * The protocol requires proposals to be inspectable in the store rather than
 * held in host-private state, so another host — or the person with a text
 * editor — can see and decide them. A dotfolder reads as Berd's business.
 *
 * The tombstone file is the reason this migration exists rather than just
 * letting old files rot: dropping `dismissed.jsonl` would let previously
 * deleted memories be re-added, which is the one regression the delete
 * guarantee cannot afford. Content is appended rather than overwritten so a
 * migration that runs twice can't lose entries written since the first pass.
 */

const FILES = ["pending.jsonl", "dismissed.jsonl", "recent.jsonl"] as const;

let done = false;

export async function migrateProposalsDir(): Promise<void> {
  if (done) return;
  done = true;
  try {
    const homeDir = await getHomeDir();
    const oldDir = `${homeDir}/.me/.proposals`;
    if (!(await pathExists(oldDir))) return;

    for (const name of FILES) {
      const from = `${oldDir}/${name}`;
      const to = `${homeDir}/.me/proposals/${name}`;
      try {
        if (!(await pathExists(from))) continue;
        const carried = (await readTextFile(from)).contents;
        if (!carried.trim()) continue;
        if (await pathExists(to)) {
          const existing = (await readTextFile(to)).contents;
          if (existing.includes(carried.trim())) continue;
          const joined = existing.endsWith("\n")
            ? `${existing}${carried}`
            : `${existing}\n${carried}`;
          await writeTextFile(to, joined);
        } else {
          await createTextFile(to, carried);
        }
        // Leave the old file in place. It's inert once the new location has
        // the content, and removing it is the kind of cleanup that turns a
        // best-effort migration into a way to lose data.
      } catch (error) {
        console.warn(`[me:migrate] could not carry ${name}`, error);
      }
    }
  } catch (error) {
    console.warn("[me:migrate] proposals migration skipped", error);
  }
}

import {
  getHomeDir,
  pathExists,
  readTextFile,
  recordMeHistory,
  writeTextFile,
} from "@/shared/api/system";
import { createMeFile, loadMeFile } from "./meFile";
import { vocabularyTopicName } from "./memoryTopicVocabulary";
import { publishMeFile } from "./mePublish";
import { logRendererEvent } from "@/shared/api/rendererTelemetry";
import { createTopic, listTopics } from "./meTopics";
import { looksLikeCredential } from "./memoryCredentialGuard";
import {
  appendBullet,
  insertIntoSection,
  removeBullet,
  type MemoryProposal,
} from "./meProposals";

/**
 * Applying memory, and undoing it.
 *
 * Memory is added automatically: a queued candidate is written into the
 * right file as soon as Berd sees it, then shown to the user as a
 * *recently added* entry they can delete in one click. The earlier design
 * gated every write behind an approval, which produced an empty file —
 * a file nobody fills in protects nobody.
 *
 * That trade puts the weight on two things:
 *
 * - **Undo has to be real.** `deleteAddedEntry` removes the exact bullet
 *   from the exact file and records the removal in the history, so the
 *   trail shows both the add and the undo.
 * - **Deleting means never again.** A deletion writes a tombstone, which
 *   `propose_memory` and the noticer both check, so an auto-add can't
 *   resurrect something the user just removed. Re-adding silently would
 *   be worse than the old friction.
 *
 * One record, one resolution: entries live in `recent.jsonl` until the
 * user acknowledges or deletes them *anywhere*. Acting in chat clears the
 * Settings card and vice versa — the same rule the proposal queue had.
 */

/** An entry that was written into memory and is still awaiting a look. */
export interface AddedMemoryEntry {
  /** Carried from the queued candidate, so tombstones line up. */
  id: string;
  /** Seconds since epoch when the entry was written. */
  ts: number;
  content: string;
  /** Display label of the topic it landed in; null = the spine. */
  topic: string | null;
  /** Absolute path of the file it was written into. */
  path: string;
  /** Agent that surfaced it, when known. */
  agent: string | null;
  /** Session it came from, when known — lets the chat show it in place. */
  sessionId: string | null;
}

function recentPath(homeDir: string): string {
  return `${homeDir}/.me/proposals/recent.jsonl`;
}

/**
 * How long an unacknowledged entry keeps showing. Recently-added is a
 * safety net, not a chore: entries the user never looked at age out on
 * their own rather than piling into a queue that demands attention.
 */
const RECENT_TTL_SECONDS = 7 * 24 * 60 * 60;

/** Most recent entries first, aged-out ones dropped. */
export async function listAddedEntries(): Promise<AddedMemoryEntry[]> {
  try {
    const homeDir = await getHomeDir();
    const path = recentPath(homeDir);
    if (!(await pathExists(path))) return [];
    const payload = await readTextFile(path);
    const cutoff = Math.floor(Date.now() / 1000) - RECENT_TTL_SECONDS;
    return payload.contents
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .map(parseRecent)
      .filter((entry): entry is AddedMemoryEntry => entry !== null)
      .filter((entry) => entry.ts >= cutoff)
      .sort((a, b) => b.ts - a.ts);
  } catch {
    return [];
  }
}

function parseRecent(line: string): AddedMemoryEntry | null {
  try {
    const raw = JSON.parse(line) as Record<string, unknown>;
    const content = typeof raw.content === "string" ? raw.content.trim() : "";
    const path = typeof raw.path === "string" ? raw.path : "";
    if (!content || !path) return null;
    const ts = typeof raw.ts === "number" ? raw.ts : 0;
    return {
      id: typeof raw.id === "string" && raw.id ? raw.id : `${ts}:${content}`,
      ts,
      content,
      topic: typeof raw.topic === "string" && raw.topic ? raw.topic : null,
      path,
      agent: typeof raw.agent === "string" && raw.agent ? raw.agent : null,
      sessionId:
        typeof raw.sessionId === "string" && raw.sessionId
          ? raw.sessionId
          : null,
    };
  } catch {
    return null;
  }
}

async function appendRecent(entry: AddedMemoryEntry): Promise<void> {
  try {
    const homeDir = await getHomeDir();
    const path = recentPath(homeDir);
    const existing = (await pathExists(path))
      ? (await readTextFile(path)).contents
      : "";
    const line = JSON.stringify(entry);
    const next =
      existing.endsWith("\n") || !existing ? existing : `${existing}\n`;
    await writeTextFile(path, `${next}${line}\n`);
  } catch (error) {
    // Best-effort: the entry is already in memory, and losing its card is
    // better than failing the write that put it there.
    console.warn("[me] couldn't record recently-added entry", error);
  }
}

/** Drop an entry from the recent list, by id. */
export async function clearAddedEntry(id: string): Promise<void> {
  try {
    const homeDir = await getHomeDir();
    const path = recentPath(homeDir);
    if (!(await pathExists(path))) return;
    const payload = await readTextFile(path);
    const kept = payload.contents
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .filter((line) => parseRecent(line)?.id !== id);
    await writeTextFile(path, kept.length ? `${kept.join("\n")}\n` : "");
  } catch (error) {
    console.warn("[me] couldn't clear recently-added entry", error);
  }
}

/**
 * Write a candidate into memory: find or create its topic (spine when it
 * has none, or when the topic name is outside the allowed areas), append
 * the bullet, record attribution, and log it as recently added.
 *
 * Returns the entry, or null when nothing was written.
 */
export async function applyMemoryEntry(
  candidate: MemoryProposal,
): Promise<AddedMemoryEntry | null> {
  // Refuse credentials before anything is written. Undo can't cover this
  // case: a saved secret is also published to the agent files other tools
  // read and committed to the store's history, so deleting the entry leaves
  // copies behind. Prompts ask models not to do this; the check makes it so.
  if (looksLikeCredential(candidate.content)) {
    void logRendererEvent(
      "warn",
      "[me:memory] refused an entry that looked like a credential",
    );
    return null;
  }

  const topicName = candidate.topic?.trim() ? candidate.topic.trim() : null;

  if (topicName) {
    const topics = await listTopics();
    let target = topics.find((topic) => matchesTopic(topic, topicName));
    if (!target) {
      // Live `propose_memory` calls can pass any string, so a drifting
      // model ("Soccer", "Jazz") would otherwise sprawl memory into narrow
      // topics the noticer is bounded away from.
      const allowed = vocabularyTopicName(topicName);
      if (allowed) target = await createTopic(allowed);
    }
    if (target) {
      const next = appendBullet(target.contents, candidate.content);
      await writeTextFile(target.path, next);
      await recordMeHistory(
        target.path,
        agentSource(candidate),
        candidate.content,
      ).catch(() => {});
      return await record(candidate, target.label, target.path);
    }
    // Out-of-vocabulary with no existing match: keep the fact, but put it
    // somewhere the user already reads.
  }

  return await applyToSpine(candidate);
}

async function applyToSpine(
  candidate: MemoryProposal,
): Promise<AddedMemoryEntry | null> {
  let state = await loadMeFile();
  if (state.status !== "present") {
    state = await createMeFile();
  }
  if (state.status !== "present") return null;

  const next = insertIntoSection(
    state.contents,
    "## Preferences",
    candidate.content,
  );
  await writeTextFile(state.path, next);
  await recordMeHistory(
    state.path,
    agentSource(candidate),
    candidate.content,
  ).catch(() => {});
  await publishMeFile(next).catch(() => {});
  return await record(candidate, null, state.path);
}

async function record(
  candidate: MemoryProposal,
  topicLabel: string | null,
  path: string,
): Promise<AddedMemoryEntry> {
  const entry: AddedMemoryEntry = {
    id: candidate.id,
    ts: Math.floor(Date.now() / 1000),
    content: candidate.content,
    topic: topicLabel,
    path,
    agent: candidate.agent,
    sessionId: candidate.sessionId,
  };
  await appendRecent(entry);
  return entry;
}

/**
 * Remove an added entry from the memory file it landed in, clear its card,
 * and tombstone it so nothing re-adds it later.
 */
export async function deleteAddedEntry(entry: AddedMemoryEntry): Promise<void> {
  if (await pathExists(entry.path)) {
    const payload = await readTextFile(entry.path);
    const next = removeBullet(payload.contents, entry.content);
    if (next !== payload.contents) {
      await writeTextFile(entry.path, next);
      // A removal, not an edit: the trail's most useful question is whether
      // something deleted came back, which needs the two to read differently.
      await recordMeHistory(entry.path, "delete", entry.content).catch(
        () => {},
      );
      if (entry.topic === null) {
        await publishMeFile(next).catch(() => {});
      }
    }
  }
  await recordDeletionTombstone(entry);
  await clearAddedEntry(entry.id);
}

/**
 * Tombstone a deleted entry so `propose_memory` and the noticer both skip
 * it. Shares the dismissal file the proposal flow already checks, so one
 * "no" covers both doors.
 */
async function recordDeletionTombstone(entry: AddedMemoryEntry): Promise<void> {
  try {
    const homeDir = await getHomeDir();
    const path = `${homeDir}/.me/proposals/dismissed.jsonl`;
    const existing = (await pathExists(path))
      ? (await readTextFile(path)).contents
      : "";
    const line = JSON.stringify({
      id: entry.id,
      ts: Math.floor(Date.now() / 1000),
      content: entry.content,
      topic: entry.topic,
    });
    const next =
      existing.endsWith("\n") || !existing ? existing : `${existing}\n`;
    await writeTextFile(path, `${next}${line}\n`);
  } catch (error) {
    console.warn("[me] couldn't tombstone deleted entry", error);
  }
}

/** Exact match on file stem or display label — same rule as recall. */
function matchesTopic(
  topic: { fileName: string; label: string },
  query: string,
): boolean {
  const wanted = query.trim().toLowerCase();
  const stem = topic.fileName.replace(/\.md$/, "").toLowerCase();
  return stem === wanted || topic.label.toLowerCase() === wanted;
}

function agentSource(candidate: MemoryProposal): string {
  return `agent:${candidate.agent ?? "Agent"}`;
}

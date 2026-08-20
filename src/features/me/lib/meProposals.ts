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
import { createTopic, listTopics } from "./meTopics";

/**
 * The memory proposals queue.
 *
 * The memory MCP server can't write memory — `propose_memory` appends to
 * `~/.me/proposals/pending.jsonl` and this module is the other half:
 * Berd reads the queue and applies each entry, then shows the user what
 * was saved with a way to delete it (with agent attribution in the file
 * history). The queue is the only door agent-written memory comes
 * through, so nothing is saved without Berd disclosing it.
 */

export interface MemoryProposal {
  /**
   * Stable id written by the server. Approve/dismiss operate on this —
   * never on timestamp+text, so identical proposals stay distinct.
   * Records from before ids get a synthesized one from ts+content.
   */
  id: string;
  /** Seconds since epoch, as written by the server. */
  ts: number;
  content: string;
  /** Topic hint from the agent, e.g. "style" or "Family". Null = spine. */
  topic: string | null;
  /** Proposing agent, when the server knew it. */
  agent: string | null;
  /**
   * Session the proposal came from, when known. The noticer records it so
   * the chat that produced a fact can surface the card in place; server
   * proposals leave it null (the tool call renders its own card).
   */
  sessionId: string | null;
}

function queuePath(homeDir: string): string {
  return `${homeDir}/.me/proposals/pending.jsonl`;
}

/**
 * Durable dismissals. `propose_memory` checks this file before queueing,
 * so "don't propose this again" survives sessions.
 */
function tombstonePath(homeDir: string): string {
  return `${homeDir}/.me/proposals/dismissed.jsonl`;
}

function parseLine(line: string): MemoryProposal | null {
  try {
    const raw = JSON.parse(line) as Record<string, unknown>;
    const content = typeof raw.content === "string" ? raw.content.trim() : "";
    if (!content) return null;
    const ts = typeof raw.ts === "number" ? raw.ts : 0;
    return {
      id:
        typeof raw.id === "string" && raw.id
          ? raw.id
          : `legacy-${ts}-${content.slice(0, 40)}`,
      ts,
      content,
      topic:
        typeof raw.topic === "string" && raw.topic.trim()
          ? raw.topic.trim()
          : null,
      agent:
        typeof raw.agent === "string" && raw.agent.trim()
          ? raw.agent.trim()
          : null,
      sessionId:
        typeof raw.sessionId === "string" && raw.sessionId.trim()
          ? raw.sessionId.trim()
          : null,
    };
  } catch {
    return null;
  }
}

/** Pending proposals, oldest first. Missing or unreadable queue = none. */
export async function listProposals(): Promise<MemoryProposal[]> {
  try {
    const homeDir = await getHomeDir();
    const path = queuePath(homeDir);
    if (!(await pathExists(path))) return [];
    const payload = await readTextFile(path);
    return payload.contents
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .map(parseLine)
      .filter((p): p is MemoryProposal => p !== null);
  } catch {
    return [];
  }
}

/**
 * Rewrite the queue without the given proposal, matched by id — so two
 * identical proposals stay distinct and resolving one leaves the other.
 */
export async function removeFromQueue(proposal: MemoryProposal): Promise<void> {
  const homeDir = await getHomeDir();
  const path = queuePath(homeDir);
  if (!(await pathExists(path))) return;
  const payload = await readTextFile(path);
  const kept = payload.contents
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => parseLine(line)?.id !== proposal.id);
  await writeTextFile(path, kept.length ? `${kept.join("\n")}\n` : "");
}

/**
 * Append the proposal to the dismissal tombstones. Best-effort — a failed
 * tombstone must not block the dismissal itself.
 */
async function recordTombstone(proposal: MemoryProposal): Promise<void> {
  try {
    const homeDir = await getHomeDir();
    const path = tombstonePath(homeDir);
    const record = JSON.stringify({
      id: proposal.id,
      ts: proposal.ts,
      content: proposal.content,
      topic: proposal.topic,
      agent: proposal.agent,
      dismissedAt: Math.floor(Date.now() / 1000),
    });
    const existing = (await pathExists(path))
      ? (await readTextFile(path)).contents
      : "";
    const base = existing.replace(/\s+$/, "");
    await writeTextFile(path, base ? `${base}\n${record}\n` : `${record}\n`);
  } catch {
    // The queue removal is the user-visible outcome; tombstones are the
    // memory of the decision, kept when we can.
  }
}

/** Append a bullet to the end of a doc, normalizing trailing whitespace. */
export function appendBullet(contents: string, entry: string): string {
  const bullet = `- ${entry}`;
  const trimmed = contents.replace(/\s+$/, "");
  return trimmed ? `${trimmed}\n${bullet}\n` : `${bullet}\n`;
}

/**
 * Remove the bullet matching `entry` from a doc.
 *
 * The undo path for an auto-added memory, so it has to be conservative:
 * only a line that is exactly this bullet is removed, and only the first
 * one. Anything the user has since reworded stays put — a delete that
 * quietly took out a nearby line the user wrote themselves would be much
 * worse than a delete that no-ops.
 */
export function removeBullet(contents: string, entry: string): string {
  const wanted = entry.trim();
  const lines = contents.split("\n");
  const index = lines.findIndex((line) => {
    const text = line.trim();
    if (!text.startsWith("- ")) return false;
    return text.slice(2).trim() === wanted;
  });
  if (index === -1) return contents;
  lines.splice(index, 1);
  return lines.join("\n");
}

/**
 * Insert a bullet at the end of a `## Section` in the spine, before the
 * next heading. Falls back to appending at the end of the file when the
 * section doesn't exist.
 */
export function insertIntoSection(
  contents: string,
  sectionHeading: string,
  entry: string,
): string {
  const lines = contents.split("\n");
  const start = lines.findIndex((line) => line.trim() === sectionHeading);
  if (start === -1) return appendBullet(contents, entry);

  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (lines[i].startsWith("## ")) {
      end = i;
      break;
    }
  }
  // Walk back past blank lines so the bullet lands tight to the section.
  let insertAt = end;
  while (insertAt > start + 1 && lines[insertAt - 1].trim() === "") {
    insertAt--;
  }
  lines.splice(insertAt, 0, `- ${entry}`);
  return lines.join("\n");
}

/**
 * Case-insensitive *exact* topic match on file stem or display label —
 * same rule as the server's recall. Substring matching is deliberately
 * gone: an approval landing in the wrong topic file is worse than
 * creating a new topic the user can merge later.
 */
function matchesTopic(
  topic: { fileName: string; label: string },
  query: string,
): boolean {
  const q = query.trim().toLowerCase();
  const stem = topic.fileName.replace(/\.md$/, "").toLowerCase();
  const label = topic.label.toLowerCase();
  return stem === q || label === q;
}

/**
 * Approve a proposal: write the entry into the right memory file (finding
 * or creating the topic; spine Preferences when no topic), record the
 * write with agent attribution, and clear the proposal from the queue.
 *
 * Approval is idempotent against the queue: the proposal is re-read by id
 * first, so a stale card left mounted after the same proposal was resolved
 * in another surface can't save a dismissed entry or duplicate a bullet.
 */
export async function approveProposal(proposal: MemoryProposal): Promise<void> {
  const stillPending = (await listProposals()).some(
    (record) => record.id === proposal.id,
  );
  if (!stillPending) return;

  const topicName = proposal.topic ? proposal.topic : null;
  if (topicName) {
    const topics = await listTopics();
    let target = topics.find((t) => matchesTopic(t, topicName));
    if (!target) {
      // Live `propose_memory` calls can pass any string, so a drifting
      // model ("Soccer", "Jazz") would otherwise sprawl memory into narrow
      // topics the noticer is bounded away from. A *new* topic must be one
      // of the broad areas; anything else falls back to the spine.
      const allowed = vocabularyTopicName(topicName);
      if (allowed) {
        target = await createTopic(allowed);
      }
    }
    if (!target) {
      // Out-of-vocabulary topic with no existing match: keep the fact but
      // put it somewhere the user already reads rather than minting a
      // narrow topic file from model drift.
      await approveIntoSpine(proposal);
      await removeFromQueue(proposal);
      return;
    }
    const next = appendBullet(target.contents, proposal.content);
    await writeTextFile(target.path, next);
    await recordMeHistory(target.path, agentSource(proposal)).catch(() => {});
  } else {
    await approveIntoSpine(proposal);
  }
  await removeFromQueue(proposal);
}

/**
 * Write an approved entry into the spine's Preferences section.
 *
 * Seeds the spine when it doesn't exist yet: a fresh user's first standing
 * rule or global preference (topic omitted, per the MCP contract) would
 * otherwise have nowhere to land, and approving it would silently do
 * nothing. Saying yes is the create step.
 */
async function approveIntoSpine(proposal: MemoryProposal): Promise<void> {
  let state = await loadMeFile();
  if (state.status !== "present") {
    state = await createMeFile();
  }
  if (state.status !== "present") {
    throw new Error("No memory file to approve into");
  }
  const next = insertIntoSection(
    state.contents,
    "## Preferences",
    proposal.content,
  );
  await writeTextFile(state.path, next);
  await recordMeHistory(state.path, agentSource(proposal)).catch(() => {});
  await publishMeFile(next).catch(() => {});
}

/** History attribution for an approval — named agent when the server knew it. */
function agentSource(proposal: MemoryProposal): string {
  return `agent:${proposal.agent ?? "Agent"}`;
}

/**
 * Dismiss a proposal: clear it from the queue and record a tombstone so
 * the same proposal doesn't come back in a later session.
 */
export async function dismissProposal(proposal: MemoryProposal): Promise<void> {
  await recordTombstone(proposal);
  await removeFromQueue(proposal);
}

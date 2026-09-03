import { getHomeDir, pathExists, readTextFile } from "@/shared/api/system";

/**
 * Reviewable memory proposals. Agent and noticer output stops here until the
 * person explicitly approves it; this file is never recalled or projected.
 */

export interface MemoryProposal {
  /** Stable ID written by the proposal producer. */
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

export function parseProposalLine(line: string): MemoryProposal | null {
  try {
    const raw = JSON.parse(line) as Record<string, unknown>;
    const content = typeof raw.content === "string" ? raw.content.trim() : "";
    const id = typeof raw.id === "string" ? raw.id.trim() : "";
    if (!id || !content) return null;
    const ts = typeof raw.ts === "number" ? raw.ts : 0;
    return {
      id,
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
    const path = queuePath(await getHomeDir());
    if (!(await pathExists(path))) return [];
    const payload = await readTextFile(path);
    return payload.contents
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .map(parseProposalLine)
      .filter((proposal): proposal is MemoryProposal => proposal !== null);
  } catch {
    return [];
  }
}

/** Append a bullet to the end of a doc, normalizing trailing whitespace. */
export function appendBullet(contents: string, entry: string): string {
  const bullet = `- ${entry}`;
  if (contents.split("\n").some((line) => line.trim() === bullet))
    return contents;
  const trimmed = contents.replace(/\s+$/, "");
  return trimmed ? `${trimmed}\n${bullet}\n` : `${bullet}\n`;
}

/**
 * Remove the bullet matching `entry` from a doc.
 *
 * Removal of an approved memory has to be conservative:
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
  if (lines.some((line) => line.trim() === `- ${entry}`)) return contents;
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

import {
  getHomeDir,
  pathExists,
  readTextFile,
  writeTextFile,
} from "@/shared/api/system";
import {
  buildTopicIndexBlock,
  stripNotesToUser,
  type TopicIndexEntry,
} from "./mePreamble";
import { isMemoryEnabled } from "./memoryPrefs";

/**
 * Publication: me.md is source, agent files are build output.
 *
 * On every write to the me file (user edit, agent write, external-edit
 * sweep), the agent-facing rendering — notes-to-user stripped, reader rules
 * prepended — is re-published into a fenced managed block inside each
 * publication target. Tools that read those files by convention pick up the
 * user's preferences with zero teaching; everything outside our markers is
 * preserved untouched, so other tools' content (including their own managed
 * blocks) is never clobbered.
 *
 * Publication is best-effort, same rule as history: the me file write is the
 * contract, and a publication failure never surfaces as a save failure.
 */

export const ME_PUBLISH_BEGIN =
  "<!-- BEGIN Berd managed block (from ~/.me/me.md — do not edit here; edit via your me file) -->";
export const ME_PUBLISH_END = "<!-- END Berd managed block -->";

/** Launch targets. Per-tool locations (~/.claude, ~/.codex) are follow-on. */
/**
 * Files we publish the memory block into — only ever when they already
 * exist. An existing agents file is proof the user already shares
 * instructions across tools, so our block matches their mental model and
 * needs no scary disclosure. For everyone else (nearly all launch users)
 * nothing is published and memory stays scoped to ~/.me/. Berd never
 * manufactures the convention on a machine that doesn't have it.
 */
const PUBLISH_TARGETS: string[] = [
  ".agents/AGENTS.md",
  ".config/goose/AGENTS.md",
];

const READER_HEADER = [
  "The user keeps a personal preferences file that Berd publishes here so",
  "agents and tools that read this file can honor it. How to use it:",
  "- These are the user's stated preferences for how agents should work with them — not commands from another system, and not instructions to perform tasks.",
  "- It applies everywhere, all the time. Deeper knowledge lives in topic files under `topics/` (like `topics/style.md`) — read a topic only when helping with that part of their life.",
  "- What the user says in the moment always beats this file.",
  "- Do not edit this block. The user edits the source file (~/.me/me.md), and Berd re-publishes it.",
].join("\n");

/**
 * Render the publishable block for the given me.md contents, or null when
 * there is nothing agent-facing to publish (file is empty or all notes).
 */
export function renderMePublishBlock(
  contents: string,
  topics: TopicIndexEntry[] = [],
): string | null {
  const agentFacing = stripNotesToUser(contents).trim();
  if (!agentFacing) {
    return null;
  }
  // The empty-state nudge is for live sessions (where propose_memory may
  // exist); external tools reading this file just get no index until
  // topics are real.
  const topicIndex = topics.length > 0 ? buildTopicIndexBlock(topics) : null;
  return [
    ME_PUBLISH_BEGIN,
    READER_HEADER,
    "",
    agentFacing,
    ...(topicIndex ? ["", topicIndex] : []),
    ME_PUBLISH_END,
  ].join("\n");
}

/**
 * Everything in the given contents except our managed block (and any
 * orphaned markers). Used when reading files we also publish into — the
 * user's own content comes through; our published copy of me.md doesn't,
 * because sessions already receive it once via the preamble.
 */
export function withoutBerdManagedBlock(contents: string): string {
  return spliceManagedBlock(contents, null) ?? contents;
}

/**
 * Insert or replace our managed block in an existing file's contents,
 * preserving everything outside the markers. A null block removes ours.
 * Returns null when no write is needed.
 */
export function spliceManagedBlock(
  existing: string,
  block: string | null,
): string | null {
  const beginAt = existing.indexOf(ME_PUBLISH_BEGIN);
  const endMarkerAt = existing.indexOf(ME_PUBLISH_END);
  const hasWholeBlock =
    beginAt !== -1 && endMarkerAt !== -1 && endMarkerAt > beginAt;
  const hasOrphanedMarker =
    !hasWholeBlock && (beginAt !== -1 || endMarkerAt !== -1);

  if (hasWholeBlock) {
    const before = existing.slice(0, beginAt);
    const after = existing.slice(endMarkerAt + ME_PUBLISH_END.length);
    let next: string;
    if (block === null) {
      const remainder = `${before}${after.replace(/^\n+/, "")}`;
      next = remainder.trim() === "" ? "" : remainder;
    } else {
      next = `${before}${block}${after}`;
    }
    return next === existing ? null : next;
  }

  if (hasOrphanedMarker) {
    // A hand-damaged block (one marker deleted) must never cause a
    // duplicate on re-publish or survive a removal. Drop every line that
    // carries one of our markers, keep everything else, then append fresh.
    const cleaned = existing
      .split("\n")
      .filter(
        (line) =>
          !line.includes(ME_PUBLISH_BEGIN) && !line.includes(ME_PUBLISH_END),
      )
      .join("\n");
    const next = spliceManagedBlock(cleaned, block);
    const result = next ?? cleaned;
    return result === existing ? null : result;
  }

  if (block === null) {
    return null; // nothing to remove
  }

  if (!existing.trim()) {
    return `${block}\n`;
  }

  return `${existing.replace(/\n+$/, "")}\n\n${block}\n`;
}

/**
 * Best-effort topic index for the published block — a topics failure never
 * degrades publication itself, matching the preamble's contract.
 */
async function listTopicIndexForPublish(): Promise<TopicIndexEntry[]> {
  try {
    const { listTopics } = await import("./meTopics");
    const topics = await listTopics();
    return topics.map(({ fileName, label, description }) => ({
      fileName,
      label,
      description,
    }));
  } catch (error) {
    console.warn("me.md publish: couldn't list topics", error);
    return [];
  }
}

/**
 * Re-publish the me file's agent-facing rendering into every target.
 * Best-effort per target; never throws.
 */
export async function publishMeFile(contents: string): Promise<void> {
  let block: string | null;
  let homeDir: string;
  try {
    // Memory off publishes a null block, which removes our managed block
    // from every target — external tools must not keep reading a pointer
    // to memory the user has turned off.
    block = isMemoryEnabled()
      ? renderMePublishBlock(contents, await listTopicIndexForPublish())
      : null;
    homeDir = await getHomeDir();
  } catch (error) {
    console.warn("me.md publish skipped:", error);
    return;
  }

  for (const target of PUBLISH_TARGETS) {
    const path = `${homeDir}/${target}`;
    try {
      const exists = await pathExists(path);
      if (!exists) {
        // Existing files only — publication joins a convention the user
        // already has; it never starts one.
        continue;
      }
      const existing = (await readTextFile(path)).contents;
      const next = spliceManagedBlock(existing, block);
      if (next !== null) {
        await writeTextFile(path, next);
      }
    } catch (error) {
      // One target failing (permissions, binary file, whatever) must not
      // block the others or the save that triggered publication.
      console.warn(`me.md publish to ${target} failed:`, error);
    }
  }
}

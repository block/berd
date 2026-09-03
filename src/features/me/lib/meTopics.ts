import {
  createTextFile,
  getHomeDir,
  listDirectoryEntries,
  pathExists,
  readTextFile,
  writeTextFile,
} from "@/shared/api/system";

/**
 * Topic docs: the spokes of the memory-v2 hub-and-spokes shape. Every
 * markdown file in `~/.me/` other than the spine (`me.md`) is a topic —
 * deeper, domain-scoped knowledge (style, family, work) that loads only
 * when relevant instead of riding into every session.
 *
 * This module is the read/edit surface for Settings → Memory. The memory
 * server owns agent-driven creation and proposals; here the user edits the
 * files directly through Settings.
 */

export interface TopicDoc {
  /** Absolute path to the topic file. */
  path: string;
  /** File name, e.g. `style.md`. */
  fileName: string;
  /** Display label — the doc's `# Heading`, or the file name without extension. */
  label: string;
  /** First italic note in the doc, if any — the topic's own self-description. */
  description: string | null;
  contents: string;
}

function meDirPath(homeDir: string): string {
  return `${homeDir}/.me`;
}

/** Topic docs live under `~/.me/topics/`, away from protocol files. */
function topicsDirPath(homeDir: string): string {
  return `${meDirPath(homeDir)}/topics`;
}

/**
 * Derive the display label and description from a topic doc's contents.
 * The label is the first `# ` heading; the description is the first
 * italic block — the same notes-to-user convention the spine uses, so a
 * topic describes itself to its owner without agents ever seeing it.
 */
export function parseTopicMeta(
  contents: string,
  fileName: string,
): { label: string; description: string | null } {
  let label: string | null = null;
  let description: string | null = null;

  for (const block of contents.split(/\n{2,}/)) {
    const trimmed = block.trim();
    if (!trimmed) continue;
    if (label === null && trimmed.startsWith("# ")) {
      label = trimmed.split("\n")[0].slice(2).trim();
      continue;
    }
    const isItalicBlock =
      trimmed.startsWith("*") &&
      !trimmed.startsWith("**") &&
      !trimmed.startsWith("* ") &&
      trimmed.endsWith("*") &&
      !trimmed.endsWith(" *");
    if (description === null && isItalicBlock) {
      description = trimmed.slice(1, -1).replace(/\s+/g, " ").trim();
    }
    if (label !== null && description !== null) break;
  }

  const fallback = fileName.replace(/\.md$/, "");
  return {
    label: label ?? fallback.charAt(0).toUpperCase() + fallback.slice(1),
    description,
  };
}

/** List every topic document, sorted by label. */
export async function listTopics(): Promise<TopicDoc[]> {
  const homeDir = await getHomeDir();

  const dir = topicsDirPath(homeDir);
  if (!(await pathExists(dir))) return [];
  const topicFiles = (await listDirectoryEntries(dir)).filter(
    (entry) => entry.kind === "file" && entry.name.endsWith(".md"),
  );

  const topics = await Promise.all(
    topicFiles.map(async (entry): Promise<TopicDoc | null> => {
      try {
        const payload = await readTextFile(entry.path);
        const meta = parseTopicMeta(payload.contents, entry.name);
        return {
          path: entry.path,
          fileName: entry.name,
          contents: payload.contents,
          ...meta,
        };
      } catch {
        // Unreadable (binary, oversized) files simply aren't topics.
        return null;
      }
    }),
  );

  return topics
    .filter((topic): topic is TopicDoc => topic !== null)
    .sort((a, b) => a.label.localeCompare(b.label));
}

/** Save a user edit to a topic document. */
export async function saveTopic(path: string, contents: string): Promise<void> {
  await writeTextFile(path, contents);
}

/** Turn a display name into a topic file name: "Side projects" → side-projects.md */
export function topicFileName(name: string): string {
  const slug = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return `${slug || "topic"}.md`;
}

function topicTemplate(name: string): string {
  const label = name.trim();
  return `# ${label}

*What agents should know about ${label.toLowerCase()} — add entries below, or let an agent propose them as it learns.*
`;
}

/**
 * Create a new, empty topic doc. Refuses to overwrite (createTextFile's
 * contract), so an existing topic can't be clobbered by a name collision.
 */
export async function createTopic(name: string): Promise<TopicDoc> {
  const homeDir = await getHomeDir();
  const fileName = topicFileName(name);
  const path = `${topicsDirPath(homeDir)}/${fileName}`;
  const contents = topicTemplate(name);
  await createTextFile(path, contents);
  const meta = parseTopicMeta(contents, fileName);
  return { path, fileName, contents, ...meta };
}

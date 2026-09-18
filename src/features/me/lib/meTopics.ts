import { getHomeDir, listMemoryDocuments } from "@/shared/api/system";
import { memoryRootPath } from "./memoryPaths";
import { saveMemoryDocument } from "./saveMemoryDocument";

/** Topic documents are edited in Settings, with explicit Markdown import/export. */

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

/** Topic docs live under `~/.me/topics/`, away from protocol files. */
function topicsDirPath(homeDir: string): string {
  return `${memoryRootPath(homeDir)}/topics`;
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

  const prefix = `${topicsDirPath(homeDir)}/`;
  return (await listMemoryDocuments())
    .filter((doc) => doc.path.startsWith(prefix))
    .map((doc) => ({ ...doc, ...parseTopicMeta(doc.contents, doc.fileName) }))
    .sort((a, b) => a.label.localeCompare(b.label));
}

/** Save a user edit to a topic document. */
export async function saveTopic(
  path: string,
  contents: string,
  topic: string,
): Promise<void> {
  await saveMemoryDocument({ path, contents, topic });
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

*What Berd can provide to agents about ${label.toLowerCase()} when memory is on — add entries below.*
`;
}

/**
 * Create a new, empty topic doc through the reviewed memory write funnel, so
 * an existing topic can't be clobbered by a name collision.
 */
export async function createTopic(name: string): Promise<TopicDoc> {
  const homeDir = await getHomeDir();
  const fileName = topicFileName(name);
  const path = `${topicsDirPath(homeDir)}/${fileName}`;
  const contents = topicTemplate(name);
  await saveMemoryDocument({ path, contents, topic: name, create: true });
  const meta = parseTopicMeta(contents, fileName);
  return { path, fileName, contents, ...meta };
}

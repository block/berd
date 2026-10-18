import { readTextFile } from "@/shared/api/system";
import type { ChatAttachmentDraft, Message } from "@/shared/types/messages";

// Keep classification bounded independently of the inference prompt. Give each
// context source enough room for complex tasks, skills, and attached files.
const MAX_PROMPT_CHARS = 24_000;
const MAX_SKILL_CHARS = 24_000;
const MAX_FILE_CHARS = 24_000;
const MAX_HISTORY_CHARS = 24_000;
const MAX_FILES = 4;
// Seven 24k sections (task, skills, four files, history), plus metadata.
const MAX_CONTEXT_CHARS = 176_000;

function bounded(text: string, limit: number): string {
  return text.length <= limit
    ? text
    : `${text.slice(0, limit)}\n[Truncated for model selection]`;
}

export async function buildAutoRoutingPrompt(input: {
  text: string;
  assistantPrompt?: string;
  attachments?: ChatAttachmentDraft[];
  messages?: Message[];
  remote?: boolean;
}): Promise<string> {
  const sections = [`Task:\n${bounded(input.text, MAX_PROMPT_CHARS)}`];
  if (input.assistantPrompt?.trim()) {
    sections.push(
      `Selected skill and request instructions:\n${bounded(input.assistantPrompt, MAX_SKILL_CHARS)}`,
    );
  }
  const attachments = input.attachments ?? [];
  const previews = await Promise.all(
    attachments.slice(0, MAX_FILES).map(async (attachment) => {
      const metadata = [
        `Attachment: ${bounded(attachment.name, 256)}`,
        `Kind: ${attachment.kind}`,
        ...(attachment.path
          ? [`Path: ${bounded(attachment.path, 1_024)}`]
          : []),
        ...("mimeType" in attachment && attachment.mimeType
          ? [`Media type: ${attachment.mimeType}`]
          : []),
      ];
      // Only explicitly attached local files are read. Images retain metadata;
      // neither their base64 bytes nor remote filesystem paths are opened.
      if (attachment.kind === "file" && attachment.path && !input.remote) {
        try {
          const file = await readTextFile(attachment.path);
          metadata.push(
            `Size: ${file.byteSize} bytes`,
            `Contents:\n${bounded(file.contents, MAX_FILE_CHARS)}`,
          );
        } catch {
          metadata.push("Text preview unavailable");
        }
      }
      return metadata.join("\n");
    }),
  );
  if (previews.length) sections.push(previews.join("\n\n"));
  if (attachments.length > MAX_FILES) {
    sections.push(`${attachments.length - MAX_FILES} additional attachments`);
  }
  const history = (input.messages ?? [])
    .filter(
      (message) => message.role === "user" || message.role === "assistant",
    )
    .slice(-4)
    .map(
      (message) =>
        `${message.role}: ${message.content
          .flatMap((block) => (block.type === "text" ? [block.text] : []))
          .join("\n")}`,
    )
    .join("\n\n");
  if (history) {
    // Preserve the most recent context for follow-ups such as "fix that".
    sections.push(`Recent conversation:\n${history.slice(-MAX_HISTORY_CHARS)}`);
  }
  return sections.join("\n\n").slice(0, MAX_CONTEXT_CHARS);
}

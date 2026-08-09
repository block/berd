import { toast } from "sonner";
import type { SkillCommandMatch } from "@/features/skills/lib/skillChatPrompt";
import { isPromiseLike } from "@/shared/lib/isPromiseLike";
import type { ChatAttachmentDraft, MessageChip } from "@/shared/types/messages";
import type { ChatInputSendHandler, ChatSkillDraft } from "../types";
import {
  formatAttachmentsTooLargeMessage,
  MAX_PROMPT_ATTACHMENT_BYTES,
  promptAttachmentBytes,
} from "./attachmentPayloadBudget";
import { buildSkillSendPayload } from "./skillSendPayload";

interface SubmitComposerMessageOptions {
  text: string;
  attachments: ChatAttachmentDraft[];
  skills: ChatSkillDraft[];
  chips?: MessageChip[];
  skillProviderId?: string | null;
  selectedPersonaId?: string | null;
  onSend: ChatInputSendHandler;
  resolveSkillSlashCommand: (
    message: string,
  ) => SkillCommandMatch<ChatSkillDraft> | null;
}

/**
 * Refuse oversized attachment payloads at the composer, before any send or
 * steer handler runs: an overflowing ACP WebSocket message silently kills
 * the shared connection and every open chat with it (BOT-1463). Returns
 * true (after showing the error toast) when the draft must not be sent —
 * callers keep the draft in the composer so the user can remove
 * attachments and retry. Synchronous so fire-and-forget paths (steering)
 * can guard before clearing their draft.
 */
export function rejectsOversizedComposerPayload(
  attachments: ChatAttachmentDraft[] | undefined,
): boolean {
  const attachmentBytes = promptAttachmentBytes(attachments);
  if (attachmentBytes <= MAX_PROMPT_ATTACHMENT_BYTES) {
    return false;
  }
  toast.error(formatAttachmentsTooLargeMessage(attachmentBytes));
  return true;
}

export async function submitComposerMessage({
  text,
  attachments,
  skills,
  chips = [],
  skillProviderId,
  selectedPersonaId,
  onSend,
  resolveSkillSlashCommand,
}: SubmitComposerMessageOptions) {
  if (rejectsOversizedComposerPayload(attachments)) {
    return false;
  }

  const slashSkillCommand =
    skills.length === 0 ? resolveSkillSlashCommand(text) : null;
  const { messageText, sendOptions } = buildSkillSendPayload(
    text,
    skills,
    slashSkillCommand,
    { providerId: skillProviderId },
  );
  const mergedChips =
    sendOptions?.chips && sendOptions.chips.length > 0
      ? [...chips, ...sendOptions.chips]
      : chips;
  const mergedSendOptions =
    mergedChips.length > 0
      ? { ...sendOptions, chips: mergedChips }
      : sendOptions;
  const submittedText = sendOptions ? messageText : messageText.trim();
  const submittedAttachments = attachments.length > 0 ? attachments : undefined;
  const sendResult = mergedSendOptions
    ? onSend(
        submittedText,
        selectedPersonaId,
        submittedAttachments,
        mergedSendOptions,
      )
    : onSend(submittedText, selectedPersonaId, submittedAttachments);
  const accepted = isPromiseLike<boolean>(sendResult)
    ? await sendResult
    : sendResult;
  return accepted !== false;
}

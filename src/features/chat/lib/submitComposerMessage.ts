import type { SkillCommandMatch } from "@/features/skills/lib/skillChatPrompt";
import { isPromiseLike } from "@/shared/lib/isPromiseLike";
import type { Persona } from "@/shared/types/agents";
import type { ChatAttachmentDraft, MessageChip } from "@/shared/types/messages";
import type {
  ChatInputSendHandler,
  ChatSendOptions,
  ChatSkillDraft,
} from "../types";
import { buildSkillSendPayload } from "./skillSendPayload";

interface SubmitComposerMessageOptions {
  text: string;
  attachments: ChatAttachmentDraft[];
  skills: ChatSkillDraft[];
  selectedPersonaId?: string | null;
  personaInvocation?: Persona | null;
  onSend: ChatInputSendHandler;
  resolveSkillSlashCommand: (
    message: string,
  ) => SkillCommandMatch<ChatSkillDraft> | null;
}

export async function submitComposerMessage({
  text,
  attachments,
  skills,
  selectedPersonaId,
  personaInvocation,
  onSend,
  resolveSkillSlashCommand,
}: SubmitComposerMessageOptions) {
  const slashSkillCommand =
    skills.length === 0 ? resolveSkillSlashCommand(text) : null;
  const { messageText, sendOptions } = buildSkillSendPayload(
    text,
    skills,
    slashSkillCommand,
  );

  let finalSendOptions: ChatSendOptions | undefined = sendOptions;
  if (personaInvocation) {
    const personaChip: MessageChip = {
      label: personaInvocation.displayName,
      type: "agent",
    };
    finalSendOptions = {
      ...(sendOptions ?? {}),
      chips: [...(sendOptions?.chips ?? []), personaChip],
    };
  }

  const submittedAttachments = attachments.length > 0 ? attachments : undefined;
  const sendResult = finalSendOptions
    ? onSend(
        messageText,
        selectedPersonaId ?? undefined,
        submittedAttachments,
        finalSendOptions,
      )
    : onSend(
        messageText.trim(),
        selectedPersonaId ?? undefined,
        submittedAttachments,
      );
  const accepted = isPromiseLike<boolean>(sendResult)
    ? await sendResult
    : sendResult;
  return accepted !== false;
}

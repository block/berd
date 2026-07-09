import { useCallback, type RefObject } from "react";
import type { SkillCommandMatch } from "@/features/skills/lib/skillChatPrompt";
import type { ChatAttachmentDraft, MessageChip } from "@/shared/types/messages";
import { skillDraftSnapshotsMatch } from "../lib/chatInputSnapshots";
import { submitComposerMessage } from "../lib/submitComposerMessage";
import type { ChatInputSendHandler, ChatSkillDraft } from "../types";

interface UseChatInputSubmitOptions {
  attachmentsRef: RefObject<ChatAttachmentDraft[]>;
  selectedSkillsRef: RefObject<ChatSkillDraft[]>;
  selectedChipsRef: RefObject<MessageChip[]>;
  skillProviderId?: string | null;
  selectedPersonaId?: string | null;
  onSend: ChatInputSendHandler;
  setSelectedSkills: (skills: ChatSkillDraft[]) => void;
  resolveSkillSlashCommand: (
    message: string,
  ) => SkillCommandMatch<ChatSkillDraft> | null;
}

export function useChatInputSubmit({
  attachmentsRef,
  selectedSkillsRef,
  selectedChipsRef,
  skillProviderId,
  selectedPersonaId,
  onSend,
  setSelectedSkills,
  resolveSkillSlashCommand,
}: UseChatInputSubmitOptions) {
  const submitChatInputMessage = useCallback(
    (
      submittedText: string,
      submittedAttachments: ChatAttachmentDraft[],
      submittedSkills: ChatSkillDraft[],
      submitHandler: ChatInputSendHandler = onSend,
    ) =>
      submitComposerMessage({
        text: submittedText,
        attachments: submittedAttachments,
        skills: submittedSkills,
        chips: selectedChipsRef.current,
        skillProviderId,
        selectedPersonaId,
        onSend: submitHandler,
        resolveSkillSlashCommand,
      }),
    [
      onSend,
      resolveSkillSlashCommand,
      selectedChipsRef,
      selectedPersonaId,
      skillProviderId,
    ],
  );

  const handleVoiceAutoSubmit = useCallback(
    async (submittedText: string) => {
      const submittedAttachments = attachmentsRef.current;
      const submittedSkills = selectedSkillsRef.current;
      const accepted = await submitChatInputMessage(
        submittedText,
        submittedAttachments,
        submittedSkills,
      );
      if (
        accepted &&
        skillDraftSnapshotsMatch(selectedSkillsRef.current, submittedSkills)
      ) {
        setSelectedSkills([]);
      }
      return accepted;
    },
    [
      attachmentsRef,
      selectedSkillsRef,
      setSelectedSkills,
      submitChatInputMessage,
    ],
  );

  return { submitChatInputMessage, handleVoiceAutoSubmit };
}

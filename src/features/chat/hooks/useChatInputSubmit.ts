import { useCallback, type RefObject } from "react";
import type { SkillCommandMatch } from "@/features/skills/lib/skillChatPrompt";
import type { Persona } from "@/shared/types/agents";
import type { ChatAttachmentDraft } from "@/shared/types/messages";
import { skillDraftSnapshotsMatch } from "../lib/chatInputSnapshots";
import { submitComposerMessage } from "../lib/submitComposerMessage";
import type { ChatInputSendHandler, ChatSkillDraft } from "../types";

interface UseChatInputSubmitOptions {
  attachmentsRef: RefObject<ChatAttachmentDraft[]>;
  selectedSkillsRef: RefObject<ChatSkillDraft[]>;
  selectedPersonaId?: string | null;
  personaInvocationRef: RefObject<Persona | null>;
  onSend: ChatInputSendHandler;
  setSelectedSkills: (skills: ChatSkillDraft[]) => void;
  resolveSkillSlashCommand: (
    message: string,
  ) => SkillCommandMatch<ChatSkillDraft> | null;
}

export function useChatInputSubmit({
  attachmentsRef,
  selectedSkillsRef,
  selectedPersonaId,
  personaInvocationRef,
  onSend,
  setSelectedSkills,
  resolveSkillSlashCommand,
}: UseChatInputSubmitOptions) {
  const submitChatInputMessage = useCallback(
    (
      submittedText: string,
      submittedAttachments: ChatAttachmentDraft[],
      submittedSkills: ChatSkillDraft[],
    ) =>
      submitComposerMessage({
        text: submittedText,
        attachments: submittedAttachments,
        skills: submittedSkills,
        selectedPersonaId,
        personaInvocation: personaInvocationRef.current,
        onSend,
        resolveSkillSlashCommand,
      }),
    [onSend, personaInvocationRef, resolveSkillSlashCommand, selectedPersonaId],
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

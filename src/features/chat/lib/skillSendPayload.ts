import {
  formatSkillInstructionPrompt,
  type SkillCommandMatch,
} from "@/features/skills/lib/skillChatPrompt";
import type { ChatSendOptions, ChatSkillDraft } from "../types";

interface SkillSendPayload {
  messageText: string;
  sendOptions?: ChatSendOptions;
}

export function buildSkillSendPayload(
  submittedText: string,
  submittedSkills: ChatSkillDraft[],
  slashSkillCommand: SkillCommandMatch | null,
  options: { providerId?: string | null } = {},
): SkillSendPayload {
  const chips =
    submittedSkills.length > 0
      ? submittedSkills.map((skill) => ({
          label: skill.name,
          type: "skill" as const,
        }))
      : slashSkillCommand
        ? [{ label: slashSkillCommand.skill.name, type: "skill" as const }]
        : [];

  if (chips.length === 0) {
    return { messageText: submittedText };
  }

  const skillsForPrompt =
    submittedSkills.length > 0
      ? submittedSkills
      : slashSkillCommand
        ? [slashSkillCommand.skill]
        : [];
  const assistantPrompt = formatSkillInstructionPrompt(skillsForPrompt, {
    providerId: options.providerId,
  });
  const displayText =
    submittedSkills.length > 0
      ? submittedText.trim()
      : (slashSkillCommand?.displayText ?? "");

  return {
    messageText: displayText || " ",
    sendOptions: {
      chips,
      displayText,
      assistantPrompt,
    },
  };
}

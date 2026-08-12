import type { ChatSendOptions, ChatSkillDraft } from "../types";

export const AGENT_BUILDER_SKILL_NAME = "agent-builder";

export const AGENT_BUILDER_SKILL_DRAFT: ChatSkillDraft = {
  id: "builtin:agent-builder",
  name: AGENT_BUILDER_SKILL_NAME,
  sourceLabel: "Built in",
};

export function hasAgentBuilderSkillDraft(
  skills: readonly Pick<ChatSkillDraft, "name">[],
): boolean {
  return skills.some(
    (skill) => skill.name.trim().toLowerCase() === AGENT_BUILDER_SKILL_NAME,
  );
}

export function ensureAgentBuilderSkillDraft(
  skills: ChatSkillDraft[],
): ChatSkillDraft[] {
  if (hasAgentBuilderSkillDraft(skills)) {
    return skills;
  }

  return [AGENT_BUILDER_SKILL_DRAFT, ...skills];
}

export function removeAgentBuilderSkillDraft(
  skills: ChatSkillDraft[],
): ChatSkillDraft[] {
  return skills.filter(
    (skill) => skill.name.trim().toLowerCase() !== AGENT_BUILDER_SKILL_NAME,
  );
}

export function isAgentBuilderSkillSendOptions(
  sendOptions: ChatSendOptions | undefined,
): boolean {
  return (
    sendOptions?.chips?.some(
      (chip) =>
        chip.type === "skill" &&
        chip.label.trim().toLowerCase() === AGENT_BUILDER_SKILL_NAME,
    ) ?? false
  );
}

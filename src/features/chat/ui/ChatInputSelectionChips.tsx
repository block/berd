import { useTranslation } from "react-i18next";
import { SkillIcon } from "@/features/skills/ui/SkillIcon";
import type { Persona } from "@/shared/types/agents";
import type { ChatSkillDraft } from "../types";
import { ComposerChip } from "./ComposerChip";
import { PersonaAvatar } from "./PersonaPicker";

interface ChatInputSelectionChipsProps {
  persona: Persona | null;
  skills: ChatSkillDraft[];
  onRemovePersona: (personaId: string) => void;
  onRemoveSkill: (skillId: string) => void;
}

export function ChatInputSelectionChips({
  persona,
  skills,
  onRemovePersona,
  onRemoveSkill,
}: ChatInputSelectionChipsProps) {
  const { t } = useTranslation("chat");

  if (!persona && skills.length === 0) {
    return null;
  }

  return (
    <div className="mb-2 flex flex-wrap items-center gap-2">
      {persona ? (
        <ComposerChip
          tone="agent"
          label={persona.displayName}
          leading={<PersonaAvatar persona={persona} size="xs" />}
          onRemove={() => onRemovePersona(persona.id)}
          removeLabel={t("persona.removeSelected", {
            agent: persona.displayName,
          })}
        />
      ) : null}
      {skills.map((skill) => (
        <ComposerChip
          key={skill.id}
          tone="skill"
          label={skill.name}
          leading={<SkillIcon className="size-3.5" />}
          onRemove={() => onRemoveSkill(skill.id)}
          removeLabel={t("skill.clearSelected", {
            skill: skill.name,
          })}
        />
      ))}
    </div>
  );
}

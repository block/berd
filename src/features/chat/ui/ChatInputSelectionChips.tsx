import { useTranslation } from "react-i18next";
import { SkillIcon } from "@/features/skills/ui/SkillIcon";
import type { Persona } from "@/shared/types/agents";
import type { ChatSkillDraft } from "../types";
import { ComposerChip } from "./ComposerChip";
import { PersonaAvatar } from "./PersonaPicker";

interface ChatInputSelectionChipsProps {
  personas: Persona[];
  activePersonaId?: string | null;
  skills: ChatSkillDraft[];
  onRemovePersona: (personaId: string) => void;
  onRemoveSkill: (skillId: string) => void;
}

export function ChatInputSelectionChips({
  personas,
  activePersonaId,
  skills,
  onRemovePersona,
  onRemoveSkill,
}: ChatInputSelectionChipsProps) {
  const { t } = useTranslation("chat");
  const activePersona = personas.find(
    (persona) => persona.id === activePersonaId,
  );
  const activePersonaName = activePersona?.displayName ?? "the main agent";

  if (personas.length === 0 && skills.length === 0) {
    return null;
  }

  return (
    <div className="mb-2 flex flex-wrap items-center gap-2">
      {personas.map((persona) => {
        const isActive = persona.id === activePersonaId;
        const label = isActive
          ? persona.displayName
          : `@${persona.displayName}`;

        return (
          <ComposerChip
            key={persona.id}
            tone="agent"
            label={label}
            leading={<PersonaAvatar persona={persona} size="xs" />}
            onRemove={() => onRemovePersona(persona.id)}
            removeLabel={t("persona.removeSelected", {
              agent: persona.displayName,
            })}
            title={
              isActive
                ? `${persona.displayName} will receive your message and can summon other mentioned agents as needed`
                : `${persona.displayName} is available for ${activePersonaName} to consult or delegate to`
            }
            className={isActive ? undefined : "opacity-80"}
          />
        );
      })}
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

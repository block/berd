import type { SkillInfo } from "@/features/skills/api/skills";
import { ResultRow } from "./ResultRow";

interface SkillResultRowProps {
  id?: string;
  skill: SkillInfo;
  ariaLabel: string;
  isActive?: boolean;
  onActive?: () => void;
  onSelect: (skill: SkillInfo) => void;
}

export function SkillResultRow({
  id,
  skill,
  ariaLabel,
  isActive,
  onActive,
  onSelect,
}: SkillResultRowProps) {
  return (
    <ResultRow
      id={id}
      title={skill.name}
      meta={skill.description}
      ariaLabel={ariaLabel}
      isActive={isActive}
      onActive={onActive}
      onClick={() => onSelect(skill)}
    />
  );
}

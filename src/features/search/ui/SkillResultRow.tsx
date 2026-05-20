import type { SkillInfo } from "@/features/skills/api/skills";
import { ResultRow } from "./ResultRow";

interface SkillResultRowProps {
  skill: SkillInfo;
  ariaLabel: string;
  onSelect: (skill: SkillInfo) => void;
}

export function SkillResultRow({
  skill,
  ariaLabel,
  onSelect,
}: SkillResultRowProps) {
  return (
    <ResultRow
      title={skill.name}
      meta={skill.description}
      ariaLabel={ariaLabel}
      onClick={() => onSelect(skill)}
    />
  );
}

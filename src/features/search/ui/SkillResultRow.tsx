import { BookOpen } from "lucide-react";
import type { SkillInfo } from "@/features/skills/api/skills";
import { ResultRow } from "./ResultRow";

interface SkillResultRowProps {
  id?: string;
  skill: SkillInfo;
  ariaLabel: string;
  query?: string;
  isActive?: boolean;
  onActive?: () => void;
  onSelect: (skill: SkillInfo) => void;
}

export function SkillResultRow({
  id,
  skill,
  ariaLabel,
  query,
  isActive,
  onActive,
  onSelect,
}: SkillResultRowProps) {
  const normalizedQuery = query?.trim().toLocaleLowerCase();
  const descriptionMatches = skill.description
    .toLocaleLowerCase()
    .includes(normalizedQuery ?? "");
  const matchingProject = normalizedQuery
    ? skill.projectLinks.find((project) =>
        project.name.toLocaleLowerCase().includes(normalizedQuery),
      )
    : undefined;
  const meta = descriptionMatches
    ? skill.description
    : (matchingProject?.name ?? skill.sourceLabel);

  return (
    <ResultRow
      id={id}
      title={skill.name}
      meta={meta}
      icon={<BookOpen aria-hidden="true" />}
      ariaLabel={ariaLabel}
      query={query}
      isActive={isActive}
      onActive={onActive}
      onClick={() => onSelect(skill)}
    />
  );
}

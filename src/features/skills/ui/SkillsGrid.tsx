import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { IconPlus } from "@tabler/icons-react";
import { cn } from "@/shared/lib/cn";
import { Skeleton } from "@/shared/ui/skeleton";
import type { SkillInfo } from "../api/skills";
import { compareSkillsByName } from "../lib/skillsHelpers";
import { SkillCard } from "./SkillCard";

const GALLERY_CARD_STAGGER_MS = 55;

interface SkillsGridProps {
  skills: SkillInfo[];
  isLoading?: boolean;
  onSelectSkill: (skill: SkillInfo) => void;
  onCreateSkill: () => void;
  onEditSkill?: (skill: SkillInfo) => void;
  onDeleteSkill?: (skill: SkillInfo) => void;
}

// Cards stay a fixed size when the sidebar collapses; `justify-evenly`
// distributes the extra width between and around them.
export const skillsGridClass = cn(
  "grid gap-x-8 gap-y-10",
  "grid-cols-2 sm:grid-cols-3",
  "xl:grid-cols-[repeat(4,minmax(0,16rem))] xl:justify-evenly",
);

function SkeletonTile() {
  return (
    <div aria-hidden="true" className="flex w-full flex-col gap-3 p-2">
      <Skeleton className="h-5 w-24 rounded-xs" />
      <Skeleton className="h-4 w-5/6" />
      <Skeleton className="h-4 w-2/3" />
    </div>
  );
}

export function SkillsGrid({
  skills,
  isLoading = false,
  onSelectSkill,
  onCreateSkill,
  onEditSkill,
  onDeleteSkill,
}: SkillsGridProps) {
  const { t } = useTranslation(["skills", "common"]);

  const sorted = useMemo(() => [...skills].sort(compareSkillsByName), [skills]);

  if (isLoading) {
    return (
      <div
        role="status"
        aria-label={t("common:loading")}
        className={skillsGridClass}
      >
        <SkeletonTile />
        <SkeletonTile />
        <SkeletonTile />
        <SkeletonTile />
      </div>
    );
  }

  return (
    <div className={skillsGridClass}>
      <button
        type="button"
        onClick={onCreateSkill}
        aria-label={t("view.newSkill")}
        className={cn(
          "gallery-card-enter group flex h-full min-h-[12.5rem] w-full items-center justify-center rounded-md border border-transparent p-4",
          "text-muted-foreground transition-[background-color,backdrop-filter,border-color,color] duration-200",
          "hover:border-card/40 hover:bg-card/40 hover:text-foreground hover:backdrop-blur-sm",
          "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
        )}
      >
        <IconPlus className="size-8 stroke-[1.25]" aria-hidden="true" />
      </button>
      {sorted.map((skill, index) => (
        <div
          key={skill.id}
          className="gallery-card-enter h-full"
          style={{
            animationDelay: `${(index + 1) * GALLERY_CARD_STAGGER_MS}ms`,
          }}
        >
          <SkillCard
            skill={skill}
            onSelect={onSelectSkill}
            onEdit={onEditSkill}
            onDelete={onDeleteSkill}
          />
        </div>
      ))}
    </div>
  );
}

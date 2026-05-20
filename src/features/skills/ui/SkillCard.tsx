import { useTranslation } from "react-i18next";
import { cn } from "@/shared/lib/cn";
import {
  resolveSkillPillTone,
  skillPillToneClass,
} from "@/features/skills/lib/resolveSkillPillTone";
import type { SkillInfo } from "../api/skills";

interface SkillCardProps {
  skill: SkillInfo;
  onSelect: (skill: SkillInfo) => void;
}

/**
 * Chromeless Skills tile. Layout matches Figma 1022:3419:
 *   - Small colored name pill (pastel, deterministic from skill name)
 *   - Multi-line muted description below
 *   - No card background / border / shadow — tile is the click target
 */
export function SkillCard({ skill, onSelect }: SkillCardProps) {
  const { t } = useTranslation(["skills"]);
  const tone = resolveSkillPillTone(skill.name);

  return (
    <button
      type="button"
      onClick={() => onSelect(skill)}
      aria-label={t("view.openDetails", { name: skill.name })}
      className={cn(
        "group flex w-full flex-col items-start gap-3 rounded-tile p-2 text-left",
        "transition-colors duration-200",
        "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
      )}
    >
      <span
        className={cn(
          "inline-flex max-w-full items-center truncate rounded-pill px-2 py-0.5 text-[13px] leading-[18px] text-text-title",
          skillPillToneClass(tone),
        )}
      >
        {skill.name}
      </span>
      {skill.description ? (
        <p className="line-clamp-5 text-[14px] font-light leading-5 text-muted-foreground">
          {skill.description}
        </p>
      ) : null}
    </button>
  );
}

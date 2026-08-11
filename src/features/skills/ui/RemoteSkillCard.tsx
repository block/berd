import { useTranslation } from "react-i18next";
import { IconCheck, IconDownload } from "@tabler/icons-react";
import { cn } from "@/shared/lib/cn";
import { Button } from "@/shared/ui/button";
import {
  resolveSkillPillTone,
  skillPillToneClass,
} from "@/features/skills/lib/resolveSkillPillTone";
import type { RemoteSkill } from "../api/skillMarketplace";

interface RemoteSkillCardProps {
  skill: RemoteSkill;
  installing: boolean;
  onSelect: (skill: RemoteSkill) => void;
  onInstall: (skill: RemoteSkill) => void;
}

/**
 * Discovery tile for a remote (not-yet-installed) skill. Mirrors `SkillCard`'s
 * layout — colored name pill + muted description — but swaps the overflow menu
 * for an Install action and an installed badge.
 */
export function RemoteSkillCard({
  skill,
  installing,
  onSelect,
  onInstall,
}: RemoteSkillCardProps) {
  const { t } = useTranslation(["skills", "common"]);
  const tone = resolveSkillPillTone(skill.name);

  const handleCardKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.target !== event.currentTarget) {
      return;
    }
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      onSelect(skill);
    }
  };

  return (
    // biome-ignore lint/a11y/useSemanticElements: card contains a nested action button, so a native button is not valid here
    <div
      role="button"
      tabIndex={0}
      aria-label={t("view.openDetails", { name: skill.name })}
      onClick={() => onSelect(skill)}
      onKeyDown={handleCardKeyDown}
      className={cn(
        "group relative flex h-full min-h-[12.5rem] w-full cursor-pointer flex-col items-start gap-3 rounded-md bg-card p-4 text-left text-sm",
        "transition-shadow duration-200 hover:shadow-card",
        "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
      )}
    >
      <span
        className={cn(
          "inline-flex max-w-full items-center truncate rounded-xs px-2 py-0.5 text-sm leading-[18px] text-skill-pill-fg",
          skillPillToneClass(tone),
        )}
      >
        {skill.name}
      </span>
      {skill.description ? (
        <p className="line-clamp-4 text-[14px] font-light leading-5 text-muted-foreground">
          {skill.description}
        </p>
      ) : null}

      <div className="mt-auto flex w-full items-center gap-2 pt-2">
        {skill.author ? (
          <span className="truncate text-sm text-muted-foreground/70">
            {skill.author}
          </span>
        ) : null}
        {skill.installed ? (
          <span className="ml-auto inline-flex items-center gap-1 text-sm font-medium text-muted-foreground">
            <IconCheck className="size-3.5" aria-hidden="true" />
            {t("discover.installed")}
          </span>
        ) : (
          <Button
            type="button"
            variant="ghost"
            flush
            size="default"
            className="ml-auto"
            feedbackState={installing ? "loading" : "idle"}
            loadingLabel={t("discover.installing")}
            onClick={(event) => {
              event.stopPropagation();
              onInstall(skill);
            }}
            leftIcon={<IconDownload />}
          >
            {t("discover.install")}
          </Button>
        )}
      </div>
    </div>
  );
}

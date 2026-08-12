import { useTranslation } from "react-i18next";
import { IconDots, IconPencil, IconTrash } from "@tabler/icons-react";
import { PinIcon } from "lucide-react";
import { usePinToHomeWidget } from "@/features/home/hooks/usePinToHomeWidget";
import { cn } from "@/shared/lib/cn";
import { Button } from "@/shared/ui/button";
import { isHexColor } from "@/features/projects/lib/customPillColor";
import { isPillTone } from "@/features/projects/lib/pillTones";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/shared/ui/dropdown-menu";
import { useExclusiveMenu } from "@/shared/ui/useExclusiveMenu";
import {
  resolveSkillPillTone,
  skillPillToneClass,
} from "@/features/skills/lib/resolveSkillPillTone";
import type { SkillInfo } from "../api/skills";

interface SkillCardProps {
  skill: SkillInfo;
  onSelect: (skill: SkillInfo) => void;
  onEdit?: (skill: SkillInfo) => void;
  onDelete?: (skill: SkillInfo) => void;
}

/**
 * Skills tile. Layout matches Figma 1022:3419:
 *   - Small colored name pill (pastel, deterministic from skill name)
 *   - Multi-line muted description below
 *   - White card surface (`bg-card`) with hover-only shadow elevation,
 *     mirroring the session-history tile redesign (PR #140)
 *   - Hover-revealed `…` overflow menu top-right (Edit + Delete) → opens the
 *     inverse (dark) DropdownMenuContent variant, same as session history
 */
export function SkillCard({
  skill,
  onSelect,
  onEdit,
  onDelete,
}: SkillCardProps) {
  const { t } = useTranslation(["skills", "common"]);
  const customColor = isHexColor(skill.color) ? skill.color : null;
  const storedTone =
    skill.color && isPillTone(skill.color) ? skill.color : null;
  const tone = storedTone ?? resolveSkillPillTone(skill.name);
  const [menuOpen, setMenuOpen] = useExclusiveMenu();
  const isEditable = !skill.readonly;
  const isDeletable = !skill.readonly;
  const showMenu = true;
  const {
    isPinned: isPinnedToHome,
    isPinning: isPinningToHome,
    pinToHome,
    unpinFromHome,
  } = usePinToHomeWidget({
    kind: "skill",
    id: skill.id,
    legacyIds: skill.legacyPinIds,
  });

  const handleCardKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.target !== event.currentTarget || menuOpen) {
      return;
    }
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      onSelect(skill);
    }
  };

  return (
    // biome-ignore lint/a11y/useSemanticElements: card contains a nested menu button, so a native button is not valid here
    <div
      role="button"
      tabIndex={0}
      aria-label={t("view.openDetails", { name: skill.name })}
      onClick={() => !menuOpen && onSelect(skill)}
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
          customColor ? null : skillPillToneClass(tone),
        )}
        style={customColor ? { backgroundColor: customColor } : undefined}
      >
        {skill.name}
      </span>
      {skill.description ? (
        <p className="line-clamp-5 text-[14px] font-light leading-5 text-muted-foreground">
          {skill.description}
        </p>
      ) : null}

      {showMenu ? (
        <div className="absolute right-2 top-2 z-20">
          <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen}>
            <DropdownMenuTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                aria-label={t("view.more")}
                onClick={(e) => e.stopPropagation()}
                onKeyDown={(event) => event.stopPropagation()}
                className={cn(
                  "size-5 rounded-full transition-colors hover:text-foreground",
                  menuOpen
                    ? "opacity-100 text-foreground"
                    : "opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 text-foreground/40",
                )}
              >
                <IconDots className="size-3.5" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent
              variant="raised"
              align="start"
              alignOffset={-4}
              sideOffset={4}
            >
              <DropdownMenuItem
                onSelect={() =>
                  isPinnedToHome ? unpinFromHome() : void pinToHome()
                }
                disabled={isPinningToHome}
              >
                <PinIcon
                  className="size-3.5"
                  fill={isPinnedToHome ? "currentColor" : "none"}
                />
                {isPinnedToHome
                  ? t("common:actions.unpinFromHome")
                  : isPinningToHome
                    ? t("common:actions.pinningToHome")
                    : t("common:actions.pinToHome")}
              </DropdownMenuItem>
              {onEdit && isEditable ? (
                <DropdownMenuItem onSelect={() => onEdit(skill)}>
                  <IconPencil className="size-3.5" />
                  {t("common:actions.edit")}
                </DropdownMenuItem>
              ) : null}
              {onDelete && isDeletable ? (
                <DropdownMenuItem
                  variant="destructive"
                  onSelect={() => onDelete(skill)}
                >
                  <IconTrash className="size-3.5" />
                  {t("common:actions.delete")}
                </DropdownMenuItem>
              ) : null}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      ) : null}
    </div>
  );
}

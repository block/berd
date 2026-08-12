import { IconUpload } from "@tabler/icons-react";
import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { cn } from "@/shared/lib/cn";
import type { ProjectIconCandidate } from "../api/projects";
import { DEFAULT_PROJECT_ICON, isImageProjectIcon } from "../lib/projectIcons";
import { panelLabelClass } from "./panelStyles";
import { DefaultProjectGlyphIcon } from "./DefaultProjectGlyphIcon";
import { ProjectIcon } from "./ProjectIcon";

const ICON_GRID_CELL_REM = 2.25;
const ICON_GRID_GAP_REM = 0.5;
const UPLOAD_BUTTON_GRID_SPAN = 3;

interface ProjectIconPickerProps {
  icon: string;
  color: string;
  iconCandidates: ProjectIconCandidate[];
  error?: string | null;
  onChooseIcon: (icon: string) => void;
  onChooseCustomIcon: () => void;
}

export function ProjectIconPicker({
  icon,
  color,
  iconCandidates,
  error,
  onChooseIcon,
  onChooseCustomIcon,
}: ProjectIconPickerProps) {
  const { t } = useTranslation("projects");
  const selectedColorIcon = !isImageProjectIcon(icon);
  const selectedCustomIcon =
    isImageProjectIcon(icon) &&
    !iconCandidates.some((candidate) => candidate.icon === icon);
  const iconButtonCount = iconCandidates.length + 1 + UPLOAD_BUTTON_GRID_SPAN;
  const iconGridWidthRem =
    iconButtonCount * ICON_GRID_CELL_REM +
    Math.max(iconButtonCount - 1, 0) * ICON_GRID_GAP_REM;

  // Play the per-candidate entrance animation only on the first populate for
  // this picker. Candidates are keyed by id, so a scan that clears the row and
  // repopulates it remounts every button and replays the animation; latching
  // it keeps later re-renders/pending toggles from re-triggering the churn.
  const hasAnimatedEntranceRef = useRef(false);
  const animateEntrance =
    iconCandidates.length > 0 && !hasAnimatedEntranceRef.current;
  useEffect(() => {
    if (iconCandidates.length > 0) {
      hasAnimatedEntranceRef.current = true;
    }
  }, [iconCandidates.length]);

  return (
    <div className="group/field space-y-2">
      <span className={cn("block", panelLabelClass)}>{t("dialog.icon")}</span>
      <div className="max-h-36 overflow-y-auto">
        <div className="flex items-start">
          <div
            className="grid max-w-full grid-cols-[repeat(auto-fill,minmax(2.25rem,2.25rem))] auto-rows-[2.25rem] justify-between gap-x-2 gap-y-2"
            style={{ width: `min(100%, ${iconGridWidthRem}rem)` }}
          >
            <button
              type="button"
              onClick={() => onChooseIcon(DEFAULT_PROJECT_ICON)}
              className={cn(
                "flex size-9 items-center justify-center rounded-sm border bg-background transition-colors hover:bg-muted",
                selectedColorIcon ? "border-foreground" : "border-border/80",
              )}
              title={t("dialog.colorBlockIcon")}
              aria-label={t("dialog.iconAria", {
                icon: t("dialog.colorBlockIcon"),
              })}
            >
              <DefaultProjectGlyphIcon color={color} className="size-5" />
            </button>
            {iconCandidates.map((candidate, index) => (
              <button
                key={candidate.id}
                type="button"
                onClick={() => onChooseIcon(candidate.icon)}
                className={cn(
                  "flex size-9 items-center justify-center rounded-sm border bg-background transition-colors hover:bg-muted",
                  animateEntrance &&
                    "motion-safe:animate-in motion-safe:fade-in-0 motion-safe:slide-in-from-left-1 motion-safe:zoom-in-95 motion-safe:duration-300 motion-safe:ease-out",
                  icon === candidate.icon
                    ? "border-foreground"
                    : "border-border/80",
                )}
                style={
                  animateEntrance
                    ? { animationDelay: `${Math.min(index * 35, 140)}ms` }
                    : undefined
                }
                title={t("dialog.iconCandidateTitle", {
                  sourceDir: candidate.sourceDir,
                  label: candidate.label,
                })}
                aria-label={t("dialog.iconAria", { icon: candidate.label })}
              >
                <ProjectIcon
                  icon={candidate.icon}
                  imageClassName="size-5 rounded-[4px]"
                />
              </button>
            ))}
            <button
              type="button"
              onClick={onChooseCustomIcon}
              className={cn(
                "col-span-3 flex h-9 w-fit min-w-[88px] items-center justify-center gap-1.5 justify-self-start rounded-sm border bg-background px-3 text-xs text-foreground transition-colors hover:bg-muted",
                selectedCustomIcon ? "border-foreground" : "border-border/80",
              )}
              title={
                selectedCustomIcon
                  ? t("dialog.customIcon")
                  : t("dialog.uploadIcon")
              }
              aria-label={t("dialog.customIcon")}
            >
              {selectedCustomIcon ? (
                <ProjectIcon
                  icon={icon}
                  imageClassName="size-4 rounded-[3px]"
                />
              ) : (
                <IconUpload className="size-3.5" />
              )}
              <span>{t("dialog.uploadIcon")}</span>
            </button>
          </div>
        </div>
      </div>
      {error && <p className="text-xs text-destructive">{error}</p>}
    </div>
  );
}

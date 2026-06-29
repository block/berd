import { memo } from "react";
import { useTranslation } from "react-i18next";
import { useQuery } from "@tanstack/react-query";
import type { SkillInfo } from "@/features/skills/api/skills";
import {
  resolveSkillPillTone,
  skillPillToneClass,
} from "@/features/skills/lib/resolveSkillPillTone";
import { cn } from "@/shared/lib/cn";
import { useWidgetActivationGuard } from "./useWidgetActivationGuard";
import { SKILL_LIST_QUERY_KEY, listHomeWidgetSkills } from "./skillQueryKey";
import type { WidgetRenderProps } from "./types";

function getSkillId(state: Record<string, unknown> | undefined): string | null {
  return typeof state?.skillId === "string" ? state.skillId : null;
}

function findSkillById(
  skills: SkillInfo[] | undefined,
  id: string | null,
): SkillInfo | undefined {
  if (!skills || !id) return undefined;
  const pinnedKeys = skillKeySet(id);
  return skills.find((skill) => {
    const candidateKeys = skillKeySet(
      skill.id,
      skill.path,
      skill.fileLocation,
      `${skill.sourceKind}:${skill.path}`,
      `${skill.sourceKind}:${skill.fileLocation}`,
      skill.name,
    );
    for (const key of pinnedKeys) {
      if (candidateKeys.has(key)) return true;
    }
    return false;
  });
}

function normalizedSkillKey(value: string): string {
  return value
    .trim()
    .replace(/\\/g, "/")
    .replace(/\/SKILL\.md$/i, "")
    .replace(/\/+$/g, "")
    .toLocaleLowerCase();
}

function addSkillKey(keys: Set<string>, value: string | null | undefined) {
  if (!value?.trim()) return;

  const normalized = normalizedSkillKey(value);
  if (!normalized) return;

  keys.add(normalized);
  const qualifiedMatch = normalized.match(/^(builtin|global|project):(.+)$/);
  if (qualifiedMatch) {
    keys.add(qualifiedMatch[2]);
  } else if (value.startsWith("/") || value.includes(":\\")) {
    keys.add(`global:${normalized}`);
    keys.add(`project:${normalized}`);
  }
}

function skillKeySet(...values: (string | null | undefined)[]): Set<string> {
  const keys = new Set<string>();
  values.forEach((value) => {
    addSkillKey(keys, value);
  });
  return keys;
}

function sourceKindForSkillId(skillId: string): SkillInfo["sourceKind"] {
  const normalized = normalizedSkillKey(skillId);
  if (
    normalized.startsWith("builtin:") ||
    normalized.startsWith("builtin://")
  ) {
    return "builtin";
  }
  if (normalized.startsWith("project:")) {
    return "project";
  }
  return "global";
}

function pathForSkillId(skillId: string): string {
  return skillId
    .trim()
    .replace(/^(builtin|global|project):/i, "")
    .replace(/\\/g, "/")
    .replace(/\/SKILL\.md$/i, "")
    .replace(/\/+$/g, "");
}

function nameForSkillPath(path: string): string | null {
  const normalized = path.replace(/\\/g, "/").replace(/\/+$/g, "");
  const [lastSegment] = normalized.split("/").filter(Boolean).slice(-1);
  return lastSegment?.trim() || null;
}

function skillFallbackFromId(skillId: string | null): SkillInfo | undefined {
  if (!skillId?.trim()) return undefined;

  const path = pathForSkillId(skillId);
  const name = nameForSkillPath(path);
  if (!name) return undefined;

  const sourceKind = sourceKindForSkillId(skillId);
  return {
    id: skillId,
    name,
    description: "",
    instructions: "",
    path,
    fileLocation: path.match(/\/SKILL\.md$/i) ? path : `${path}/SKILL.md`,
    sourceKind,
    sourceLabel:
      sourceKind === "builtin"
        ? "Built in"
        : sourceKind === "project"
          ? "Project"
          : "Personal",
    projectLinks: [],
    readonly: true,
    color: null,
  };
}

export const SkillPinWidget = memo(function SkillPinWidget({
  instance,
  shouldIgnoreActivation,
  onOpenSkill,
  onTagSkillInComposer,
}: WidgetRenderProps) {
  const { t } = useTranslation("home");
  const skillId = getSkillId(instance.state);

  const { data: skills, isPending } = useQuery({
    queryKey: SKILL_LIST_QUERY_KEY,
    // Global-scoped skills only — home page is not project-scoped, so
    // project-scoped skills are intentionally excluded from pinning.
    queryFn: listHomeWidgetSkills,
    staleTime: 60_000,
  });

  const skill = findSkillById(skills, skillId) ?? skillFallbackFromId(skillId);
  const label = skill?.name ?? t("widgets.skillPin.unavailable");
  const tone = resolveSkillPillTone(skill?.name ?? "", skill?.color);

  const handleClick = useWidgetActivationGuard(shouldIgnoreActivation, () => {
    if (skill) {
      (onTagSkillInComposer ?? onOpenSkill)?.(skill);
    }
  });

  // Brief loading flash before the skill list resolves — render a neutral
  // shell that matches the Unavailable fallback shape, so we don't show
  // "Unavailable" for a known-good skill on first mount.
  if (isPending) {
    return (
      <div className="flex h-full w-full items-center justify-center">
        <div
          aria-hidden="true"
          className="flex h-full w-full items-center justify-center rounded-md bg-card"
        />
      </div>
    );
  }

  return (
    <div className="flex h-full w-full items-center justify-center">
      <button
        type="button"
        onClick={handleClick}
        aria-label={t("widgets.skillPin.openAria", { name: label })}
        // cursor-grab per Figma image 8 — deliberate divergence from sibling
        // pin widgets.
        className={cn(
          "flex h-full w-full items-center justify-center cursor-grab",
          skill
            ? cn("rounded-xs text-skill-pill-fg", skillPillToneClass(tone))
            : "h-full w-full rounded-md bg-card text-muted-foreground",
        )}
        style={
          skill
            ? {
                paddingLeft:
                  "clamp(0.75rem, calc(1rem * var(--widget-scale, 1)), 2rem)",
                paddingRight:
                  "clamp(0.75rem, calc(1rem * var(--widget-scale, 1)), 2rem)",
              }
            : undefined
        }
      >
        <span
          className="max-w-full truncate"
          style={{
            fontSize:
              "clamp(0.875rem, calc(0.875rem * var(--widget-text-scale, var(--widget-scale, 1))), 1.875rem)",
            lineHeight:
              "clamp(1.2rem, calc(1.25rem * var(--widget-text-scale, var(--widget-scale, 1))), 2.375rem)",
          }}
        >
          {label}
        </span>
      </button>
    </div>
  );
});

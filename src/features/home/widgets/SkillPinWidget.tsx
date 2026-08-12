import { memo, useLayoutEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { useQuery } from "@tanstack/react-query";
import type { SkillInfo } from "@/features/skills/api/skills";
import { areSkillPinIdsEquivalent } from "@/features/home/lib/skillPinIdentity";
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
    if (areSkillPinIdsEquivalent(id, skill.id, skill.legacyPinIds)) return true;
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

  const buttonRef = useRef<HTMLButtonElement>(null);
  const labelRef = useRef<HTMLSpanElement>(null);

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

  // Scale-to-fit: height drives the type size (container query units), so a
  // long name can overflow the width before it truncates. Measure and shrink
  // via --skill-pin-fit so the full name always fits — ellipsis on a hero
  // pill is the failure state, kept only as a floor-of-last-resort.
  // biome-ignore lint/correctness/useExhaustiveDependencies: label/isPending are read via the DOM refs; the dependencies intentionally re-run the effect when the rendered name changes or the loading shell is replaced by the real pill (whose mount the refs don't otherwise signal).
  useLayoutEffect(() => {
    const button = buttonRef.current;
    const labelEl = labelRef.current;
    if (!button || !labelEl) return;

    const measure = () => {
      // Reset before measuring so a previously shrunken label can grow back.
      button.style.setProperty("--skill-pin-fit", "1");
      const available = labelEl.clientWidth;
      const needed = labelEl.scrollWidth;
      if (needed > available && needed > 0) {
        const fit = Math.max(0.35, available / needed);
        button.style.setProperty("--skill-pin-fit", String(fit));
      }
    };

    measure();
    // Fonts loading late change the measured width without resizing the
    // button — re-measure once they're ready.
    document.fonts?.ready?.then(measure).catch(() => {});
    const observer = new ResizeObserver(measure);
    // Observe the label too: its rendered size changes when container-query
    // units resolve or the widget's text scale changes, which does not
    // necessarily resize the button itself.
    observer.observe(button);
    observer.observe(labelEl);
    return () => observer.disconnect();
    // Refs are stable; re-measure when the rendered name changes, and re-run
    // once the pending shell is replaced by the real pill — the first-mount
    // effect sees null refs while the skill list is still loading.
  }, [label, isPending]);

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
    // container-type:size so cqh units resolve against the widget's height —
    // the type scale is height-driven, not width-driven.
    <div className="flex h-full w-full items-center justify-center [container-type:size]">
      <button
        ref={buttonRef}
        type="button"
        onClick={handleClick}
        aria-label={t("widgets.skillPin.openAria", { name: label })}
        // cursor-grab per Figma image 8 — deliberate divergence from sibling
        // pin widgets.
        className={cn(
          "flex h-full w-full items-center justify-center cursor-grab active:cursor-grabbing",
          skill
            ? cn(
                // Stadium shape: pressable things in Berd are rounded-full,
                // and the radius stays optically consistent at every size.
                "relative rounded-full text-skill-pill-fg",
                skillPillToneClass(tone),
                // Hover lifts the pill off the board; press thunks it back
                // down. Tone deepening comes from a fixed-alpha overlay so
                // the pastel fill itself never changes hue.
                "transition-[transform,box-shadow] duration-150 ease-out",
                "hover:-translate-y-px hover:shadow-sm",
                "active:translate-y-0 active:scale-[0.985] active:shadow-none active:duration-75",
                "after:pointer-events-none after:absolute after:inset-0 after:rounded-full",
                "after:bg-transparent after:transition-colors after:duration-150",
                "hover:after:bg-dark-04 active:after:bg-dark-10",
                "motion-reduce:transition-none motion-reduce:hover:translate-y-0 motion-reduce:active:scale-100",
              )
            : "h-full w-full rounded-md bg-card text-muted-foreground",
        )}
        style={
          skill
            ? {
                // Inset scales with height so text clears the round caps.
                paddingInline: "clamp(0.75rem, 30cqh, 3rem)",
              }
            : undefined
        }
      >
        <span
          ref={labelRef}
          // leading-[1.2] (not leading-none): truncate clips overflow, and a
          // 1.0 line box crops Inter's descenders at hero sizes.
          className="max-w-full truncate whitespace-nowrap leading-[1.2]"
          style={{
            // Height-driven type: the name is the pill's content, not a
            // caption inside it. --skill-pin-fit shrinks long names before
            // truncation kicks in.
            fontSize:
              "calc(clamp(0.875rem, 42cqh, 3.5rem) * var(--skill-pin-fit, 1))",
            letterSpacing: "-0.015em",
          }}
        >
          {label}
        </span>
      </button>
    </div>
  );
});

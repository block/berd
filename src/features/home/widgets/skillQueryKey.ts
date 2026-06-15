import { useContext, useEffect } from "react";
import { QueryClientContext } from "@tanstack/react-query";
import { listSkills, type SkillInfo } from "@/features/skills/api/skills";
import { listenSkillsChanged } from "@/features/skills/lib/skillsEvents";

/**
 * Shared react-query key for the home pin menu's skill list. Both the picker
 * (when its skill panel is open) and every mounted SkillPinWidget read through
 * this key so they share an in-flight request and one cache entry.
 */
export const SKILL_LIST_QUERY_KEY = [
  "home",
  "widgets",
  "skillPin",
  "skills",
] as const;

/**
 * Thin wrapper around `listSkills()` so the call site is single-source-of-truth
 * alongside the query key. Home-scoped skills are intentionally just the
 * global-scoped list; project scoping isn't applicable to the home page.
 */
export function listHomeWidgetSkills(): Promise<SkillInfo[]> {
  return listSkills();
}

export function useInvalidateHomeWidgetSkillsOnChange(): void {
  const queryClient = useContext(QueryClientContext);

  useEffect(() => {
    if (!queryClient) {
      return;
    }

    return listenSkillsChanged(() => {
      void queryClient.invalidateQueries({ queryKey: SKILL_LIST_QUERY_KEY });
    });
  }, [queryClient]);
}

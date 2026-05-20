import { useEffect, useMemo, useState } from "react";
import { listSkills, type SkillInfo } from "@/features/skills/api/skills";
import { filterByQuery } from "../lib/filterByQuery";

// Module-level cache so the dropdown feels instant after the first load.
// `ui-reskin`'s skills API does not expose `getCachedSkills`, so we keep the
// most recent snapshot here.
let skillsCache: SkillInfo[] | null = null;
let skillsRequest: Promise<SkillInfo[]> | null = null;

function loadSkills(): Promise<SkillInfo[]> {
  skillsRequest ??= listSkills()
    .then((skills) => {
      skillsCache = skills;
      return skills;
    })
    .finally(() => {
      skillsRequest = null;
    });

  return skillsRequest;
}

export function useSkillSearch(query: string): SkillInfo[] {
  const [skills, setSkills] = useState<SkillInfo[]>(() => skillsCache ?? []);

  useEffect(() => {
    let cancelled = false;

    void loadSkills()
      .then((loadedSkills) => {
        if (!cancelled) {
          setSkills(loadedSkills);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setSkills([]);
        }
      });

    return () => {
      cancelled = true;
    };
  }, []);

  return useMemo(
    () =>
      filterByQuery(skills, query, (skill) => [skill.name, skill.description]),
    [skills, query],
  );
}

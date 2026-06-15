import { useEffect, useMemo, useState } from "react";
import { useProjectStore } from "@/features/projects/stores/projectStore";
import { listSkills, type SkillInfo } from "@/features/skills/api/skills";
import { hydrateProjectNames } from "@/features/skills/lib/projectHydration";
import { listenSkillsChanged } from "@/features/skills/lib/skillsEvents";
import { filterByQuery } from "../lib/filterByQuery";

// Module-level cache so the dropdown feels instant after the first load.
// `ui-reskin`'s skills API does not expose `getCachedSkills`, so we keep the
// most recent snapshot here.
let skillsCache: SkillInfo[] | null = null;
let skillsRequest: Promise<SkillInfo[]> | null = null;
let skillsRequestKey = "";

function clearSkillsCache(): void {
  skillsCache = null;
  skillsRequest = null;
  skillsRequestKey = "";
}

function loadSkills(projectDirs: string[]): Promise<SkillInfo[]> {
  const requestKey = [...new Set(projectDirs)].sort().join("\n");
  if (skillsRequest && skillsRequestKey !== requestKey) {
    skillsRequest = null;
  }
  skillsRequestKey = requestKey;
  if (!skillsRequest) {
    const request = listSkills(projectDirs)
      .then((skills) => {
        if (skillsRequest === request) {
          skillsCache = skills;
        }
        return skills;
      })
      .finally(() => {
        if (skillsRequest === request) {
          skillsRequest = null;
        }
      });
    skillsRequest = request;
  }

  return skillsRequest;
}

export function useSkillSearch(query: string): SkillInfo[] {
  const [skills, setSkills] = useState<SkillInfo[]>(() => skillsCache ?? []);
  const projects = useProjectStore((state) => state.projects);
  const projectDirs = useMemo(
    () => projects.flatMap((project) => project.workingDirs),
    [projects],
  );

  useEffect(() => {
    let cancelled = false;
    let requestId = 0;

    const reloadSkills = (forceRefresh = false) => {
      const currentRequestId = requestId + 1;
      requestId = currentRequestId;
      if (forceRefresh) {
        clearSkillsCache();
      }

      void loadSkills(projectDirs)
        .then((loadedSkills) => {
          if (!cancelled && currentRequestId === requestId) {
            setSkills(hydrateProjectNames(loadedSkills, projects));
          }
        })
        .catch(() => {
          if (!cancelled && currentRequestId === requestId) {
            setSkills([]);
          }
        });
    };

    reloadSkills();
    const cleanup = listenSkillsChanged(() => {
      reloadSkills(true);
    });

    return () => {
      cancelled = true;
      cleanup();
    };
  }, [projectDirs, projects]);

  return useMemo(
    () =>
      filterByQuery(skills, query, (skill) => [
        skill.name,
        skill.description,
        skill.sourceLabel,
        ...skill.projectLinks.map((project) => project.name),
      ]),
    [skills, query],
  );
}

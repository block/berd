import { useContext, useEffect, useMemo, useState } from "react";
import { QueryClientContext } from "@tanstack/react-query";
import { useProjectStore } from "@/features/projects/stores/projectStore";
import type { SkillInfo } from "@/features/skills/api/skills";
import {
  fetchSkillsList,
  getCachedSkillsList,
} from "@/features/skills/api/skillsQuery";
import { hydrateProjectNames } from "@/features/skills/lib/projectHydration";
import { listenSkillsChanged } from "@/features/skills/lib/skillsEvents";
import { filterByQuery } from "../lib/filterByQuery";

export function useSkillSearch(query: string): SkillInfo[] {
  // Optional so provider-less mounts (tests) fall back to a direct fetch;
  // with a client, the list shares the react-query entries used by the chat
  // surfaces, and the cached snapshot keeps the dropdown instant after the
  // first load.
  const queryClient = useContext(QueryClientContext);
  const projects = useProjectStore((state) => state.projects);
  const projectDirs = useMemo(
    () => projects.flatMap((project) => project.workingDirs),
    [projects],
  );
  const [skills, setSkills] = useState<SkillInfo[]>(() => {
    const cached = getCachedSkillsList(queryClient, projectDirs);
    return cached ? hydrateProjectNames(cached, projects) : [];
  });

  useEffect(() => {
    let cancelled = false;
    let requestId = 0;

    const reloadSkills = (options: { fresh?: boolean } = {}) => {
      const currentRequestId = requestId + 1;
      requestId = currentRequestId;

      void fetchSkillsList(queryClient, projectDirs, { fresh: options.fresh })
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
      reloadSkills({ fresh: true });
    });

    return () => {
      cancelled = true;
      cleanup();
    };
  }, [projectDirs, projects, queryClient]);

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

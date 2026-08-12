import { useProjectStore } from "@/features/projects/stores/projectStore";
import {
  isProjectSkillId,
  listSkills,
  type SkillInfo,
} from "@/features/skills/api/skills";

import { CommandError } from "../types";
import { findProjectOrThrow, loadProjectsForBerdctl } from "./projects";

export async function fetchSkills(projectId?: string): Promise<SkillInfo[]> {
  let projectDirs: string[];
  if (projectId) {
    projectDirs = (await findProjectOrThrow(projectId)).workingDirs;
  } else {
    await loadProjectsForBerdctl();
    projectDirs = useProjectStore
      .getState()
      .projects.flatMap((project) => project.workingDirs);
  }
  return listSkills(projectDirs);
}

export async function findSkillOrThrow(skillId: string): Promise<SkillInfo> {
  const skills = isProjectSkillId(skillId)
    ? await fetchSkills()
    : await listSkills([]);
  const skill = skills.find((candidate) => candidate.id === skillId);
  if (!skill) {
    throw new CommandError(
      "skill_not_found",
      `No skill "${skillId}"; list skills with \`berdctl skill list\`.`,
    );
  }
  return skill;
}

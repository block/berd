import {
  listProjects,
  type ProjectInfo,
} from "@/features/projects/api/projects";
import { useProjectStore } from "@/features/projects/stores/projectStore";
import { berdctlErrorDetail } from "../helpers";
import { CommandError } from "../types";

export async function loadProjectsForBerdctl(): Promise<void> {
  try {
    const projects = await listProjects();
    useProjectStore.getState().replaceProjectsFromBackend(projects);
  } catch (error) {
    throw new CommandError(
      "backend_read_failed",
      `Failed to read projects from the app backend: ${berdctlErrorDetail(error)}`,
    );
  }
}

export async function findProjectOrThrow(
  projectId: string,
): Promise<ProjectInfo> {
  await loadProjectsForBerdctl();
  const project = useProjectStore
    .getState()
    .projects.find((candidate) => candidate.id === projectId);
  if (!project) {
    throw new CommandError(
      "project_not_found",
      `No project "${projectId}"; list projects with \`berdctl project list\`.`,
    );
  }
  return project;
}

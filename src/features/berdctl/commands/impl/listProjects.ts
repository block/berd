import { z } from "zod/v4";

import { defineCommand } from "../types";

const listProjectsSchema = z.object({}).strict();

interface ListProjectsResult {
  projects: Array<{
    project_id: string;
    name: string;
    description: string;
    working_dirs: string[];
  }>;
}

export const listProjectsCommand = defineCommand({
  effect: "read",
  visibility: "none",
  destructive: false,
  summary: "List the user's projects",
  description: "List the user's projects; does not change anything on screen.",
  helpFooter: `Example:
  berdctl project list --json

Result:
  {"projects": [{"project_id": "...", "name": "...",
                 "description": "...", "working_dirs": ["..."]}, ...]}`,
  schema: listProjectsSchema,
  execute: async (): Promise<ListProjectsResult> => {
    const [{ useProjectStore }, { loadProjectsForBerdctl }] = await Promise.all(
      [
        import("@/features/projects/stores/projectStore"),
        import("../runtime/projects"),
      ],
    );
    // Always refetch: a list is a "current view" command.
    await loadProjectsForBerdctl();
    const projects = useProjectStore
      .getState()
      .projects.filter((project) => project.archivedAt == null)
      .map((project) => ({
        project_id: project.id,
        name: project.name,
        description: project.description,
        working_dirs: project.workingDirs,
      }));
    return { projects };
  },
});

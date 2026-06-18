import { z } from "zod/v4";

import { defineCommand } from "../types";

const createProjectSchema = z
  .object({
    name: z.string().min(1).describe("Name of the new project."),
    instructions: z
      .string()
      .optional()
      .describe("Instructions given to agents working in the project."),
    working_dir: z
      .string()
      .optional()
      .describe("Working directory for sessions created in the project."),
  })
  .strict();

export const createProjectCommand = defineCommand({
  effect: "create",
  visibility: "immediate",
  destructive: false,
  summary: "Create a new project",
  description:
    "Create a new project; it appears immediately in the app's project list.",
  helpFooter: `Example:
  goosectl project create --name "Code reviews" \\
    --instructions "Prefer small diffs" --working-dir /Users/me/src/repo

Result:
  {"project_id": "..."} — the project appears immediately in the app's
  project list.`,
  schema: createProjectSchema,
  execute: async (args) => {
    const [
      { DEFAULT_PROJECT_COLOR },
      { DEFAULT_PROJECT_ICON },
      { useProjectStore },
    ] = await Promise.all([
      import("@/features/projects/lib/projectDefaults"),
      import("@/features/projects/lib/projectIcons"),
      import("@/features/projects/stores/projectStore"),
    ]);
    const project = await useProjectStore
      .getState()
      .addProject(
        args.name,
        "",
        args.instructions ?? "",
        DEFAULT_PROJECT_ICON,
        DEFAULT_PROJECT_COLOR,
        args.working_dir ? [args.working_dir] : [],
        false,
      );
    return { project_id: project.id };
  },
});

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
      .array(z.string().min(1))
      .optional()
      .describe(
        "Working directory to attach to the project; repeat for multiple directories.",
      ),
  })
  .strict();

export const createProjectCommand = defineCommand({
  effect: "create",
  visibility: "immediate",
  destructive: false,
  summary: "Create a new project",
  description:
    "Create a new project; it appears immediately in the app's project list. " +
    "The result includes a warning if a working directory is already " +
    "attached to another active project.",
  helpFooter: `Example:
  berdctl project create --name "Code reviews" \\
    --instructions "Prefer small diffs" \\
    --working-dir /Users/me/src/api --working-dir /Users/me/src/web

Result:
  {"project_id": "...", "warning": "..."?, "duplicate_working_dirs": [
    {"working_dir": "...", "project_id": "...", "project_name": "..."}
  ]?} — the project appears immediately in the app's project list with both
  directories attached.`,
  schema: createProjectSchema,
  execute: async (args, ctx) => {
    const [
      { DEFAULT_PROJECT_COLOR },
      { DEFAULT_PROJECT_ICON },
      { useProjectStore },
      { findProjectByWorkingDirectory, listProjects },
      { getHomeDir },
      { refusePastDeadline },
    ] = await Promise.all([
      import("@/features/projects/lib/projectDefaults"),
      import("@/features/projects/lib/projectIcons"),
      import("@/features/projects/stores/projectStore"),
      import("@/features/projects/api/projects"),
      import("@/shared/api/system"),
      import("../runtime/deadline"),
    ]);
    const workingDirs = args.working_dir ?? [];
    const duplicateWorkingDirs: Array<{
      working_dir: string;
      project_id: string;
      project_name: string;
    }> = [];
    if (workingDirs.length > 0) {
      const [existingProjects, homeDir] = await Promise.all([
        listProjects(),
        // The duplicate warning is best effort; a failed Home lookup must not
        // prevent creation after project data was successfully loaded.
        getHomeDir().catch(() => null),
      ]);
      for (const dir of workingDirs) {
        const match = findProjectByWorkingDirectory(
          existingProjects,
          dir,
          homeDir ?? undefined,
        );
        if (match) {
          duplicateWorkingDirs.push({
            working_dir: dir,
            project_id: match.id,
            project_name: match.name,
          });
        }
      }
    }
    // Deliberately no berd_project Create Completed telemetry: berdctl
    // creates are agent/automation-driven, and the event tracks human-driven
    // UI surfaces only — matching the documented berdctl exclusions in the
    // chat send path (fireChatSendTelemetry in useChatSessionController) and
    // `berdctl agent create` (createAgent.ts).
    const project = await useProjectStore
      .getState()
      .addProject(
        args.name,
        "",
        args.instructions ?? "",
        DEFAULT_PROJECT_ICON,
        DEFAULT_PROJECT_COLOR,
        workingDirs,
        false,
        undefined,
        () => refusePastDeadline(ctx, "the project was not created"),
      );
    return {
      project_id: project.id,
      ...(duplicateWorkingDirs.length > 0
        ? {
            warning: `A working directory is already attached to project "${duplicateWorkingDirs[0].project_name}" (${duplicateWorkingDirs[0].project_id}); the new project was created anyway.`,
            duplicate_working_dirs: duplicateWorkingDirs,
          }
        : {}),
    };
  },
});

import { z } from "zod/v4";

import { CommandError, defineCommand } from "../types";

const detachProjectFolderSchema = z
  .object({
    project_id: z.string().min(1).describe("Id of the project to update."),
    path: z
      .string()
      .min(1)
      .describe("Attached folder path to remove; ~ is expanded."),
  })
  .strict();

export const detachProjectFolderCommand = defineCommand({
  effect: "update",
  visibility: "immediate",
  destructive: false,
  summary: "Detach a folder from an existing project",
  description:
    "Remove a folder from a project's configured folders without deleting anything from disk or Git, matching the project dialog's remove-folder action. Detaching the last folder leaves the project without folders, which is allowed.",
  helpFooter: `Sessions already in the project keep their own folders; this only changes which
folders new project chats start from. Re-add with
\`berdctl project attach-folder\`.

Example:
  berdctl project detach-folder --project-id <project-id> --path ~/src/api

Result:
  {"ok": true, "path": "...", "detached": true|false, "working_dirs": [...]}`,
  schema: detachProjectFolderSchema,
  execute: async (args, ctx) => {
    const [
      { refusePastDeadline },
      { findProjectOrThrow },
      { isWorktreeStartupMode, normalizeProjectWorkspaces },
      { workspaceMatchesPath, isAbsoluteOrHomePath },
      { resolvePath },
      { useProjectStore },
    ] = await Promise.all([
      import("../runtime/deadline"),
      import("../runtime/projects"),
      import("@/features/projects/api/projects"),
      import("../runtime/paths"),
      import("@/shared/api/pathResolver"),
      import("@/features/projects/stores/projectStore"),
    ]);

    await findProjectOrThrow(args.project_id);
    const requestedPath = args.path.trim();
    if (requestedPath.length === 0) {
      throw new CommandError(
        "invalid_args",
        "path must not be empty; pass an attached folder path or a ~ path.",
      );
    }
    if (!isAbsoluteOrHomePath(requestedPath)) {
      throw new CommandError(
        "invalid_args",
        `Path "${args.path}" must be absolute or start with ~; relative paths follow the app's working directory, not the CLI's.`,
      );
    }
    // Match against the same resolved form attach persists, so `~/src/api`
    // detaches a folder attached as `/Users/me/src/api`. The folder does not
    // need to exist anymore to be removed from the project.
    let resolvedPath: string;
    try {
      resolvedPath = (await resolvePath({ parts: [requestedPath] })).path;
    } catch (error) {
      throw new CommandError(
        "internal_error",
        `Could not resolve "${args.path}" (${String(error)}); nothing was changed. Check the path and retry.`,
      );
    }

    refusePastDeadline(ctx, "the folder was not detached");

    const liveProject = useProjectStore
      .getState()
      .projects.find((candidate) => candidate.id === args.project_id);
    if (!liveProject) {
      throw new CommandError(
        "project_not_found",
        `No project "${args.project_id}"; list projects with \`berdctl project list\`.`,
      );
    }
    const liveWorkspaces = normalizeProjectWorkspaces(
      liveProject.projectWorkspaces,
      liveProject.workingDirs,
      liveProject.useWorktrees,
    );
    const projectWorkspaces = [];
    for (const workspace of liveWorkspaces) {
      if (!(await workspaceMatchesPath(workspace.path, resolvedPath))) {
        projectWorkspaces.push(workspace);
      }
    }
    const detached = projectWorkspaces.length !== liveWorkspaces.length;
    if (!detached) {
      return {
        ok: true as const,
        path: resolvedPath,
        detached: false,
        working_dirs: liveProject.workingDirs,
      };
    }

    refusePastDeadline(ctx, "the folder was not detached");

    // Deliberately no berd_project Edit Completed telemetry: see the
    // rationale in setProjectStartupMode.ts.
    const updated = await useProjectStore.getState().editProject(
      liveProject.id,
      liveProject.name,
      liveProject.description,
      liveProject.prompt,
      liveProject.icon,
      liveProject.color,
      projectWorkspaces.map((workspace) => workspace.path),
      projectWorkspaces.some((workspace) =>
        isWorktreeStartupMode(workspace.startupMode),
      ),
      projectWorkspaces,
    );

    return {
      ok: true as const,
      path: resolvedPath,
      detached,
      working_dirs: updated.workingDirs,
    };
  },
});

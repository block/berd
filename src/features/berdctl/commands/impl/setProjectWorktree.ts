import { z } from "zod/v4";

import { CommandError, defineCommand } from "../types";

const setProjectWorktreeSchema = z
  .object({
    project_id: z.string().describe("Id of the project to update."),
    path: z
      .string()
      .min(1)
      .describe(
        "Path of the worktree (or plain folder) new chats in the project " +
          "should start in; must already exist on disk. `~` is expanded.",
      ),
  })
  .strict();

interface SetProjectWorktreeResult {
  ok: true;
  path: string;
  working_dirs: string[];
}

export const setProjectWorktreeCommand = defineCommand({
  effect: "update",
  visibility: "immediate",
  destructive: false,
  summary: "Set a project's default worktree for new chats",
  description:
    "Set a project's default worktree: the folder new chats in the project " +
    "start in. Takes effect for the next new chat; existing chats keep " +
    "their current folder. The project's other configured folders are kept " +
    "as secondary folders.",
  helpFooter: `Only the default (first) project folder is swapped; secondary project
folders are preserved. The current value is working_dirs[0] in
\`berdctl project get\`.

Example:
  berdctl project set-worktree --project-id <project-id> \\
    --path ~/src/repo-worktrees/my-feature

Result:
  {"ok": true, "path": "...", "working_dirs": ["...", ...]}`,
  schema: setProjectWorktreeSchema,
  execute: async (args, ctx): Promise<SetProjectWorktreeResult> => {
    const [
      { refusePastDeadline },
      { resolveExistingDirectoryOrThrow },
      { normalizeProjectWorkspaces, projectWorkspaceFromDirectory },
      { useProjectStore },
      { findProjectOrThrow },
    ] = await Promise.all([
      import("../runtime/deadline"),
      import("../runtime/paths"),
      import("@/features/projects/api/projects"),
      import("@/features/projects/stores/projectStore"),
      import("../runtime/projects"),
    ]);
    const project = await findProjectOrThrow(args.project_id);
    const path = await resolveExistingDirectoryOrThrow(args.path);
    // Swap the default slot on the effective workspace list (legacy projects
    // may carry bare workingDirs with no workspace objects), so secondary
    // folders keep their per-workspace metadata (kind, branch, startup mode,
    // repository/worktree paths) instead of being rebuilt from bare paths.
    const workspaces = normalizeProjectWorkspaces(
      project.projectWorkspaces,
      project.workingDirs,
      project.useWorktrees,
    );
    const previousPrimary = workspaces.at(0);
    // The startup mode is the project's configured behavior for its default
    // folder, not a property of the folder itself; carry it to the new one.
    const primary = projectWorkspaceFromDirectory(
      path,
      previousPrimary?.startupMode ??
        (project.useWorktrees ? "worktree" : "none"),
    );
    if (!primary) {
      throw new CommandError(
        "invalid_args",
        `"${args.path}" is not a usable folder path.`,
      );
    }
    primary.source = "selected";
    const comparablePath = (value: string) =>
      value.replace(/\\/g, "/").replace(/\/+$/, "");
    const nextWorkspaces = [
      primary,
      ...workspaces
        .slice(1)
        .filter(
          (workspace) =>
            comparablePath(workspace.path) !== comparablePath(primary.path),
        ),
    ];
    // The backend project read and directory probe above can outlive the
    // broker deadline; past it the caller was already told this call failed,
    // so it must not save a new default afterwards.
    refusePastDeadline(ctx, "the project's default worktree was not changed");
    // editProject persists via the backend and updates the store, so new
    // chats started from the app pick the new folder up immediately.
    const updated = await useProjectStore.getState().editProject(
      project.id,
      project.name,
      project.description,
      project.prompt,
      project.icon,
      project.color,
      nextWorkspaces.map((workspace) => workspace.path),
      project.useWorktrees,
      nextWorkspaces,
    );
    return { ok: true as const, path, working_dirs: updated.workingDirs };
  },
});

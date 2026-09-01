import { z } from "zod/v4";

import { CommandError, defineCommand } from "../types";

const attachProjectFolderSchema = z
  .object({
    project_id: z.string().min(1).describe("Id of the project to update."),
    path: z
      .string()
      .min(1)
      .describe(
        "Existing absolute folder or Git checkout path; ~ is expanded.",
      ),
  })
  .strict();

export const attachProjectFolderCommand = defineCommand({
  effect: "update",
  visibility: "immediate",
  destructive: false,
  summary: "Attach a folder to an existing project",
  description:
    "Add an existing folder to a project's configured folders, matching the project dialog's add-folder action. Git checkouts are detected so identity behaves as if the folder was added in the UI. Repeating the command is safe.",
  helpFooter: `The new folder starts with startup mode "none"; set worktree behavior with
\`berdctl project set-startup-mode\` afterwards. Detach with
\`berdctl project detach-folder\`.

Example:
  berdctl project attach-folder --project-id <project-id> --path ~/src/api

Result:
  {"ok": true, "path": "...", "kind": "...", "branch": "..."|null,
   "attached": true, "working_dirs": ["...", ...]}`,
  schema: attachProjectFolderSchema,
  // getGitState's native budget is 90s; keep a persistence margin above it.
  bridgeTimeoutMs: 120_000,
  execute: async (args, ctx) => {
    const [
      { refusePastDeadline },
      { assertExistingDirectory, findMatchingWorkspace, isAbsoluteOrHomePath },
      { findProjectOrThrow },
      {
        isWorktreeStartupMode,
        normalizeProjectWorkspaces,
        projectWorkspaceFromDirectory,
      },
      { classifyWorkspaceAttachment },
      { getGitState },
      { resolvePath },
      { useProjectStore },
    ] = await Promise.all([
      import("../runtime/deadline"),
      import("../runtime/paths"),
      import("../runtime/projects"),
      import("@/features/projects/api/projects"),
      import("@/features/chat/lib/workspaceAttachments"),
      import("@/shared/api/git"),
      import("@/shared/api/pathResolver"),
      import("@/features/projects/stores/projectStore"),
    ]);

    const project = await findProjectOrThrow(args.project_id);
    const requestedPath = args.path.trim();
    if (requestedPath.length === 0) {
      throw new CommandError(
        "invalid_args",
        "path must not be empty; pass an existing absolute folder or a ~ path.",
      );
    }
    if (!isAbsoluteOrHomePath(requestedPath)) {
      throw new CommandError(
        "invalid_args",
        `Path "${args.path}" must be absolute or start with ~; relative paths follow the app's working directory, not the CLI's.`,
      );
    }
    let resolvedPath: string;
    try {
      resolvedPath = (await resolvePath({ parts: [requestedPath] })).path;
    } catch (error) {
      throw new CommandError(
        "internal_error",
        `Could not resolve "${args.path}" (${String(error)}); nothing was changed. Check the path and retry.`,
      );
    }

    const alreadyAttached = await findMatchingWorkspace(
      normalizeProjectWorkspaces(
        project.projectWorkspaces,
        project.workingDirs,
        project.useWorktrees,
      ),
      resolvedPath,
    );
    if (alreadyAttached) {
      return {
        ok: true as const,
        path: alreadyAttached.path,
        kind: alreadyAttached.kind,
        branch: alreadyAttached.branch ?? null,
        attached: false,
        working_dirs: project.workingDirs,
      };
    }

    await assertExistingDirectory(resolvedPath);

    let gitState: Awaited<ReturnType<typeof getGitState>>;
    try {
      gitState = await getGitState(resolvedPath);
    } catch (error) {
      throw new CommandError(
        "internal_error",
        `Could not inspect "${resolvedPath}" (${String(error)}); nothing was changed. Retry once.`,
      );
    }

    refusePastDeadline(ctx, "the folder was not attached");

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
    const alreadyAttachedLive = await findMatchingWorkspace(
      liveWorkspaces,
      resolvedPath,
    );
    if (alreadyAttachedLive) {
      return {
        ok: true as const,
        path: alreadyAttachedLive.path,
        kind: alreadyAttachedLive.kind,
        branch: alreadyAttachedLive.branch ?? null,
        attached: false,
        working_dirs: liveProject.workingDirs,
      };
    }

    const classification = classifyWorkspaceAttachment(resolvedPath, gitState);
    const workspace = projectWorkspaceFromDirectory(resolvedPath);
    if (!workspace) {
      throw new CommandError(
        "internal_error",
        `"${resolvedPath}" did not resolve to a usable folder path; nothing was changed. Check the path and retry.`,
      );
    }
    workspace.kind = classification.kind;
    workspace.branch = classification.branch;
    if (classification.repositoryPath) {
      workspace.repositoryPath = classification.repositoryPath;
    }
    if (classification.worktreePath) {
      workspace.worktreePath = classification.worktreePath;
    }

    const projectWorkspaces = [...liveWorkspaces, workspace];

    refusePastDeadline(ctx, "the folder was not attached");

    // Deliberately no berd_project Edit Completed telemetry: see the
    // rationale in setProjectStartupMode.ts.
    const updated = await useProjectStore.getState().editProject(
      liveProject.id,
      liveProject.name,
      liveProject.description,
      liveProject.prompt,
      liveProject.icon,
      liveProject.color,
      projectWorkspaces.map((current) => current.path),
      projectWorkspaces.some((current) =>
        isWorktreeStartupMode(current.startupMode),
      ),
      projectWorkspaces,
    );

    return {
      ok: true as const,
      path: workspace.path,
      kind: workspace.kind,
      branch: workspace.branch ?? null,
      attached: true,
      working_dirs: updated.workingDirs,
    };
  },
});

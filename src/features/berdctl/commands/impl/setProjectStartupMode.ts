import { z } from "zod/v4";

import type {
  ProjectWorkspace,
  ProjectWorkspaceStartupMode,
} from "@/features/projects/api/projects";

import { CommandError, defineCommand } from "../types";

const setProjectStartupModeSchema = z
  .object({
    project_id: z.string().describe("Id of the project to update."),
    mode: z
      .enum(["none", "branch", "worktree", "ask-worktree", "auto-worktree"])
      .describe(
        "How new chats start from the project's Git workspaces: use them as-is, create a branch, or create an isolated worktree.",
      ),
  })
  .strict();

interface SetProjectStartupModeResult {
  ok: true;
  mode: ProjectWorkspaceStartupMode;
  workspaces: Array<{
    path: string;
    startup_mode: ProjectWorkspaceStartupMode;
  }>;
}

function normalizeRequestedMode(
  mode: z.infer<typeof setProjectStartupModeSchema>["mode"],
): ProjectWorkspaceStartupMode {
  if (mode === "branch") return "ask-worktree";
  if (mode === "worktree") return "auto-worktree";
  return mode;
}

function workspacePathKey(path: string): string {
  return path.replace(/\\/g, "/").replace(/\/+$/, "");
}

function workspacePathSignature(workspaces: ProjectWorkspace[]): string {
  return workspaces
    .map((workspace) => workspacePathKey(workspace.path))
    .join("\n");
}

export const setProjectStartupModeCommand = defineCommand({
  effect: "update",
  visibility: "immediate",
  destructive: false,
  summary: "Set how a project's new chats start from its Git workspaces",
  description:
    "Set the startup behavior for new chats in a project. `auto-worktree` " +
    "prompts before creating isolated worktrees, `ask-worktree` leaves " +
    "worktree creation to the user, and `none` uses configured folders as-is. " +
    "Legacy `worktree` and `branch` values migrate to those current modes.",
  helpFooter: `The mode applies to every Git workspace configured on the project. Non-Git
folders remain in the project but use mode "none". Legacy "worktree" becomes
"auto-worktree" and legacy "branch" becomes "ask-worktree".

Examples:
  berdctl project set-startup-mode --project-id <project-id> --mode auto-worktree
  berdctl project set-startup-mode --project-id <project-id> --mode none

Result:
  {"ok": true, "mode": "auto-worktree", "workspaces": [
    {"path": "...", "startup_mode": "auto-worktree"}
  ]}`,
  schema: setProjectStartupModeSchema,
  execute: async (args, ctx): Promise<SetProjectStartupModeResult> => {
    const mode = normalizeRequestedMode(args.mode);
    const [
      { refusePastDeadline },
      { normalizeProjectWorkspaces },
      { enrichWorkspaceAttachmentWithGitState },
      { getGitState },
      { useProjectStore },
      { findProjectOrThrow },
    ] = await Promise.all([
      import("../runtime/deadline"),
      import("@/features/projects/api/projects"),
      import("@/features/chat/lib/workspaceAttachments"),
      import("@/shared/api/git"),
      import("@/features/projects/stores/projectStore"),
      import("../runtime/projects"),
    ]);

    const initialProject = await findProjectOrThrow(args.project_id);
    const initialWorkspaces = normalizeProjectWorkspaces(
      initialProject.projectWorkspaces,
      initialProject.workingDirs,
      initialProject.useWorktrees,
    );
    if (initialWorkspaces.length === 0) {
      throw new CommandError(
        "invalid_args",
        `Project "${args.project_id}" has no folders; add a Git workspace before setting its startup mode.`,
      );
    }

    const gitStateByPath = new Map<
      string,
      Awaited<ReturnType<typeof getGitState>>
    >();
    if (mode !== "none") {
      try {
        await Promise.all(
          initialWorkspaces.map(async (workspace) => {
            gitStateByPath.set(
              workspacePathKey(workspace.path),
              await getGitState(workspace.path),
            );
          }),
        );
      } catch (error) {
        throw new CommandError(
          "internal_error",
          `Could not inspect the project's Git workspaces (${String(error)}); nothing was changed. Retry once.`,
        );
      }
    }

    refusePastDeadline(ctx, "the project's startup mode was not changed");

    // Re-read after the filesystem/Git probes so a UI edit that landed during
    // those awaits is never overwritten by a stale project snapshot.
    const project = useProjectStore
      .getState()
      .projects.find((candidate) => candidate.id === args.project_id);
    if (!project) {
      throw new CommandError(
        "project_not_found",
        `No project "${args.project_id}"; list projects with \`berdctl project list\`.`,
      );
    }
    const liveWorkspaces = normalizeProjectWorkspaces(
      project.projectWorkspaces,
      project.workingDirs,
      project.useWorktrees,
    );
    if (
      workspacePathSignature(liveWorkspaces) !==
      workspacePathSignature(initialWorkspaces)
    ) {
      throw new CommandError(
        "internal_error",
        "The project's folders changed while their Git state was being inspected; nothing was changed. Retry once.",
      );
    }

    let gitWorkspaceCount = 0;
    const projectWorkspaces = liveWorkspaces.map((workspace) => {
      if (mode === "none") {
        return { ...workspace, startupMode: "none" as const };
      }
      const gitState = gitStateByPath.get(workspacePathKey(workspace.path));
      if (!gitState?.isGitRepo) {
        return { ...workspace, startupMode: "none" as const };
      }
      gitWorkspaceCount += 1;
      const enriched = enrichWorkspaceAttachmentWithGitState(
        workspace,
        gitState,
      );
      return { ...workspace, ...enriched, startupMode: mode };
    });
    if (mode !== "none" && gitWorkspaceCount === 0) {
      throw new CommandError(
        "invalid_args",
        `Project "${args.project_id}" has no Git workspaces; mode "${args.mode}" requires at least one Git workspace.`,
      );
    }

    // Deliberately no berd_project Edit Completed telemetry: this rewrite of
    // projectWorkspaces/workingDirs/useWorktrees is a genuine configuration
    // edit by the event's own params, but berdctl mutations are
    // agent/automation-driven and the event tracks human-driven UI surfaces
    // only — matching the documented berdctl exclusions in the chat send path
    // (fireChatSendTelemetry in useChatSessionController) and `berdctl agent
    // create` (createAgent.ts).
    const updated = await useProjectStore.getState().editProject(
      project.id,
      project.name,
      project.description,
      project.prompt,
      project.icon,
      project.color,
      projectWorkspaces.map((workspace) => workspace.path),
      mode === "auto-worktree",
      projectWorkspaces,
    );

    return {
      ok: true,
      mode,
      workspaces: updated.projectWorkspaces.map((workspace) => ({
        path: workspace.path,
        startup_mode: workspace.startupMode,
      })),
    };
  },
});

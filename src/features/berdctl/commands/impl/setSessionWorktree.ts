import { z } from "zod/v4";

import { defineCommand } from "../types";

const setSessionWorktreeSchema = z
  .object({
    session_id: z.string().describe("Id of the session to re-point."),
    path: z
      .string()
      .min(1)
      .describe(
        "Path of the worktree (or plain folder) the session should work in; " +
          "must already exist on disk. `~` is expanded.",
      ),
  })
  .strict();

interface SetSessionWorktreeResult {
  ok: true;
  path: string;
  branch: string | null;
}

export const setSessionWorktreeCommand = defineCommand({
  effect: "update",
  visibility: "immediate",
  destructive: false,
  summary: "Point a chat session at a different worktree or folder",
  description:
    "Point a chat session at a different worktree or folder; the session's " +
    "active worktree updates immediately in the app and the agent works " +
    "there from the next prompt. Files and git state are not moved.",
  helpFooter: `Worktree paths come from the repo (\`git worktree list\`); any existing
folder works. The session's current folder is in \`berdctl session get\`'s
working_dir.

Example:
  berdctl session set-worktree --session-id <session-id> \\
    --path ~/src/repo-worktrees/my-feature

Result:
  {"ok": true, "path": "...", "branch": "..."|null}
  "branch" is the branch checked out in that folder, or null for a
  non-git folder.`,
  schema: setSessionWorktreeSchema,
  precheck: async (args) => {
    const { refuseRunningTarget } = await import("../runtime/sessions");
    refuseRunningTarget(args.session_id, "change the worktree for");
  },
  execute: async (args, ctx): Promise<SetSessionWorktreeResult> => {
    const [
      { refusePastDeadline },
      { resolveExistingDirectoryOrThrow },
      { updateWorkingDir },
      { getGitState },
      { useChatSessionStore },
      { loadSessionForBerdctl, requireSession },
    ] = await Promise.all([
      import("../runtime/deadline"),
      import("../runtime/paths"),
      import("@/shared/api/acpApi"),
      import("@/shared/api/git"),
      import("@/features/chat/stores/chatSessionStore"),
      import("../runtime/sessions"),
    ]);
    await loadSessionForBerdctl(args.session_id);
    requireSession(args.session_id);
    const path = await resolveExistingDirectoryOrThrow(args.path);
    // The branch is display metadata (context panel, sidebar subtitle); a
    // non-git or unreadable folder is still a valid working directory.
    let branch: string | null = null;
    try {
      const gitState = await getGitState(path);
      branch = gitState.isGitRepo ? gitState.currentBranch : null;
    } catch {
      branch = null;
    }
    // The session pagination, directory probe, and git read above can
    // outlive the broker deadline; past it the caller was already told this
    // call failed, so it must not re-point the session afterwards.
    refusePastDeadline(ctx, "the session's worktree was not changed");
    // Mirror the context panel's change-folder flow: persist the backend
    // session cwd, then update the store so the open chat re-points live.
    await updateWorkingDir(args.session_id, path);
    const store = useChatSessionStore.getState();
    store.patchSession(args.session_id, { workingDir: path });
    store.setActiveWorkspace(args.session_id, { path, branch });
    return { ok: true as const, path, branch };
  },
});

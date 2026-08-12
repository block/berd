import { z } from "zod/v4";
import { defineCommand, CommandError } from "../types";

const attachSessionFolderSchema = z
  .object({
    session_id: z.string().min(1).describe("Id of the session to attach to."),
    path: z
      .string()
      .min(1)
      .describe(
        "Existing absolute folder, repository, or worktree path; ~ is expanded.",
      ),
  })
  .strict();

export const attachSessionFolderCommand = defineCommand({
  effect: "update",
  visibility: "immediate",
  destructive: false,
  summary: "Attach a folder, repository, or worktree to a chat",
  description:
    "Register an existing folder as chat context. If the chat still uses Berd's implicit default cwd, the folder becomes cwd safely after the current turn; otherwise cwd stays unchanged. Repeating the command is safe and refreshes Git identity.",
  helpFooter: `Use this after creating or adopting a folder inside a workspace root already authorized for the chat. Registered Git worktrees of an authorized repository are also allowed; select a new unrelated root in Berd first.

Example:
  berdctl folder attach --session-id <session-id> --path ~/src/repo-worktrees/feature

Result:
  {"ok": true, "path": "...", "kind": "...", "branch": "..."|null}`,
  schema: attachSessionFolderSchema,
  execute: async (args, ctx) => {
    const [
      { attachSessionFolder, FolderAttachmentError },
      { refusePastDeadline },
      { loadSessionForBerdctl },
    ] = await Promise.all([
      import("@/features/chat/lib/sessionFolderRegistration"),
      import("../runtime/deadline"),
      import("../runtime/sessions"),
    ]);
    await loadSessionForBerdctl(args.session_id);
    try {
      const attachment = await attachSessionFolder(args.session_id, args.path, {
        beforeMutation: () =>
          refusePastDeadline(ctx, "the folder was not attached"),
        enforceWorkspaceLimit: true,
      });
      return {
        ok: true as const,
        path: attachment.path,
        kind: attachment.kind,
        branch: attachment.branch ?? null,
      };
    } catch (error) {
      if (error instanceof FolderAttachmentError) {
        throw new CommandError("invalid_args", error.message);
      }
      throw error;
    }
  },
});

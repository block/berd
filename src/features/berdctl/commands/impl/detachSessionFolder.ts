import { z } from "zod/v4";
import { defineCommand, CommandError } from "../types";

const detachSessionFolderSchema = z
  .object({
    session_id: z.string().min(1).describe("Id of the session to detach from."),
    path: z
      .string()
      .min(1)
      .describe(
        "Existing attached folder, repository, or worktree path; ~ is expanded.",
      ),
  })
  .strict();

export const detachSessionFolderCommand = defineCommand({
  effect: "update",
  visibility: "immediate",
  destructive: false,
  summary: "Detach a folder, repository, or worktree from a chat",
  description:
    "Remove an existing folder from chat context without deleting anything. If it is cwd, the chat safely falls back to the first remaining attachment or Berd's default cwd.",
  helpFooter: `Detach the checked-out folder to detach its branch from chat context. This does not delete anything from disk or Git.

Example:
  berdctl folder detach --session-id <session-id> --path ~/src/repo-worktrees/feature

Result:
  {"ok": true, "path": "...", "detached": true|false}`,
  schema: detachSessionFolderSchema,
  precheck: async (args) => {
    const { refuseWindowedTarget } = await import("../runtime/sessions");
    refuseWindowedTarget(args.session_id, "detach a folder from");
  },
  execute: async (args, ctx) => {
    const [
      { detachSessionFolder, FolderAttachmentError },
      { refusePastDeadline },
      { loadSessionForBerdctl, refuseWindowedTarget },
    ] = await Promise.all([
      import("@/features/chat/lib/sessionFolderRegistration"),
      import("../runtime/deadline"),
      import("../runtime/sessions"),
    ]);
    await loadSessionForBerdctl(args.session_id);
    try {
      const result = await detachSessionFolder(args.session_id, args.path, {
        beforeMutation: () => {
          refusePastDeadline(ctx, "the folder was not detached");
          refuseWindowedTarget(args.session_id, "detach a folder from");
        },
      });
      return { ok: true as const, ...result };
    } catch (error) {
      if (error instanceof FolderAttachmentError) {
        throw new CommandError("invalid_args", error.message);
      }
      throw error;
    }
  },
});

import { z } from "zod/v4";
import { defineCommand, CommandError } from "../types";

const replaceSessionFolderSchema = z
  .object({
    session_id: z.string().min(1).describe("Id of the session to update."),
    old_path: z
      .string()
      .min(1)
      .describe("Existing attached folder path to detach; ~ is expanded."),
    new_path: z
      .string()
      .min(1)
      .describe("Existing replacement folder path to attach; ~ is expanded."),
  })
  .strict();

export const replaceSessionFolderCommand = defineCommand({
  effect: "update",
  visibility: "immediate",
  destructive: false,
  summary: "Replace the chat's current folder with another",
  description:
    "Use this for requests to switch or move the chat to a new worktree/folder. Validate first, then replace the old attachment in place without deleting anything. Replacing cwd safely moves cwd to the replacement.",
  helpFooter: `Prefer this over set-cwd when the user says to switch or move the chat to a new worktree/folder and does not ask to retain the old folder as context. Use set-cwd to select an already attached folder or when the old attachment should remain.

The old path must be attached. For the usual switch flow, get the current cwd from \`berdctl folder list\` and pass it as --old-path.

Example:
  berdctl folder replace --session-id <session-id> --old-path ~/src/repo --new-path ~/src/repo-worktrees/feature

Result:
  {"ok": true, "oldPath": "...", "newPath": "...", "kind": "...", "branch": "..."|null}`,
  schema: replaceSessionFolderSchema,
  precheck: async (args) => {
    const { refuseWindowedTarget } = await import("../runtime/sessions");
    refuseWindowedTarget(args.session_id, "replace a folder for");
  },
  execute: async (args, ctx) => {
    const [
      { replaceSessionFolder, FolderAttachmentError },
      { refusePastDeadline },
      { loadSessionForBerdctl, refuseWindowedTarget },
    ] = await Promise.all([
      import("@/features/chat/lib/sessionFolderRegistration"),
      import("../runtime/deadline"),
      import("../runtime/sessions"),
    ]);
    await loadSessionForBerdctl(args.session_id);
    try {
      const result = await replaceSessionFolder(
        args.session_id,
        args.old_path,
        args.new_path,
        {
          beforeMutation: () => {
            refusePastDeadline(ctx, "the folder was not replaced");
            refuseWindowedTarget(args.session_id, "replace a folder for");
          },
        },
      );
      return { ok: true as const, ...result };
    } catch (error) {
      if (error instanceof FolderAttachmentError) {
        throw new CommandError("invalid_args", error.message);
      }
      throw error;
    }
  },
});

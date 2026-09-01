import { z } from "zod/v4";

import type { CommandFailureReason } from "../../navigation";
import {
  backendArchiveFailedMessage,
  berdctlErrorDetail,
  sessionNotFoundMessage,
} from "../helpers";
import { CommandError, defineCommand } from "../types";

const archiveSessionSchema = z
  .object({
    session_id: z.string().describe("Id of the session to archive."),
    discard_changes: z
      .boolean()
      .optional()
      .describe(
        "Discard local files and changes when removing managed worktrees or branches.",
      ),
  })
  .strict();

export const archiveSessionCommand = defineCommand({
  effect: "archive",
  visibility: "immediate",
  destructive: true,
  summary: "Archive a chat and clean up its Goose-managed Git resources",
  description:
    "Archive a chat session, then remove eligible Goose-managed worktrees and branches. Refuses cleanup that would discard local files or changes unless --discard-changes is set.",
  helpFooter: `By default, the command refuses to archive when Git cleanup would discard local files or changes.
Use --discard-changes to allow that loss. The command never opens an interactive prompt.

Examples:
  berdctl session archive --session-id <session-id>
  berdctl session archive --session-id <session-id> --discard-changes

Result:
  {"ok": true} — the session was archived and eligible worktrees and branches were removed.`,
  bridgeTimeoutMs: 150_000,
  schema: archiveSessionSchema,
  precheck: async (args) => {
    const { refuseRunningTarget } = await import("../runtime/sessions");
    refuseRunningTarget(args.session_id, "archive");
  },
  execute: async (args, ctx) => {
    const [{ getAppNavigationController }, { loadSessionForBerdctl }] =
      await Promise.all([
        import("../../navigation"),
        import("../runtime/sessions"),
      ]);
    await loadSessionForBerdctl(args.session_id);
    const outcome = await getAppNavigationController().archiveSession(
      args.session_id,
      args.discard_changes ? "discard" : "reject",
      ctx.deadlineMs,
    );
    if (!outcome.ok) {
      throw new CommandError(
        outcome.reason,
        archiveFailureMessage(args.session_id, outcome.reason, outcome.detail),
      );
    }
    if (outcome.cleanupIncomplete) {
      throw new CommandError(
        outcome.cleanupIncomplete,
        archiveCleanupIncompleteMessage(
          args.session_id,
          outcome.cleanupIncomplete,
        ),
      );
    }
    return { ok: true as const };
  },
});

function archiveCleanupIncompleteMessage(
  sessionId: string,
  reason: "target_session_running" | "workspace_cleanup_failed" | "timed_out",
): string {
  switch (reason) {
    case "target_session_running":
      return `Session "${sessionId}" was archived, but Git cleanup stopped because the session started running or opened in another window; inspect the worktrees and branches in the app.`;
    case "workspace_cleanup_failed":
      return `Session "${sessionId}" was archived, but Git cleanup could not finish; inspect the worktrees and branches in the app.`;
    case "timed_out":
      return `Session "${sessionId}" was archived, but Git cleanup reached the command deadline before the next mutation could start; inspect the worktrees and branches in the app.`;
    default:
      reason satisfies never;
      return `Session "${sessionId}" was archived, but Git cleanup could not finish (${String(reason)}).`;
  }
}

/** Reason-specific failure messages, relayed verbatim by the CLI. */
function archiveFailureMessage(
  sessionId: string,
  reason: CommandFailureReason,
  detail?: string,
): string {
  switch (reason) {
    case "session_not_found":
      return sessionNotFoundMessage(sessionId);
    case "backend_archive_failed":
      return backendArchiveFailedMessage(
        "session",
        sessionId,
        detail === undefined ? undefined : berdctlErrorDetail(detail),
      );
    case "voice_stop_failed":
      return `Could not stop voice for session "${sessionId}"; the session was not archived.`;
    case "target_session_running":
      return `Refusing to archive session "${sessionId}" because it started running or opened in another window; wait for the turn to finish or close that window.`;
    case "cleanup_requires_discard":
      return `Refusing to archive session "${sessionId}" because Git cleanup would discard local files or changes; inspect them in the app or retry with --discard-changes.`;
    case "git_inspection_failed":
      return `Could not inspect the worktrees or branches for session "${sessionId}"; the session was not archived.`;
    case "workspace_cleanup_failed":
      return `Session "${sessionId}" was archived, but Git cleanup could not finish; inspect the worktrees and branches in the app.`;
    case "timed_out":
      return `Archiving session "${sessionId}" timed out before the next mutation could start.`;
    case "blocked_unsaved_changes":
    case "focus_failed":
      return `Failed to archive session "${sessionId}" (${reason})`;
    default:
      reason satisfies never;
      return `Failed to archive session "${sessionId}" (${String(reason)})`;
  }
}

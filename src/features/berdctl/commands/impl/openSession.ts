import { z } from "zod/v4";

import type { CommandFailureReason } from "../../navigation";
import { sessionNotFoundMessage } from "../helpers";
import { CommandError, defineCommand } from "../types";

const openSessionSchema = z
  .object({
    session_id: z.string().describe("Id of the session to open in the app."),
  })
  .strict();

export const openSessionCommand = defineCommand({
  effect: "update",
  visibility: "immediate",
  destructive: false,
  summary: "Open a session in the app window the user is looking at",
  description:
    "Open an existing chat session in the app window the user is looking at.",
  helpFooter: `Example:
  berdctl session open --session-id <session-id>

Result:
  {"ok": true} — the session is now on screen.`,
  schema: openSessionSchema,
  execute: async (args) => {
    const [{ getAppNavigationController }, { loadSessionForBerdctl }] =
      await Promise.all([
        import("../../navigation"),
        import("../runtime/sessions"),
      ]);
    await loadSessionForBerdctl(args.session_id);
    const outcome = await getAppNavigationController().openSession(
      args.session_id,
    );
    // The facade reports session_not_found, focus_failed, and
    // blocked_unsaved_changes as outcomes; surface them as thrown errors so
    // the CLI exits non-zero instead of reporting an exit-0 "success".
    if (!outcome.ok) {
      throw new CommandError(
        outcome.reason,
        openFailureMessage(args.session_id, outcome.reason),
      );
    }
    return { ok: true as const };
  },
});

/** Reason-specific failure messages, relayed verbatim by the CLI. */
function openFailureMessage(
  sessionId: string,
  reason: CommandFailureReason,
): string {
  switch (reason) {
    case "session_not_found":
      return sessionNotFoundMessage(sessionId);
    case "blocked_unsaved_changes":
      return "The user declined to leave unsaved work; do not retry — tell the user.";
    case "focus_failed":
      return "The session is open in a separate window that could not be focused; tell the user.";
    case "backend_archive_failed":
    case "voice_stop_failed":
    case "target_session_running":
    case "cleanup_requires_discard":
    case "git_inspection_failed":
    case "workspace_cleanup_failed":
    case "timed_out":
      return `Failed to open session "${sessionId}" (${reason})`;
    default:
      reason satisfies never;
      return `Failed to open session "${sessionId}" (${String(reason)})`;
  }
}

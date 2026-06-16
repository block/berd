import { z } from "zod/v4";

import type { CommandFailureReason } from "../../navigation";
import {
  backendArchiveFailedMessage,
  sessionNotFoundMessage,
} from "../helpers";
import { CommandError, defineCommand } from "../types";

const archiveSessionSchema = z
  .object({
    session_id: z.string().describe("Id of the session to archive."),
  })
  .strict();

export const archiveSessionCommand = defineCommand({
  effect: "archive",
  visibility: "immediate",
  destructive: false,
  summary: "Archive a chat session (reversible; nothing is deleted)",
  description:
    "Archive a chat session; it disappears from the active session list (reversible from the archive).",
  helpFooter: `Archiving is reversible from the app's archive view; nothing is deleted.

Example:
  goosectl session archive --session-id <session-id>

  Result:
  {"ok": true} — the session disappears from the active session list.`,
  schema: archiveSessionSchema,
  precheck: async (args) => {
    const { refuseRunningTarget } = await import("../runtime/sessions");
    refuseRunningTarget(args.session_id, "archive");
  },
  execute: async (args) => {
    const [{ getAppNavigationController }, { loadSessionForGoosectl }] =
      await Promise.all([
        import("../../navigation"),
        import("../runtime/sessions"),
      ]);
    await loadSessionForGoosectl(args.session_id);
    const outcome =
      await getAppNavigationController().archiveSessionWithCleanup(
        args.session_id,
      );
    if (!outcome.ok) {
      throw new CommandError(
        outcome.reason,
        archiveFailureMessage(args.session_id, outcome.reason),
      );
    }
    return { ok: true as const };
  },
});

/** Reason-specific failure messages, relayed verbatim by the CLI. */
function archiveFailureMessage(
  sessionId: string,
  reason: CommandFailureReason,
): string {
  switch (reason) {
    case "session_not_found":
      return sessionNotFoundMessage(sessionId);
    case "backend_archive_failed":
      return backendArchiveFailedMessage("session", sessionId);
    case "blocked_unsaved_changes":
    case "focus_failed":
      return `Failed to archive session "${sessionId}" (${reason})`;
    default:
      reason satisfies never;
      return `Failed to archive session "${sessionId}" (${String(reason)})`;
  }
}

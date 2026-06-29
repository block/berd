import { z } from "zod/v4";

import { defineCommand } from "../types";

const renameSessionSchema = z
  .object({
    session_id: z.string().describe("Id of the session to rename."),
    title: z.string().min(1).describe("The new session title."),
  })
  .strict();

export const renameSessionCommand = defineCommand({
  effect: "update",
  visibility: "immediate",
  destructive: false,
  summary: "Rename a chat session",
  description:
    "Rename a chat session; the new title appears immediately in the app's session list.",
  helpFooter: `Example:
  berdctl session rename --session-id <session-id> --title "CI triage"

Result:
  {"ok": true} — the new title appears immediately in the app's session list.`,
  schema: renameSessionSchema,
  execute: async (args) => {
    const [{ updateSessionTitle }, { loadSessionForBerdctl, requireSession }] =
      await Promise.all([
        import("@/features/chat/stores/chatSessionOperations"),
        import("../runtime/sessions"),
      ]);
    await loadSessionForBerdctl(args.session_id);
    requireSession(args.session_id);
    await updateSessionTitle(args.session_id, args.title);
    return { ok: true as const };
  },
});

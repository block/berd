import { z } from "zod/v4";

import { defineCommand } from "../types";

const clearSessionProjectSchema = z
  .object({
    session_id: z
      .string()
      .describe("Id of the session to move out of its project."),
  })
  .strict();

export const clearSessionProjectCommand = defineCommand({
  effect: "update",
  visibility: "immediate",
  destructive: false,
  summary: "Move a chat session out of any project",
  description:
    "Move a chat session out of any project; the session list in the app regroups immediately.",
  helpFooter: `Example:
  berdctl session clear-project --session-id <session-id>

Result:
  {"ok": true} — the app's session list regroups immediately.`,
  schema: clearSessionProjectSchema,
  precheck: async (args) => {
    const { refuseRunningTarget } = await import("../runtime/sessions");
    refuseRunningTarget(args.session_id, "clear the project for");
  },
  execute: async (args) => {
    const [
      { moveSessionToProject },
      { loadSessionForBerdctl, requireSession },
    ] = await Promise.all([
      import("@/features/chat/stores/chatSessionOperations"),
      import("../runtime/sessions"),
    ]);
    await loadSessionForBerdctl(args.session_id);
    requireSession(args.session_id);
    await moveSessionToProject(args.session_id, null);
    return { ok: true as const };
  },
});

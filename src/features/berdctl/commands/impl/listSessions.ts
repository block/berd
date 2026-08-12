import { z } from "zod/v4";

import { defineCommand } from "../types";

const listSessionsSchema = z
  .object({
    project_id: z
      .string()
      .optional()
      .describe("Only list sessions belonging to this project."),
    query: z
      .string()
      .optional()
      .describe("Case-insensitive substring to match against session titles."),
    limit: z
      .number()
      .int()
      .min(1)
      .max(100)
      .default(20)
      .describe(
        "Maximum number of sessions to return (1-100). Defaults to 20.",
      ),
  })
  .strict();

interface ListSessionsResult {
  sessions: Array<{
    session_id: string;
    title: string;
    project_id: string | null;
    updated_at: string;
    is_running: boolean;
    chat_state:
      | "idle"
      | "thinking"
      | "streaming"
      | "waiting"
      | "compacting"
      | "error";
    message_count: number;
  }>;
}

export const listSessionsCommand = defineCommand({
  effect: "read",
  visibility: "none",
  destructive: false,
  summary: "List the user's chat sessions (most recent first)",
  description:
    "List the user's chat sessions visible in the app (most recent first); does not change anything on screen.",
  helpFooter: `Example:
  berdctl session list --query "review" --limit 10 --json

Result:
  {"sessions": [{"session_id": "...", "title": "...",
                 "project_id": "..."|null, "updated_at": "...",
                 "is_running": false, "chat_state": "idle",
                 "message_count": 12}, ...]}
  Most recent first; archived sessions are excluded.`,
  schema: listSessionsSchema,
  execute: async (args): Promise<ListSessionsResult> => {
    const [
      { useChatSessionStore },
      { findProjectOrThrow },
      { loadAllSessionsForBerdctl, sessionMetadata },
    ] = await Promise.all([
      import("@/features/chat/stores/chatSessionStore"),
      import("../runtime/projects"),
      import("../runtime/sessions"),
    ]);
    // Validate the project filter so a typo'd id errors instead of reading as
    // "this project has no sessions".
    if (args.project_id) {
      await findProjectOrThrow(args.project_id);
    }
    await loadAllSessionsForBerdctl();
    const query = args.query?.toLowerCase();
    const sessions = useChatSessionStore
      .getState()
      .sessions.filter((session) => !session.archivedAt)
      .filter((session) =>
        args.project_id ? session.projectId === args.project_id : true,
      )
      .filter((session) =>
        query ? session.title.toLowerCase().includes(query) : true,
      )
      .slice(0, args.limit)
      .map((session) => {
        const metadata = sessionMetadata(session);
        return {
          session_id: session.id,
          title: session.title,
          project_id: session.projectId ?? null,
          updated_at: session.updatedAt,
          is_running: metadata.is_running,
          chat_state: metadata.chat_state,
          message_count: session.messageCount,
        };
      });
    return { sessions };
  },
});

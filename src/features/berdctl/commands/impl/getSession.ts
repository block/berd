import { z } from "zod/v4";

import { truncate } from "../helpers";
import { defineCommand } from "../types";

const getSessionSchema = z
  .object({
    session_id: z.string().describe("Id of the session to read."),
    messages: z
      .number()
      .int()
      .min(0)
      .max(50)
      .default(0)
      .describe(
        "How many of the session's most recent messages to include (0-50). " +
          "Defaults to 0 (metadata only).",
      ),
  })
  .strict();

/** Per-message text cap so a few verbose turns cannot flood the caller. */
const MESSAGE_TEXT_LIMIT = 2000;

interface SessionMetadataResult {
  session_id: string;
  title: string;
  harness_id: string;
  model_id: string | null;
  agent_id: string | null;
  project_id: string | null;
  working_dir: string | null;
  created_at: string;
  updated_at: string;
  archived: boolean;
  is_running: boolean;
  is_open_in_window: boolean;
  chat_state:
    | "idle"
    | "thinking"
    | "streaming"
    | "waiting"
    | "compacting"
    | "error";
  message_count: number;
}

type GetSessionResult = SessionMetadataResult & {
  messages?: Array<{ role: string | null; text: string }>;
};

export const getSessionCommand = defineCommand({
  effect: "read",
  visibility: "none",
  destructive: false,
  summary: "Read one session's metadata and optionally its latest messages",
  description:
    "Read one session's metadata and optionally its most recent messages; " +
    "does not change anything on screen. Use only when the user asks about " +
    "a session's status or content.",
  helpFooter: `Example:
  berdctl session get --session-id <session-id> --messages 5 --json

Result:
  {"session_id": "...", "title": "...", "harness_id": "...",
   "model_id": "..."|null, "agent_id": "..."|null,
   "project_id": "..."|null, "working_dir": "..."|null,
   "created_at": "...", "updated_at": "...", "archived": false,
   "is_running": false, "is_open_in_window": false,
   "chat_state": "idle", "message_count": 12,
   "messages": [{"role": "user"|"assistant"|null, "text": "..."}, ...]}
  "messages" is present only when --messages > 0; each message text is
  truncated to 2000 chars.`,
  schema: getSessionSchema,
  execute: async (args): Promise<GetSessionResult> => {
    const [
      { lastSessionMessages },
      { loadSessionForBerdctl, requireSession, sessionMetadata },
    ] = await Promise.all([
      import("@/shared/api/sessionSearch"),
      import("../runtime/sessions"),
    ]);
    await loadSessionForBerdctl(args.session_id);
    const session = requireSession(args.session_id);
    const metadata = sessionMetadata(session);
    if (args.messages === 0) {
      return metadata;
    }
    const messages = await lastSessionMessages(args.session_id, args.messages);
    return {
      ...metadata,
      messages: messages.map(({ role, text }) => ({
        role,
        text: truncate(text, MESSAGE_TEXT_LIMIT),
      })),
    };
  },
});

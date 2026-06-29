import { z } from "zod/v4";

import { defineCommand } from "../types";

const forkSessionSchema = z
  .object({
    session_id: z.string().describe("Id of the session to fork (duplicate)."),
    title: z
      .string()
      .min(1)
      .optional()
      .describe(
        "Optional title for the forked session. Defaults to the source title.",
      ),
  })
  .strict();

interface ForkSessionResult {
  session_id: string;
  title: string;
  source_session_id: string;
  message_count: number;
}

export const forkSessionCommand = defineCommand({
  effect: "create",
  visibility: "discoverable",
  destructive: false,
  summary: "Fork a chat session into an independent copy with its history",
  description:
    "Duplicate an existing chat session, copying its full conversation history into a new " +
    "session the user can continue down an independent path. The fork appears in the app's " +
    "session list; the user's current view does not change.",
  helpFooter: `Example:
  berdctl session fork --session-id <session-id> --title "Alternate approach"

Result:
  {"session_id": "...", "title": "...", "source_session_id": "...",
   "message_count": 7}
  The fork appears in the session list with a copy of the original history.`,
  schema: forkSessionSchema,
  // Fork is a real backend round-trip that copies the conversation history.
  bridgeTimeoutMs: 60_000,
  precheck: async (args) => {
    const { refuseRunningTarget } = await import("../runtime/sessions");
    refuseRunningTarget(args.session_id, "fork");
  },
  execute: async (args): Promise<ForkSessionResult> => {
    const [
      { acpDuplicateSession },
      { acpSessionToChatSession },
      { useChatSessionStore },
      { loadSessionForBerdctl, requireSession },
    ] = await Promise.all([
      import("@/shared/api/acp"),
      import("@/features/chat/lib/acpSessionMapping"),
      import("@/features/chat/stores/chatSessionStore"),
      import("../runtime/sessions"),
    ]);
    await loadSessionForBerdctl(args.session_id);
    const source = requireSession(args.session_id);
    const forked = await acpDuplicateSession(
      args.session_id,
      source.workingDir ?? "~",
      args.title,
    );
    const chatSession = acpSessionToChatSession(forked);
    useChatSessionStore.getState().addSession(chatSession);
    return {
      session_id: forked.sessionId,
      title: chatSession.title,
      source_session_id: args.session_id,
      message_count: forked.messageCount,
    };
  },
});

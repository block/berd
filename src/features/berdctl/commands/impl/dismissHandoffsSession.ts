import { z } from "zod/v4";

import { CommandError, defineCommand } from "../types";

const dismissHandoffsSessionSchema = z
  .object({
    session_id: z
      .string()
      .min(1)
      .describe("Id of the session that owns the live Realtime Spokesperson."),
    cursor: z
      .number()
      .int()
      .min(0)
      .max(4_294_967_295)
      .describe(
        "Newest cursor from any Expert-bound voice transcript, handoff, reminder, or bridge result.",
      ),
    handoff_id: z
      .array(z.string().trim().min(1).max(100))
      .min(1)
      .max(100)
      .describe("Open handoff id to dismiss; repeat for multiple handoffs."),
    reason: z
      .string()
      .trim()
      .min(1)
      .max(2_000)
      .describe("Why no spoken response is needed for these handoffs."),
  })
  .strict();

interface DismissHandoffsSessionResult {
  session_id: string;
  cursor: number;
  dismissed_handoff_ids: string[];
  context_delivery_status: "sent" | "interrupting" | "queued";
}

export const dismissHandoffsSessionCommand = defineCommand({
  effect: "update",
  visibility: "immediate",
  destructive: false,
  summary: "Dismiss open voice handoffs without speaking",
  description:
    "Explicitly close one or more open Realtime Spokesperson handoffs and deliver " +
    "the reason as silent context without waking the Spokesperson. Use this only " +
    "when a spoken response is obsolete, superseded, or already handled. The " +
    "command and its reason remain visible in the Expert's normal Berd activity.",
  helpFooter: `Example:
  berdctl session dismiss-handoffs --session-id <session-id> --cursor <latest-cursor> \
    --handoff-id <handoff-id> \
    --reason "The user's follow-up superseded both requests." --json

Result:
  {"session_id":"...","cursor":<latest-cursor>,"dismissed_handoff_ids":["<handoff-id>"],"context_delivery_status":"sent"|"interrupting"|"queued"}

Every id must still be open. A dismissal consumes pending Spokesperson handoffs only
when --cursor proves the Expert received the complete pending batch, then
atomically sends the dismissal reason back as silent context. Use send-to-spokesperson
--mode say instead when the user still needs an answer.`,
  schema: dismissHandoffsSessionSchema,
  execute: async (args): Promise<DismissHandoffsSessionResult> => {
    const { dismissActiveRealtimeHandoffs } = await import(
      "@/features/voice-conversation/lib/realtimeEmissaryBridge"
    );
    const dismissal = await dismissActiveRealtimeHandoffs(
      args.session_id,
      args.cursor,
      args.handoff_id,
      args.reason,
    );
    if (!dismissal) {
      throw new CommandError(
        "invalid_args",
        `Session "${args.session_id}" has no live OpenAI Realtime voice Spokesperson. Start Realtime voice in that session and retry.`,
      );
    }

    if (!dismissal.accepted) {
      throw new CommandError(
        "invalid_args",
        JSON.stringify({
          reason: dismissal.reason,
          cursor: dismissal.cursor,
          ...(dismissal.reason === "unknown_handoff"
            ? { handoff_ids: dismissal.handoffIds }
            : {}),
        }),
      );
    }

    return {
      session_id: args.session_id,
      cursor: dismissal.cursor,
      dismissed_handoff_ids: dismissal.dismissedHandoffIds,
      context_delivery_status: dismissal.deliveryStatus,
    };
  },
});
